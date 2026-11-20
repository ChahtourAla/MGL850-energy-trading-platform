/** Offline checks of candidate immutable facts, not a trust or authorization boundary. */
import {matchingInputHash,allocationId,paymentParts} from '../../../packages/shared/v2-identity.mjs';
import {planCommitment} from '../../../packages/contracts/src/b23-identity.ts';

export function verifyCandidatePlan({marketId,snapshotId,planId,snapshotHash,manifest,manifestHash,planVersion,allocations}){
 if(matchingInputHash(manifest)!==manifestHash || manifest.marketId!==marketId || manifest.snapshotHash!==snapshotHash)throw Error('Manifest commitment mismatch');
 if(manifest.algorithmVersion!=='1.0.0'||manifest.pricingPolicyVersion!=='SELLER_ASK_V1')throw Error('Unsupported matching policy');
 if(!Array.isArray(allocations))throw Error('Allocation set required');
 const participants=new Map(manifest.participants.map(x=>[x.userId,x])), totals=new Map(manifest.participants.map(x=>[x.userId,0n])), buyers=new Set(), ids=new Set();
 for(const a of allocations){
  const b=participants.get(a.buyerId),s=participants.get(a.sellerId);
  if(!b||!s||b.marketRole!=='BUYER'||s.marketRole!=='SELLER'||buyers.has(a.buyerId)||ids.has(a.id))throw Error('Invalid allocation parties or duplicate');
  const q=BigInt(a.quantityWh),p=BigInt(a.unitPriceMicrousdPerKwh),money=paymentParts(a.quantityWh,a.unitPriceMicrousdPerKwh);
  if(a.marketId!==marketId||a.snapshotId!==snapshotId||a.planId!==planId||a.planVersion!==planVersion||a.algorithmVersion!==manifest.algorithmVersion||a.pricingVersion!==manifest.pricingPolicyVersion||a.status!=='VALIDATED'||q!==BigInt(b.requiredWh)||q>BigInt(s.availableWh)||p!==BigInt(s.askPriceMicrousdPerKwh)||p>BigInt(b.maxPriceMicrousdPerKwh)||a.buyerAddress!==b.evmAddress||a.sellerAddress!==s.evmAddress||(b.preferredEnergyType!=='ANY'&&b.preferredEnergyType!==s.energyType)||Math.hypot(Number(b.xKm)-Number(s.xKm),Number(b.yKm)-Number(s.yKm))>Number(manifest.maximumDistanceKm)||money.amountBaseUnits!==a.amountBaseUnits||money.amountBaseUnits==='0'||money.remainder!==0||a.remainder!==0)throw Error('Invalid allocation terms');
  const expected=allocationId(marketId,snapshotHash,b.userId,s.userId,b.evmAddress,s.evmAddress,a.quantityWh,a.unitPriceMicrousdPerKwh,manifest.algorithmVersion,manifest.pricingPolicyVersion,planVersion);
  if(a.id!==expected)throw Error('Allocation identity mismatch');
  ids.add(a.id);buyers.add(a.buyerId);totals.set(a.buyerId,totals.get(a.buyerId)+q);totals.set(a.sellerId,totals.get(a.sellerId)+q);
 }
 for(const p of manifest.participants)if(totals.get(p.userId)>BigInt(p.marketRole==='BUYER'?p.requiredWh:p.availableWh))throw Error('Aggregate position exceeded');
 return {commitment:planCommitment(marketId,snapshotHash,manifestHash,[...ids]),allocationCount:ids.size};
}
