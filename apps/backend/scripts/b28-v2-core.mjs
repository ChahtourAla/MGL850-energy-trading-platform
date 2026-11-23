/** B28.1: pure, deterministic V2 proposal transformation. No IO, no persistence. */
import {createHash} from 'node:crypto';
import {allocationId, matchingInputHash, snapshotHash, uint} from '../../../packages/shared/v2-identity.mjs';
import {B28_POLICY, quoteTeusd} from './b28-teusd-quantization.mjs';

export const B28_PLAN_PREFIX='b28-';
export const B28_PRICING_POLICY=B28_POLICY;
const hex64=/^0x[0-9a-f]{64}$/;
const digest=(domain,parts)=>'0x'+createHash('sha256').update(JSON.stringify([domain,...parts]),'ascii').digest('hex');

export function makeB28Proposal({source,legacy,sourceId}) {
  if (!source || !legacy || !Array.isArray(legacy.allocations) || !Array.isArray(legacy.positions) || !hex64.test(legacy.marketId) || !hex64.test(legacy.snapshotHash)) throw Error('B28 verified matching proposal required');
  if (legacy.marketId !== source.marketId || legacy.snapshotHash !== source.snapshotHash || legacy.manifestHash !== matchingInputHash(legacy.manifest)) throw Error('B28 source/proposal commitment mismatch');
  if (legacy.manifest.pricingPolicyVersion !== 'SELLER_ASK_V1' || legacy.manifest.algorithmVersion !== '1.0.0') throw Error('B28 only supports validated B22 V1 match replay');
  if (typeof sourceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sourceId)) throw Error('B11 source snapshot ID missing');
  if (!legacy.allocations.length) throw Error('B28 refuses to promote a no-match market');
  const manifest=Object.freeze({...legacy.manifest,pricingPolicyVersion:B28_PRICING_POLICY});
  const manifestHash=matchingInputHash(manifest);
  const planVersion=B28_PLAN_PREFIX+manifestHash.slice(2);
  const planId=digest('mgl850:b28:allocation-plan:1',[legacy.marketId,sourceId,manifestHash]);
  const people=new Map(manifest.participants.map(x=>[x.userId,x]));
  const seenIds=new Set(),seenBuyers=new Set(),totals=new Map(manifest.participants.map(x=>[x.userId,0n]));
  const allocations=legacy.allocations.map(a=>{
    const b=people.get(a.buyerId),s=people.get(a.sellerId);
    if(!b||!s||b.marketRole!=='BUYER'||s.marketRole!=='SELLER'||seenBuyers.has(a.buyerId)) throw Error('B28 invalid matching parties');
    const q=uint(a.quantityWh),p=uint(a.unitPriceMicrousdPerKwh);
    if(q!==BigInt(b.requiredWh)||q>BigInt(s.availableWh)||p!==BigInt(s.askPriceMicrousdPerKwh)||p>BigInt(b.maxPriceMicrousdPerKwh)) throw Error('B28 unapproved energy or price terms');
    const quote=quoteTeusd({quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.unitPriceMicrousdPerKwh,policy:B28_PRICING_POLICY});
    const maxPg=9223372036854775807n;
    if(BigInt(quote.amountBaseUnits)>maxPg) throw Error('B28 amount exceeds PostgreSQL bigint');
    const id=allocationId(legacy.marketId,legacy.snapshotHash,a.buyerId,a.sellerId,b.evmAddress,s.evmAddress,a.quantityWh,a.unitPriceMicrousdPerKwh,manifest.algorithmVersion,B28_PRICING_POLICY,planVersion);
    if(seenIds.has(id))throw Error('B28 duplicate allocation ID');
    seenIds.add(id);seenBuyers.add(a.buyerId);
    totals.set(a.buyerId,totals.get(a.buyerId)+q);
    totals.set(a.sellerId,totals.get(a.sellerId)+q);
    return Object.freeze({id,marketId:legacy.marketId,snapshotId:sourceId,planId,buyerId:a.buyerId,sellerId:a.sellerId,buyerAddress:b.evmAddress,sellerAddress:s.evmAddress,quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.unitPriceMicrousdPerKwh,amountBaseUnits:quote.amountBaseUnits,remainder:Number(quote.remainderOf1000),algorithmVersion:manifest.algorithmVersion,pricingVersion:B28_PRICING_POLICY,planVersion,status:'VALIDATED',roundingDeltaNumerator:quote.errorNumeratorOf1000BaseUnits});
  });
  const positions=manifest.participants.map(p=>{
    const qty=totals.get(p.userId),buyer=p.marketRole==='BUYER',seller=p.marketRole==='SELLER';
    const limit=BigInt(buyer?p.requiredWh:seller?p.availableWh:'0');
    if(qty>limit || (buyer&&qty!==0n&&qty!==limit))throw Error('B28 matching position exceeds or partially fills buyer');
    return Object.freeze({marketId:legacy.marketId,userId:p.userId,productionWh:p.productionWh,consumptionWh:p.consumptionWh,netEnergyWh:(BigInt(p.productionWh)-BigInt(p.consumptionWh)).toString(),role:p.marketRole,availableWh:p.availableWh,requiredWh:p.requiredWh,matchedBoughtWh:buyer?qty.toString():'0',matchedSoldWh:seller?qty.toString():'0',unmatchedDeficitWh:buyer?(limit-qty).toString():'0',unmatchedSurplusWh:seller?(limit-qty).toString():'0'});
  });
  if(positions.length!==legacy.positions.length||snapshotHash(legacy.marketId,positions.map(p=>({userId:p.userId,productionWh:p.productionWh,consumptionWh:p.consumptionWh})))!==legacy.snapshotHash)throw Error('B28 position conservation / source snapshot mismatch');
  return Object.freeze({marketId:legacy.marketId,snapshotId:sourceId,snapshotHash:legacy.snapshotHash,manifest,manifestHash,planId,planVersion,allocations,positions,policy:B28_PRICING_POLICY,simulationOnly:true});
}

