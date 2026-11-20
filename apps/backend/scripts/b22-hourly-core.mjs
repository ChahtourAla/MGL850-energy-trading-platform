/** B22 offline prototype: validated proposals only; never writes or signs. */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { checkSnapshot, requireHour } from './b11-pipeline-core.mjs';
import { makeMatchingInput, assertMatchingBusinessRules } from './b12-matching-core.mjs';
import { marketId, snapshotHash, matchingInputHash, allocationId, paymentParts } from '../../../packages/shared/v2-identity.mjs';
import { validateV2 } from './b21-v2-validator.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const schemas = ['common','user','user-registry','hourly-energy-record','energy-snapshot','matching-config','matching-input','match-result','matching-output'];
const ajv = new Ajv2020({allErrors:true, strict:false}); formats(ajv);
for (const name of schemas) ajv.addSchema(JSON.parse(readFileSync(join(root, 'packages/shared/schemas', `${name}.schema.json`), 'utf8')));
function validate(name, value) {
  const check = ajv.getSchema(`https://energy-trading.example/schemas/${name}.schema.json`);
  if (!check(value)) throw new Error(`Invalid ${name}: ${ajv.errorsText(check.errors)}`);
}
const decimal = n => {
  if (typeof n !== 'number' || !Number.isFinite(n) || /e/i.test(String(n))) throw Error('Noncanonical decimal input');
  return String(Object.is(n,-0) ? 0 : n);
};
const exact = (n, name) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error(`Invalid ${name}`);
  return String(n);
};

/** Independent V1 reference: greedy buyer order and complete seller ranking. */
export function verifyGreedySelection(input, output) {
  const buyers=input.users.filter(u=>u.marketRole==='BUYER').sort((a,b)=>b.requiredEnergyWh-a.requiredEnergyWh||a.userId.localeCompare(b.userId,'en'));
  const sellers=input.users.filter(u=>u.marketRole==='SELLER'), remaining=new Map(sellers.map(s=>[s.userId,s.availableEnergyWh]));
  const expected=[], unmatched=[], w=input.scoringWeights;
  for(const buyer of buyers){
    const candidates=[];
    for(const seller of sellers){
      const quantity=remaining.get(seller.userId), distance=Math.hypot(buyer.xKm-seller.xKm,buyer.yKm-seller.yKm);
      if(buyer.userId===seller.userId||buyer.evmAddress.toLowerCase()===seller.evmAddress.toLowerCase()||buyer.timeSlot!==seller.timeSlot||quantity<buyer.requiredEnergyWh||seller.askPriceMicrousdPerKwh>buyer.maxPriceMicrousdPerKwh||(buyer.preferredEnergyType!=='ANY'&&buyer.preferredEnergyType!==seller.energyType)||distance>input.maximumDistanceKm) continue;
      const score=Math.max(0,Math.min(1,w.quantity*(buyer.requiredEnergyWh/quantity)+w.price*(1-seller.askPriceMicrousdPerKwh/buyer.maxPriceMicrousdPerKwh)+w.distance*(1-distance/input.maximumDistanceKm)+w.reputation*(seller.reputation/100)));
      candidates.push({seller,distance,score});
    }
    candidates.sort((a,b)=>b.score-a.score||a.seller.askPriceMicrousdPerKwh-b.seller.askPriceMicrousdPerKwh||a.distance-b.distance||(a.seller.userId<b.seller.userId?-1:a.seller.userId>b.seller.userId?1:0));
    if(!candidates.length){unmatched.push(buyer.userId);continue;}
    const best=candidates[0];expected.push({buyerId:buyer.userId,sellerId:best.seller.userId,score:best.score,distance:best.distance});remaining.set(best.seller.userId,remaining.get(best.seller.userId)-buyer.requiredEnergyWh);
  }
  if(expected.length!==output.matches.length||unmatched.length!==output.unmatchedBuyerIds.length||unmatched.some((u,i)=>u!==output.unmatchedBuyerIds[i]))throw Error('Matching selection mismatch');
  expected.forEach((e,i)=>{const m=output.matches[i];if(m.buyerId!==e.buyerId||m.sellerId!==e.sellerId||Math.abs(m.score-e.score)>1e-12||Math.abs(m.distanceKm-e.distance)>1e-12)throw Error('Matching selection or score mismatch');});
}

