/** B22-B disposable-only matching. No wallet, blockchain or payment operations. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {inspectHistoricalHour} from './b22a-ingestion.mjs';
import {prepareHourly,runHourlyDryRun} from './b22-hourly-core.mjs';
import {matchingInputHash,allocationId,paymentParts} from '../../../packages/shared/v2-identity.mjs';

const config=JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/shared/fixtures/matching-config.sample.json',import.meta.url)),'utf8'));
// Only backend-owned, versioned configurations are selectable; the second is disposable-test-only.
const configurations=Object.freeze({'v1-default':config,'v1-disposable-distance-test':Object.freeze({...config,scoringWeights:Object.freeze({quantity:0.2,price:0.3,distance:0.35,reputation:0.15})})});
const python=fileURLToPath(new URL('../../../.venv/Scripts/python.exe',import.meta.url));
const planId=(market,snapshot,hash)=>'0x'+createHash('sha256').update(JSON.stringify(['mgl850:b22:allocation-plan:1',market,snapshot,hash])).digest('hex');
async function source(client,slot,matchingConfig=config){
 const history=await inspectHistoricalHour(client,slot);
 if(history.state!=='FINALIZED')throw Error('Historical snapshot not verified and finalized');
 const snapshot=history.snapshots[0];
 const q=await client.query('SELECT i.payload,r.profiles FROM "B22Ingestion" i JOIN "B22HourlyRegistry" r ON r.id=i."registryId" WHERE i."snapshotId"=$1',[snapshot.snapshotId]);
 if(q.rowCount!==1)throw Error('Missing archived ingestion evidence');
 const {payload,profiles}=q.rows[0], options={sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:profiles.length};
 const prepared=prepareHourly(payload,{users:profiles},matchingConfig,options);
 if(prepared.snapshotHash!==snapshot.payloadHash||prepared.manifest.marketId!==history.marketId)throw Error('Archived input commitment mismatch');
 return {history,snapshot,payload,profiles,options,prepared};
}
function verifyReadback(proposal,plan,allocations,positions){
 if(plan.manifestHash!==proposal.manifestHash||plan.planVersion!==proposal.planVersion)throw Error('Persisted plan commitment mismatch');
 if(allocations.length!==proposal.allocations.length)throw Error('Incomplete or conflicting persisted draft');
 const indexed=new Map(allocations.map(a=>[a.id,a]));
 for(const a of proposal.allocations){const stored=indexed.get(a.allocationId);if(!stored||stored.quantityWh!==a.quantityWh||stored.unitPriceMicrousdPerKwh!==a.unitPriceMicrousdPerKwh||stored.amountBaseUnits!==a.amountBaseUnits||stored.remainder!==a.remainder||stored.status!==(proposal.policyBlocked?'PLANNED':'VALIDATED'))throw Error('Persisted allocation mismatch');}
 if(proposal.policyBlocked){if(plan.status!=='DRAFT'||positions.length)throw Error('Blocked draft has authoritative state');return;}
 if(plan.status!=='AUTHORITATIVE'||positions.length!==proposal.positions.length)throw Error('Incomplete authoritative projection');
 const byId=new Map(positions.map(p=>[p.userId,p]));
 for(const p of proposal.positions){const s=byId.get(p.userId);if(!s||s.role!==p.role||s.productionWh!==p.productionWh||s.consumptionWh!==p.consumptionWh||s.matchedBoughtWh!==(p.role==='BUYER'?p.matchedWh:'0')||s.matchedSoldWh!==(p.role==='SELLER'?p.matchedWh:'0')||s.unmatchedDeficitWh!==(p.role==='BUYER'?p.unmatchedWh:'0')||s.unmatchedSurplusWh!==(p.role==='SELLER'?p.unmatchedWh:'0'))throw Error('Persisted position mismatch');}
}
/** Validate persisted facts without calling the current Python matcher. */
async function reconcile(client,slot,history,plan){
 const m=plan.manifest;
 if(plan.marketId!==history.marketId||plan.snapshotId!==history.snapshots[0].snapshotId||matchingInputHash(m)!==plan.manifestHash||plan.id!==planId(plan.marketId,plan.snapshotId,plan.manifestHash)||plan.planVersion!==`b22-${plan.manifestHash.slice(2)}`)throw Error('Conflicting historical plan identity or manifest');
 const archivedConfig={schemaVersion:'1.0.0',algorithmVersion:m.algorithmVersion,maximumDistanceKm:Number(m.maximumDistanceKm),scoringWeights:Object.fromEntries(Object.entries(m.scoringWeights).map(([k,v])=>[k,Number(v)]))};
 const archived=await source(client,slot,archivedConfig);
 if(archived.prepared.manifestHash!==plan.manifestHash)throw Error('Historical manifest differs from archived evidence');
 const allocations=(await client.query('SELECT * FROM "V2Allocation" WHERE "planId"=$1',[plan.id])).rows;
 const rows=(await client.query('SELECT * FROM "V2Position" WHERE "marketId"=$1',[plan.marketId])).rows;
 const people=new Map(m.participants.map(p=>[p.userId,p])),totals=new Map(m.participants.map(p=>[p.userId,0n])),buyers=new Set();
 for(const a of allocations){
  const b=people.get(a.buyerId),s=people.get(a.sellerId);if(!b||!s||b.marketRole!=='BUYER'||s.marketRole!=='SELLER'||buyers.has(b.userId)||a.status!=='VALIDATED'||a.marketId!==plan.marketId||a.snapshotId!==plan.snapshotId||a.buyerAddress!==b.evmAddress||a.sellerAddress!==s.evmAddress||a.algorithmVersion!==m.algorithmVersion||a.pricingVersion!==m.pricingPolicyVersion||a.planVersion!==plan.planVersion)throw Error('Historical allocation identity mismatch');
  const q=BigInt(a.quantityWh),price=BigInt(a.unitPriceMicrousdPerKwh),parts=paymentParts(a.quantityWh,a.unitPriceMicrousdPerKwh);
  if(m.algorithmVersion==='1.0.0' && q!==BigInt(b.requiredWh))throw Error('V1 allocation must fully satisfy buyer demand');
  if(q<=0n||price!==BigInt(s.askPriceMicrousdPerKwh)||price>BigInt(b.maxPriceMicrousdPerKwh)||(b.preferredEnergyType!=='ANY'&&b.preferredEnergyType!==s.energyType)||Math.hypot(Number(b.xKm)-Number(s.xKm),Number(b.yKm)-Number(s.yKm))>Number(m.maximumDistanceKm)||parts.amountBaseUnits!==a.amountBaseUnits||parts.remainder!==a.remainder||parts.remainder!==0||parts.amountBaseUnits==='0'||a.id!==allocationId(plan.marketId,m.snapshotHash,b.userId,s.userId,b.evmAddress,s.evmAddress,a.quantityWh,a.unitPriceMicrousdPerKwh,m.algorithmVersion,m.pricingPolicyVersion,plan.planVersion))throw Error('Historical allocation terms mismatch');
  buyers.add(b.userId);totals.set(b.userId,totals.get(b.userId)+q);totals.set(s.userId,totals.get(s.userId)+q);
 }
 if(rows.length!==people.size)throw Error('Historical projection count mismatch');
 const byId=new Map(rows.map(r=>[r.userId,r]));let bought=0n,sold=0n;
 for(const p of m.participants){const r=byId.get(p.userId),n=BigInt(p.productionWh)-BigInt(p.consumptionWh),buyer=p.marketRole==='BUYER',seller=p.marketRole==='SELLER',matched=totals.get(p.userId),limit=BigInt(buyer?p.requiredWh:p.availableWh);if(matched>limit||!r||r.productionWh!==p.productionWh||r.consumptionWh!==p.consumptionWh||r.netEnergyWh!==String(n)||r.role!==p.marketRole||r.requiredWh!==(buyer?String(limit):'0')||r.availableWh!==(seller?String(limit):'0')||r.matchedBoughtWh!==(buyer?String(matched):'0')||r.matchedSoldWh!==(seller?String(matched):'0')||r.unmatchedDeficitWh!==(buyer?String(limit-matched):'0')||r.unmatchedSurplusWh!==(seller?String(limit-matched):'0'))throw Error('Historical participant accounting mismatch');if(buyer)bought+=matched;if(seller)sold+=matched;}
 if(bought!==sold)throw Error('Historical aggregate conservation mismatch');
 return {marketId:plan.marketId,snapshotId:plan.snapshotId,planId:plan.id,manifest:m,manifestHash:plan.manifestHash,status:plan.status,allocations,positions:rows,persisted:true,reused:true};
}