/** Explicit SQL write plan. Caller must verify source, credentials, transaction, and role. */
export function buildB28Statements(plan,{slot,configHash,b11Import,b11Digest}){
  if(!plan?.allocations?.length||plan.policy!==B28_PRICING_POLICY||!hex64.test(plan.manifestHash)||plan.manifestHash!==matchingInputHash(plan.manifest)||plan.manifest.marketId!==plan.marketId||plan.manifest.snapshotHash!==plan.snapshotHash)throw Error('B28 invalid plan');
  if(!b11Import||b11Import.id!==plan.snapshotId||b11Import.generatorVersion!=='1.0.0'||b11Import.schemaVersion!=='1.0.0'||!/^\w{64}$/.test(b11Digest)||!hex64.test(configHash)||plan.manifest.intervalStart!==new Date(slot).toISOString())throw Error('B28 unverified imported source or config');
  const start=new Date(slot),end=new Date(start.getTime()+3600000);
  const add=(sql,values)=>({sql,values});
  const statements=[];
  statements.push(add('INSERT INTO "V2Market" (id,namespace,mode,"intervalStart","intervalEnd",status,"schemaVersion","configVersion","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())',[plan.marketId,'hourly','HOURLY',start,end,'DISCOVERED','2.0.0',B28_PRICING_POLICY]));
  statements.push(add('INSERT INTO "V2Snapshot" (id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)',[plan.snapshotId,plan.marketId,start,end,'B11_LOCAL_SIMULATOR_V1',b11Import.generatorVersion,configHash,plan.snapshotHash,'2.0.0',plan.positions.length,plan.positions.length,JSON.stringify({simulationOnly:true,b11SnapshotId:plan.snapshotId,b11PayloadSha256:b11Digest,expectedParticipants:plan.positions.length,integrity:'B11_FINGERPRINT_AND_REPLAY_VERIFIED'}),new Date(b11Import.importedAt),'PENDING']));
  for(const p of plan.positions)statements.push(add('INSERT INTO "V2SnapshotMeasurement" ("snapshotId","marketId","userId","productionWh","consumptionWh") VALUES ($1,$2,$3,$4,$5)',[plan.snapshotId,plan.marketId,p.userId,p.productionWh,p.consumptionWh]));
  statements.push(add('UPDATE "V2Snapshot" SET status=$1,"finalizedAt"=now(),finalizer=$2 WHERE id=$3 AND status=$4',['FINALIZED','b28_b11_verified',plan.snapshotId,'PENDING']));
  statements.push(add('UPDATE "V2Market" SET status=$1,"updatedAt"=now() WHERE id=$2 AND status=$3',['FINALIZED',plan.marketId,'DISCOVERED']));
  statements.push(add('INSERT INTO "V2AllocationPlan" (id,"marketId","snapshotId","planVersion","manifestHash",manifest,status) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',[plan.planId,plan.marketId,plan.snapshotId,plan.planVersion,plan.manifestHash,JSON.stringify(plan.manifest),'DRAFT']));
  for(const a of plan.allocations) statements.push(add('INSERT INTO "V2Allocation" (id,"marketId","snapshotId","planId","buyerId","sellerId","buyerAddress","sellerAddress","quantityWh","unitPriceMicrousdPerKwh","amountBaseUnits",remainder,"algorithmVersion","pricingVersion","planVersion",status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[a.id,a.marketId,a.snapshotId,a.planId,a.buyerId,a.sellerId,a.buyerAddress,a.sellerAddress,a.quantityWh,a.unitPriceMicrousdPerKwh,a.amountBaseUnits,a.remainder,a.algorithmVersion,a.pricingVersion,a.planVersion,'PLANNED']));
  for(const a of plan.allocations) statements.push(add('UPDATE "V2Allocation" SET status=$1 WHERE id=$2 AND status=$3',['VALIDATED',a.id,'PLANNED']));
  statements.push(add('UPDATE "V2AllocationPlan" SET status=$1 WHERE id=$2 AND status=$3',['AUTHORITATIVE',plan.planId,'DRAFT']));
  for(const p of plan.positions)statements.push(add('INSERT INTO "V2Position" ("marketId","userId","productionWh","consumptionWh","netEnergyWh",role,"availableWh","requiredWh","matchedBoughtWh","matchedSoldWh","unmatchedDeficitWh","unmatchedSurplusWh") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[p.marketId,p.userId,p.productionWh,p.consumptionWh,p.netEnergyWh,p.role,p.availableWh,p.requiredWh,p.matchedBoughtWh,p.matchedSoldWh,p.unmatchedDeficitWh,p.unmatchedSurplusWh]));
  statements.push(add('UPDATE "V2Market" SET status=$1,"updatedAt"=now() WHERE id=$2 AND status=$3',['MATCHED',plan.marketId,'FINALIZED']));
  return statements;
}

export function validateCommittedRows(plan,{market,snapshot,dbPlan,allocations,positions}){
 if(market?.id!==plan.marketId||market.status!=='MATCHED'||snapshot?.id!==plan.snapshotId||snapshot.status!=='FINALIZED'||snapshot.payloadHash!==plan.snapshotHash||dbPlan?.id!==plan.planId||dbPlan.status!=='AUTHORITATIVE'||dbPlan.manifestHash!==plan.manifestHash||dbPlan.planVersion!==plan.planVersion||allocations.length!==plan.allocations.length||positions.length!==plan.positions.length)throw Error('B28 persisted market/plan readback mismatch');
 const map=new Map(allocations.map(x=>[x.id,x]));
 for(const a of plan.allocations){const x=map.get(a.id);if(!x||x.planId!==a.planId||x.buyerId!==a.buyerId||x.sellerId!==a.sellerId||x.buyerAddress!==a.buyerAddress||x.sellerAddress!==a.sellerAddress||String(x.quantityWh)!==a.quantityWh||String(x.unitPriceMicrousdPerKwh)!==a.unitPriceMicrousdPerKwh||String(x.amountBaseUnits)!==a.amountBaseUnits||Number(x.remainder)!==a.remainder||x.pricingVersion!==a.pricingVersion||x.status!=='VALIDATED')throw Error('B28 persisted allocation mismatch');}
 const pmap=new Map(positions.map(x=>[x.userId,x]));
 for(const p of plan.positions){const x=pmap.get(p.userId);if(!x||x.marketId!==p.marketId||x.role!==p.role||['productionWh','consumptionWh','matchedBoughtWh','matchedSoldWh','unmatchedDeficitWh','unmatchedSurplusWh'].some(k=>String(x[k])!==p[k]))throw Error('B28 persisted position mismatch');}
 return {marketId:plan.marketId,planId:plan.planId,allocations:allocations.length,positions:positions.length};
}
