import {expect} from 'chai';
import assert from 'node:assert/strict';
import {network} from 'hardhat';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from '../../../apps/backend/node_modules/pg/lib/index.js';
import {ingestLocalHour} from '../../../apps/backend/scripts/b22a-ingestion.mjs';
import {processFinalizedHour} from '../../../apps/backend/scripts/b22b-matching.mjs';
import {prepareAuthorization} from '../../../apps/backend/scripts/b24a1-authorization.mjs';
import {verifySigningPreflight} from '../../../apps/backend/scripts/b24a2-signing-preflight.mjs';
import {inspectLocalReadiness} from '../../../apps/backend/scripts/b24-readiness.mjs';
import {createOfflineSigningService,createEphemeralTestWalletRegistry} from '../../../apps/backend/scripts/b24-signing.mjs';
import {establishLocalChainSession,restoreLocalChainSession,retireLocalChainSession} from '../../../apps/backend/scripts/b24-local-chain-session.mjs';
import {verifyLocalReceipt} from '../../../apps/backend/scripts/b24-receipt-verifier.mjs';
import {fundLocalReservation} from '../../../apps/backend/scripts/b24-funding.mjs';
import {setLocalAllowance} from '../../../apps/backend/scripts/b24-allowance.mjs';
import {recoverLocalOperation} from '../../../apps/backend/scripts/b24-local-tx-recovery.mjs';
const {ethers}=await network.create();
const {Client}=pg;

