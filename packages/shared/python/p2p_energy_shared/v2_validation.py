"""V2 structural and semantic validation. Chain verification remains a B25 duty."""
from __future__ import annotations
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from .v2_identity import MAX, market_id, payment_parts, snapshot_hash, uint, utc, validate_position, intent_id, allocation_id, matching_input_hash

_SCHEMA = json.loads((Path(__file__).resolve().parents[2] / 'schemas' / 'v2-market.schema.json').read_text(encoding='utf-8-sig'))
_KINDS = ('market','snapshot','position','allocation','intent','attempt','evidence','snapshotPayload','matchingManifest','snapshotMeasurement','allocationPlan')
_VALIDATORS = {k: Draft202012Validator({'$ref': f'#/$defs/{k}', '$defs': _SCHEMA['$defs']}, format_checker=FormatChecker()) for k in _KINDS}

def validate_v2(kind, value, *, context=None):
    if kind not in _VALIDATORS: raise ValueError('unsupported kind')
    errors = list(_VALIDATORS[kind].iter_errors(value))
    if errors: raise ValueError('invalid structure')
    v=value
    for key in ('quantityWh','unitPriceMicrousdPerKwh','amountBaseUnits','nonce','productionWh','consumptionWh'):
        if key in v: uint(v[key])
    for key in ('intervalStart','intervalEnd','createdAt','updatedAt','collectedAt','finalizedAt','confirmedAt'):
        if key in v: utc(v[key])
    if 'updatedAt' in v and v['updatedAt'] < v['createdAt']: raise ValueError('invalid update timestamp')
    if kind=='market':
        if market_id(v['namespace'],v['mode'],v['intervalStart'],v['intervalEnd']) != v['marketId']: raise ValueError('market identity mismatch')
    elif kind=='snapshot':
        if utc(v['intervalEnd']) <= utc(v['intervalStart']) or v['actualCount']>v['expectedCount']: raise ValueError('invalid snapshot interval or count')
        if v['status']=='FINALIZED' and (v['actualCount']!=v['expectedCount'] or not v.get('finalizedAt') or not v.get('finalizer')): raise ValueError('incomplete finalization')
        if v.get('finalizedAt') and v['finalizedAt']<v['collectedAt']: raise ValueError('finalization precedes collection')
        if context and (v['marketId']!=context['marketId'] or v['intervalStart']!=context['intervalStart'] or v['intervalEnd']!=context['intervalEnd']): raise ValueError('snapshot market mismatch')
    elif kind=='position': validate_position(v)
    elif kind=='snapshotPayload': snapshot_hash(v['marketId'],v['participants'])
    elif kind=='matchingManifest': matching_input_hash(v)
    elif kind=='snapshotMeasurement':
        if context and (v['snapshotId']!=context['snapshotId'] or v['marketId']!=context['marketId']): raise ValueError('measurement snapshot mismatch')
    elif kind=='allocationPlan':
        if matching_input_hash(v['manifest'])!=v['manifestHash'] or v['manifest']['marketId']!=v['marketId']: raise ValueError('plan manifest mismatch')
        if context and (v['snapshotId']!=context['snapshotId'] or v['marketId']!=context['marketId'] or v['manifest']['snapshotHash']!=context['payloadHash']): raise ValueError('plan snapshot mismatch')
    elif kind=='allocation':
        if v['buyerId']==v['sellerId'] or v['buyerAddress']==v['sellerAddress'] or uint(v['quantityWh'])==0 or uint(v['unitPriceMicrousdPerKwh'])==0: raise ValueError('invalid allocation')
        amount,remainder=payment_parts(v['quantityWh'],v['unitPriceMicrousdPerKwh'])
        if (amount,remainder)!=(v['amountBaseUnits'],v['remainder']): raise ValueError('amount mismatch')
        if context:
            if context['status']!='FINALIZED' or context['snapshotId']!=v['snapshotId'] or context['marketId']!=v['marketId']: raise ValueError('snapshot mismatch')
            expected=allocation_id(v['marketId'],context['payloadHash'],v['buyerId'],v['sellerId'],v['buyerAddress'],v['sellerAddress'],v['quantityWh'],v['unitPriceMicrousdPerKwh'],v['algorithmVersion'],v['pricingVersion'],v['planVersion'])
            if v['allocationId']!=expected: raise ValueError('allocation identity mismatch')
            if context.get('manifest') is not None:
                m=context['manifest']; matching_input_hash(m)
                if m['marketId']!=v['marketId'] or m['snapshotHash']!=context['payloadHash']: raise ValueError('manifest source mismatch')
                buyer=next((x for x in m['participants'] if x['userId']==v['buyerId'] and x['marketRole']=='BUYER' and x['evmAddress']==v['buyerAddress']),None)
                seller=next((x for x in m['participants'] if x['userId']==v['sellerId'] and x['marketRole']=='SELLER' and x['evmAddress']==v['sellerAddress']),None)
                if not buyer or not seller: raise ValueError('allocation parties absent from manifest')
                if (v['algorithmVersion']!=m['algorithmVersion'] or v['pricingVersion']!=m['pricingPolicyVersion'] or uint(v['quantityWh'])>uint(buyer['requiredWh']) or uint(v['quantityWh'])>uint(seller['availableWh']) or uint(v['unitPriceMicrousdPerKwh'])<uint(seller['askPriceMicrousdPerKwh']) or uint(v['unitPriceMicrousdPerKwh'])>uint(buyer['maxPriceMicrousdPerKwh']) or (buyer['preferredEnergyType']!='ANY' and buyer['preferredEnergyType']!=seller['energyType'])): raise ValueError('allocation terms mismatch')
    elif kind=='intent':
        if intent_id(v['allocationId'],str(v['chainId']),v['tokenAddress'])!=v['settlementId']: raise ValueError('intent identity mismatch')
        if context and (v['allocationId']!=context['allocationId'] or v['marketId']!=context['marketId'] or v['amountBaseUnits']!=context['amountBaseUnits'] or context.get('status','VALIDATED')!='VALIDATED' or context.get('planStatus','AUTHORITATIVE')!='AUTHORITATIVE'): raise ValueError('allocation mismatch')
    elif kind=='evidence':
        if v['buyerAddress']==v['sellerAddress'] or (v['verificationStatus']=='VERIFIED' and v['receiptStatus']!='SUCCESS'): raise ValueError('invalid evidence')
        if context and any(v[k]!=context[k] for k in ('settlementId','chainId','tokenAddress','contractAddress','buyerAddress','sellerAddress','amountBaseUnits')): raise ValueError('evidence terms mismatch')
    return value
