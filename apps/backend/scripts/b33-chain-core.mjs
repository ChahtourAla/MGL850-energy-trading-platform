/** B33 dynamically verified V2 market and Hedera receipt proofs.
 * Does not alter B28's historical pinning or deployment. */
import {AbiCoder,Contract,Interface,getAddress,keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {marketId as deriveMarket,snapshotHash as deriveSnapshot,allocationId as deriveAllocation,matchingInputHash} from '../../../packages/shared/v2-identity.mjs';
import {quoteHalfEven,TOKEN,PRICING,CHAIN_ID} from './b28-hedera-core.mjs';
import {SETTLEMENT_ABI,TOKEN_ABI,algorithmId,policyId,TYPES,authorizationDigest,recoverBuyer} from './b28-hedera-runtime.mjs';
import {PAID_HOUR} from './b33-review-core.mjs';
const hash=/^0x[0-9a-f]{64}$/;const equal=(a,b)=>String(a??'').toLowerCase()===String(b??'').toLowerCase();
const settlementIface=new Interface(SETTLEMENT_ABI),tokenIface=new Interface(TOKEN_ABI);
export function verifyDayMarket(hour,{market,snapshot,plan,allocations,measurements,positions,importRecord}){
 if(hour.slot===PAID_HOUR||!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(hour.slot))throw Error('Historical 14:00 or noncanonical hour forbidden');
 const start=new Date(hour.slot);const mid=deriveMarket('hourly','HOURLY',start.toISOString(),new Date(start.getTime()+3600000).toISOString());
 if(mid!==hour.marketId||market?.id!==mid||market.status!=='MATCHED'||market.namespace!=='hourly'||market.mode!=='HOURLY'||new Date(market.intervalStart).toISOString()!==start.toISOString())throw Error('Market identity/status mismatch');
 if(snapshot?.id!==hour.snapshotId||snapshot.marketId!==mid||snapshot.status!=='FINALIZED'||snapshot.payloadHash!==hour.snapshotHash||snapshot.sourceIdentity!=='B11_LOCAL_SIMULATOR_V1'||snapshot.completeness?.b11PayloadSha256!==importRecord?.payload_sha256||importRecord?.id!==hour.snapshotId)throw Error('Finalized B11 source provenance mismatch');
 if(plan?.id!==hour.planId||plan.marketId!==mid||plan.snapshotId!==hour.snapshotId||plan.status!=='AUTHORITATIVE'||plan.manifestHash!==hour.manifestHash||plan.planVersion!==hour.planVersion||matchingInputHash(plan.manifest)!==hour.manifestHash||plan.manifest?.pricingPolicyVersion!==PRICING||plan.manifest?.algorithmVersion!=='1.0.0'||plan.manifest?.snapshotHash!==hour.snapshotHash||plan.manifest?.marketId!==mid)throw Error('Authoritative plan or manifest mismatch');
 if(measurements.length!==12||positions.length!==12||allocations.length!==hour.allocations.length||allocations.length<1)throw Error('Incomplete V2 market');
 const measured=new Map(measurements.map(m=>[m.userId,m]));if(measured.size!==12||deriveSnapshot(mid,measurements.map(m=>({userId:m.userId,productionWh:String(m.productionWh),consumptionWh:String(m.consumptionWh)})))!==hour.snapshotHash)throw Error('Snapshot measurements changed');
 const part=new Map(plan.manifest.participants.map(p=>[p.userId,p]));if(part.size!==12)throw Error('Manifest must have 12 unique participants');
 const pos=new Map(positions.map(x=>[x.userId,x]));if(pos.size!==12)throw Error('Missing or duplicate positions');
 for(const [id,m] of measured){const p=pos.get(id);if(!p||String(p.productionWh)!==String(m.productionWh)||String(p.consumptionWh)!==String(m.consumptionWh)||!part.has(id))throw Error('Stored market position differs from imported source');}
 const accepted=new Map(hour.allocations.map(a=>[a.id,a]));if(accepted.size!==allocations.length)throw Error('Duplicate approved allocation');
 for(const a of allocations){const approved=accepted.get(a.id);if(!approved||a.marketId!==mid||a.snapshotId!==hour.snapshotId||a.planId!==hour.planId||a.planVersion!==hour.planVersion||a.status!=='VALIDATED'||a.algorithmVersion!=='1.0.0'||a.pricingVersion!==PRICING)throw Error('Non-approved V2 allocation');
  const fields=['buyerId','sellerId','buyerAddress','sellerAddress','quantityWh','amountBaseUnits','remainder'];
  for(const k of fields){if(!equal(a[k],approved[k]))throw Error(`Changed reviewed allocation ${k}`);}
  if(String(a.unitPriceMicrousdPerKwh)!==approved.price)throw Error('Payment price changed');
  const b=part.get(a.buyerId),s=part.get(a.sellerId);
  if(!b||!s||b.marketRole!=='BUYER'||s.marketRole!=='SELLER'||!equal(b.evmAddress,a.buyerAddress)||!equal(s.evmAddress,a.sellerAddress))throw Error('Wallet or counterparty outside manifest');
  const exact=quoteHalfEven(a.quantityWh,a.unitPriceMicrousdPerKwh);if(exact.amountBaseUnits!==String(a.amountBaseUnits)||exact.remainder!==Number(a.remainder))throw Error('Half-even economic mismatch');
  const canonical=deriveAllocation(mid,hour.snapshotHash,a.buyerId,a.sellerId,a.buyerAddress.toLowerCase(),a.sellerAddress.toLowerCase(),String(a.quantityWh),String(a.unitPriceMicrousdPerKwh),'1.0.0',PRICING,hour.planVersion);
  if(canonical!==a.id)throw Error('Non-canonical buyer/seller-bound allocation id');
  accepted.delete(a.id);
 }
 if(accepted.size)throw Error('Approved allocations missing');
 return true;
}
export function marketPlanCommitment(hour){
 const ids=hour.allocations.map(a=>a.id.toLowerCase()).sort();if(!ids.length||new Set(ids).size!==ids.length||ids.some(x=>!hash.test(x)))throw Error('Invalid commitment allocation ids');
 return keccak256(AbiCoder.defaultAbiCoder().encode(['string','bytes32','bytes32','bytes32','bytes32[]'],['mgl850:b28:half-even-plan:1',hour.marketId,hour.snapshotHash,hour.manifestHash,ids]));
}
export function marketTerms(hour,a,nonce,deadline){
 if(!hour.allocations.some(v=>v.id===a.id))throw Error('Allocation not included in approved plan');
 return {token:getAddress(TOKEN),marketId:hour.marketId,snapshotHash:hour.snapshotHash,planCommitment:marketPlanCommitment(hour),allocationId:a.id,buyer:getAddress(a.buyerAddress),seller:getAddress(a.sellerAddress),quantityWh:BigInt(a.quantityWh),unitPriceMicrousdPerKwh:BigInt(a.unitPriceMicrousdPerKwh),amountBaseUnits:BigInt(a.amountBaseUnits),algorithmId,pricingPolicyId:policyId,nonce:BigInt(nonce),deadline:BigInt(deadline)};
}
/** Independently validates the canonical Hedera receipt and EXACT ERC-20 Transfer. */
export async function verifyMarketSettlement(provider,{hash:txHash,contract,hour,allocation:a,expectedDigest,operator}){
 const [tx,receipt]=await Promise.all([provider.getTransaction(txHash),provider.getTransactionReceipt(txHash)]);
 if(!tx||!receipt||receipt.status!==1||!equal(tx.hash,txHash)||!equal(tx.to,contract)||!equal(tx.from,operator)||!equal(receipt.to,contract)||BigInt(tx.value)!==0n)throw Error('Invalid/missing Hedera settlement receipt');
 const block=await provider.getBlock(receipt.blockNumber);if(!block||!equal(block.hash,receipt.blockHash))throw Error('Settlement block is not canonical');
 const call=settlementIface.parseTransaction({data:tx.data,value:tx.value});if(call?.name!=='settle')throw Error('Transaction is not settlement');
 const term=call.args[0],sign=call.args[1];const approved=marketTerms(hour,a,term.nonce,term.deadline);
 for(const f of TYPES.Settlement){if(f.type==='uint256'?BigInt(term[f.name])!==BigInt(approved[f.name]):!equal(term[f.name],approved[f.name]))throw Error('On-chain terms differ from approved V2 allocation');}
 const digest=authorizationDigest(approved,contract);if(digest!==expectedDigest||!recoverBuyer(approved,contract,sign))throw Error('Invalid buyer EIP712 signature or settlement digest');
 const settled=[],transfers=[];
 for(const log of receipt.logs){
  if(equal(log.address,contract)){try{const e=settlementIface.parseLog(log);if(e?.name==='EnergyPaymentSettled'&&equal(e.args.settlementId,digest)&&equal(e.args.marketId,hour.marketId)&&equal(e.args.allocationId,a.id)&&equal(e.args.snapshotHash,hour.snapshotHash)&&equal(e.args.planCommitment,approved.planCommitment)&&equal(e.args.buyer,a.buyerAddress)&&equal(e.args.seller,a.sellerAddress)&&equal(e.args.token,TOKEN)&&BigInt(e.args.quantityWh)===BigInt(a.quantityWh)&&BigInt(e.args.unitPriceMicrousdPerKwh)===BigInt(a.unitPriceMicrousdPerKwh)&&BigInt(e.args.amountBaseUnits)===BigInt(a.amountBaseUnits)&&equal(e.args.algorithmId,algorithmId)&&equal(e.args.pricingPolicyId,policyId)&&BigInt(e.args.nonce)===BigInt(term.nonce))settled.push(log);}catch{}}
  if(equal(log.address,TOKEN)){try{const e=tokenIface.parseLog(log);if(e?.name==='Transfer'&&equal(e.args.from,a.buyerAddress)&&equal(e.args.to,a.sellerAddress)&&BigInt(e.args.value)===BigInt(a.amountBaseUnits))transfers.push(log);}catch{}}
 }
 if(settled.length!==1||transfers.length!==1)throw Error('Missing or duplicated TEUSD transfer/settlement event');
 const c=new Contract(contract,SETTLEMENT_ABI,provider);
 const [executed,paid,used,pinnedPlan,pinnedSnapshot,onChainDigest]=await Promise.all([c.executedSettlements(digest),c.paidAllocations(a.id),c.usedNonces(a.buyerAddress,term.nonce),c.marketPlans(hour.marketId),c.marketSnapshots(hour.marketId),c.settlementId(approved)]);
 if(!executed||!paid||!used||!equal(pinnedPlan,approved.planCommitment)||!equal(pinnedSnapshot,hour.snapshotHash)||!equal(onChainDigest,digest))throw Error('Onchain replay/commitment proof failed');
 const recheck=await provider.getBlock(receipt.blockNumber);if(!recheck||!equal(recheck.hash,receipt.blockHash))throw Error('Noncanonical confirmation');
 return {txHash:txHash.toLowerCase(),blockHash:receipt.blockHash,blockNumber:receipt.blockNumber,settlementLogIndex:settled[0].index,transferLogIndex:transfers[0].index};
}
