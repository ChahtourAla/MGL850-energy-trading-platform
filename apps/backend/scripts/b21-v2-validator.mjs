import {readFileSync} from 'node:fs';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {marketId, snapshotHash, uint, paymentParts, validatePosition, intentId, allocationId, matchingInputHash} from '../../../packages/shared/v2-identity.mjs';
const schema=JSON.parse(readFileSync(new URL('../../../packages/shared/schemas/v2-market.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({allErrors:true,strict:false}); formats(ajv); ajv.addSchema(schema);
const kinds=['market','snapshot','position','allocation','intent','attempt','evidence','snapshotPayload','matchingManifest','snapshotMeasurement','allocationPlan'];
const validators=Object.fromEntries(kinds.map(k=>[k,ajv.compile({$ref:`${schema.$id}#/$defs/${k}`})]));
const time=v=>{if(typeof v!=='string'||v.startsWith('0000-')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)throw Error('invalid timestamp');return v;};
export function validateV2(kind,v,context) {
 if(!validators[kind]||!validators[kind](v))throw Error('invalid structure');
 for(const k of ['quantityWh','unitPriceMicrousdPerKwh','amountBaseUnits','nonce','productionWh','consumptionWh'])if(k in v)uint(v[k]);
 for(const k of ['intervalStart','intervalEnd','createdAt','updatedAt','collectedAt','finalizedAt','confirmedAt'])if(k in v)time(v[k]);
 if('updatedAt'in v&&v.updatedAt<v.createdAt)throw Error('invalid update timestamp');
 if(kind==='market') {if(marketId(v.namespace,v.mode,v.intervalStart,v.intervalEnd)!==v.marketId)throw Error('market identity mismatch');}
 if(kind==='snapshot') {if(v.intervalEnd<=v.intervalStart||v.actualCount>v.expectedCount)throw Error('invalid snapshot');if(v.status==='FINALIZED'&&(v.actualCount!==v.expectedCount||!v.finalizedAt||!v.finalizer))throw Error('incomplete finalization');if(v.finalizedAt&&v.finalizedAt<v.collectedAt)throw Error('invalid finalization');if(context&&(v.marketId!==context.marketId||v.intervalStart!==context.intervalStart||v.intervalEnd!==context.intervalEnd))throw Error('snapshot market mismatch');}
 if(kind==='position')validatePosition(v);
 if(kind==='snapshotPayload')snapshotHash(v.marketId,v.participants);
 if(kind==='matchingManifest')matchingInputHash(v);
 if(kind==='snapshotMeasurement'&&context&&(v.snapshotId!==context.snapshotId||v.marketId!==context.marketId))throw Error('measurement snapshot mismatch');
 if(kind==='allocationPlan'){if(matchingInputHash(v.manifest)!==v.manifestHash||v.manifest.marketId!==v.marketId)throw Error('plan manifest mismatch');if(context&&(v.snapshotId!==context.snapshotId||v.marketId!==context.marketId||v.manifest.snapshotHash!==context.payloadHash))throw Error('plan snapshot mismatch');}
 if(kind==='allocation'){if(v.buyerId===v.sellerId||v.buyerAddress===v.sellerAddress||uint(v.quantityWh)===0n||uint(v.unitPriceMicrousdPerKwh)===0n)throw Error('invalid allocation');const p=paymentParts(v.quantityWh,v.unitPriceMicrousdPerKwh);if(p.amountBaseUnits!==v.amountBaseUnits||p.remainder!==v.remainder)throw Error('amount mismatch');if(context){if(context.status!=='FINALIZED'||context.snapshotId!==v.snapshotId||context.marketId!==v.marketId)throw Error('snapshot mismatch');if(allocationId(v.marketId,context.payloadHash,v.buyerId,v.sellerId,v.buyerAddress,v.sellerAddress,v.quantityWh,v.unitPriceMicrousdPerKwh,v.algorithmVersion,v.pricingVersion,v.planVersion)!==v.allocationId)throw Error('allocation identity mismatch');if(context.manifest){const m=context.manifest;matchingInputHash(m);if(m.marketId!==v.marketId||m.snapshotHash!==context.payloadHash)throw Error('manifest source mismatch');const b=m.participants.find(x=>x.userId===v.buyerId&&x.marketRole==='BUYER'&&x.evmAddress===v.buyerAddress),s=m.participants.find(x=>x.userId===v.sellerId&&x.marketRole==='SELLER'&&x.evmAddress===v.sellerAddress);if(!b||!s)throw Error('allocation parties absent from manifest');if(v.algorithmVersion!==m.algorithmVersion||v.pricingVersion!==m.pricingPolicyVersion||uint(v.quantityWh)>uint(b.requiredWh)||uint(v.quantityWh)>uint(s.availableWh)||uint(v.unitPriceMicrousdPerKwh)<uint(s.askPriceMicrousdPerKwh)||uint(v.unitPriceMicrousdPerKwh)>uint(b.maxPriceMicrousdPerKwh)||(b.preferredEnergyType!=='ANY'&&b.preferredEnergyType!==s.energyType))throw Error('allocation terms mismatch');}}}
 if(kind==='intent'){if(intentId(v.allocationId,String(v.chainId),v.tokenAddress)!==v.settlementId)throw Error('intent identity mismatch');if(context&&(v.allocationId!==context.allocationId||v.marketId!==context.marketId||v.amountBaseUnits!==context.amountBaseUnits||(context.status!==undefined&&context.status!=='VALIDATED')||(context.planStatus!==undefined&&context.planStatus!=='AUTHORITATIVE')))throw Error('allocation mismatch');}
 if(kind==='evidence'){if(v.buyerAddress===v.sellerAddress||(v.verificationStatus==='VERIFIED'&&v.receiptStatus!=='SUCCESS'))throw Error('invalid evidence');if(context&&['settlementId','chainId','tokenAddress','contractAddress','buyerAddress','sellerAddress','amountBaseUnits'].some(k=>v[k]!==context[k]))throw Error('evidence terms mismatch');}
 return v;
}
