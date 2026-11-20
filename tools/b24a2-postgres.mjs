import assert from 'node:assert/strict';
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifySigningPreflight} from '../apps/backend/scripts/b24a2-signing-preflight.mjs';
const {Client}=pg;
async function client(){const c=new Client({connectionString:process.env.B24_PREFLIGHT_DATABASE_URL});await c.connect();return c;}
export async function testEligible({owner,stored}){
 const c=await client();try{
  const before=(await owner.query('SELECT count(*)::int n, sum("amountBaseUnits")::text total FROM "B24AuthorizationReservation"')).rows[0];
  const result=await verifySigningPreflight(c,{reservationId:stored.id});assert.equal(result.state,'SIMULATION_ELIGIBLE');assert.equal(result.realSigningAuthorized,false);assert.equal(result.typedDataVerified,true);
  const contractDir=fileURLToPath(new URL('../packages/contracts/',import.meta.url));
  const cli=fileURLToPath(new URL('../packages/contracts/node_modules/hardhat/dist/src/cli.js',import.meta.url));
  const hardhat=spawnSync(process.execPath,[cli,'test','--no-compile','test/B24A2SigningPreflight.ts'],{cwd:contractDir,env:{...process.env,B24_A2_RESERVATION:JSON.stringify(stored.terms)},encoding:'utf8',timeout:60000});
  assert.equal(hardhat.status,0,`captured reservation Solidity digest: ${hardhat.stderr}`);assert.match(hardhat.stdout,/2 passing/);console.log('PASS captured PostgreSQL reservation digest matches Solidity on local simulated network');

  for(const sql of ['INSERT INTO "B24AuthorizationReservation" DEFAULT VALUES','UPDATE "B24AuthorizationReservation" SET status=status WHERE false','INSERT INTO "B24SpendingPolicy" DEFAULT VALUES','INSERT INTO "B24Deployment" DEFAULT VALUES','UPDATE "V2Snapshot" SET status=status WHERE false','UPDATE "V2Allocation" SET status=status WHERE false','INSERT INTO "V2SettlementEvidence" DEFAULT VALUES','SELECT encrypted_private_key FROM wallets LIMIT 1','ALTER TABLE "V2Allocation" DISABLE TRIGGER ALL','CREATE TABLE public.b24a2_forbidden(id int)'])await assert.rejects(c.query(sql),e=>e.code==='42501');
  const base=c.query.bind(c);
  const mutations={marketId:x=>x.marketId='0x'+'0'.repeat(64),snapshotHash:x=>x.terms.terms.snapshotHash='0x'+'0'.repeat(64),manifestHash:x=>x.planCommitment='0x'+'0'.repeat(64),allocationId:x=>x.allocationId='0x'+'0'.repeat(64),buyer:x=>x.buyerAddress='0x'+'9'.repeat(40),seller:x=>x.terms.terms.seller='0x'+'9'.repeat(40),quantity:x=>x.terms.terms.quantityWh='29',price:x=>x.terms.terms.unitPriceMicrousdPerKwh='2',amount:x=>x.amountBaseUnits='1',algorithm:x=>x.terms.terms.algorithmId='0x'+'0'.repeat(64),pricing:x=>x.terms.terms.pricingPolicyId='0x'+'0'.repeat(64),token:x=>x.terms.terms.token='0x'+'9'.repeat(40),chain:x=>x.terms.domain.chainId='1',contract:x=>x.terms.domain.verifyingContract='0x'+'9'.repeat(40),nonce:x=>x.nonce='-1',deadline:x=>x.terms.terms.deadline='1',digest:x=>x.settlementId='0x'+'0'.repeat(64),domainName:x=>x.terms.domain.name='other',domainVersion:x=>x.terms.domain.version='2',policyReference:x=>x.policyId='ffffffff-ffff-4fff-8fff-ffffffffffff',deploymentReference:x=>x.deploymentId='ffffffff-ffff-4fff-8fff-ffffffffffff',extraTerm:x=>x.terms.terms.unexpected='1',deadlineBeyondPolicy:x=>x.deadline=new Date('2099-01-01T00:00:00Z')};
  const expected={marketId:'MARKET_NOT_FOUND',snapshotHash:'TYPED_DATA_MISMATCH',manifestHash:'PLAN_COMMITMENT_MISMATCH',allocationId:'ALLOCATION_NOT_IN_PLAN',buyer:'RESERVATION_CONTEXT_MISMATCH',seller:'TYPED_DATA_MISMATCH',quantity:'TYPED_DATA_MISMATCH',price:'TYPED_DATA_MISMATCH',amount:'RESERVATION_CONTEXT_MISMATCH',algorithm:'TYPED_DATA_MISMATCH',pricing:'TYPED_DATA_MISMATCH',token:'TYPED_DATA_MISMATCH',chain:'TYPED_DATA_MISMATCH',contract:'TYPED_DATA_MISMATCH',nonce:'NONCE_UNIQUENESS',deadline:'TYPED_DATA_MISMATCH',digest:'TYPED_DATA_MISMATCH',domainName:'TYPED_DATA_MISMATCH',domainVersion:'TYPED_DATA_MISMATCH',policyReference:'POLICY_NOT_FOUND',deploymentReference:'DEPLOYMENT_NOT_FOUND',extraTerm:'TYPED_DATA_MISMATCH',deadlineBeyondPolicy:'DEADLINE_INVALID'};
  for(const [name,mutate] of Object.entries(mutations)){
   let injected=false;c.query=async(...args)=>{const q=await base(...args);if(!injected&&typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM "B24AuthorizationReservation" WHERE id=')&&q.rowCount){q.rows[0]=structuredClone(q.rows[0]);mutate(q.rows[0]);injected=true;}return q;};
   try{const rejected=await verifySigningPreflight(c,{reservationId:stored.id});assert.equal(injected,true,name);assert.equal(rejected.state,'BLOCKED',name);assert.equal(rejected.reason,expected[name],name);assert.equal(rejected.realSigningAuthorized,false,name);}finally{c.query=base;}
  }

  const cases=[
   ['policy revoked','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.status='REVOKED','POLICY_REVOKED'],
   ['policy expired','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>{x.effectiveAt=new Date('2000-01-01T00:00:00Z');x.expiresAt=new Date('2001-01-01T00:00:00Z');},'DEADLINE_INVALID'],
   ['policy not effective','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>{x.effectiveAt=new Date(Date.now()+60000);x.expiresAt=new Date(Date.now()+7200000);},'POLICY_NOT_EFFECTIVE'],
   ['policy wrong buyer','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.buyerId='ffffffff-ffff-4fff-8fff-ffffffffffff','POLICY_SCOPE_MISMATCH'],
   ['policy wallet','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.buyerAddress='0x'+'9'.repeat(40),'POLICY_SCOPE_MISMATCH'],
   ['policy scope','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.marketId='0x'+'9'.repeat(64),'POLICY_SCOPE_MISMATCH'],
   ['policy limit','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.perAllocationLimit='1','PER_ALLOCATION_LIMIT'],
   ['policy budget','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.cumulativeLimit='1','CUMULATIVE_LIMIT'],
   ['policy evidence','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.auditReference='','MISSING_APPROVAL_EVIDENCE'],
   ['policy version','SELECT * FROM "B24SpendingPolicy" WHERE id=',x=>x.version=0,'RESERVATION_CONTEXT_MISMATCH'],
   ['deployment retired','SELECT * FROM "B24Deployment" WHERE id=',x=>x.status='RETIRED','DEPLOYMENT_BLOCKED'],
   ['deployment unverified','SELECT * FROM "B24Deployment" WHERE id=',x=>x.status='UNVERIFIED','DEPLOYMENT_BLOCKED'],
   ['deployment fingerprint','SELECT * FROM "B24Deployment" WHERE id=',x=>x.codeHash='0x'+'0'.repeat(64),'DEPLOYMENT_INTEGRITY'],
   ['deployment chain','SELECT * FROM "B24Deployment" WHERE id=',x=>x.chainId=296,'DEPLOYMENT_INTEGRITY'],
   ['deployment token','SELECT * FROM "B24Deployment" WHERE id=',x=>x.tokenAddress='0x'+'9'.repeat(40),'TYPED_DATA_MISMATCH'],
   ['deployment contract','SELECT * FROM "B24Deployment" WHERE id=',x=>x.contractAddress='0x'+'9'.repeat(40),'TYPED_DATA_MISMATCH'],
   ['deadline expiry','SELECT current_database() db',x=>x.now=new Date(stored.deadline.getTime()+1000),'DEADLINE_INSUFFICIENT'],
   ['policy expiry by time','SELECT current_database() db',x=>x.now=new Date(stored.deadline.getTime()+3600000),'POLICY_EXPIRED']
  ];
  for(const [name,prefix,change,reason] of cases){let hit=false;c.query=async(...args)=>{const q=await base(...args);if(!hit&&typeof args[0]==='string'&&args[0].startsWith(prefix)&&q.rowCount){q.rows[0]=structuredClone(q.rows[0]);change(q.rows[0]);hit=true;}return q;};try{const r=await verifySigningPreflight(c,{reservationId:stored.id});assert.equal(hit,true,name);assert.equal(r.reason,reason,name);}finally{c.query=base;}}

  const missing=await verifySigningPreflight(c,{reservationId:'ffffffff-ffff-4fff-8fff-ffffffffffff'});assert.equal(missing.reason,'RESERVATION_NOT_FOUND');
  assert.deepEqual((await owner.query('SELECT count(*)::int n, sum("amountBaseUnits")::text total FROM "B24AuthorizationReservation"')).rows[0],before);
  console.log('PASS B24-A2 real 2541-unit read-only preflight, 41 corrupted read cases and 10 role denials');
 }finally{await c.end();}
}
export async function testRevoked({stored}){const c=await client();try{const r=await verifySigningPreflight(c,{reservationId:stored.id});assert.equal(r.reason,'POLICY_REVOKED');assert.equal(r.realSigningAuthorized,false);console.log('PASS B24-A2 post-reservation policy revocation blocks preflight');}finally{await c.end();}}
export async function testRetired({stored}){const c=await client();try{const r=await verifySigningPreflight(c,{reservationId:stored.id});assert.equal(r.reason,'DEPLOYMENT_BLOCKED');assert.equal(r.realSigningAuthorized,false);console.log('PASS B24-A2 retired deployment blocks preflight');}finally{await c.end();}}

export async function testRace({approver,policy,stored}){
 const c=await client();const base=c.query.bind(c);let release,signal;const gate=new Promise(r=>release=r),ready=new Promise(r=>signal=r);let paused=false;
 c.query=async(...args)=>{const result=await base(...args);if(!paused&&typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM "B24SpendingPolicy" WHERE id=')){paused=true;signal();await gate;}return result;};
 try{const pending=verifySigningPreflight(c,{reservationId:stored.id});await ready;await approver.query('UPDATE "B24SpendingPolicy" SET status=\'REVOKED\' WHERE id=$1',[policy]);release();const oldSnapshot=await pending;assert.equal(oldSnapshot.state,'SIMULATION_ELIGIBLE');c.query=base;const current=await verifySigningPreflight(c,{reservationId:stored.id});assert.equal(current.reason,'POLICY_REVOKED');console.log('PASS B24-A2 overlapping revocation: prior snapshot remains visible, next read blocks');}finally{release();c.query=base;await c.end();}
}
