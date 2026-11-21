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
import {createOfflineSigningService,createEphemeralTestWalletRegistry} from '../../../apps/backend/scripts/b24-signing.mjs';
import {establishLocalChainSession} from '../../../apps/backend/scripts/b24-local-chain-session.mjs';
import {fundLocalReservation} from '../../../apps/backend/scripts/b24-funding.mjs';
import {setLocalAllowance} from '../../../apps/backend/scripts/b24-allowance.mjs';
import {inspectLocalReadiness} from '../../../apps/backend/scripts/b24-readiness.mjs';
import {createLocalSettlementIntent} from '../../../apps/backend/scripts/b25-settlement-intent.mjs';
import {createLocalOperatorRegistry,executeLocalSettlement} from '../../../apps/backend/scripts/b25-settlement-executor.mjs';
import {verifyAndRecordLocalSettlement} from '../../../apps/backend/scripts/b25-settlement-receipt.mjs';
import {reconcileLocalMarket} from '../../../apps/backend/scripts/b25-settlement-reconciliation.mjs';
const {ethers}=await network.create();const {Client}=pg;
describe('B25 genuine two-allocation market',function(){
 this.timeout(120000);
 it('reconciles partial and complete settlement without paying either allocation twice',async function(){
  if(process.env.B24_A2_TEST!=='1'||(process.env.B25_TEST_LOST_HANDOFF_RESPONSE==='1'||process.env.B25_TEST_REVOKE_BEFORE_EXECUTE==='1'||process.env.B25_TEST_REVOKE_BEFORE_HANDOFF==='1'||process.env.B25_TEST_NONCE_CONFLICT==='1'||process.env.B25_TEST_RETIRE_BEFORE_HANDOFF==='1'||process.env.B25_TEST_EXPIRED==='1'||process.env.B25_TEST_RETIRED_SESSION==='1'||process.env.B25_TEST_CONCURRENT_CONFLICT==='1'||Boolean(process.env.B25_TEST_BROADCAST_FAILURE))){this.skip();return;}
  const urls=['B22_TEST_DATABASE_URL','B22_ROSTER_DATABASE_URL','B22_INGEST_DATABASE_URL','B22_MATCH_DATABASE_URL','B24_APPROVER_DATABASE_URL','B24_EVALUATOR_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_SIGNER_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B25_EXECUTOR_DATABASE_URL','B25_VERIFIER_DATABASE_URL','B25_REPORTER_DATABASE_URL'];
  for(const name of urls){const u=new URL(process.env[name]!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/b22_disposable_review')throw Error('unsafe database');}
  const clients=urls.map(name=>new Client({connectionString:process.env[name]}));await Promise.all(clients.map(c=>c.connect()));
  const [owner,roster,ingest,matcher,approver,evaluator,preflight,signer,receiptClient,funder,allowanceClient,executor,verifier,reporter]=clients;
  try{
   const [admin,operator,pauser]=await ethers.getSigners();
   const registry=await createEphemeralTestWalletRegistry({client:signer,provider:ethers.provider});const buyers=[registry.createBuyer(),registry.createBuyer()];
   const ids=['00000000-0000-4000-8000-000000000075','00000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-00000000001b'];
   const users=ids.map((userId,i)=>({userId,name:`B25 multi ${i}`,email:`b25-multi-${i}@example.com`,physicalAddress:'Simulation',xKm:0,yKm:0,preferredEnergyType:'ANY',reputation:80,hederaAccountId:`0.0.${3000+i}`,evmAddress:i?buyers[i-1].address.toLowerCase():'0x0000000000000000000000000000000000000075'}));
   for(const u of users){
    await owner.query('INSERT INTO users(id,name,email,password_hash,physical_address,x_km,y_km,reputation,preferred_energy_type,updated_at) VALUES($1,$2,$3,\'synthetic\',$4,$5,$6,$7,$8,now())',[u.userId,u.name,u.email,u.physicalAddress,u.xKm,u.yKm,u.reputation,u.preferredEnergyType]);
    await owner.query('INSERT INTO wallets(id,user_id,hedera_account_id,evm_address,public_key,encrypted_private_key,encryption_iv,encryption_auth_tag,updated_at) VALUES($1,$2,$3,$4,\'synthetic\',\'synthetic\',\'synthetic\',\'synthetic\',now())',[randomUUID(),u.userId,u.hederaAccountId,u.evmAddress]);
   }
   const slot='2026-10-01T08:00:00Z';await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,\'ignored\',1)',[randomUUID(),slot,'2026-10-01T09:00:00Z',JSON.stringify(users)]);
   await ingestLocalHour(ingest,slot,{execute:true});const plan=await processFinalizedHour(matcher,slot,{execute:true});
   expect(plan.status).eq('AUTHORITATIVE');expect(plan.allocations.length).eq(2);expect(plan.allocations.map((a:any)=>a.amountBaseUnits).sort()).deep.eq(['10624','3984']);
   // Each Hardhat test module has a separate chain with the same initial nonce.
   // Advance it so this fixture's deployment does not collide in the shared disposable database.
   await (await admin.sendTransaction({to:admin.address,value:0})).wait();
   const token:any=await ethers.deployContract('TestEnergyUSD',[admin.address]);const contract:any=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
   const tokenAddress=(await token.getAddress()).toLowerCase(),contractAddress=(await contract.getAddress()).toLowerCase();const artifact=JSON.parse(readFileSync(new URL('../artifacts/contracts/EnergyTradingDirectSettlement.sol/EnergyTradingDirectSettlement.json',import.meta.url),'utf8'));const deployment=randomUUID();
   await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'multi fixture\',now())',[deployment,contractAddress,tokenAddress,ethers.keccak256(artifact.deployedBytecode),ethers.keccak256(artifact.bytecode)]);
   const localOperator=await createLocalOperatorRegistry({client:executor,provider:ethers.provider});await (await admin.sendTransaction({to:localOperator.address,value:ethers.parseEther('1')})).wait();await (await contract.grantRole(await contract.OPERATOR_ROLE(),localOperator.address)).wait();
   const sessions=new Map();let verified=0n;
   const initial=await reconcileLocalMarket({client:reporter,verifierClient:verifier,provider:ethers.provider,marketId:plan.marketId,sessions});expect(initial.pending).eq(2);expect(initial.verifiedPaidBaseUnits).eq('0');expect(initial.unpaidBaseUnits).eq('14608');
   for(let i=0;i<2;i++){
    const a=plan.allocations.find((x:any)=>x.buyerId===users[i+1].userId);expect(a).not.eq(undefined);
    const policy=randomUUID(),amount=BigInt(a.amountBaseUnits);
    await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,$7,$7,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',1,\'ignored\',\'multi fixture\')',[policy,a.buyerId,buyers[i].address.toLowerCase(),deployment,tokenAddress,plan.marketId,amount.toString()]);
    const row=(await prepareAuthorization(evaluator,{slot,allocationId:a.allocationId,policyId:policy,deploymentId:deployment,execute:true})).reservation;
    expect((await verifySigningPreflight(preflight,{reservationId:row.id})).state).eq('SIMULATION_ELIGIBLE');
    const anchor=await (await admin.sendTransaction({to:buyers[i].address,value:ethers.parseEther('1')})).wait();
    const session=await establishLocalChainSession(preflight,{reservationId:row.id,provider:ethers.provider,anchorTransactionHash:anchor.hash,approvalClient:approver});sessions.set(row.id,session);
    const signing=createOfflineSigningService({client:signer,preflightClient:preflight,registry,session});expect((await signing.signReservation(row.id)).state).eq('SIGNED_OFFLINE');
    const grant=randomUUID(),budget=randomUUID();
    await approver.query('INSERT INTO "B24LocalFundingGrant"(id,"sessionId","minterAddress","perOperationLimit","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$4,\'ignored\')',[grant,session.id,admin.address.toLowerCase(),amount.toString()]);
    await approver.query('INSERT INTO "B24LocalFundingBudget"(id,"buyerAddress","tokenAddress","minterAddress","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$5,\'ignored\')',[budget,buyers[i].address.toLowerCase(),tokenAddress,admin.address.toLowerCase(),amount.toString()]);
    await approver.query('INSERT INTO "B24LocalFundingBudgetGrant"("grantId","budgetId") VALUES($1,$2)',[grant,budget]);
    expect((await fundLocalReservation({client:funder,preflightClient:preflight,receiptClient,provider:ethers.provider,session,minter:admin,reservationId:row.id,grantId:grant})).state).eq('VERIFIED');
    expect((await setLocalAllowance({client:allowanceClient,preflightClient:preflight,receiptClient,provider:ethers.provider,session,registry,reservationId:row.id})).state).eq('VERIFIED');
    expect((await inspectLocalReadiness(preflight,{reservationId:row.id,provider:ethers.provider,session})).state).eq('READY_FOR_LOCAL_SETTLEMENT');
    if(i===1)await expect(contract.connect(operator).settle({...row.terms.terms,planCommitment:'0x'+'ab'.repeat(32)},'0x')).to.be.revertedWithCustomError(contract,'ConflictingPlan');
    const intent=await createLocalSettlementIntent({client:executor,preflightClient:preflight,reservationId:row.id,provider:ethers.provider,session});
    const before=await token.balanceOf(row.terms.terms.seller);
    let result:any,revertPoint:any;
    if(i===1&&process.env.B25_TEST_REVERT==='1'){
     revertPoint=await ethers.provider.send('evm_snapshot',[]);
     const broadcast=ethers.provider.broadcastTransaction.bind(ethers.provider);
     try{
      (ethers.provider as any).broadcastTransaction=async(raw:string)=>{await (await contract.connect(pauser).pause()).wait();return broadcast(raw);};
      result=await executeLocalSettlement({client:executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});
     }finally{(ethers.provider as any).broadcastTransaction=broadcast;}
     const reverted=await ethers.provider.getTransactionReceipt(result.transactionHash);expect(reverted?.status).eq(0);
     const {recoverLocalSettlement}=await import('../../../apps/backend/scripts/b25-settlement-recovery.mjs');
     const failed=await recoverLocalSettlement({client:verifier,provider:ethers.provider,session,attemptId:result.attemptId});expect(failed.state).eq('REVERTED_LOCAL');
     const failedReport=await reconcileLocalMarket({client:reporter,verifierClient:verifier,provider:ethers.provider,marketId:plan.marketId,sessions});expect(failedReport.failed).eq(1);expect(failedReport.confirmed).eq(1);expect(BigInt(failedReport.unpaidBaseUnits)).eq(amount);
     expect(await token.balanceOf(row.terms.terms.seller)).eq(before);expect((await executeLocalSettlement({client:executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId})).reused).eq(true);
     const originalTx=await ethers.provider.getTransaction(result.transactionHash);
     const originalRaw=ethers.Transaction.from(originalTx!).serialized;
     await ethers.provider.send('evm_revert',[revertPoint]);
     expect((await recoverLocalSettlement({client:verifier,provider:ethers.provider,session,attemptId:result.attemptId})).reason).eq('NONCANONICAL');
     expect((await reconcileLocalMarket({client:reporter,verifierClient:verifier,provider:ethers.provider,marketId:plan.marketId,sessions})).unresolved).eq(1);
     if(process.env.B25_TEST_SUPERSESSION==='1'){
      // Simulate network remining of the identical signed transaction on the replacement chain.
      await (await ethers.provider.broadcastTransaction(originalRaw)).wait();
      expect((await recoverLocalSettlement({client:verifier,provider:ethers.provider,session,attemptId:result.attemptId})).state).eq('CONFIRMED_LOCAL');
      const recoveredReport=await reconcileLocalMarket({client:reporter,verifierClient:verifier,provider:ethers.provider,marketId:plan.marketId,sessions});
      expect(recoveredReport.confirmed).eq(2);expect(recoveredReport.verifiedPaidBaseUnits).eq('14608');expect(recoveredReport.unpaidBaseUnits).eq('0');
      const history=(await owner.query('SELECT outcome FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1 ORDER BY sequence',[result.attemptId])).rows;
      expect(history.map((x:any)=>x.outcome)).deep.eq(['REVERTED','NONCANONICAL','SUCCESS']);
     }
     return;
    }
    result=await executeLocalSettlement({client:executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(result.state).eq('SUBMITTED');
    const inflight=await reconcileLocalMarket({client:reporter,verifierClient:verifier,provider:ethers.provider,marketId:plan.marketId,sessions});expect(inflight.unresolved).eq(1);expect(BigInt(inflight.verifiedPaidBaseUnits)).eq(verified);
    expect((await verifyAndRecordLocalSettlement({client:verifier,provider:ethers.provider,session,attemptId:result.attemptId})).state).eq('CONFIRMED_LOCAL');
    expect(await token.balanceOf(row.terms.terms.seller)).eq(before+amount);expect(await token.balanceOf(buyers[i].address)).eq(0n);expect(await token.balanceOf(contractAddress)).eq(0n);
    const retry=await executeLocalSettlement({client:executor,preflightClient:preflight,provider:ethers.provider,session,registry:localOperator,intentId:intent.intentId});expect(retry.reused).eq(true);expect(retry.transactionHash).eq(result.transactionHash);
    verified+=amount;const report=await reconcileLocalMarket({client:reporter,verifierClient:verifier,provider:ethers.provider,marketId:plan.marketId,sessions});
    expect(BigInt(report.verifiedPaidBaseUnits)).eq(verified);expect(BigInt(report.expectedBaseUnits)).eq(BigInt(report.verifiedPaidBaseUnits)+BigInt(report.unpaidBaseUnits));expect(report.confirmed).eq(i+1);expect(report.pending).eq(1-i);
    expect(await contract.marketPlans(plan.marketId)).eq(row.planCommitment);expect(await contract.marketSnapshots(plan.marketId)).eq(row.terms.terms.snapshotHash);
    if(i===0){
     const otherContract:any=await ethers.deployContract('EnergyTradingDirectSettlement',[tokenAddress,admin.address,operator.address,pauser.address]);const otherAddress=(await otherContract.getAddress()).toLowerCase(),otherDeployment=randomUUID(),otherPolicy=randomUUID();
     await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'second local fixture\',now())',[otherDeployment,otherAddress,tokenAddress,ethers.keccak256(artifact.deployedBytecode),ethers.keccak256(artifact.bytecode)]);
     await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,$7,$7,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',2,\'ignored\',\'cross deployment fixture\')',[otherPolicy,a.buyerId,buyers[i].address.toLowerCase(),otherDeployment,tokenAddress,plan.marketId,amount.toString()]);
     await assert.rejects(prepareAuthorization(evaluator,{slot,allocationId:a.allocationId,policyId:otherPolicy,deploymentId:otherDeployment,execute:true}),/Conflicting existing reservation/);
     expect((await owner.query('SELECT count(*)::int n FROM "V2SettlementIntent" WHERE "allocationId"=$1',[a.allocationId])).rows[0].n).eq(1);
    }

   }
   console.log(JSON.stringify({state:'B25_MULTI_LOCAL_TEST_ONLY',marketId:plan.marketId,allocations:plan.allocations.length,paidBaseUnits:verified.toString()}));
  }finally{await Promise.allSettled(clients.map(c=>c.end()));}
 });
});