/** Registry is a caller-supplied trust input, not proof of database ownership. */
export function prepareHourly(snapshot, registry, config, options = {}) {
  if (options.sourcePolicy !== 'LOCAL_SIMULATOR_V1' || snapshot?.generatorVersion !== '1.0.0') throw Error('Unapproved simulation source/version');
  validate('energy-snapshot', snapshot); validate('matching-config', config);
  if (snapshot.schemaVersion !== '1.0.0' || config.algorithmVersion !== '1.0.0') throw Error('Unsupported input or algorithm version');
  requireHour(snapshot.timeSlot);
  const start = new Date(snapshot.timeSlot).toISOString(), endMs = Date.parse(start) + 3600000;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || endMs > now) throw Error('Market interval is not completed');
  const end = new Date(endMs).toISOString();
  if (!Array.isArray(registry?.users) || !Number.isInteger(options.expectedUsers) || options.expectedUsers < 1 || registry.users.length !== options.expectedUsers) throw Error('Expected registry is missing or incomplete');
  const profiles = new Map(); const wallets = new Set();
  for (const p of registry.users) {
    if (typeof p.userId !== 'string' || p.userId !== p.userId.toLowerCase() || !/^0x[0-9a-f]{40}$/.test(p.evmAddress ?? '') || profiles.has(p.userId) || wallets.has(p.evmAddress)) throw Error('Invalid or duplicate registry identity');
    profiles.set(p.userId,p); wallets.add(p.evmAddress);
  }
  checkSnapshot(snapshot, registry, snapshot.timeSlot);
  const input = makeMatchingInput(snapshot,config,options.expectedUsers); validate('matching-input',input);
  const market = marketId('hourly','HOURLY',start,end);
  const measurements = input.users.map(u=>({userId:u.userId,productionWh:exact(u.productionWh,'production'),consumptionWh:exact(u.consumptionWh,'consumption')}));
  const hash = snapshotHash(market,measurements);
  const participants = input.users.map(u=>{
    const p=profiles.get(u.userId); if (!p || ['evmAddress','xKm','yKm','reputation','preferredEnergyType'].some(k=>p[k]!==u[k])) throw Error('Snapshot differs from trusted registry profile');
    const net=BigInt(exact(u.productionWh,'production'))-BigInt(exact(u.consumptionWh,'consumption'));
    const role=net>0n?'SELLER':net<0n?'BUYER':'NEUTRAL';
    if (u.marketRole!==role || !Number.isSafeInteger(u.netEnergyWh) || BigInt(u.netEnergyWh)!==net || BigInt(exact(u.availableEnergyWh,'surplus'))!==(net>0n?net:0n) || BigInt(exact(u.requiredEnergyWh,'deficit'))!==(net<0n?-net:0n)) throw Error('Invalid energy classification');
    return {userId:u.userId,timeSlot:start,productionWh:String(u.productionWh),consumptionWh:String(u.consumptionWh),marketRole:role,availableWh:String(u.availableEnergyWh),requiredWh:String(u.requiredEnergyWh),energyType:u.energyType,askPriceMicrousdPerKwh:u.askPriceMicrousdPerKwh===null?null:exact(u.askPriceMicrousdPerKwh,'ask'),maxPriceMicrousdPerKwh:u.maxPriceMicrousdPerKwh===null?null:exact(u.maxPriceMicrousdPerKwh,'limit'),xKm:decimal(u.xKm),yKm:decimal(u.yKm),reputation:exact(u.reputation,'reputation'),preferredEnergyType:u.preferredEnergyType,evmAddress:u.evmAddress};
  });
  const manifest={schemaVersion:'1.0.0',marketId:market,snapshotHash:hash,intervalStart:start,intervalEnd:end,algorithmVersion:config.algorithmVersion,pricingPolicyVersion:'SELLER_ASK_V1',maximumDistanceKm:decimal(config.maximumDistanceKm),scoringWeights:Object.fromEntries(Object.entries(config.scoringWeights).map(([k,v])=>[k,decimal(v)])),participants};
  validateV2('matchingManifest',manifest);
  return {input,config,manifest,manifestHash:matchingInputHash(manifest),snapshotHash:hash};
}

