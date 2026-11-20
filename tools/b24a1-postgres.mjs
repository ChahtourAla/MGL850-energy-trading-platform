import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {keccak256} from '../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {prepareAuthorization,inspectReservation} from '../apps/backend/scripts/b24a1-authorization.mjs';
import {ingestLocalHour} from '../apps/backend/scripts/b22a-ingestion.mjs';
import {processFinalizedHour} from '../apps/backend/scripts/b22b-matching.mjs';
const {Client}=pg;
const owner=new Client({connectionString:process.env.B22_TEST_DATABASE_URL}),approver=new Client({connectionString:process.env.B24_APPROVER_DATABASE_URL}),evaluator=new Client({connectionString:process.env.B24_EVALUATOR_DATABASE_URL}),other=new Client({connectionString:process.env.B24_EVALUATOR_DATABASE_URL}),roster=new Client({connectionString:process.env.B22_ROSTER_DATABASE_URL}),ingest=new Client({connectionString:process.env.B22_INGEST_DATABASE_URL}),matcher=new Client({connectionString:process.env.B22_MATCH_DATABASE_URL});
await Promise.all([owner.connect(),approver.connect(),evaluator.connect(),other.connect(),roster.connect(),ingest.connect(),matcher.connect()]);
try{
 const inventory=(await owner.query('SELECT a."buyerId",a."quantityWh"::text AS quantity,a."amountBaseUnits"::text AS amount,a."marketId" FROM "V2Allocation" a JOIN "V2AllocationPlan" p ON p.id=a."planId" WHERE p.status=\'AUTHORITATIVE\' ORDER BY a."buyerId"')).rows;console.log('B24 synthetic market inventory',JSON.stringify(inventory));
 const allocation=(await owner.query('SELECT a.* FROM "V2Allocation" a JOIN "V2AllocationPlan" p ON p.id=a."planId" WHERE a."quantityWh"=28 AND a."unitPriceMicrousdPerKwh"=90750 AND p.status=\'AUTHORITATIVE\'')).rows[0];assert.ok(allocation);
 const artifact=JSON.parse(readFileSync(new URL('../packages/contracts/artifacts/contracts/EnergyTradingDirectSettlement.sol/EnergyTradingDirectSettlement.json',import.meta.url)));
 const deployment='aaaaaaaa-3333-4333-8333-333333333333',policy='bbbbbbbb-3333-4333-8333-333333333333',token='0x'+'2'.repeat(40),contract='0x'+'1'.repeat(40);
 await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'offline artifact fixture\',now())',[deployment,contract,token,keccak256(artifact.deployedBytecode),keccak256(artifact.bytecode)]);
 await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,$6,2541,2541,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',1,\'ignored\',\'synthetic grant\')',[policy,allocation.buyerId,allocation.buyerAddress,deployment,token,allocation.marketId]);
 for(const sql of ['INSERT INTO "B24SpendingPolicy" DEFAULT VALUES','INSERT INTO "B24Deployment" DEFAULT VALUES','UPDATE "V2SnapshotMeasurement" SET "productionWh"="productionWh" WHERE false','UPDATE "V2Allocation" SET status=status WHERE false','SELECT encrypted_private_key FROM wallets LIMIT 1','INSERT INTO "V2SettlementEvidence" DEFAULT VALUES','ALTER TABLE "V2Allocation" DISABLE TRIGGER ALL','CREATE TABLE public.b24a1_forbidden(id int)'])await assert.rejects(evaluator.query(sql),e=>e.code==='42501');
 const req={slot:'2026-10-03T12:00:00Z',allocationId:allocation.id,policyId:policy,deploymentId:deployment};
 const principals=(await owner.query('SELECT d."approvalPrincipal",p.approver,p."consentKind" FROM "B24Deployment" d JOIN "B24SpendingPolicy" p ON p."deploymentId"=d.id WHERE d.id=$1',[deployment])).rows[0];assert.deepEqual(principals,{approvalPrincipal:'b24_approver',approver:'b24_approver',consentKind:'SIMULATED_TEST'});
 await assert.rejects(evaluator.query('UPDATE "B24Deployment" SET status=\'RETIRED\' WHERE id=$1',[deployment]),e=>e.code==='42501');


 await assert.rejects(prepareAuthorization(evaluator,{...req,policyId:'ffffffff-ffff-4fff-8fff-ffffffffffff'}),/Policy or deployment not approved/);
 await assert.rejects(prepareAuthorization(evaluator,{...req,slot:'2026-10-17T10:00:00Z'}),/Historical source not finalized/);
 const draft=(await owner.query('SELECT a.id FROM "V2Allocation" a JOIN "V2AllocationPlan" p ON p.id=a."planId" WHERE p.status=\'DRAFT\' LIMIT 1')).rows[0];assert.ok(draft);
 await assert.rejects(prepareAuthorization(evaluator,{...req,slot:'2026-10-17T13:00:00Z',allocationId:draft.id,execute:true}),/Authoritative plan missing or ambiguous/);

 const low='cccccccc-3333-4333-8333-333333333333';
 await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") SELECT $1,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId",1,1,"effectiveAt","expiresAt",status,"consentKind",2,approver,"auditReference" FROM "B24SpendingPolicy" WHERE id=$2',[low,policy]);
 await assert.rejects(prepareAuthorization(evaluator,{...req,policyId:low,execute:true}),/PER_ALLOCATION_LIMIT/);
 const bad='dddddddd-3333-4333-8333-333333333333';
 await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'incorrect fingerprint fixture\',now())',[bad,'0x'+'3'.repeat(40),token,'0x'+'0'.repeat(64),keccak256(artifact.bytecode)]);
 await assert.rejects(prepareAuthorization(evaluator,{...req,deploymentId:bad,execute:true}),/Deployment not approved as test fixture/);

 const unverified='99999999-3333-4333-8333-333333333333';
 await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'UNVERIFIED\',31337,$2,$3,6,$4,$5,\'ignored\',\'not verified\',now())',[unverified,'0x'+'5'.repeat(40),token,keccak256(artifact.deployedBytecode),keccak256(artifact.bytecode)]);
 await assert.rejects(prepareAuthorization(evaluator,{...req,deploymentId:unverified,execute:true}),/Deployment not approved as test fixture/);
 const revoked='88888888-3333-4333-8333-333333333333',expired='77777777-3333-4333-8333-333333333333',wrongWallet='66666666-3333-4333-8333-333333333333';
 for(const id of [revoked,expired,wrongWallet])await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") SELECT $1,"buyerId",CASE WHEN $1=$3::uuid THEN $4 ELSE "buyerAddress" END,"deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit",CASE WHEN $1=$5::uuid THEN now()-interval \'2 hours\' ELSE "effectiveAt" END,CASE WHEN $1=$5::uuid THEN now()-interval \'1 hour\' ELSE "expiresAt" END,status,"consentKind",5,approver,"auditReference" FROM "B24SpendingPolicy" WHERE id=$2',[id,policy,wrongWallet,'0x'+'9'.repeat(40),expired]);
 await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[revoked]);
 await assert.rejects(prepareAuthorization(evaluator,{...req,policyId:revoked,execute:true}),/POLICY_REVOKED/);
 await assert.rejects(prepareAuthorization(evaluator,{...req,policyId:expired,execute:true}),/POLICY_EXPIRED/);
 await assert.rejects(prepareAuthorization(evaluator,{...req,policyId:wrongWallet,execute:true}),/POLICY_SCOPE_MISMATCH/);
 await assert.rejects(evaluator.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]),e=>e.code==='42501');
 // A corrupted plan result is rejected before a reservation is written.
 const queryBefore=evaluator.query.bind(evaluator);let planAltered=false;
 try{evaluator.query=async(...args)=>{const result=await queryBefore(...args);if(!planAltered&&typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM "V2AllocationPlan" WHERE')&&result.rowCount===1){result.rows[0].manifestHash='0x'+'0'.repeat(64);planAltered=true;}return result;};await assert.rejects(prepareAuthorization(evaluator,{...req,execute:true}),/Conflicting historical plan identity or manifest/);assert.equal(planAltered,true);}finally{evaluator.query=queryBefore;}
 const original=evaluator.query.bind(evaluator);let injected=false;
 try{evaluator.query=async(...args)=>{if(args[0]==='COMMIT'&&!injected){injected=true;throw Error('injected precommit failure');}return original(...args);};await assert.rejects(prepareAuthorization(evaluator,{...req,execute:true}),/injected precommit failure/);assert.equal(injected,true);}finally{evaluator.query=original;}
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "B24AuthorizationReservation"')).rows[0].n,0);
 const preview=await prepareAuthorization(evaluator,req);assert.equal(preview.persisted,false);assert.equal(preview.terms.terms.amountBaseUnits,'2541');assert.equal((await owner.query('SELECT count(*)::int AS n FROM "B24AuthorizationReservation"')).rows[0].n,0);
 const results=await Promise.all([prepareAuthorization(evaluator,{...req,execute:true}),prepareAuthorization(other,{...req,execute:true})]);assert.deepEqual(results.map(r=>r.reused).sort(),[false,true]);assert.equal(results[0].reservation.id,results[1].reservation.id);
 const stored=(await owner.query('SELECT * FROM "B24AuthorizationReservation" WHERE "allocationId"=$1',[allocation.id])).rows;assert.equal(stored.length,1);assert.equal(stored[0].amountBaseUnits,'2541');assert.equal(stored[0].nonce,'0');assert.ok(stored[0].deadline>Date.now());
 const replay=await prepareAuthorization(evaluator,{...req,execute:true});assert.equal(replay.reservation.id,stored[0].id);assert.equal(replay.reservation.settlementId,stored[0].settlementId);
 const counts=(await owner.query('SELECT (SELECT count(*)::int FROM "V2SettlementIntent") intents,(SELECT count(*)::int FROM "V2SettlementAttempt") attempts,(SELECT count(*)::int FROM "V2SettlementEvidence") evidence')).rows[0];assert.deepEqual(counts,{intents:0,attempts:0,evidence:0});
 console.log(JSON.stringify({status:'PASS B24-A1 exact reservation',allocationId:allocation.id,amountBaseUnits:stored[0].amountBaseUnits,nonce:stored[0].nonce,settlementId:stored[0].settlementId,concurrentReplay:true}));
 // A second approved offline deployment cannot reserve an already reserved allocation.
 const alt='eeeeeeee-3333-4333-8333-333333333333',altPolicy='ffffffff-3333-4333-8333-333333333333';
 await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'alternate fixture\',now())',[alt,'0x'+'4'.repeat(40),token,keccak256(artifact.deployedBytecode),keccak256(artifact.bytecode)]);
 await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") SELECT $1,"buyerId","buyerAddress",$2,"tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",3,approver,"auditReference" FROM "B24SpendingPolicy" WHERE id=$3',[altPolicy,alt,policy]);
 await assert.rejects(prepareAuthorization(other,{...req,deploymentId:alt,policyId:altPolicy,execute:true}),/Conflicting existing reservation/);
 // Produce two additional real B22 finalized markets for the same buyer.
 const profiles=(await owner.query('SELECT profiles FROM "B22HourlyRegistry" WHERE "intervalStart"=$1 ORDER BY revision DESC LIMIT 1',['2026-10-17T08:00:00Z'])).rows[0].profiles;profiles[0].reputation--;
 const slots=['2026-06-29T12:00:00Z','2026-01-21T15:00:00Z'],ids=['11111111-4444-4444-8444-444444444444','22222222-4444-4444-8444-444444444444'],markets=[];
 for(let i=0;i<slots.length;i++){const end=new Date(Date.parse(slots[i])+3600000).toISOString();await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,\'ignored\',1)',[ids[i],slots[i],end,JSON.stringify(profiles)]);await ingestLocalHour(ingest,slots[i],{execute:true});const plan=await processFinalizedHour(matcher,slots[i],{execute:true});assert.equal(plan.status,'AUTHORITATIVE');markets.push(plan);}
 const selected=markets.map(m=>m.allocations.find(a=>a.buyerId===allocation.buyerId));assert.ok(selected.every(Boolean));
 const shared='33333333-4444-4444-8444-444444444444';
 await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,NULL,60000,55000,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',4,\'ignored\',\'budget concurrency\')',[shared,allocation.buyerId,allocation.buyerAddress,deployment,token]);
 let release,signal;const gate=new Promise(r=>release=r),reached=new Promise(r=>signal=r),real=evaluator.query.bind(evaluator);let paused=false;
 evaluator.query=async(...args)=>{if(!paused&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO "B24AuthorizationReservation"')){paused=true;signal();await gate;}return real(...args);};
 try{
  const first=prepareAuthorization(evaluator,{slot:slots[0],allocationId:selected[0].allocationId,policyId:shared,deploymentId:deployment,execute:true}).then(value=>({value}),error=>({error}));await reached;
  const second=prepareAuthorization(other,{slot:slots[1],allocationId:selected[1].allocationId,policyId:shared,deploymentId:deployment,execute:true}).then(value=>({value}),error=>({error}));
  let blocked=false;for(let i=0;i<200;i++){const wait=(await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[other.processID])).rows[0];if(wait?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,25));}assert.equal(blocked,true);
  release();const won=await first,lost=await second;assert.equal(won.value?.state,'RESERVED');assert.equal(won.value.reservation.nonce,'1');assert.match(lost.error?.message??'',/CUMULATIVE_LIMIT|budget exceeded/);
 }finally{release();evaluator.query=real;}
 const spending=(await owner.query('SELECT count(*)::int AS n,sum("amountBaseUnits")::text AS total FROM "B24AuthorizationReservation" WHERE "policyId"=$1',[shared])).rows[0];assert.equal(spending.n,1);assert.ok(BigInt(spending.total)<=55000n);
 console.log('PASS cross-deployment conflict and independently authenticated concurrent budget serialization',JSON.stringify(spending));

 // Historical reservations remain immutable and consume budget after eligibility changes.
 const reservationState=async()=> (await owner.query('SELECT row_to_json(r) AS reservation,(SELECT count(*)::int FROM "B24AuthorizationReservation" WHERE "allocationId"=$1) AS allocation_count,(SELECT count(*)::int FROM "B24AuthorizationReservation" WHERE "deploymentId"=$2 AND "buyerAddress"=$3 AND nonce=$4) AS nonce_count,(SELECT sum("amountBaseUnits")::text FROM "B24AuthorizationReservation" WHERE "policyId"=$5) AS reserved FROM "B24AuthorizationReservation" r WHERE r.id=$6',[allocation.id,deployment,allocation.buyerAddress,stored[0].nonce,policy,stored[0].id])).rows[0];
 const baseline=await reservationState();assert.equal(baseline.reserved,'2541');assert.equal(baseline.allocation_count,1);assert.equal(baseline.nonce_count,1);
 const checkBlocked=async(state,reason)=>{const result=await prepareAuthorization(evaluator,{...req,execute:true});assert.equal(result.state,state);assert.equal(result.reason,reason);assert.equal(result.currentEligibility,'BLOCKED');assert.equal(result.historicalStatus,'RESERVED');assert.equal(result.reservationId,stored[0].id);assert.equal('reservation' in result,false);assert.deepEqual(await reservationState(),baseline);};
 const realNow=Date.now;
 try{
  const expiry=(await owner.query('SELECT "expiresAt" FROM "B24SpendingPolicy" WHERE id=$1',[policy])).rows[0].expiresAt;
  Date.now=()=>expiry.getTime()+1000;await checkBlocked('EXPIRED','POLICY_EXPIRED');
  Date.now=()=>stored[0].deadline.getTime()+1000;await checkBlocked('EXPIRED','AUTHORIZATION_DEADLINE_EXPIRED');
 }finally{Date.now=realNow;}
 await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]);
 await checkBlocked('REVOKED','POLICY_REVOKED');
 await approver.query('UPDATE "B24Deployment" SET status=\'RETIRED\' WHERE id=$1',[deployment]);
 await checkBlocked('BLOCKED','DEPLOYMENT_NOT_APPROVED');
 const audit=await inspectReservation(evaluator,allocation.id);assert.equal(audit.historicalStatus,'RESERVED');assert.equal(audit.currentEligibility,'NOT_EVALUATED');assert.equal(audit.reservation.id,stored[0].id);assert.deepEqual(await reservationState(),baseline);
 assert.deepEqual((await owner.query('SELECT (SELECT count(*)::int FROM "V2SettlementIntent") intents,(SELECT count(*)::int FROM "V2SettlementAttempt") attempts,(SELECT count(*)::int FROM "V2SettlementEvidence") evidence')).rows[0],{intents:0,attempts:0,evidence:0});
 console.log('PASS reservation replay: policy expiry, deadline expiry, revocation, retirement and immutable budget/audit');


}finally{await Promise.allSettled([owner.end(),approver.end(),evaluator.end(),other.end(),roster.end(),ingest.end(),matcher.end()]);}
