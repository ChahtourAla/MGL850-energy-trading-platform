/** Pure B28.2-B28.4 invariants. Never accesses credentials, PostgreSQL or Hedera. */
import {TARGET} from './b28-one-step-core.mjs';
import {allocationId as deriveAllocationId} from '../../../packages/shared/v2-identity.mjs';
export const MARKET = '0x5661be2e34e1c2631f517dca6e879932671b78f8d4edc3df85350d2e80972188';
export const PLAN = '0x72bfa3a65778cf258563c6acf6813f615c974f5a7a222547ee477f247e1f1a25';
export const SNAPSHOT = '7372cfa7-d41f-5246-969a-5ccfb6033a7f';
export const SNAPSHOT_HASH = '0x11cf62562f9ad041d14e4c937db532419cbac7751f6fc4af8248a860bbb08f62';
export const MANIFEST_HASH = '0x2afa930c478a06e7106fd367e028174b1e45fa1f84c029185d57a1b40adf28e7';
export const TOKEN = '0x5B529135D699244D1247877353EaFdC429892bed';
export const LEGACY_SETTLEMENT = '0xcbFfe6349c3337270d50AB8bb2f41E88E136D586';
export const ADMIN = '0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4';
export const PRICING = 'b28-teusd-half-even-1';
export const PINNED_PLAN_VERSION='b28-'+MANIFEST_HASH.slice(2);
export const CHAIN_ID = 296;
export const CHOSEN = Object.freeze({
  buyerId:'bf625602-1885-5938-8982-d6058d51e5cc',
  sellerId:'849a45cc-f3b2-5c75-8fe9-3e371ceea410',
  buyerAddress:'0x5e77aa89C832f9d1cD2D7a28EcC622563031CB0F',
  sellerAddress:'0x133b23B613209cA21ea8A6138f7215c288E5C99F',
  quantityWh:'246',amountBaseUnits:'20956',remainder:494,
});
const integer=/^(0|[1-9][0-9]*)$/;
const hex64=/^0x[0-9a-f]{64}$/;
const addr=/^0x[0-9a-f]{40}$/i;
export function uint(input,label='integer') {
  const s=String(input);
  if (!integer.test(s)) throw Error(`Invalid ${label}`);
  return BigInt(s);
}
export function quoteHalfEven(quantity,price) {
  const q=uint(quantity,'quantity'),p=uint(price,'price');
  if(!q||!p||q>9223372036854775807n||p>9223372036854775807n) throw Error('Invalid pricing terms');
  const product=q*p, floor=product/1000n, r=product%1000n;
  const amount=floor+((r>500n||(r===500n&&floor%2n===1n))?1n:0n);
  if(!amount||amount>9223372036854775807n)throw Error('Non-payable amount');
  return {amountBaseUnits:amount.toString(),remainder:Number(r),errorNumerator:(amount*1000n-product).toString()};
}
export function assertAllocation(a) {
  if (!a||a.marketId!==MARKET||a.planId!==PLAN||a.snapshotId!==SNAPSHOT||a.status!=='VALIDATED'||a.pricingVersion!==PRICING||a.algorithmVersion!=='1.0.0'||!hex64.test(a.id)||!addr.test(a.buyerAddress)||!addr.test(a.sellerAddress)||!Number.isInteger(Number(a.remainder)))throw Error('Untrusted allocation identity');
  const calc=quoteHalfEven(a.quantityWh,a.unitPriceMicrousdPerKwh);
  if(calc.amountBaseUnits!==String(a.amountBaseUnits)||calc.remainder!==Number(a.remainder))throw Error('Incorrect rounded price');
  return a;
}
export function assertPinnedMarket(market,snapshot,plan,allocations,allocationId=null) {
  if(market?.id!==MARKET||market?.status!=='MATCHED'||market.namespace!=='hourly'||market.mode!=='HOURLY'||snapshot?.id!==SNAPSHOT||snapshot.marketId!==MARKET||snapshot.status!=='FINALIZED'||snapshot.payloadHash!==SNAPSHOT_HASH||plan?.id!==PLAN||plan.snapshotId!==SNAPSHOT||plan.marketId!==MARKET||plan.status!=='AUTHORITATIVE'||plan.manifestHash!==MANIFEST_HASH||plan.planVersion!==PINNED_PLAN_VERSION||plan.manifest?.snapshotHash!==SNAPSHOT_HASH||plan.manifest?.pricingPolicyVersion!==PRICING)throw Error('B28.1 authoritative plan readback mismatch');
  if(!Array.isArray(allocations)||allocations.length!==3||new Set(allocations.map(x=>x.id)).size!==3)throw Error('B28.1 expected three unique allocations');
  allocations.forEach(assertAllocation);
  if(allocations.reduce((s,a)=>s+BigInt(a.amountBaseUnits),0n)!==458177n)throw Error('Historical allocation total mismatch');
  // Bind *every* payable allocation to the previously verified B28.1 economic terms.
  // A successful total alone would allow swapping buyers/sellers or terms across rows.
  const expected=new Map(TARGET.matches.map(x=>[`${x.buyer}/${x.seller}`,x]));
  for(const a of allocations){
    const key=`${a.buyerId}/${a.sellerId}`;
    const x=expected.get(key);
    if(!x||String(a.quantityWh)!==x.q||String(a.unitPriceMicrousdPerKwh)!==x.price||
      String(a.amountBaseUnits)!==x.base||Number(a.remainder)!==x.remainder||
      a.buyerAddress.toLowerCase()===a.sellerAddress.toLowerCase()||
      a.planVersion!==PINNED_PLAN_VERSION)
      throw Error('B28 approved household/energy/payment terms mismatch');
    // Recompute the canonical allocation ID, including buyer/seller wallets,
    // instead of trusting a database ID supplied alongside modified addresses.
    const canonical=deriveAllocationId(MARKET,SNAPSHOT_HASH,a.buyerId,a.sellerId,
      a.buyerAddress.toLowerCase(),a.sellerAddress.toLowerCase(),String(a.quantityWh),String(a.unitPriceMicrousdPerKwh),
      a.algorithmVersion,a.pricingVersion,PINNED_PLAN_VERSION);
    if(a.id!==canonical)throw Error('B28 allocation ID does not match canonical wallet-bound identity');
    expected.delete(key);
  }
  if(expected.size)throw Error('B28 authoritative household allocations incomplete');
  const chosen=allocations.find(a=>a.buyerId===CHOSEN.buyerId&&a.sellerId===CHOSEN.sellerId);
  if(!chosen||chosen.buyerAddress.toLowerCase()!==CHOSEN.buyerAddress.toLowerCase()||
    chosen.sellerAddress.toLowerCase()!==CHOSEN.sellerAddress.toLowerCase())
    throw Error('Pinned first buyer/seller wallet mismatch');
  const selected=allocationId===null?chosen:allocations.find(a=>a.id===allocationId);
  if(!selected)throw Error('Requested allocation is not part of the verified B28.1 plan');
  return selected;
}
export function assertExecutionApproval(flags,chosen) {
  if(flags.mode!=='execute'||flags.allocation!==chosen.id||flags.amount!==String(chosen.amountBaseUnits)||flags.plan!==PLAN||flags.confirm!=='I_AUTHORIZE_ONE_HEDERA_TESTNET_TRADE'||flags.allowCustody!=='YES')throw Error('Explicit allocation/plan/amount and demo custody approval required');
  return true;
}
export function assertDeploymentInputs(admin,operator,pauser) {
  const all=[admin,operator,pauser];
  if(all.some(x=>typeof x!=='string'||!addr.test(x))||new Set(all.map(a=>a.toLowerCase())).size!==3)throw Error('Three distinct verified deployment role addresses required');
  if(admin.toLowerCase()!==ADMIN.toLowerCase())throw Error('Unapproved deployment administrator');
}
export function assertNoPrior(intent,attempts) {
  if(intent||attempts?.length)throw Error('Existing settlement activity: reconcile; never auto-repeat or replace authorization');
}