describe('B24 database-bound buyer local experiment',function(){
 this.timeout(120000);
 it('binds a newly enrolled ephemeral buyer to B22, B24-A1 and B23',async function(){
  if(process.env.B24_A2_TEST!=='1'){this.skip();return;}
  const urls=['B22_TEST_DATABASE_URL','B22_ROSTER_DATABASE_URL','B22_INGEST_DATABASE_URL','B22_MATCH_DATABASE_URL','B24_APPROVER_DATABASE_URL','B24_EVALUATOR_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_SIGNER_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_SIGNER_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL'];
  for(const name of urls){const u=new URL(process.env[name]!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/b22_disposable_review')throw Error('unsafe database');}
  const clients=urls.map(name=>new Client({connectionString:process.env[name]}));await Promise.all(clients.map(c=>c.connect()));
  const [owner,roster,ingest,matcher,approver,evaluator,preflight,signerClient,otherPreflight,otherSigner,receiptVerifier,funder,allowanceClient,otherFunder,otherAllowance,thirdPreflight,otherReceipt,conflictingAllowance,budgetFunder,budgetPreflight,budgetReceipt,budgetAllowance]=clients;
  try{
   const [admin,operator,pauser]=await ethers.getSigners();const registry=await createEphemeralTestWalletRegistry({client:signerClient,provider:ethers.provider});const buyer=registry.createBuyer();
   const raw=JSON.parse(readFileSync(new URL('../../shared/fixtures/b22-hourly-prototype.json',import.meta.url),'utf8'));
   const users=raw.snapshot.users.map((u:any,i:number)=>({userId:u.userId,name:`Synthetic ${i}`,email:`wallet-bound-${i}@example.com`,physicalAddress:'Simulated road',xKm:u.xKm,yKm:u.yKm,preferredEnergyType:u.preferredEnergyType,reputation:u.reputation-(i===0?2:0),hederaAccountId:`0.0.${1000+i}`,evmAddress:i===4?buyer.address.toLowerCase():u.evmAddress}));
   for(const [i,u] of users.entries()){
    await owner.query('INSERT INTO users(id,name,email,password_hash,physical_address,x_km,y_km,reputation,preferred_energy_type,updated_at) VALUES($1,$2,$3,\'synthetic\',$4,$5,$6,$7,$8,now())',[u.userId,u.name,u.email,u.physicalAddress,u.xKm,u.yKm,u.reputation,u.preferredEnergyType]);
    await owner.query('INSERT INTO wallets(id,user_id,hedera_account_id,evm_address,public_key,encrypted_private_key,encryption_iv,encryption_auth_tag,updated_at) VALUES($1,$2,$3,$4,\'synthetic\',\'synthetic\',\'synthetic\',\'synthetic\',now())',[raw.snapshot.users[i].recordId,u.userId,u.hederaAccountId,u.evmAddress]);
   }
   const slot='2026-10-03T12:00:00Z';await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,\'ignored\',1)',[randomUUID(),slot,'2026-10-03T13:00:00Z',JSON.stringify(users)]);
   const snapshot=await ingestLocalHour(ingest,slot,{execute:true});const plan=await processFinalizedHour(matcher,slot,{execute:true});expect(plan.status).eq('AUTHORITATIVE');expect(plan.snapshotId).eq(snapshot.snapshotId);
   const allocation=plan.allocations.find((a:any)=>a.buyerId===users[4].userId);expect(allocation).not.eq(undefined);expect(allocation.quantityWh).eq('28');expect(allocation.unitPriceMicrousdPerKwh).eq('90750');expect(allocation.amountBaseUnits).eq('2541');expect(allocation.remainder).eq(0);
   const token:any=await ethers.deployContract('TestEnergyUSD',[admin.address]);const contract:any=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
   const artifact=JSON.parse(readFileSync(new URL('../artifacts/contracts/EnergyTradingDirectSettlement.sol/EnergyTradingDirectSettlement.json',import.meta.url),'utf8'));const deployment=randomUUID(),policy=randomUUID(),contractAddress=(await contract.getAddress()).toLowerCase(),tokenAddress=(await token.getAddress()).toLowerCase();
   await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'local test fixture\',now())',[deployment,contractAddress,tokenAddress,ethers.keccak256(artifact.deployedBytecode),ethers.keccak256(artifact.bytecode)]);
   await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,2541,2541,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',1,\'ignored\',\'synthetic only\')',[policy,allocation.buyerId,buyer.address.toLowerCase(),deployment,tokenAddress,plan.marketId]);
   const reserved=await prepareAuthorization(evaluator,{slot,allocationId:allocation.allocationId,policyId:policy,deploymentId:deployment,execute:true});expect(reserved.state).eq('RESERVED');const row=reserved.reservation;
   expect((await verifySigningPreflight(preflight,{reservationId:row.id})).state).eq('SIMULATION_ELIGIBLE');const built=row.terms;

   // Draft journals are deliberately fail-closed; no runtime service grants exist yet.
   const signingId=randomUUID(),fundingId=randomUUID(),allowanceId=randomUUID();

   await owner.query('INSERT INTO "B24FundingOperation"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES($1,$2,$3,$4,2541,$5)',[fundingId,row.id,'draft-funding','test-only','local-session']);
   await owner.query('INSERT INTO "B24AllowanceOperation"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES($1,$2,$3,$4,2541,$5)',[allowanceId,row.id,'draft-allowance','test-only','local-session']);


   await assert.rejects(evaluator.query('SELECT * FROM "B24SigningOperation"'),(e:any)=>e.code==='42501');

   const eventId=randomUUID();
   await owner.query('INSERT INTO "B24OperationEvent"(id,"fundingOperationId",sequence,state,actor,"txHash") VALUES($1,$2,1,\'SUBMITTED\',\'forged\',$3)',[eventId,fundingId,'0x'+'1'.repeat(64)]);
   const event=(await owner.query('SELECT actor,state,sequence FROM "B24OperationEvent" WHERE id=$1',[eventId])).rows[0];expect(event.actor).eq('b22test');expect(event.state).eq('SUBMITTED');expect(event.sequence).eq(1);
   await assert.rejects(owner.query('INSERT INTO "B24OperationEvent"(id,"fundingOperationId",sequence,state,actor) VALUES($1,$2,2,\'VERIFIED\',\'x\')',[randomUUID(),fundingId]),(e:any)=>e.code==='42501'&&e.message.includes('verified receipt evidence missing'));
   await assert.rejects(owner.query('UPDATE "B24OperationEvent" SET state=\'FAILED\' WHERE id=$1',[eventId]),(e:any)=>e.message.includes('append-only'));
   await assert.rejects(owner.query('INSERT INTO "B24OperationEvent"(id,"fundingOperationId",sequence,state,actor) VALUES($1,$2,3,\'FAILED\',\'x\')',[randomUUID(),fundingId]),(e:any)=>e.message.includes('event sequence invalid'));
   await assert.rejects(evaluator.query('INSERT INTO "B24OperationEvent"(id,"fundingOperationId",sequence,state,actor) VALUES($1,$2,2,\'FAILED\',\'x\')',[randomUUID(),fundingId]),(e:any)=>e.code==='42501');
   // SQL-boundary test only: the dedicated verifier is trusted to inspect real receipts.
   const fakeHash='0x'+'1'.repeat(64),blockHash='0x'+'2'.repeat(64);
   await assert.rejects(evaluator.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6)',['FUNDING',fundingId,fakeHash,blockHash,1,0]),(e:any)=>e.code==='42501');
   await assert.rejects(receiptVerifier.query('INSERT INTO "B24ReceiptEvidence"(id) VALUES($1)',[randomUUID()]),(e:any)=>e.code==='42501');
   await assert.rejects(receiptVerifier.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6)',['FUNDING',fundingId,'0x'+'3'.repeat(64),blockHash,1,0]),(e:any)=>e.message.includes('receipt operation context invalid'));
   await receiptVerifier.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6)',['FUNDING',fundingId,fakeHash,blockHash,1,0]);
   const receiptEvidence=(await owner.query('SELECT "verifiedBy","amountBaseUnits","buyerAddress" FROM "B24ReceiptEvidence" WHERE "fundingOperationId"=$1',[fundingId])).rows[0];expect(receiptEvidence.verifiedBy).eq('b24_receipt_verifier');expect(receiptEvidence.amountBaseUnits).eq('2541');expect(receiptEvidence.buyerAddress).eq(buyer.address.toLowerCase());
   await assert.rejects(receiptVerifier.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6)',['FUNDING',fundingId,fakeHash,blockHash,1,0]),(e:any)=>e.message.includes('receipt operation context invalid'));
   await assert.rejects(owner.query('UPDATE "B24ReceiptEvidence" SET "blockNumber"=2 WHERE "fundingOperationId"=$1',[fundingId]),(e:any)=>e.message.includes('immutable'));
   const allowanceHash='0x'+'4'.repeat(64);
   await owner.query('INSERT INTO "B24OperationEvent"(id,"allowanceOperationId",sequence,state,actor,"txHash") VALUES($1,$2,1,\'SUBMITTED\',\'ignored\',$3)',[randomUUID(),allowanceId,allowanceHash]);
   await receiptVerifier.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6)',['ALLOWANCE',allowanceId,allowanceHash,blockHash,1,1]);
   const allowanceEvidence=(await owner.query('SELECT "spenderAddress","tokenAddress","amountBaseUnits" FROM "B24ReceiptEvidence" WHERE "allowanceOperationId"=$1',[allowanceId])).rows[0];expect(allowanceEvidence.spenderAddress).eq(contractAddress);expect(allowanceEvidence.tokenAddress).eq(tokenAddress);expect(allowanceEvidence.amountBaseUnits).eq('2541');
   await assert.rejects(receiptVerifier.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6)',['ALLOWANCE',allowanceId,allowanceHash,blockHash,1,1]),(e:any)=>e.message.includes('receipt operation context invalid'));


   expect(built.terms.buyer.toLowerCase()).eq(buyer.address.toLowerCase());expect(await contract.settlementId(built.terms)).eq(row.settlementId);
   const chainSnapshot=await ethers.provider.send('evm_snapshot',[]);
   const firstAnchor=await (await admin.sendTransaction({to:buyer.address,value:ethers.parseEther('1')})).wait();
   const originalCode=await ethers.provider.getCode(tokenAddress);
   try{const altered=originalCode.slice(0,18)+(originalCode.slice(18,20)==='00'?'01':'00')+originalCode.slice(20);await ethers.provider.send('hardhat_setCode',[tokenAddress,altered]);await assert.rejects(establishLocalChainSession(preflight,{reservationId:row.id,provider:ethers.provider,anchorTransactionHash:firstAnchor.hash,approvalClient:approver}),/Local runtime code mismatch/);}finally{await ethers.provider.send('hardhat_setCode',[tokenAddress,originalCode]);}
   const staleSession=await establishLocalChainSession(preflight,{reservationId:row.id,provider:ethers.provider,anchorTransactionHash:firstAnchor.hash,approvalClient:approver});
   await ethers.provider.send('evm_revert',[chainSnapshot]);
   await assert.rejects(inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session:staleSession}),/Stale local chain session/);
   await retireLocalChainSession(staleSession,approver);
   const anchor=await (await admin.sendTransaction({to:buyer.address,value:ethers.parseEther('1')})).wait();
   const session=await establishLocalChainSession(preflight,{reservationId:row.id,provider:ethers.provider,anchorTransactionHash:anchor.hash,approvalClient:approver});
   // A second authentic historical market for the same buyer shares the funding budget.
   const budgetSlot='2026-06-29T12:00:00Z';await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,\'ignored\',1)',[randomUUID(),budgetSlot,'2026-06-29T13:00:00Z',JSON.stringify(users)]);
   await ingestLocalHour(ingest,budgetSlot,{execute:true});const budgetPlan=await processFinalizedHour(matcher,budgetSlot,{execute:true});expect(budgetPlan.status).eq('AUTHORITATIVE');
   const budgetAllocation=budgetPlan.allocations.find((a:any)=>a.buyerId===users[4].userId);expect(budgetAllocation).not.eq(undefined);expect(BigInt(budgetAllocation.amountBaseUnits)>2541n).eq(true);
   const budgetPolicy=randomUUID();await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,$7,$7,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',2,\'ignored\',\'second synthetic market\')',[budgetPolicy,budgetAllocation.buyerId,buyer.address.toLowerCase(),deployment,tokenAddress,budgetPlan.marketId,budgetAllocation.amountBaseUnits]);
   const budgetReservation=(await prepareAuthorization(evaluator,{slot:budgetSlot,allocationId:budgetAllocation.allocationId,policyId:budgetPolicy,deploymentId:deployment,execute:true})).reservation;
   const budgetSession=await establishLocalChainSession(budgetPreflight,{reservationId:budgetReservation.id,provider:ethers.provider,anchorTransactionHash:anchor.hash,approvalClient:approver});
   await assert.rejects(evaluator.query('UPDATE "B24LocalChainSession" SET status=\'RETIRED\' WHERE id=$1',[session.id]),(e:any)=>e.code==='42501');
   await assert.rejects(restoreLocalChainSession(preflight,{sessionId:staleSession.id,provider:ethers.provider}),/Local chain session unavailable/);
   await assert.rejects(inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session:{}}),/Unknown or mismatched local chain session/);
   const readiness=await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session});expect(readiness.state).eq('SIGNATURE_REQUIRED');expect(readiness.balanceBaseUnits).eq('0');expect(readiness.allowanceBaseUnits).eq('0');expect(readiness.realHederaExecutionAuthorized).eq(false);
   for(const address of [contractAddress,tokenAddress]){const original=await ethers.provider.getCode(address);try{const altered=original.slice(0,18)+(original.slice(18,20)==='00'?'01':'00')+original.slice(20);await ethers.provider.send('hardhat_setCode',[address,altered]);await assert.rejects(inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session}),/Local runtime code mismatch/);}finally{await ethers.provider.send('hardhat_setCode',[address,original]);}}

   const signing=createOfflineSigningService({client:signerClient,preflightClient:preflight,registry,session});
   await assert.rejects(createOfflineSigningService({client:signerClient,preflightClient:preflight,registry,session:{}}).signReservation(row.id),/Unknown or mismatched local chain session/);
   await assert.rejects(createEphemeralTestWalletRegistry({client:evaluator,provider:ethers.provider}),/Refusing non-disposable signer target/);
   await assert.rejects(createEphemeralTestWalletRegistry({client:signerClient,provider:{getNetwork:async()=>({chainId:296n})}}),/Unapproved test wallet registry/);
   const wrongRegistry=await createEphemeralTestWalletRegistry({client:otherSigner,provider:ethers.provider});wrongRegistry.createBuyer();
   const wrong=createOfflineSigningService({client:otherSigner,preflightClient:otherPreflight,registry:wrongRegistry,session});
   await assert.rejects(wrong.signReservation(row.id),/Archived buyer has no registered test signer/);
   assert.throws(()=>createOfflineSigningService({client:signerClient,preflightClient:preflight,registry:{createBuyer(){return buyer;}}}),/Registered local test wallet registry required/);
   assert.throws(()=>createOfflineSigningService({client:signerClient,preflightClient:preflight,signerAdapter:ethers.Wallet.createRandom()}),/Registered local test wallet registry required/);
   expect(Object.keys(buyer)).deep.eq(['address']);
   await assert.rejects(preflight.query('SELECT "b24_sign_lock"($1)',[row.id]),(e:any)=>e.code==='42501');
   const realQuery=signerClient.query.bind(signerClient);let injected=false;
   try{(signerClient as any).query=async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].includes('b24_sign_record')){injected=true;throw Error('injected signing persistence failure');}return realQuery(...args);};await assert.rejects(signing.signReservation(row.id),/injected signing persistence failure/);expect(injected).eq(true);}finally{(signerClient as any).query=realQuery;}
   expect((await owner.query('SELECT count(*)::int n FROM "B24SignedAuthorization"')).rows[0].n).eq(0);
   const concurrent=createOfflineSigningService({client:otherSigner,preflightClient:otherPreflight,registry,session});
   const signedResults=await Promise.all([signing.signReservation(row.id),concurrent.signReservation(row.id)]);expect(signedResults.map((x:any)=>x.reused).sort()).deep.eq([false,true]);
   const signed=signedResults[0];expect(signed.state).eq('SIGNED_OFFLINE');const signature=signed.signature;expect(ethers.verifyTypedData(built.domain,built.types,built.terms,signature)).eq(buyer.address);expect(signedResults[1].signature).eq(signature);
   const retry=await signing.signReservation(row.id);expect(retry.reused).eq(true);expect(retry.signature).eq(signature);
   const sameClientRetries=await Promise.all([signing.signReservation(row.id),signing.signReservation(row.id)]);expect(sameClientRetries.every((x:any)=>x.reused&&x.signature===signature)).eq(true);
   let lostResponse=false;const beforeLost=signerClient.query.bind(signerClient);
   try{(signerClient as any).query=async(...args:any[])=>{const result=await beforeLost(...args);if(!lostResponse&&args[0]==='COMMIT'){lostResponse=true;throw Error('injected lost commit response');}return result;};await assert.rejects(signing.signReservation(row.id),/injected lost commit response/);expect(lostResponse).eq(true);}finally{(signerClient as any).query=beforeLost;}
   const afterLost=await signing.signReservation(row.id);expect(afterLost.reused).eq(true);expect(afterLost.signature).eq(signature);
   await assert.rejects(signerClient.query('SELECT * FROM "B24SignedAuthorization"'),(e:any)=>e.code==='42501');

   const signingRecords=(await owner.query('SELECT id FROM "B24SigningOperation" WHERE "reservationId"=$1',[row.id])).rows;expect(signingRecords.length).eq(1);
   const signEvents=(await owner.query('SELECT state,actor FROM "B24OperationEvent" WHERE "signingOperationId"=$1 ORDER BY sequence',[signingRecords[0].id])).rows;expect(signEvents).deep.eq([{state:'AUTHORIZED',actor:'b24_signer'},{state:'SIGNED',actor:'b24_signer'}]);
   await assert.rejects(owner.query('UPDATE "B24SigningOperation" SET state=\'SIGNED\' WHERE id=$1',[signingRecords[0].id]),(e:any)=>e.message.includes('draft B24 operation records are immutable'));
   await assert.rejects(signerClient.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]),(e:any)=>e.code==='42501');
   await assert.rejects(signerClient.query('SELECT encrypted_private_key FROM wallets LIMIT 1'),(e:any)=>e.code==='42501');
   expect((await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session})).state).eq('FUNDING_REQUIRED');
   const beforeLocalTransactions=await ethers.provider.send('evm_snapshot',[]);

   const grantId=randomUUID();await approver.query('INSERT INTO "B24LocalFundingGrant"(id,"sessionId","minterAddress","perOperationLimit","cumulativeLimit","approvedBy") VALUES($1,$2,$3,2541,2541,\'ignored\')',[grantId,session.id,admin.address.toLowerCase()]);
   const smallGrant=randomUUID();await approver.query('INSERT INTO "B24LocalFundingGrant"(id,"sessionId","minterAddress","perOperationLimit","cumulativeLimit","approvedBy") VALUES($1,$2,$3,1,1,\'ignored\')',[smallGrant,session.id,admin.address.toLowerCase()]);
   const fundingBudget=randomUUID();await approver.query('INSERT INTO "B24LocalFundingBudget"(id,"buyerAddress","tokenAddress","minterAddress","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,2541,\'ignored\')',[fundingBudget,buyer.address.toLowerCase(),tokenAddress,admin.address.toLowerCase()]);
   const budgetGrant=randomUUID();await approver.query('INSERT INTO "B24LocalFundingGrant"(id,"sessionId","minterAddress","perOperationLimit","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$4,\'ignored\')',[budgetGrant,budgetSession.id,admin.address.toLowerCase(),budgetAllocation.amountBaseUnits]);
   await approver.query('INSERT INTO "B24LocalFundingBudgetGrant"("grantId","budgetId") VALUES($1,$4),($2,$4),($3,$4)',[grantId,smallGrant,budgetGrant,fundingBudget]);
   await assert.rejects(fundLocalReservation({client:evaluator,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,minter:admin,reservationId:row.id,grantId}),/Refusing non-disposable funding target/);
   await assert.rejects(fundLocalReservation({client:funder,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,minter:admin,reservationId:row.id,grantId:smallGrant}),/funding amount or nonce invalid/);
   await assert.rejects(fundLocalReservation({client:funder,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,minter:operator,reservationId:row.id,grantId}),/Funding signer or session mismatch/);
   await assert.rejects(funder.query('SELECT encrypted_private_key FROM wallets LIMIT 1'),(e:any)=>e.code==='42501');
   await assert.rejects(funder.query('SELECT "b24_sign_lock"($1)',[row.id]),(e:any)=>e.code==='42501');
   await assert.rejects(funder.query('UPDATE "B24LocalFundingBudget" SET status=\'REVOKED\' WHERE id=$1',[fundingBudget]),(e:any)=>e.code==='42501');
   for(const runtime of [signerClient,funder,allowanceClient,receiptVerifier,preflight]){
    await assert.rejects(runtime.query('ALTER TABLE "V2Allocation" DISABLE TRIGGER ALL'),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('INSERT INTO "V2SettlementEvidence" DEFAULT VALUES'),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('SELECT encrypted_private_key FROM wallets LIMIT 1'),(e:any)=>e.code==='42501');
   }
   const fundingArgs={client:funder,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,minter:admin,reservationId:row.id,grantId};
   await assert.rejects(fundLocalReservation({...fundingArgs,recipient:operator.address}),/Funding terms must come from the approved reservation/);
   await assert.rejects(fundLocalReservation({...fundingArgs,tokenAddress:contractAddress}),/Funding terms must come from the approved reservation/);
   const fundingQuery=funder.query.bind(funder);let releaseFunding:any,signalFunding:any,fundingPaused=false,fundingSubmissionLost=false,fundingMarkLost=false;
   const fundingGate=new Promise<void>(r=>releaseFunding=r),fundingReached=new Promise<void>(r=>signalFunding=r);
   let fundingResults:any[];
   try{
    (funder as any).query=async(...args:any[])=>{if(!fundingSubmissionLost&&typeof args[0]==='string'&&args[0].includes('b24_submit_local_funding')){fundingSubmissionLost=true;throw Error('injected funding submission response loss');}if(fundingSubmissionLost&&!fundingMarkLost&&typeof args[0]==='string'&&args[0].includes('b24_mark_local_unresolved')){fundingMarkLost=true;throw Error('injected funding journal interruption');}const result=await fundingQuery(...args);if(!fundingPaused&&typeof args[0]==='string'&&args[0].includes('b24_lock_local_funding')){fundingPaused=true;signalFunding();await fundingGate;}return result;};
    const first=fundLocalReservation(fundingArgs);await fundingReached;
    const second=fundLocalReservation({...fundingArgs,client:otherFunder,preflightClient:thirdPreflight,receiptClient:otherReceipt});
    const budgetConflict=fundLocalReservation({client:budgetFunder,preflightClient:budgetPreflight,receiptClient:budgetReceipt,provider:ethers.provider,session:budgetSession,minter:admin,reservationId:budgetReservation.id,grantId:budgetGrant}).then(()=>null,(e:any)=>e);
    let waiting=false;for(let i=0;i<200;i++){const status=(await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[otherFunder.processID])).rows[0];if(status?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,25));}expect(waiting).eq(true);
    let budgetWaiting=false;for(let i=0;i<200;i++){const status=(await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[budgetFunder.processID])).rows[0];if(status?.wait_event_type==='Lock'){budgetWaiting=true;break;}await new Promise(r=>setTimeout(r,25));}expect(budgetWaiting).eq(true);
    releaseFunding();fundingResults=await Promise.all([first,second]);expect((await budgetConflict)?.message).matches(/shared funding budget (has unresolved operation|exceeded)/);
   }finally{releaseFunding();(funder as any).query=fundingQuery;}
   expect(fundingSubmissionLost).eq(true);expect(fundingMarkLost).eq(true);
   expect(fundingResults.every((x:any)=>['VERIFIED','UNRESOLVED'].includes(x.state))).eq(true);expect(new Set(fundingResults.map((x:any)=>x.operationId)).size).eq(1);
   const funding=await fundLocalReservation(fundingArgs);expect(funding.state).eq('VERIFIED');
   const fundingStates=(await owner.query('SELECT state FROM "B24OperationEvent" WHERE "fundingOperationId"=$1 ORDER BY sequence',[funding.operationId])).rows.map((x:any)=>x.state);expect(fundingStates).deep.eq(['UNRESOLVED','SUBMITTED','VERIFIED']);
   await assert.rejects(fundLocalReservation({client:budgetFunder,preflightClient:budgetPreflight,receiptClient:budgetReceipt,provider:ethers.provider,session:budgetSession,minter:admin,reservationId:budgetReservation.id,grantId:budgetGrant}),/shared funding budget exceeded/);
   expect((await owner.query('SELECT count(*)::int n FROM "B24FundingSubmission" WHERE "reservationId"=$1',[budgetReservation.id])).rows[0].n).eq(0);
   // A hung local sender must time out without resubmitting its reserved nonce.
   const hungMinter=ethers.Wallet.createRandom().address,hungBudget=randomUUID(),hungGrant=randomUUID();
   await (await token.grantRole(await token.MINTER_ROLE(),hungMinter)).wait();
   await approver.query('INSERT INTO "B24LocalFundingBudget"(id,"buyerAddress","tokenAddress","minterAddress","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$5,\'ignored\')',[hungBudget,buyer.address.toLowerCase(),tokenAddress,hungMinter.toLowerCase(),budgetAllocation.amountBaseUnits]);
   await approver.query('INSERT INTO "B24LocalFundingGrant"(id,"sessionId","minterAddress","perOperationLimit","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$4,\'ignored\')',[hungGrant,budgetSession.id,hungMinter.toLowerCase(),budgetAllocation.amountBaseUnits]);
   await approver.query('INSERT INTO "B24LocalFundingBudgetGrant"("grantId","budgetId") VALUES($1,$2)',[hungGrant,hungBudget]);
   let hungAttempts=0;const hungRunner={provider:ethers.provider,getAddress:async()=>hungMinter,sendTransaction:async()=>{hungAttempts++;return new Promise(()=>{});}};
   const hungArgs={client:budgetFunder,preflightClient:budgetPreflight,receiptClient:budgetReceipt,provider:ethers.provider,session:budgetSession,minter:hungRunner,reservationId:budgetReservation.id,grantId:hungGrant};
   const hung=await fundLocalReservation(hungArgs);expect(hung.state).eq('UNRESOLVED');expect(hungAttempts).eq(1);
   const hungRetry=await fundLocalReservation(hungArgs);expect(hungRetry.state).eq('UNRESOLVED');expect(hungRetry.operationId).eq(hung.operationId);expect(hungAttempts).eq(1);
   expect((await owner.query('SELECT state FROM "B24OperationEvent" WHERE "fundingOperationId"=$1 ORDER BY sequence DESC LIMIT 1',[hung.operationId])).rows[0].state).eq('UNRESOLVED');
   const fundingRetry=await fundLocalReservation({client:funder,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,minter:admin,reservationId:row.id,grantId});expect(fundingRetry.state).eq('VERIFIED');expect(fundingRetry.operationId).eq(funding.operationId);expect(fundingRetry.reused).eq(true);
   const fundingEvent=(await owner.query('SELECT "txHash" FROM "B24OperationEvent" WHERE "fundingOperationId"=$1 AND state=\'SUBMITTED\'',[funding.operationId])).rows[0];const mintReceipt=await ethers.provider.getTransactionReceipt(fundingEvent.txHash);expect(mintReceipt?.status).eq(1);expect(await token.balanceOf(buyer.address)).eq(2541n);
   expect((await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session})).state).eq('ALLOWANCE_REQUIRED');
   await assert.rejects(setLocalAllowance({client:evaluator,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,registry,reservationId:row.id}),/Refusing non-disposable allowance target/);
   const allowanceArgs={client:allowanceClient,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,registry,reservationId:row.id};
   await assert.rejects(setLocalAllowance({...allowanceArgs,spender:operator.address}),/Allowance terms must come from the approved reservation/);
   await assert.rejects(setLocalAllowance({...allowanceArgs,amountBaseUnits:'999999'}),/Allowance terms must come from the approved reservation/);
   await assert.rejects(setLocalAllowance({...allowanceArgs,revoke:'false'}),/Allowance terms must come from the approved reservation/);
   const allowanceQuery=allowanceClient.query.bind(allowanceClient);let releaseAllowance:any,signalAllowance:any,allowancePaused=false,allowanceSubmissionLost=false,allowanceMarkLost=false;
   const allowanceGate=new Promise<void>(r=>releaseAllowance=r),allowanceReached=new Promise<void>(r=>signalAllowance=r);
   let allowanceResults:any[];
   try{
    (allowanceClient as any).query=async(...args:any[])=>{if(!allowanceSubmissionLost&&typeof args[0]==='string'&&args[0].includes('b24_submit_local_allowance')){allowanceSubmissionLost=true;throw Error('injected allowance submission response loss');}if(allowanceSubmissionLost&&!allowanceMarkLost&&typeof args[0]==='string'&&args[0].includes('b24_mark_local_unresolved')){allowanceMarkLost=true;throw Error('injected allowance journal interruption');}const result=await allowanceQuery(...args);if(!allowancePaused&&typeof args[0]==='string'&&args[0].includes('b24_lock_local_allowance')){allowancePaused=true;signalAllowance();await allowanceGate;}return result;};
    const first=setLocalAllowance(allowanceArgs);await allowanceReached;
    const second=setLocalAllowance({...allowanceArgs,client:otherAllowance,preflightClient:thirdPreflight,receiptClient:otherReceipt});
    const conflict=setLocalAllowance({...allowanceArgs,client:conflictingAllowance,preflightClient:otherPreflight,receiptClient:otherReceipt,revoke:true}).then(()=>null,(e:any)=>e);
    const otherMarket=setLocalAllowance({client:budgetAllowance,preflightClient:budgetPreflight,receiptClient:budgetReceipt,provider:ethers.provider,session:budgetSession,registry,reservationId:budgetReservation.id}).then(()=>null,(e:any)=>e);
    let waiting=false;for(let i=0;i<200;i++){const status=(await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[otherAllowance.processID])).rows[0];if(status?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,25));}expect(waiting).eq(true);
    let domainWaiting=false;for(let i=0;i<200;i++){const status=(await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[budgetAllowance.processID])).rows[0];if(status?.wait_event_type==='Lock'){domainWaiting=true;break;}await new Promise(r=>setTimeout(r,25));}expect(domainWaiting).eq(true);
    expect((await inspectLocalReadiness(budgetPreflight,{reservationId:budgetReservation.id,provider:ethers.provider,session:budgetSession})).state).eq('UNRESOLVED');
    releaseAllowance();allowanceResults=await Promise.all([first,second]);expect((await conflict)?.message).contains('allowance operation unresolved');expect((await otherMarket)?.message).contains('allowance operation unresolved');
   }finally{releaseAllowance();(allowanceClient as any).query=allowanceQuery;}
   expect(allowanceSubmissionLost).eq(true);expect(allowanceMarkLost).eq(true);
   expect(allowanceResults.every((x:any)=>['VERIFIED','UNRESOLVED'].includes(x.state))).eq(true);expect(new Set(allowanceResults.map((x:any)=>x.operationId)).size).eq(1);
   const allowance=await setLocalAllowance(allowanceArgs);expect(allowance.state).eq('VERIFIED');
   const allowanceStates=(await owner.query('SELECT state FROM "B24OperationEvent" WHERE "allowanceOperationId"=$1 ORDER BY sequence',[allowance.operationId])).rows.map((x:any)=>x.state);expect(allowanceStates).deep.eq(['UNRESOLVED','SUBMITTED','VERIFIED']);
   const nonceRows=(await owner.query('SELECT kind,"senderAddress","senderNonce" FROM "B24LocalSenderNonce" WHERE "operationId" IN ($1,$2) ORDER BY kind',[allowance.operationId,funding.operationId])).rows;expect(nonceRows.length).eq(2);expect(nonceRows.map((x:any)=>x.kind)).deep.eq(['ALLOWANCE','FUNDING']);
   await assert.rejects(owner.query('UPDATE "B24LocalSenderNonce" SET "senderNonce"=9 WHERE kind=\'FUNDING\''),(e:any)=>e.message.includes('immutable'));
   await assert.rejects(allowanceClient.query('UPDATE "V2Allocation" SET status=\'CANCELLED\' WHERE id=$1',[allocation.allocationId]),(e:any)=>e.code==='42501');
   await assert.rejects(allowanceClient.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]),(e:any)=>e.code==='42501');
   await assert.rejects(allowanceClient.query('SELECT "b24_prepare_local_allowance"($1,$2,$3,$4)',[row.id,session.id,99,2542]),(e:any)=>e.message.includes('allowance authorization invalid'));
   await assert.rejects(funder.query('SELECT "b24_prepare_local_allowance"($1,$2,$3,$4)',[row.id,session.id,99,2541]),(e:any)=>e.code==='42501');
   await assert.rejects(owner.query('INSERT INTO "B24LocalSenderNonce"("senderAddress","senderNonce",kind,"operationId") VALUES($1,$2,\'ALLOWANCE\',$3)',[nonceRows[1].senderAddress,nonceRows[1].senderNonce,randomUUID()]),(e:any)=>e.code==='23505');
   await assert.rejects(preflight.query('INSERT INTO "B24OperationEvent"(id,"allowanceOperationId",sequence,state,actor) VALUES($1,$2,99,\'FAILED\',\'ignored\')',[randomUUID(),allowance.operationId]),(e:any)=>e.code==='42501');
   const allowanceRetry=await setLocalAllowance({client:allowanceClient,preflightClient:preflight,receiptClient:receiptVerifier,provider:ethers.provider,session,registry,reservationId:row.id});expect(allowanceRetry.state).eq('VERIFIED');expect(allowanceRetry.operationId).eq(allowance.operationId);expect(allowanceRetry.reused).eq(true);
   const allowanceEvent=(await owner.query('SELECT "txHash" FROM "B24OperationEvent" WHERE "allowanceOperationId"=$1 AND state=\'SUBMITTED\'',[allowance.operationId])).rows[0];const approvalReceipt=await ethers.provider.getTransactionReceipt(allowanceEvent.txHash);expect(approvalReceipt?.status).eq(1);expect(await token.allowance(buyer.address,contractAddress)).eq(2541n);
   const badFunding=randomUUID();
   for(const [id,table,key] of [[badFunding,'B24FundingOperation','bad-funding']]){
    await owner.query(`INSERT INTO "${table}"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES($1,$2,$3,'fixture',2541,$4)`,[id,row.id,key,session.id]);
   }
   for(const [id,column,hash] of [[badFunding,'fundingOperationId',approvalReceipt!.hash]]){
    await owner.query(`INSERT INTO "B24OperationEvent"(id,"${column}",sequence,state,actor,"txHash") VALUES($1,$2,1,'SUBMITTED','fixture',$3)`,[randomUUID(),id,hash.toLowerCase()]);
   }
   await assert.rejects(verifyLocalReceipt({client:receiptVerifier,preflightClient:preflight,provider:ethers.provider,session,kind:'FUNDING',operationId:badFunding}),/Receipt context invalid/);
   expect((await owner.query('SELECT count(*)::int n FROM "B24ReceiptEvidence" WHERE "fundingOperationId"=$1',[badFunding])).rows[0].n).eq(0);
   await assert.rejects(verifyLocalReceipt({client:evaluator,preflightClient:preflight,provider:ethers.provider,session,kind:'FUNDING',operationId:funding.operationId}),/Refusing non-disposable receipt verifier/);
   expect((await verifyLocalReceipt({client:receiptVerifier,provider:ethers.provider,session,kind:'ALLOWANCE',operationId:allowance.operationId})).rechecked).eq(true);
   expect((await verifyLocalReceipt({client:receiptVerifier,provider:ethers.provider,session,kind:'FUNDING',operationId:funding.operationId})).rechecked).eq(true);
   const fundedReadiness=await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session});expect(fundedReadiness.state).eq('READY_FOR_LOCAL_SETTLEMENT');expect(fundedReadiness.balanceBaseUnits).eq('2541');expect(fundedReadiness.allowanceBaseUnits).eq('2541');expect(fundedReadiness.realHederaExecutionAuthorized).eq(false);
   const readinessQuery=preflight.query.bind(preflight);
   try{
    (preflight as any).query=async(...args:any[])=>{const result=await readinessQuery(...args);if(typeof args[0]==='string'&&args[0].includes('b24_local_readiness_evidence'))result.rows[0].evidence.signature='0x'+'00'.repeat(65);return result;};
    const corrupt=await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session});expect(corrupt.state).eq('BLOCKED');expect(corrupt.reason).eq('INVALID_SIGNATURE');
    (preflight as any).query=async(...args:any[])=>{const result=await readinessQuery(...args);if(typeof args[0]==='string'&&args[0].includes('b24_local_readiness_evidence'))result.rows[0].evidence.allowanceReceipt.txHash='0x'+'0'.repeat(64);return result;};
    const stale=await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session});expect(stale.state).eq('UNRESOLVED');expect(stale.reason).eq('RECEIPT_NOT_CANONICAL');
    (preflight as any).query=async(...args:any[])=>{const result=await readinessQuery(...args);if(typeof args[0]==='string'&&args[0].includes('b24_local_readiness_evidence'))result.rows[0].evidence.fundingReceipt.senderNonce='999';return result;};
    const wrongNonce=await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session});expect(wrongNonce.state).eq('UNRESOLVED');expect(wrongNonce.reason).eq('RECEIPT_NOT_CANONICAL');
   }finally{(preflight as any).query=readinessQuery;}
   expect(await token.balanceOf(buyer.address)).eq(2541n);expect(await token.allowance(buyer.address,contractAddress)).eq(2541n);
   const seller=built.terms.seller,old=await token.balanceOf(seller);const receipt=await (await contract.connect(operator).settle(built.terms,signature)).wait();expect(receipt.status).eq(1);const events=receipt.logs.map((l:any)=>{try{return contract.interface.parseLog(l)?.name;}catch{return null;}});expect(events).includes('EnergyPaymentSettled');const transfers=receipt.logs.map((l:any)=>{try{return token.interface.parseLog(l);}catch{return null;}}).filter((x:any)=>x?.name==='Transfer');expect(transfers.length).eq(1);expect(transfers[0].args.value).eq(2541n);expect(await token.balanceOf(buyer.address)).eq(0n);expect(await token.balanceOf(seller)).eq(old+2541n);expect(await token.balanceOf(contractAddress)).eq(0n);await expect(contract.connect(operator).settle(built.terms,signature)).to.be.revertedWithCustomError(contract,'Replay');const afterSettlement=await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session});expect(afterSettlement.state).eq('BLOCKED');expect(afterSettlement.reason).eq('ALREADY_SETTLED');
   const counts=(await owner.query('SELECT (SELECT count(*)::int FROM "B24AuthorizationReservation") reservations,(SELECT count(*)::int FROM "V2SettlementIntent") intents,(SELECT count(*)::int FROM "V2SettlementAttempt") attempts,(SELECT count(*)::int FROM "V2SettlementEvidence") evidence,(SELECT count(*)::int FROM "B24FundingSubmission" WHERE "reservationId"=$1) funding,(SELECT count(*)::int FROM "B24AllowanceSubmission" WHERE "reservationId"=$1 AND "targetAmount">0) approvals',[row.id])).rows[0];expect(counts).deep.eq({reservations:2,intents:0,attempts:0,evidence:0,funding:1,approvals:1});

   // Simulate a lost receipt after a service-issued allowance reduction.
   const beforeRecoveryQuery=receiptVerifier.query.bind(receiptVerifier);let recoveryReceiptLost=false,recoveryOperation:any;
   try{
    (receiptVerifier as any).query=async(...args:any[])=>{if(!recoveryReceiptLost&&typeof args[0]==='string'&&args[0].includes('b24_local_receipt_context')){recoveryReceiptLost=true;throw Error('injected recovery receipt loss');}return beforeRecoveryQuery(...args);};
    recoveryOperation=await setLocalAllowance({...allowanceArgs,revoke:true});expect(recoveryOperation.state).eq('UNRESOLVED');expect(recoveryReceiptLost).eq(true);
   }finally{(receiptVerifier as any).query=beforeRecoveryQuery;}

   // A separate approver session attempts revocation while the signer holds the policy lock.
   const signerQuery=signerClient.query.bind(signerClient);let release:any,signal:any,paused=false;
   const gate=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>signal=r);
   try{
    (signerClient as any).query=async(...args:any[])=>{const result=await signerQuery(...args);if(!paused&&typeof args[0]==='string'&&args[0].includes('b24_sign_lock')){paused=true;signal();await gate;}return result;};
    const pending=signing.signReservation(row.id).then((value:any)=>({value}),(error:any)=>({error}));await reached;
    const revocation=approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]);
    let waiting=false;for(let i=0;i<200;i++){const status=(await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[approver.processID])).rows[0];if(status?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,25));}expect(waiting).eq(true);
    release();await revocation;const result=await pending;expect(result.error?.message).contains('signing authorization invalid');
   }finally{release();(signerClient as any).query=signerQuery;}
   expect((await owner.query('SELECT count(*)::int n FROM "B24SignedAuthorization" WHERE "reservationId"=$1',[row.id])).rows[0].n).eq(1);
   await assert.rejects(signing.signReservation(row.id),/POLICY_REVOKED/);
   await assert.rejects(signerClient.query('SELECT "b24_sign_lookup"($1)',[row.id]),/signing authorization invalid/);
   await approver.query('UPDATE "B24Deployment" SET status=\'RETIRED\' WHERE id=$1',[deployment]);
   await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[budgetPolicy]);
   const restoredBudgetSession=await restoreLocalChainSession(budgetPreflight,{sessionId:budgetSession.id,provider:ethers.provider});
   expect((await recoverLocalOperation({client:budgetFunder,receiptClient:budgetReceipt,provider:ethers.provider,session:restoredBudgetSession,kind:'FUNDING',operationId:hung.operationId})).state).eq('UNRESOLVED');expect(hungAttempts).eq(1);
   await assert.rejects(setLocalAllowance(allowanceArgs),/Allowance preflight blocked/);
   const restored=await restoreLocalChainSession(preflight,{sessionId:session.id,provider:ethers.provider});
   expect((await recoverLocalOperation({client:funder,receiptClient:receiptVerifier,provider:ethers.provider,session:restored,kind:'FUNDING',operationId:funding.operationId})).state).eq('VERIFIED');
   await assert.rejects(recoverLocalOperation({client:evaluator,receiptClient:receiptVerifier,provider:ethers.provider,session:restored,kind:'FUNDING',operationId:funding.operationId}),/Refusing non-disposable recovery target/);
   const recovered=await recoverLocalOperation({client:allowanceClient,receiptClient:receiptVerifier,provider:ethers.provider,session:restored,kind:'ALLOWANCE',operationId:recoveryOperation.operationId});expect(recovered.state).eq('VERIFIED');
   const revokedAllowance=await setLocalAllowance({...allowanceArgs,revoke:true});expect(revokedAllowance.state).eq('VERIFIED');expect(await token.allowance(buyer.address,contractAddress)).eq(0n);
   expect((await owner.query('SELECT count(*)::int n FROM "B24ReceiptEvidence" WHERE "allowanceOperationId"=$1',[recoveryOperation.operationId])).rows[0].n).eq(1);
   await ethers.provider.send('evm_revert',[beforeLocalTransactions]);
   const afterReorg=await restoreLocalChainSession(preflight,{sessionId:session.id,provider:ethers.provider});
   expect((await recoverLocalOperation({client:funder,receiptClient:receiptVerifier,provider:ethers.provider,session:afterReorg,kind:'FUNDING',operationId:funding.operationId})).state).eq('UNRESOLVED');
   expect(await token.balanceOf(buyer.address)).eq(0n);

   console.log(JSON.stringify({state:'OFFLINE_SERVICE_WORKFLOW_TEST',market:plan.marketId,snapshot:snapshot.snapshotId,plan:plan.planId,allocation:allocation.allocationId,reservation:row.id,buyer:buyer.address,seller, snapshotHash:built.terms.snapshotHash,planCommitment:row.planCommitment,nonce:row.nonce,token:tokenAddress,contract:contractAddress,mintTx:mintReceipt.hash,approvalTx:approvalReceipt.hash,settlementTx:receipt.hash,settlementId:row.settlementId,quantityWh:'28',price:'90750',amountBaseUnits:'2541'}));
  }finally{await Promise.allSettled(clients.map(c=>c.end()));}
 });
});
