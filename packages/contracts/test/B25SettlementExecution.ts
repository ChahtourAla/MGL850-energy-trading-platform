import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {reconcileLocalMarket} from '../../../apps/backend/scripts/b25-settlement-reconciliation.mjs';
import {recoverLocalSettlement} from '../../../apps/backend/scripts/b25-settlement-recovery.mjs';
import {createLocalSettlementIntent} from '../../../apps/backend/scripts/b25-settlement-intent.mjs';
import {createLocalOperatorRegistry,executeLocalSettlement} from '../../../apps/backend/scripts/b25-settlement-executor.mjs';
import {inspectSettlementReceipt,verifyAndRecordLocalSettlement} from '../../../apps/backend/scripts/b25-settlement-receipt.mjs';
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

describe('B25 database-bound local settlement',function(){
 this.timeout(300000);
 it('binds a newly enrolled ephemeral buyer to B22, B24-A1 and B23',async function(){
  if(process.env.B24_A2_TEST!=='1'){this.skip();return;}
  const urls=['B22_TEST_DATABASE_URL','B22_ROSTER_DATABASE_URL','B22_INGEST_DATABASE_URL','B22_MATCH_DATABASE_URL','B24_APPROVER_DATABASE_URL','B24_EVALUATOR_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_SIGNER_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_SIGNER_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B25_EXECUTOR_DATABASE_URL','B25_VERIFIER_DATABASE_URL','B25_REPORTER_DATABASE_URL','B25_EXECUTOR_DATABASE_URL','B25_VERIFIER_DATABASE_URL'];
  for(const name of urls){const u=new URL(process.env[name]!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/b22_disposable_review')throw Error('unsafe database');}
  const clients=urls.map(name=>new Client({connectionString:process.env[name]}));await Promise.all(clients.map(c=>c.connect()));
  const [owner,roster,ingest,matcher,approver,evaluator,preflight,signerClient,otherPreflight,otherSigner,receiptVerifier,funder,allowanceClient,otherFunder,otherAllowance,thirdPreflight,otherReceipt,conflictingAllowance,budgetFunder,budgetPreflight,budgetReceipt,budgetAllowance,b25executor,b25verifier,b25reporter,b25otherExecutor,b25otherVerifier]=clients;
  try{
   for(const runtime of [b25executor,b25verifier,b25reporter]){
    await assert.rejects(runtime.query('SELECT encrypted_private_key FROM wallets LIMIT 1'),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('ALTER TABLE "V2Allocation" DISABLE TRIGGER ALL'),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('UPDATE "V2Allocation" SET status=\'CANCELLED\''),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\''),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('INSERT INTO "B25LocalAttempt" DEFAULT VALUES'),(e:any)=>e.code==='42501');
   }
   for(const runtime of [evaluator,preflight,signerClient,funder,allowanceClient,receiptVerifier]){
    await assert.rejects(runtime.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),randomUUID(),'REVERTED','0x'+'00'.repeat(32),0,null,null,null]),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query('SELECT "b25_prepare_local_attempt"($1,$2,$3,$4,$5,$6,$7)',['0x'+'00'.repeat(32),randomUUID(),randomUUID(),'0x'+'00'.repeat(20),0,'0x'+'00'.repeat(32),'0x'+'00'.repeat(32)]),(e:any)=>e.code==='42501');
   }
   // Audit every B25 SECURITY DEFINER function, its fixed search path, public
   // privilege, and the runtime roles that can invoke it.
   const grants:Record<string,string[]>={
    b25_create_local_intent:['b25_executor'],b25_local_context:['b25_executor'],
    b25_prepare_local_attempt:['b25_executor'],b25_lock_local_submission:['b25_executor'],
    b25_authorize_handoff:['b25_executor'],b25_receipt_context:['b25_verifier'],
    b25_record_nonce_conflict:['b25_verifier'],b25_record_outcome:['b25_verifier'],
    b25_record_local_evidence:[],b25_mark_noncanonical:[],b25_record_revert:[]
   };
   const functions=(await owner.query(`SELECT p.proname,p.prosrc,array_to_string(p.proconfig,',') config,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute,
    has_function_privilege('b25_executor',p.oid,'EXECUTE') executor,
    has_function_privilege('b25_verifier',p.oid,'EXECUTE') verifier,
    has_function_privilege('b25_reporter',p.oid,'EXECUTE') reporter
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'b25_%' AND p.prosecdef ORDER BY p.proname`)).rows;
   expect(functions.length).eq(Object.keys(grants).length);
   for(const fn of functions){
    expect(grants[fn.proname],fn.proname).not.eq(undefined);expect(fn.config,fn.proname).matches(/search_path=pg_catalog, ?public/);expect(fn.public_execute,fn.proname).eq(false);
    for(const role of ['executor','verifier','reporter'])expect(fn[role],`${fn.proname}:${role}`).eq(grants[fn.proname].includes(`b25_${role}`));
    if(fn.proname==='b25_authorize_handoff')expect(fn.prosrc).contains('b25_lock_local_submission');
    else{expect(fn.prosrc,fn.proname).contains('session_user');expect(fn.prosrc,fn.proname).contains('b22_guard.marker');}
    if(!['b25_local_context','b25_receipt_context'].includes(fn.proname))expect(fn.prosrc,fn.proname).matches(/FOR UPDATE|b25_lock_local_submission/i);
   }
   for(const role of ['b24_evaluator','b24_preflight','b24_signer','b24_funder','b24_allowance','b24_receipt_verifier'])for(const target of ['b25_executor','b25_verifier','b25_reporter'])expect((await owner.query(`SELECT pg_has_role($1,$2,'MEMBER') member`,[role,target])).rows[0].member,`${role}:${target}`).eq(false);
   for(const runtime of [b25executor,b25verifier,b25reporter]){
    await assert.rejects(runtime.query('DELETE FROM "B25CanonicalOutcomeEvent"'),(e:any)=>e.code==='42501');
    await assert.rejects(runtime.query(`UPDATE "V2SettlementIntent" SET status='CONFIRMED'`),(e:any)=>e.code==='42501');
   }
   const missingAttempt=randomUUID(),missingIntent='0x'+'00'.repeat(32),missingSession=randomUUID(),badHash='0x'+'00'.repeat(32);
   for(const [runtime,sql,args,reason] of [
    [b25executor,'SELECT "b25_create_local_intent"($1,$2,$3)',[randomUUID(),missingSession,missingIntent],/B25 reservation or authorization invalid/],
    [b25executor,'SELECT "b25_local_context"($1)',[missingIntent],/B25 intent missing/],
    [b25executor,'SELECT "b25_prepare_local_attempt"($1,$2,$3,$4,$5,$6,$7)',[missingIntent,missingAttempt,missingSession,'0x'+'00'.repeat(20),0,badHash,badHash],/B25 authorization expired or changed/],
    [b25executor,'SELECT "b25_lock_local_submission"($1)',[missingAttempt],/B25 authorization expired or changed/],
    [b25executor,'SELECT "b25_authorize_handoff"($1)',[missingAttempt],/B25 authorization expired or changed/],
    [b25verifier,'SELECT "b25_receipt_context"($1)',[missingAttempt],/B25 attempt missing/],
    [b25verifier,'SELECT "b25_record_nonce_conflict"($1,$2,$3)',[missingAttempt,randomUUID(),badHash],/Invalid B25 nonce conflict/],
    [b25verifier,'SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[missingAttempt,randomUUID(),'REVERTED',badHash,0,null,null,null],/Invalid B25 outcome identity/]
   ] as any[])await assert.rejects(runtime.query(sql,args),reason);
   await assert.rejects(b25verifier.query('SELECT "b25_authorize_handoff"($1)',[randomUUID()]),(e:any)=>e.code==='42501');
   await assert.rejects(b25reporter.query('SELECT "b25_record_revert"($1,$2,$3,$4)',[randomUUID(),randomUUID(),'0x'+'00'.repeat(32),0]),(e:any)=>e.code==='42501');
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
   await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,2541,2541,now()-interval \'1 minute\',now()+make_interval(secs=>$7),\'ACTIVE\',\'SIMULATED_TEST\',1,\'ignored\',\'synthetic only\')',[policy,allocation.buyerId,buyer.address.toLowerCase(),deployment,tokenAddress,plan.marketId,process.env.B25_TEST_EXPIRED==='1'?90:3600]);
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
   const localOperator=await createLocalOperatorRegistry({client:b25executor,provider:ethers.provider});
   await (await admin.sendTransaction({to:localOperator.address,value:ethers.parseEther('1')})).wait();
   await (await contract.connect(admin).grantRole(await contract.OPERATOR_ROLE(),localOperator.address)).wait();
   const competingOperator=await createLocalOperatorRegistry({client:b25otherExecutor,provider:ethers.provider});
   await (await admin.sendTransaction({to:competingOperator.address,value:ethers.parseEther('1')})).wait();
   await (await contract.connect(admin).grantRole(await contract.OPERATOR_ROLE(),competingOperator.address)).wait();
   await assert.rejects(createLocalSettlementIntent({client:evaluator,preflightClient:preflight,reservationId:row.id,provider:ethers.provider,session}),/Refusing non-disposable B25 executor/);
   const intent=await createLocalSettlementIntent({client:b25executor,preflightClient:preflight,reservationId:row.id,provider:ethers.provider,session});expect(intent.state).eq('PLANNED');
   const replayIntent=await createLocalSettlementIntent({client:b25executor,preflightClient:preflight,reservationId:row.id,provider:ethers.provider,session});expect(replayIntent.reused).eq(true);expect(replayIntent.intentId).eq(intent.intentId);
   if(process.env.B25_TEST_RETIRED_SESSION==='1'){
    await retireLocalChainSession(session,approver);
    await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/Unknown or mismatched local chain session|Local chain session retired/);
    expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);return;
   }
   if(process.env.B25_TEST_EXPIRED==='1'){
    const delay=Math.max(0,new Date(row.deadline).getTime()-Date.now()+1100);await new Promise(resolve=>setTimeout(resolve,delay));
    await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/B25 preflight blocked/);
    expect((await owner.query('SELECT count(*)::int n FROM \"B25LocalAttempt\" WHERE \"intentId\"=$1',[intent.intentId])).rows[0].n).eq(0);return;
   }
   // Corrupt the executor's database-read boundary, without altering archived facts.
   const contextQuery=b25executor.query.bind(b25executor);
   const attacks:[string,(x:any)=>void,RegExp][]=[
    ['signature',x=>x.signature='0x'+'00'.repeat(65),/B25 signature invalid/],
    ['buyer',x=>x.buyerAddress=admin.address,/B25 signature invalid/],
    ['seller',x=>x.terms.terms.seller=admin.address,/B25 signature invalid/],
    ['quantity',x=>x.terms.terms.quantityWh='29',/B25 signature invalid/],
    ['price',x=>x.terms.terms.unitPriceMicrousdPerKwh='90751',/B25 signature invalid/],
    ['amount',x=>x.terms.terms.amountBaseUnits='2542',/B25 signature invalid/],
    ['market',x=>x.terms.terms.marketId='0x'+'ab'.repeat(32),/B25 signature invalid/],
    ['snapshot',x=>x.terms.terms.snapshotHash='0x'+'ab'.repeat(32),/B25 signature invalid/],
    ['domain',x=>x.terms.domain.chainId='1',/B25 signature invalid/],
    ['domain-contract',x=>x.terms.domain.verifyingContract=admin.address,/B25 signature invalid/],
    ['token',x=>x.tokenAddress=admin.address,/Unknown or mismatched local chain session/],
    ['contract',x=>x.contractAddress=tokenAddress,/Unknown or mismatched local chain session/]
   ];
   try{
    for(const [name,mutate,reason] of attacks){
     (b25executor as any).query=async(...args:any[])=>{const q=await contextQuery(...args);if(typeof args[0]==='string'&&args[0].includes('b25_local_context')){q.rows[0].context=structuredClone(q.rows[0].context);mutate(q.rows[0].context);}return q;};
     await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),reason,name);
     expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n,name).eq(0);
    }
   }finally{(b25executor as any).query=contextQuery;}

   await assert.rejects(executeLocalSettlement({client:evaluator,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/Refusing non-disposable B25 executor/);
   await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session:{},registry:localOperator,intentId:intent.intentId}),/B25 intent context invalid/);
   const savedCode=await ethers.provider.getCode(contractAddress);
   try{const altered=savedCode.slice(0,18)+(savedCode.slice(18,20)==='00'?'01':'00')+savedCode.slice(20);await ethers.provider.send('hardhat_setCode',[contractAddress,altered]);await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/Local runtime code mismatch/);}finally{await ethers.provider.send('hardhat_setCode',[contractAddress,savedCode]);}
   expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
   // Independently exercise B25's balance and allowance gates against local ERC-20 state.
   for(const kind of ['balance','allowance']){
    const checkpoint=await ethers.provider.send('evm_snapshot',[]);
    try{
     await ethers.provider.send('hardhat_impersonateAccount',[buyer.address]);
     const localBuyer=await ethers.getSigner(buyer.address);
     if(kind==='balance')await (await token.connect(localBuyer).transfer(admin.address,2541n)).wait();
     else await (await token.connect(localBuyer).approve(contractAddress,0n)).wait();
     await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),new RegExp(`B25 readiness blocked: ${kind==='balance'?'FUNDING_REQUIRED':'ALLOWANCE_REQUIRED'}`));
     expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
    }finally{await ethers.provider.send('hardhat_stopImpersonatingAccount',[buyer.address]);await ethers.provider.send('evm_revert',[checkpoint]);}
   }

   // Feed the executor specific conflicting replay-state reads without writing
   // to the local chain; all other reads use the real deployed contracts.
   for(const method of ['usedNonces','executedSettlements','paidAllocations']){
    const call=ethers.provider.call.bind(ethers.provider),selector=contract.interface.getFunction(method).selector;
    try{
     (ethers.provider as any).call=async(...args:any[])=>String(args[0]?.data??'').startsWith(selector)?ethers.AbiCoder.defaultAbiCoder().encode(['bool'],[true]):call(...args);
     await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),method==='paidAllocations'?/B25 readiness blocked: BLOCKED/:/B25 on-chain preflight blocked/);
     expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
    }finally{(ethers.provider as any).call=call;}
   }
   expect(await contract.usedNonces(buyer.address,built.terms.nonce)).eq(false);expect(await contract.paidAllocations(built.terms.allocationId)).eq(false);
   const unauthorizedOperator=await createLocalOperatorRegistry({client:b25executor,provider:ethers.provider});
   await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:unauthorizedOperator,intentId:intent.intentId}),/B25 on-chain preflight blocked/);
   await (await contract.connect(pauser).pause()).wait();
   try{await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/B25 on-chain preflight blocked/);}finally{await (await contract.connect(pauser).unpause()).wait();}
   expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);

   for(const method of ['getNetwork','getCode','getFeeData']){
    const original=(ethers.provider as any)[method].bind(ethers.provider);
    try{
     (ethers.provider as any)[method]=async()=>{throw Error(`injected ${method} RPC failure`);};
     await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),new RegExp(`injected ${method} RPC failure`));
     expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
    }finally{(ethers.provider as any)[method]=original;}
   }
   if(process.env.B25_TEST_EXECUTOR_TIMEOUT==='1'){
    for(const method of ['getNetwork','getCode','getTransactionCount','getFeeData']){
     const original=(ethers.provider as any)[method].bind(ethers.provider);
     try{
      (ethers.provider as any)[method]=()=>new Promise(()=>{});
      await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/Local operation timed out/);
      expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
     }finally{(ethers.provider as any)[method]=original;}
    }
    for(const method of ['OPERATOR_ROLE','paused','usedNonces','paidAllocations']){
     const original=ethers.provider.call.bind(ethers.provider),selector=contract.interface.getFunction(method).selector;
     try{
      (ethers.provider as any).call=(...args:any[])=>String(args[0]?.data??'').startsWith(selector)?new Promise(()=>{}):original(...args);
      await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/Local operation timed out|B25 readiness blocked: UNRESOLVED/);
      expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
     }finally{(ethers.provider as any).call=original;}
    }
   }
   // Test the controlled operator's local signing boundary without exposing its key.
   const signTransaction=ethers.BaseWallet.prototype.signTransaction;
   try{
    (ethers.BaseWallet.prototype as any).signTransaction=async()=>{throw Error('injected local signing failure');};
    await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/injected local signing failure/);
    expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
    if(process.env.B25_TEST_SIGN_TIMEOUT==='1'){
     (ethers.BaseWallet.prototype as any).signTransaction=()=>new Promise(()=>{});
     await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/Local operation timed out/);
     expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
    }
   }finally{(ethers.BaseWallet.prototype as any).signTransaction=signTransaction;}
   const nonceQuery=ethers.provider.getTransactionCount.bind(ethers.provider);
   try{(ethers.provider as any).getTransactionCount=async()=>{throw Error('injected operator nonce RPC failure');};await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/injected operator nonce RPC failure/);}finally{(ethers.provider as any).getTransactionCount=nonceQuery;}
   for(const method of ['OPERATOR_ROLE','paused','usedNonces']){
    const call=ethers.provider.call.bind(ethers.provider),selector=contract.interface.getFunction(method).selector;
    try{
     (ethers.provider as any).call=async(...args:any[])=>{if(String(args[0]?.data??'').startsWith(selector))throw Error(`injected ${method} RPC failure`);return call(...args);};
     await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),new RegExp(`injected ${method} RPC failure|B25 readiness blocked: UNRESOLVED`));
     expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
    }finally{(ethers.provider as any).call=call;}
   }
   const onchainCall=ethers.provider.call.bind(ethers.provider);
   try{(ethers.provider as any).call=async(...args:any[])=>{if(String(args[0]?.data??'').startsWith(contract.interface.getFunction('paidAllocations').selector))throw Error('injected replay-state RPC failure');return onchainCall(...args);};await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/injected replay-state RPC failure/);}finally{(ethers.provider as any).call=onchainCall;}
   expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);
   if(process.env.B25_TEST_REVOKE_BEFORE_EXECUTE==='1'){
    await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]);
    await assert.rejects(executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId}),/B25 preflight blocked/);
    expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(0);return;
   }
   if(process.env.B25_PROCESS_CRASH_POINT){
    const sellerBalanceBefore=await token.balanceOf(built.terms.seller);
    const childPath=fileURLToPath(new URL('../../../tools/b25-restart-child.mjs',import.meta.url));
    const child=fork(childPath,[],{env:{...process.env,B25_CHILD_ACTION:'execute',B25_CRASH_POINT:process.env.B25_PROCESS_CRASH_POINT,B25_SESSION_ID:session.id,B25_INTENT_ID:intent.intentId},stdio:['ignore','ignore','pipe','ipc']});
    let childError='';child.stderr?.on('data',(b:any)=>{childError+=String(b);});
    const operatorInfo:any=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',code=>reject(Error(`executor exited before enrollment: ${code} ${childError}`)));});
    expect(operatorInfo.event).eq('operator');
    await (await admin.sendTransaction({to:operatorInfo.address,value:ethers.parseEther('1')})).wait();
    await (await contract.connect(admin).grantRole(await contract.OPERATOR_ROLE(),operatorInfo.address)).wait();
    const beforeRevert=process.env.B25_PROCESS_CRASH_POINT==='revert'?new Promise<any>(resolve=>child.once('message',resolve)):null;
    const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));child.send('start');
    if(beforeRevert){expect((await beforeRevert).event).eq('before-revert-broadcast');await (await contract.connect(pauser).pause()).wait();child.send('continue');}
    expect(await exited,childError).eq(77);
    const attempt=(await owner.query('SELECT * FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0];expect(attempt).not.eq(undefined);
    const handoffs=(await owner.query('SELECT count(*)::int n FROM "B25DispatchHandoff" WHERE "attemptId"=$1',[attempt.id])).rows[0].n;
    expect(handoffs).eq(process.env.B25_PROCESS_CRASH_POINT==='prepared'?0:1);
    const tx=await ethers.provider.getTransaction(attempt.transactionHash);
    expect(Boolean(tx)).eq(['broadcast','revert'].includes(process.env.B25_PROCESS_CRASH_POINT!));
    const recoverInNewProcess=async(crash=false)=>{
     const c=fork(childPath,[],{env:{...process.env,B25_CHILD_ACTION:crash?'recover-crash':'recover',B25_SESSION_ID:session.id,B25_ATTEMPT_ID:attempt.id},stdio:['ignore','ignore','pipe','ipc']});let errors='';c.stderr?.on('data',(b:any)=>{errors+=String(b);});
     let message:any; c.on('message',m=>{message=m;});const code=await new Promise<number|null>(resolve=>c.once('exit',resolve));expect(code,errors).eq(crash?78:0);return message;
    };
    if(['broadcast','revert'].includes(process.env.B25_PROCESS_CRASH_POINT!))await recoverInNewProcess(true);
    const recovered=await recoverInNewProcess();expect(recovered.event).eq('result');
    if(process.env.B25_PROCESS_CRASH_POINT==='revert'){
     expect(recovered.state).eq('REVERTED_LOCAL');expect((await recoverInNewProcess()).state).eq('REVERTED_LOCAL');
     expect(await token.balanceOf(built.terms.seller)).eq(sellerBalanceBefore);expect(await token.balanceOf(buyer.address)).eq(2541n);expect(await token.balanceOf(contractAddress)).eq(0n);
     const failedReport=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});expect(failedReport.failed).eq(1);expect(failedReport.verifiedPaidBaseUnits).eq('0');expect(failedReport.unpaidBaseUnits).eq('2541');
     expect((await owner.query('SELECT count(*)::int n FROM "B25RevertEvidence" WHERE "attemptId"=$1',[attempt.id])).rows[0].n).eq(1);
     expect((await owner.query('SELECT count(*)::int n FROM "V2SettlementEvidence" WHERE "settlementId"=$1',[intent.intentId])).rows[0].n).eq(0);
    }else if(process.env.B25_PROCESS_CRASH_POINT==='broadcast'){
     expect(recovered.state).eq('CONFIRMED_LOCAL');expect((await recoverInNewProcess()).state).eq('CONFIRMED_LOCAL');
     expect((await owner.query('SELECT count(*)::int n FROM "V2SettlementEvidence" WHERE "settlementId"=$1',[intent.intentId])).rows[0].n).eq(1);
    }else{
     expect(recovered.state).eq('UNRESOLVED');expect(await ethers.provider.getTransaction(attempt.transactionHash)).eq(null);
     if(process.env.B25_TEST_SCAN_TIMEOUT==='1'){
      for(const point of ['latest','scan']){
       const original=ethers.provider.send.bind(ethers.provider);
       try{
        (ethers.provider as any).send=(method:string,args:any[])=>((point==='latest'&&method==='eth_blockNumber')||(point==='scan'&&method==='eth_getBlockByNumber'&&args[1]===true))?new Promise(()=>{}):original(method,args);
        const stalled=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:attempt.id});expect(stalled.state).eq('UNRESOLVED');expect(stalled.reason).eq('RECOVERY_SCAN_UNAVAILABLE');
        expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(1);
       }finally{(ethers.provider as any).send=original;}
      }
     }
     const send=ethers.provider.send.bind(ethers.provider);
     try{(ethers.provider as any).send=async(method:string,args:any[])=>{if(method==='eth_blockNumber')throw Error('injected latest-block outage');return send(method,args);};const unavailable=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:attempt.id});expect(unavailable.state).eq('UNRESOLVED');expect(unavailable.reason).eq('RECOVERY_SCAN_UNAVAILABLE');}finally{(ethers.provider as any).send=send;}
     const restored=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:attempt.id});expect(restored.state).eq('UNRESOLVED');expect(restored.reason).eq('RECEIPT_UNAVAILABLE');
    }
    const retry=await executeLocalSettlement({client:b25otherExecutor,preflightClient:otherPreflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(retry.reused).eq(true);expect(retry.transactionHash).eq(attempt.transactionHash);
    expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(1);
    return;
   }
   let conflictFixture:any=null;
   if(process.env.B25_TEST_CONCURRENT_CONFLICT==='1'){
    const alternative:any=await ethers.deployContract('EnergyTradingDirectSettlement',[tokenAddress,admin.address,operator.address,pauser.address]);
    const otherDeployment=randomUUID(),otherPolicy=randomUUID();
    await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'concurrent fixture\',now())',[otherDeployment,(await alternative.getAddress()).toLowerCase(),tokenAddress,ethers.keccak256(artifact.deployedBytecode),ethers.keccak256(artifact.bytecode)]);
    await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,2541,2541,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',2,\'ignored\',\'concurrent fixture\')',[otherPolicy,allocation.buyerId,buyer.address.toLowerCase(),otherDeployment,tokenAddress,plan.marketId]);
    conflictFixture={otherDeployment,otherPolicy};
   }
   const seller=built.terms.seller,old=await token.balanceOf(seller);
   const beforeSettlement=await ethers.provider.send('evm_snapshot',[]);
   let signalPrepared:any,releasePrepared:any;
   const prepared=new Promise(resolve=>{signalPrepared=resolve;}),gate=new Promise(resolve=>{releasePrepared=resolve;});
   const originalExecutorQuery=b25executor.query.bind(b25executor);
   let result:any;
   try{
    (b25executor as any).query=async(...args:any[])=>{const response=await originalExecutorQuery(...args);if(typeof args[0]==='string'&&args[0].includes('b25_prepare_local_attempt')){signalPrepared();await gate;}return response;};
    const first=executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});
    await prepared;
    if(process.env.B25_TEST_LOST_HANDOFF_RESPONSE==='1'){
     (b25executor as any).query=async(...args:any[])=>{const response=await originalExecutorQuery(...args);if(typeof args[0]==='string'&&args[0].includes('b25_authorize_handoff'))throw Error('injected lost handoff response');return response;};
     releasePrepared();const uncertain=await first;expect(uncertain.state).eq('UNRESOLVED');expect(uncertain.phase).eq('HANDOFF_UNKNOWN');
     expect((await owner.query('SELECT count(*)::int n FROM "B25DispatchHandoff" WHERE "attemptId"=$1',[uncertain.attemptId])).rows[0].n).eq(1);
     expect(await ethers.provider.getTransaction(uncertain.transactionHash)).eq(null);
     const again=await executeLocalSettlement({client:b25otherExecutor,preflightClient:otherPreflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(again.reused).eq(true);expect(again.phase).eq('HANDED_OFF');return;
    }
    if(process.env.B25_TEST_REVOKE_BEFORE_HANDOFF==='1'||process.env.B25_TEST_NONCE_CONFLICT==='1'||process.env.B25_TEST_RETIRE_BEFORE_HANDOFF==='1'){
     const a=(await owner.query('SELECT id,"operatorNonce","transactionHash" FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0];
     expect(a).not.eq(undefined);
     if(process.env.B25_TEST_RETIRE_BEFORE_HANDOFF==='1')await approver.query('UPDATE "B24Deployment" SET status=\'RETIRED\' WHERE id=$1',[deployment]);
     else await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]);
     if(process.env.B25_TEST_NONCE_CONFLICT==='1'){
      await ethers.provider.send('hardhat_impersonateAccount',[localOperator.address]);
      try{const impersonated=await ethers.getSigner(localOperator.address);await (await impersonated.sendTransaction({to:localOperator.address,value:0})).wait();}finally{await ethers.provider.send('hardhat_stopImpersonatingAccount',[localOperator.address]);}
     }
     releasePrepared();const blocked=await first;expect(blocked.state).eq('BLOCKED_BEFORE_HANDOFF');
     expect((await owner.query('SELECT count(*)::int n FROM "B25DispatchHandoff" WHERE "attemptId"=$1',[a.id])).rows[0].n).eq(0);
     expect(await ethers.provider.getTransaction(a.transactionHash)).eq(null);
     const again=await executeLocalSettlement({client:b25otherExecutor,preflightClient:otherPreflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(again.reused).eq(true);expect(again.transactionHash).eq(a.transactionHash);
     expect((await owner.query('SELECT "operatorNonce" FROM "B25LocalAttempt" WHERE id=$1',[a.id])).rows[0].operatorNonce).eq(a.operatorNonce);
     if(process.env.B25_TEST_NONCE_CONFLICT==='1'){const recovery=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:a.id});expect(recovery.reason).eq('NONCE_CONFLICT');expect((await owner.query('SELECT count(*)::int n FROM "B25RecoveryObservation" WHERE "attemptId"=$1',[a.id])).rows[0].n).eq(1);}
     return;
    }
    const simultaneous=await Promise.allSettled([
     executeLocalSettlement({client:b25otherExecutor,preflightClient:otherPreflight,provider:ethers.provider,session,registry:competingOperator,intentId:intent.intentId}),
     ...(conflictFixture?[prepareAuthorization(evaluator,{slot,allocationId:allocation.allocationId,policyId:conflictFixture.otherPolicy,deploymentId:conflictFixture.otherDeployment,execute:true})]:[])
    ]);
    expect(simultaneous[0].status).eq('fulfilled');const concurrent=(simultaneous[0] as PromiseFulfilledResult<any>).value;expect(concurrent.reused).eq(true);
    if(conflictFixture){expect(simultaneous[1].status).eq('rejected');expect(String((simultaneous[1] as PromiseRejectedResult).reason)).contains('Conflicting existing reservation');expect((await owner.query('SELECT count(*)::int n FROM "V2SettlementIntent" WHERE "allocationId"=$1',[allocation.allocationId])).rows[0].n).eq(1);}

    const originalBroadcast=ethers.provider.broadcastTransaction.bind(ethers.provider);
    if(process.env.B25_TEST_BROADCAST_FAILURE){
     const mode=process.env.B25_TEST_BROADCAST_FAILURE;let sends=0;
     try{
      (ethers.provider as any).broadcastTransaction=async(raw:string)=>{if(mode==='after'){sends++;await originalBroadcast(raw);}throw Error(`injected ${mode}-send response loss`);};
      releasePrepared();const uncertain=await first;expect(uncertain.state).eq('UNRESOLVED');expect(sends).eq(mode==='after'?1:0);
      const retry=await executeLocalSettlement({client:b25otherExecutor,preflightClient:otherPreflight,provider:ethers.provider,session,registry:competingOperator,intentId:intent.intentId});expect(retry.reused).eq(true);expect(retry.transactionHash).eq(uncertain.transactionHash);expect(sends).eq(mode==='after'?1:0);
      if(mode==='after'){const receipt=await ethers.provider.getTransactionReceipt(uncertain.transactionHash);expect(receipt?.status).eq(1);expect((await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:uncertain.attemptId})).state).eq('CONFIRMED_LOCAL');}
      else{expect(await ethers.provider.getTransaction(uncertain.transactionHash)).eq(null);expect((await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:uncertain.attemptId})).state).eq('UNRESOLVED');}
      expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(1);return;
     }finally{(ethers.provider as any).broadcastTransaction=originalBroadcast;}
    }
    let entered:any,releaseBroadcast:any,lateDone:any;
    const handed=new Promise(resolve=>{entered=resolve;}), delayed=new Promise(resolve=>{releaseBroadcast=resolve;}),late=new Promise(resolve=>{lateDone=resolve;});
    let sends=0;
    try{
     (ethers.provider as any).broadcastTransaction=async(raw:string)=>{entered();await delayed;sends++;try{return await originalBroadcast(raw);}finally{lateDone();}};
     releasePrepared();await handed;
     const handoff=(await owner.query('SELECT count(*)::int n FROM "B25DispatchHandoff" WHERE "attemptId"=$1',[concurrent.attemptId])).rows[0].n;expect(handoff).eq(1);
     result=await first;expect(result.state).eq('UNRESOLVED');expect(concurrent.transactionHash).eq(result.transactionHash);expect(sends).eq(0);
     await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]);
     const afterRevocation=await executeLocalSettlement({client:b25otherExecutor,preflightClient:otherPreflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(afterRevocation.reused).eq(true);expect(sends).eq(0);
     releaseBroadcast();await late;expect(sends).eq(1);
    }finally{releaseBroadcast();(ethers.provider as any).broadcastTransaction=originalBroadcast;}
   }finally{releasePrepared();(b25executor as any).query=originalExecutorQuery;}

   const receipt=await ethers.provider.getTransactionReceipt(result.transactionHash);expect(receipt?.status).eq(1);
   const settlementRetry=await executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(settlementRetry.reused).eq(true);expect(settlementRetry.transactionHash).eq(result.transactionHash);
   // Once handed off, even unavailable preparation dependencies must not be
   // consulted to create a replacement nonce or signed transaction.
   for(const method of ['getNetwork','getCode','getTransactionCount','getFeeData','call']){
    const original=(ethers.provider as any)[method].bind(ethers.provider);let calls=0;
    try{
     (ethers.provider as any)[method]=()=>{calls++;throw Error(`unexpected ${method} retry`);};
     const unchanged=await executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});
     expect(unchanged.reused,method).eq(true);expect(unchanged.transactionHash).eq(result.transactionHash);expect(calls,method).eq(0);
    }finally{(ethers.provider as any)[method]=original;}
   }
   const signerBeforeRetry=ethers.BaseWallet.prototype.signTransaction;let signingCalls=0;
   try{
    (ethers.BaseWallet.prototype as any).signTransaction=()=>{signingCalls++;throw Error('unexpected signing retry');};
    const unchanged=await executeLocalSettlement({client:b25executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(unchanged.reused).eq(true);expect(signingCalls).eq(0);
   }finally{(ethers.BaseWallet.prototype as any).signTransaction=signerBeforeRetry;}

   const transaction=await ethers.provider.getTransaction(result.transactionHash);
   const receiptContext={terms:built.terms,contract:contractAddress,operator:localOperator.address,operatorNonce:transaction!.nonce,txHash:result.transactionHash,signature,settlementDigest:row.settlementId};
   const corruptContexts=[
    [{...receiptContext,operator:admin.address},/transaction or receipt mismatch/],
    [{...receiptContext,operatorNonce:transaction!.nonce+1},/transaction or receipt mismatch/],
    [{...receiptContext,signature:'0x'+'00'.repeat(65)},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,buyer:admin.address}},/Unknown or mismatched local chain session/],
    [{...receiptContext,terms:{...built.terms,seller:admin.address}},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,allocationId:'0x'+'ab'.repeat(32)}},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,marketId:'0x'+'ab'.repeat(32)}},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,snapshotHash:'0x'+'ab'.repeat(32)}},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,quantityWh:'29'}},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,unitPriceMicrousdPerKwh:'90751'}},/calldata terms mismatch/],
    [{...receiptContext,terms:{...built.terms,token:admin.address}},/Unknown or mismatched local chain session/],
    [{...receiptContext,terms:{...built.terms,planCommitment:'0x'+'ab'.repeat(32)}},/calldata terms mismatch/],
    [{...receiptContext,contract:tokenAddress},/Unknown or mismatched local chain session/],
    [{...receiptContext,settlementDigest:'0x'+'ab'.repeat(32)},/event missing or ambiguous/]
   ];
   for(const [corrupt,reason] of corruptContexts)await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:corrupt as any}),reason as RegExp);
   const originalTransactionLookup=ethers.provider.getTransaction.bind(ethers.provider);
   try{
    for(const [field,value,reason] of [
     ['hash','0x'+'fe'.repeat(32),/transaction or receipt mismatch/],
     ['from',admin.address,/transaction or receipt mismatch/],
     ['to',tokenAddress,/transaction or receipt mismatch/],
     ['nonce',transaction!.nonce+1,/transaction or receipt mismatch/],
     ['data','0x',/Invalid settlement calldata|Settlement calldata terms mismatch/]
    ] as any[]){
     (ethers.provider as any).getTransaction=async()=>new Proxy(transaction!,{get(target,key){return key===field?value:Reflect.get(target,key,target);}});
     await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),reason);
    }
    (ethers.provider as any).getTransaction=async()=>new Proxy(transaction!,{get(target,key){return key==='data'?'0x':Reflect.get(target,key,target);}});
    await assert.rejects(verifyAndRecordLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId}),/B25 calldata commitment mismatch/);
   }finally{(ethers.provider as any).getTransaction=originalTransactionLookup;}
   const originalReceiptLookup=ethers.provider.getTransactionReceipt.bind(ethers.provider);
   try{
    (ethers.provider as any).getTransactionReceipt=async()=>({hash:'0x'+'ff'.repeat(32),status:1,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,logs:receipt!.logs});
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/transaction or receipt mismatch/);
    (ethers.provider as any).getTransactionReceipt=async()=>({hash:receipt!.hash,status:0,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,logs:receipt!.logs});
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/transaction or receipt mismatch/);
    (ethers.provider as any).getTransactionReceipt=async()=>({hash:receipt!.hash,status:1,blockNumber:receipt!.blockNumber,blockHash:'0x'+'00'.repeat(32),logs:receipt!.logs});
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/not canonical/);
    (ethers.provider as any).getTransactionReceipt=async()=>({hash:receipt!.hash,status:1,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,logs:receipt!.logs.filter((l:any)=>l.address.toLowerCase()!==contractAddress)});
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/event missing or ambiguous/);
    for(const emitter of [contractAddress,tokenAddress]){
     const tampered=receipt!.logs.map((l:any)=>l.address.toLowerCase()===emitter?{address:admin.address,topics:l.topics,data:l.data,index:l.index}:l);
     (ethers.provider as any).getTransactionReceipt=async()=>({hash:receipt!.hash,status:1,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,logs:tampered});
     await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/event missing or ambiguous/);
    }
    const settlementLog=receipt!.logs.find((l:any)=>l.address.toLowerCase()===contractAddress)!;
    (ethers.provider as any).getTransactionReceipt=async()=>({hash:receipt!.hash,status:1,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,logs:[...receipt!.logs,settlementLog]});
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/event missing or ambiguous/);
    (ethers.provider as any).getTransactionReceipt=async()=>({hash:receipt!.hash,status:1,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,logs:receipt!.logs.filter((l:any)=>l.address.toLowerCase()!==tokenAddress)});
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/event missing or ambiguous/);
   }finally{(ethers.provider as any).getTransactionReceipt=originalReceiptLookup;}
   // A reorganization between initial verification and final block check
   // must not result in a confirmed payment.
   const sendDuringInspect=ethers.provider.send.bind(ethers.provider);let observedBlock=0;
   try{
    const height='0x'+BigInt(receipt!.blockNumber).toString(16);
    (ethers.provider as any).send=async(method:string,args:any[])=>{const value=await sendDuringInspect(method,args);if(method==='eth_getBlockByNumber'&&args[0]===height&&++observedBlock===2)return {...value,hash:'0x'+'ff'.repeat(32)};return value;};
    await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext}),/not canonical/);
    expect(observedBlock).eq(2);
   }finally{(ethers.provider as any).send=sendDuringInspect;}
   expect((await owner.query('SELECT count(*)::int n FROM "V2SettlementEvidence" WHERE "settlementId"=$1',[intent.intentId])).rows[0].n).eq(0);
   const evidence=await inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:receiptContext});
   await assert.rejects(inspectSettlementReceipt({provider:ethers.provider,session,reservationId:row.id,context:{terms:{...built.terms,amountBaseUnits:'2542'},contract:contractAddress,operator:localOperator.address,operatorNonce:transaction!.nonce,txHash:result.transactionHash,signature,settlementDigest:row.settlementId}}),/Settlement calldata terms mismatch/);
   await expect(contract.connect(operator).settle(built.terms,signature)).to.be.revertedWithCustomError(contract,'Replay');
   expect(evidence.transactionHash).eq(result.transactionHash);expect(await token.balanceOf(buyer.address)).eq(0n);expect(await token.balanceOf(seller)).eq(old+2541n);expect(await token.balanceOf(contractAddress)).eq(0n);
   expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(1);
   await assert.rejects(b25executor.query('SELECT "b25_receipt_context"($1)',[result.attemptId]),(e:any)=>e.code==='42501');
   await assert.rejects(b25executor.query('SELECT "b25_record_local_evidence"($1,$2,$3,$4,$5,$6)',[result.attemptId,randomUUID(),'0x'+'00'.repeat(32),0,0,0]),(e:any)=>e.code==='42501');
   await assert.rejects(b25verifier.query('SELECT "b25_prepare_local_attempt"($1,$2,$3,$4,$5,$6,$7)',[intent.intentId,randomUUID(),session.id,localOperator.address.toLowerCase(),1,'0x'+'01'.repeat(32),'0x'+'02'.repeat(32)]),(e:any)=>e.code==='42501');
   await assert.rejects(b25executor.query('UPDATE "B25LocalAttempt" SET "transactionHash"=$1',[result.transactionHash]),(e:any)=>e.code==='42501');
   const recorded=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(recorded.state).eq('CONFIRMED_LOCAL');
   const repeated=await verifyAndRecordLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(repeated.reused).eq(true);expect(repeated.evidenceId).eq(recorded.evidenceId);
   const concurrentVerification=await Promise.all([verifyAndRecordLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId}),verifyAndRecordLocalSettlement({client:b25otherVerifier,provider:ethers.provider,session,attemptId:result.attemptId})]);expect(concurrentVerification.every((x:any)=>x.reused&&x.evidenceId===recorded.evidenceId)).eq(true);
   await assert.rejects(b25verifier.query('INSERT INTO "B25CanonicalOutcomeEvent" DEFAULT VALUES'),(e:any)=>e.code==='42501');
   await assert.rejects(b25verifier.query(`UPDATE "B25CanonicalOutcomeEvent" SET outcome='REVERTED'`),(e:any)=>e.code==='42501');
   await assert.rejects(b25executor.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[result.attemptId,randomUUID(),'SUCCESS',recorded.blockHash.toLowerCase(),recorded.blockNumber,recorded.settlementLogIndex,recorded.transferLogIndex,recorded.eventId]),(e:any)=>e.code==='42501');
   await assert.rejects(b25reporter.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[result.attemptId,randomUUID(),'SUCCESS',recorded.blockHash.toLowerCase(),recorded.blockNumber,recorded.settlementLogIndex,recorded.transferLogIndex,recorded.eventId]),(e:any)=>e.code==='42501');
   await assert.rejects(b25verifier.query('SELECT "b25_record_local_evidence"($1,$2,$3,$4,$5,$6)',[result.attemptId,randomUUID(),recorded.blockHash.toLowerCase(),recorded.blockNumber,recorded.settlementLogIndex+1,recorded.transferLogIndex]),(e:any)=>e.code==='42501');
   await assert.rejects(b25verifier.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[result.attemptId,randomUUID(),'SUCCESS',recorded.blockHash.toLowerCase(),recorded.blockNumber,recorded.settlementLogIndex+1,recorded.transferLogIndex,recorded.eventId]),/prior outcome must be noncanonical/);
   const conflictingObservations=await Promise.allSettled([b25verifier.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[result.attemptId,randomUUID(),'SUCCESS',recorded.blockHash.toLowerCase(),recorded.blockNumber,recorded.settlementLogIndex,recorded.transferLogIndex,recorded.eventId]),b25otherVerifier.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8)',[result.attemptId,randomUUID(),'SUCCESS',recorded.blockHash.toLowerCase(),recorded.blockNumber,recorded.settlementLogIndex+1,recorded.transferLogIndex,recorded.eventId])]);
   expect(conflictingObservations[0].status).eq('fulfilled');expect(conflictingObservations[1].status).eq('rejected');
   expect((await owner.query('SELECT count(*)::int n FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1',[result.attemptId])).rows[0].n).eq(1);
   expect((await owner.query('SELECT count(*)::int n FROM "V2SettlementEvidence" WHERE "verificationStatus"=\'VERIFIED\'')).rows[0].n).eq(1);
   expect((await owner.query('SELECT status FROM "V2SettlementIntent" WHERE id=$1',[intent.intentId])).rows[0].status).eq('CONFIRMED');
   const recovered=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(recovered.state).eq('CONFIRMED_LOCAL');
   // A missing block from an otherwise current provider is not reorg proof.
   const sendForMissing=ethers.provider.send.bind(ethers.provider);
   try{
    const height='0x'+BigInt(recorded.blockNumber).toString(16);
    (ethers.provider as any).send=async(method:string,args:any[])=>method==='eth_getBlockByNumber'&&args[0]===height?null:sendForMissing(method,args);
    const missing=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});
    expect(missing.state).eq('UNRESOLVED');expect(missing.reason).eq('CANONICAL_BLOCK_UNAVAILABLE');
    expect((await owner.query('SELECT count(*)::int n FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1',[result.attemptId])).rows[0].n).eq(1);
    expect((await owner.query('SELECT status FROM "V2SettlementIntent" WHERE id=$1',[intent.intentId])).rows[0].status).eq('CONFIRMED');
   }finally{(ethers.provider as any).send=sendForMissing;}
   for(const method of ['getNetwork','getCode','getTransaction','getTransactionReceipt','send']){
    const original=(ethers.provider as any)[method].bind(ethers.provider);
    try{
     (ethers.provider as any)[method]=async(...args:any[])=>{if(method!=='send'||args[0]==='eth_getBlockByNumber')throw Error('injected local RPC outage');return original(...args);};
     for(let failure=0;failure<2;failure++){
      const uncertain=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(uncertain.state).eq('UNRESOLVED');
      expect((await owner.query('SELECT status FROM "V2SettlementIntent" WHERE id=$1',[intent.intentId])).rows[0].status).eq('CONFIRMED');
      expect((await owner.query('SELECT count(*)::int n FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1',[result.attemptId])).rows[0].n).eq(1);
     }
    }finally{(ethers.provider as any)[method]=original;}
    expect((await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId})).state).eq('CONFIRMED_LOCAL');
   }

   // A current receipt from a different block must not validate archived success evidence.
   if(process.env.B25_TEST_RECOVERY_TIMEOUT==='1'){
    for(const method of ['getNetwork','getCode','getTransaction','getTransactionReceipt','send']){
     const original=(ethers.provider as any)[method].bind(ethers.provider);
     try{
      (ethers.provider as any)[method]=(...args:any[])=>method!=='send'||(args[0]==='eth_getBlockByNumber'&&args[1]?.[0]==='0x'+BigInt(recorded.blockNumber).toString(16))?new Promise(()=>{}):original(...args);
      const uncertain=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});
      expect(uncertain.state,method).eq('UNRESOLVED');
      expect((await owner.query('SELECT count(*)::int n FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1',[result.attemptId])).rows[0].n).eq(1);
      expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(1);
     }finally{(ethers.provider as any)[method]=original;}
     expect((await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId})).state).eq('CONFIRMED_LOCAL');
    }
   }
   const reporterQuery=b25reporter.query.bind(b25reporter);
   try{
    for(const field of ['currentBlockHash','currentSettlementIndex','currentTransferIndex']){
     (b25reporter as any).query=async(...args:any[])=>{const result=await reporterQuery(...args);if(typeof args[0]==='string'&&args[0].includes('currentBlockHash'))for(const r of result.rows)if(r.evidenceId)r[field]=field==='currentBlockHash'?'0x'+'ff'.repeat(32):r[field]+1;return result;};
     const mismatch=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});
     expect(mismatch.verifiedPaidBaseUnits).eq('0');expect(mismatch.unresolved).eq(1);
    }
   }finally{(b25reporter as any).query=reporterQuery;}
   const transactionLookup=ethers.provider.getTransaction.bind(ethers.provider);
   try{
    (ethers.provider as any).getTransaction=()=>new Promise(()=>{});
    const timedOut=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});
    expect(timedOut.unresolved).eq(1);expect(timedOut.verifiedPaidBaseUnits).eq('0');
    expect((await owner.query('SELECT count(*)::int n FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1',[result.attemptId])).rows[0].n).eq(1);
   }finally{(ethers.provider as any).getTransaction=transactionLookup;}
   const report=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});expect(report.verifiedPaidBaseUnits).eq('2541');expect(report.confirmed).eq(1);
   console.log(JSON.stringify({state:'B25_LOCAL_TEST_ONLY',marketId:plan.marketId,allocationId:allocation.allocationId,intentId:intent.intentId,reservationId:row.id,settlementDigest:row.settlementId,transactionHash:result.transactionHash,blockHash:recorded.blockHash,amountBaseUnits:'2541',planAllocations:plan.allocations.length,budgetPlanAllocations:budgetPlan.allocations.length,report}));
   await assert.rejects(b25reporter.query('UPDATE "V2SettlementIntent" SET status=\'CONFIRMED\''),(e:any)=>e.code==='42501');
   await ethers.provider.send('evm_revert',[beforeSettlement]);
   const reorg=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(reorg.state).eq('UNRESOLVED');expect(reorg.reason).eq('NONCANONICAL');
   expect((await owner.query('SELECT status FROM "V2SettlementIntent" WHERE id=$1',[intent.intentId])).rows[0].status).eq('UNKNOWN');
   const afterReorg=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});expect(afterReorg.verifiedPaidBaseUnits).eq('0');expect(afterReorg.unresolved).greaterThan(0);
   if(process.env.B25_TEST_SUPERSESSION==='1'){
    // Test infrastructure remine of the original signed transaction; recovery never broadcasts.
    const raw=ethers.Transaction.from(transaction!).serialized;
    const replacementPoint=await ethers.provider.send('evm_snapshot',[]);
    await (await contract.connect(pauser).pause()).wait();
    try{await ethers.provider.broadcastTransaction(raw);}catch{/* Hardhat can throw for a mined revert. */}
    const replacement=await ethers.provider.getTransactionReceipt(result.transactionHash);
    expect(replacement?.status).eq(0);
    const changed=await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(changed.state).eq('REVERTED_LOCAL');
    const failure=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});
    expect(failure.verifiedPaidBaseUnits).eq('0');expect(failure.failed).eq(1);expect(failure.unpaidBaseUnits).eq('2541');
    const history=(await owner.query('SELECT outcome,"supersedesId" FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1 ORDER BY sequence',[result.attemptId])).rows;
    expect(history.map((x:any)=>x.outcome)).deep.eq(['SUCCESS','NONCANONICAL','REVERTED']);
    expect((await owner.query('SELECT count(*)::int n FROM "B25LocalAttempt" WHERE "intentId"=$1',[intent.intentId])).rows[0].n).eq(1);
    await ethers.provider.send('evm_revert',[replacementPoint]);
    expect((await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId})).reason).eq('NONCANONICAL');
    await (await ethers.provider.broadcastTransaction(raw)).wait();
    expect((await recoverLocalSettlement({client:b25verifier,provider:ethers.provider,session,attemptId:result.attemptId})).state).eq('CONFIRMED_LOCAL');
    const finalReport=await reconcileLocalMarket({client:b25reporter,verifierClient:b25verifier,provider:ethers.provider,marketId:plan.marketId,sessions:new Map([[row.id,session]])});
    expect(finalReport.verifiedPaidBaseUnits).eq('2541');expect(finalReport.unpaidBaseUnits).eq('0');
    const finalHistory=(await owner.query('SELECT outcome FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1 ORDER BY sequence',[result.attemptId])).rows;
    expect(finalHistory.map((x:any)=>x.outcome)).deep.eq(['SUCCESS','NONCANONICAL','REVERTED','NONCANONICAL','SUCCESS']);
   }
  }finally{await Promise.allSettled(clients.map(c=>c.end()));}
 });
});