/** Explicitly restricted to the B22 disposable database and matching identity. */
export async function processFinalizedHour(client,slot,{execute=false,configuration}={}){
 const selectedConfig=configurations[configuration??'v1-default'];if(!selectedConfig||!Object.hasOwn(configurations,configuration??'v1-default'))throw Error('Unapproved matching configuration');
 const target=client.connectionParameters;if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b22_match')throw Error('Refusing non-disposable matching database target');
 const history=await inspectHistoricalHour(client,slot);
 if(history.state!=='FINALIZED')throw Error('Historical snapshot not verified and finalized');
 const prior=await client.query('SELECT * FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\'',[history.marketId]);
 if(prior.rowCount>1)throw Error('Multiple authoritative plans');
 if(prior.rowCount===1){if(configuration){const requested=await source(client,slot,selectedConfig);if(requested.prepared.manifestHash!==prior.rows[0].manifestHash)throw Error('Conflicting authoritative matching configuration');}return reconcile(client,slot,history,prior.rows[0]);}
 const first=await source(client,slot,selectedConfig);
 const proposal=await runHourlyDryRun(first.payload,{users:first.profiles},selectedConfig,{...first.options,python});
 if(proposal.manifestHash!==first.prepared.manifestHash)throw Error('Matching manifest changed');
 const id=planId(first.history.marketId,first.snapshot.snapshotId,proposal.manifestHash);
 if(!execute)return {...proposal,planId:id,snapshotId:first.snapshot.snapshotId};
 await client.query('BEGIN');
 try{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['B22A_MARKET',first.history.marketId]);
  const checked=await source(client,slot,selectedConfig);
  if(checked.snapshot.snapshotId!==first.snapshot.snapshotId||checked.prepared.manifestHash!==proposal.manifestHash)throw Error('Historical source changed during matching');
  const selected=await client.query('SELECT id FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\'',[proposal.marketId]);
  if(selected.rowCount&&selected.rows[0].id!==id)throw Error('Conflicting authoritative plan');
  const existing=await client.query('SELECT * FROM "V2AllocationPlan" WHERE id=$1',[id]);
  if(!existing.rowCount){
   const other=await client.query('SELECT id FROM "V2AllocationPlan" WHERE "marketId"=$1',[proposal.marketId]);if(other.rowCount)throw Error('Existing alternative or partial draft requires review');
   await client.query('INSERT INTO "V2AllocationPlan"(id,"marketId","snapshotId","planVersion","manifestHash",manifest) VALUES($1,$2,$3,$4,$5,$6)',[id,proposal.marketId,first.snapshot.snapshotId,proposal.planVersion,proposal.manifestHash,JSON.stringify(proposal.manifest)]);
   const people=new Map(proposal.manifest.participants.map(p=>[p.userId,p]));
   for(const a of proposal.allocations){const b=people.get(a.buyerId),s=people.get(a.sellerId);await client.query('INSERT INTO "V2Allocation"(id,"marketId","snapshotId","planId","buyerId","sellerId","buyerAddress","sellerAddress","quantityWh","unitPriceMicrousdPerKwh","amountBaseUnits",remainder,"algorithmVersion","pricingVersion","planVersion") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[a.allocationId,proposal.marketId,first.snapshot.snapshotId,id,a.buyerId,a.sellerId,b.evmAddress,s.evmAddress,a.quantityWh,a.unitPriceMicrousdPerKwh,a.amountBaseUnits,a.remainder,proposal.manifest.algorithmVersion,proposal.manifest.pricingPolicyVersion,proposal.planVersion]);}
   if(!proposal.policyBlocked){
    for(const a of proposal.allocations)await client.query('UPDATE "V2Allocation" SET status=\'VALIDATED\' WHERE id=$1',[a.allocationId]);
    await client.query('UPDATE "V2AllocationPlan" SET status=\'AUTHORITATIVE\' WHERE id=$1',[id]);
    for(const p of proposal.positions){const net=BigInt(p.productionWh)-BigInt(p.consumptionWh),buyer=p.role==='BUYER',seller=p.role==='SELLER';await client.query('INSERT INTO "V2Position"("marketId","userId","productionWh","consumptionWh","netEnergyWh",role,"availableWh","requiredWh","matchedBoughtWh","matchedSoldWh","unmatchedDeficitWh","unmatchedSurplusWh") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[proposal.marketId,p.userId,p.productionWh,p.consumptionWh,String(net),p.role,seller?String(net):'0',buyer?String(-net):'0',buyer?p.matchedWh:'0',seller?p.matchedWh:'0',buyer?p.unmatchedWh:'0',seller?p.unmatchedWh:'0']);}
    await client.query('UPDATE "V2Market" SET status=\'MATCHED\',"updatedAt"=now() WHERE id=$1',[proposal.marketId]);
   }
  }
  const plan=(await client.query('SELECT * FROM "V2AllocationPlan" WHERE id=$1',[id])).rows[0];
  const allocations=(await client.query('SELECT * FROM "V2Allocation" WHERE "planId"=$1',[id])).rows;
  const positions=(await client.query('SELECT * FROM "V2Position" WHERE "marketId"=$1',[proposal.marketId])).rows;
  verifyReadback(proposal,plan,allocations,positions);
  await client.query('COMMIT');return {...proposal,planId:id,snapshotId:first.snapshot.snapshotId,persisted:true,reused:!!existing.rowCount,status:plan.status};
 }catch(error){await client.query('ROLLBACK');throw error;}
}
