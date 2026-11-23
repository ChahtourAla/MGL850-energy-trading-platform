/** Pure B28.1 one-step admission and migration helpers. No database or blockchain access. */
import {createHash} from 'node:crypto';

export const MIGRATION_NAME='20261123010000_b28_half_even_authoritative_v2';
export const TARGET=Object.freeze({
 slot:'2026-11-10T14:00:00Z',
 marketId:'0x5661be2e34e1c2631f517dca6e879932671b78f8d4edc3df85350d2e80972188',
 planId:'0x72bfa3a65778cf258563c6acf6813f615c974f5a7a222547ee477f247e1f1a25',
 snapshotId:'7372cfa7-d41f-5246-969a-5ccfb6033a7f',
 totalBaseUnits:458177n,
 matches:Object.freeze([
  Object.freeze({buyer:'3e06a60f-af1f-5715-9712-1df78c6d1e26',seller:'e0742bb7-4b60-5679-b59b-35f36e7a75d0',q:'2572',price:'154714',base:'397924',remainder:408}),
  Object.freeze({buyer:'76cc42d6-ae03-514d-8a22-fcc1530a4a16',seller:'e0742bb7-4b60-5679-b59b-35f36e7a75d0',q:'254',price:'154714',base:'39297',remainder:356}),
  Object.freeze({buyer:'bf625602-1885-5938-8982-d6058d51e5cc',seller:'849a45cc-f3b2-5c75-8fe9-3e371ceea410',q:'246',price:'85189',base:'20956',remainder:494}),
 ])
});

export function assertTarget(plan,slot){
 if(slot!==TARGET.slot||plan?.marketId!==TARGET.marketId||plan?.planId!==TARGET.planId||plan?.snapshotId!==TARGET.snapshotId||plan?.policy!=='b28-teusd-half-even-1'||plan?.positions?.length!==12||plan?.allocations?.length!==3||plan?.manifest?.participants?.length!==12)throw Error('B28 target market/plan/source/participant identity mismatch; operation refused');
 let total=0n;
 const expected=new Map(TARGET.matches.map(x=>[`${x.buyer}/${x.seller}`,x]));
 for(const a of plan.allocations){
  const x=expected.get(`${a.buyerId}/${a.sellerId}`);
  if(!x||a.quantityWh!==x.q||a.unitPriceMicrousdPerKwh!==x.price||a.amountBaseUnits!==x.base||a.remainder!==x.remainder||a.status!=='VALIDATED')throw Error('B28 proposed household/energy/payment terms differ from approved preview');
  expected.delete(`${a.buyerId}/${a.sellerId}`);
  total+=BigInt(a.amountBaseUnits);
 }
 if(expected.size||total!==TARGET.totalBaseUnits)throw Error('B28 expected payment conservation failed');
 return {marketId:plan.marketId,planId:plan.planId,allocationCount:plan.allocations.length,totalBaseUnits:total.toString()};
}
export function assertAdminIdentity(r){
 if(r?.db!=='energy_trading'||r?.actor!=='energy_admin'||r?.session_actor!=='energy_admin')throw Error('B28 requires the exact local energy_admin database principal');
}
export function assertWriterIdentity(r){
 if(r?.db!=='energy_trading'||r?.actor!=='b28_market_writer'||r?.session_actor!=='energy_admin')throw Error('B28 restricted role switch failed');
}
export function assertSafeRole(role){
 if(!role)return;
 if(role.rolcanlogin||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls||role.rolinherit===false){
  throw Error('Existing B28 writer role is unsafe; manual DBA review required');
 }
}
export function pendingMigrations(dirs,rows){
 const failed=rows.filter(x=>x.finished_at==null&&x.rolled_back_at==null);
 if(failed.length)throw Error('Existing failed/unresolved Prisma migration: '+failed.map(x=>x.migration_name).join(', '));
 const completed=new Set(rows.filter(x=>x.finished_at!=null&&x.rolled_back_at==null).map(x=>x.migration_name));
 const unexpected=dirs.filter(x=>!completed.has(x)&&x!==MIGRATION_NAME);
 if(unexpected.length)throw Error('Unexpected pending Prisma migrations: '+unexpected.join(', '));
 return !completed.has(MIGRATION_NAME);
}
export function migrationMatches(def){return typeof def==='string'&&def.includes('b28-teusd-half-even-1')&&def.includes('amountBaseUnits')&&def.includes('remainder');}
export function sha256(v){return createHash('sha256').update(v).digest('hex');}

/** The B28 role is NOLOGIN and never receives a password or signing capabilities. */
export const ROLE_SETUP_SQL=`DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='b28_market_writer') THEN
  CREATE ROLE b28_market_writer NOLOGIN;
 END IF;
END $$;
GRANT CONNECT ON DATABASE energy_trading TO b28_market_writer;
GRANT USAGE ON SCHEMA public TO b28_market_writer;
GRANT SELECT ON TABLE public.energy_snapshot_imports, public.energy_records TO b28_market_writer;
GRANT SELECT (id,x_km,y_km,reputation,preferred_energy_type) ON public.users TO b28_market_writer;
GRANT SELECT (user_id,evm_address) ON public.wallets TO b28_market_writer;
GRANT SELECT, INSERT ON TABLE public."V2Market", public."V2Snapshot", public."V2SnapshotMeasurement", public."V2AllocationPlan", public."V2Allocation", public."V2Position" TO b28_market_writer;
GRANT UPDATE (status,"updatedAt") ON public."V2Market" TO b28_market_writer;
GRANT UPDATE (status,"finalizedAt",finalizer) ON public."V2Snapshot" TO b28_market_writer;
GRANT UPDATE (status) ON public."V2AllocationPlan" TO b28_market_writer;
GRANT UPDATE (status) ON public."V2Allocation" TO b28_market_writer;
GRANT b28_market_writer TO energy_admin;`;