/** Independently enforce conservation and financial terms on a schema-valid CLI output. */
export function verifyProposal(prepared, output) {
  const {input,manifest,manifestHash,snapshotHash:hash}=prepared;
  validate('matching-output',output);
  if (output.snapshotId!==input.snapshotId || output.timeSlot!==input.timeSlot || output.algorithmVersion!==input.algorithmVersion || output.schemaVersion!==input.schemaVersion) throw Error('Matching output identity mismatch');
  assertMatchingBusinessRules(input,output);
  const users=new Map(input.users.map(u=>[u.userId,u])), totals=new Map(input.users.map(u=>[u.userId,0n])), seen=new Set(), planVersion=`b22-${manifestHash.slice(2)}`;
  for (const id of output.unmatchedBuyerIds) if (users.get(id)?.marketRole!=='BUYER') throw Error('Unknown unmatched buyer');
  const allocations=output.matches.map(m=>{
    const b=users.get(m.buyerId),s=users.get(m.sellerId);
    if (!b || !s || !Number.isSafeInteger(m.quantityWh) || m.quantityWh<=0 || !Number.isSafeInteger(m.unitPriceMicrousdPerKwh) || m.unitPriceMicrousdPerKwh<=0) throw Error('Invalid match terms');
    const qty=BigInt(m.quantityWh),price=BigInt(m.unitPriceMicrousdPerKwh), key=`${m.buyerId}/${m.sellerId}/${qty}/${price}`;
    if (seen.has(key)) throw Error('Duplicate allocation'); seen.add(key);
    const distance=Math.hypot(b.xKm-s.xKm,b.yKm-s.yKm);
    if (distance>input.maximumDistanceKm || Math.abs(distance-m.distanceKm)>1e-9 || m.sellerEnergyType!==s.energyType || m.totalAmountMicrousd!==Number(qty*price/1000n) || !Number.isSafeInteger(m.totalAmountMicrousd)) throw Error('Matching output terms or amount mismatch');
    for (const u of [b,s]) totals.set(u.userId,totals.get(u.userId)+qty);
    const amount=paymentParts(String(qty),String(price));
    return {allocationId:allocationId(manifest.marketId,hash,b.userId,s.userId,b.evmAddress,s.evmAddress,String(qty),String(price),input.algorithmVersion,'SELLER_ASK_V1',planVersion),buyerId:b.userId,sellerId:s.userId,quantityWh:String(qty),unitPriceMicrousdPerKwh:String(price),...amount,policyBlocked:amount.amountBaseUnits==='0'||amount.remainder!==0};
  });
  const positions=manifest.participants.map(p=>{
    const matched=totals.get(p.userId), limit=BigInt(p.marketRole==='BUYER'?p.requiredWh:p.availableWh);
    if (matched>limit || (p.marketRole==='NEUTRAL'&&matched!==0n)) throw Error('Aggregate energy exceeds participant position');
    return {userId:p.userId,role:p.marketRole,productionWh:p.productionWh,consumptionWh:p.consumptionWh,matchedWh:String(matched),unmatchedWh:String(limit-matched)};
  });
  verifyGreedySelection(input,output);
  return {marketId:manifest.marketId,snapshotHash:hash,manifest,manifestHash,planVersion,allocations,positions,policyBlocked:allocations.some(a=>a.policyBlocked),persisted:false};
}

export async function runHourlyDryRun(snapshot,registry,config,options={}) {
  const prepared=prepareHourly(snapshot,registry,config,options), dir=await mkdtemp(join(tmpdir(),'mgl850-b22-'));
  try {
    const inFile=join(dir,'input.json'),configFile=join(dir,'config.json'),outFile=join(dir,'output.json'),manifestFile=join(dir,'manifest.json');
    await writeFile(inFile,JSON.stringify(prepared.input),{flag:'wx'}); await writeFile(configFile,JSON.stringify(config),{flag:'wx'});
    await writeFile(manifestFile,JSON.stringify(prepared.manifest),{flag:'wx'});
    const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,PYTHONPATH:[join(root,'packages/shared/python'),join(root,'services/matching-engine')].join(delimiter)};
    const parity=spawnSync(options.python ?? 'python',['-c','import json,sys; from p2p_energy_shared.v2_validation import validate_v2; from p2p_energy_shared.v2_identity import matching_input_hash; m=json.load(open(sys.argv[1],encoding="utf-8")); validate_v2("matchingManifest",m); print(matching_input_hash(m))',manifestFile],{cwd:root,env,encoding:'utf8',timeout:options.timeoutMs ?? 20000,maxBuffer:1024*1024,windowsHide:true});
    if(parity.error||parity.status!==0||parity.stdout.trim()!==prepared.manifestHash) throw Error('Python matching-manifest validation or hash mismatch');
    const result=spawnSync(options.python ?? 'python',['-m','matching_engine.cli','--input',inFile,'--config',configFile,'--output',outFile],{cwd:root,env,encoding:'utf8',timeout:options.timeoutMs ?? 20000,maxBuffer:1024*1024,windowsHide:true});
    if(result.error || result.status!==0) throw Error(`Matching process failed: ${result.error?.message ?? result.stderr?.slice(0,500)}`);
    return verifyProposal(prepared,JSON.parse(await readFile(outFile,'utf8')));
  } finally { await rm(dir,{recursive:true,force:true}); }
}
