"""Offline B21 identity and exact arithmetic primitives; not settlement authorization."""
import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal, localcontext

MAX = 9223372036854775807
UINT = re.compile(r"^(0|[1-9][0-9]*)$")
HASH = re.compile(r"^0x[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")

def uint(value):
    if not isinstance(value,str) or not UINT.fullmatch(value) or int(value)>MAX:
        raise ValueError('canonical PostgreSQL bigint required')
    return int(value)

def utc(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',value):
        raise ValueError('canonical UTC timestamp required')
    try: return datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
    except ValueError as exc: raise ValueError('invalid UTC timestamp') from exc

def digest(domain, fields):
    payload=json.dumps([domain,*fields], ensure_ascii=True, separators=(',',':'))
    return '0x'+hashlib.sha256(payload.encode('ascii')).hexdigest()

def market_id(namespace, mode, start, end):
    a,b=utc(start),utc(end)
    if b<=a: raise ValueError('invalid interval')
    if mode=='HOURLY':
        if namespace!='hourly' or a.minute or a.second or a.microsecond or (b-a).total_seconds()!=3600: raise ValueError('invalid hourly interval')
    elif mode=='SIMULATION':
        if not re.fullmatch(r'simulation:[a-z0-9][a-z0-9_-]{0,63}',namespace): raise ValueError('invalid simulation namespace')
    else: raise ValueError('invalid mode')
    return digest('mgl850:v2:market:1',[namespace,mode,start,end])

def snapshot_hash(market, participants):
    if not HASH.fullmatch(market): raise ValueError('invalid market hash')
    rows=[]; seen=set()
    for p in participants:
        if set(p)!={'userId','productionWh','consumptionWh'} or not UUID.fullmatch(p['userId']) or p['userId'] in seen: raise ValueError('invalid participant')
        seen.add(p['userId']); uint(p['productionWh']); uint(p['consumptionWh'])
        rows.append([p['userId'],p['productionWh'],p['consumptionWh']])
    rows.sort(key=lambda x:x[0])
    return digest('mgl850:v2:snapshot:1',[market,rows])

def allocation_id(market, snapshot_hash_value, buyer, seller, buyer_address, seller_address, quantity, price, algorithm, pricing, plan):
    if not HASH.fullmatch(market) or not HASH.fullmatch(snapshot_hash_value) or not UUID.fullmatch(buyer) or not UUID.fullmatch(seller) or buyer==seller or not ADDRESS.fullmatch(buyer_address) or not ADDRESS.fullmatch(seller_address) or buyer_address==seller_address: raise ValueError('invalid allocation identity')
    if uint(quantity)==0 or uint(price)==0: raise ValueError('positive terms required')
    if not all(isinstance(x,str) and re.fullmatch(r'[A-Za-z0-9._-]{1,128}',x) for x in (algorithm,pricing,plan)): raise ValueError('invalid version')
    return digest('mgl850:v2:allocation:1',[market,snapshot_hash_value,buyer,seller,buyer_address,seller_address,quantity,price,algorithm,pricing,plan])

def payment_parts(quantity, price):
    product=uint(quantity)*uint(price)
    quotient,remainder=divmod(product,1000)
    if quotient>MAX: raise ValueError('payment overflows PostgreSQL bigint')
    return str(quotient),remainder


def validate_position(p):
    """Check accounting independent of allocation payment status."""
    keys=('productionWh','consumptionWh','availableWh','requiredWh','matchedBoughtWh','matchedSoldWh','unmatchedDeficitWh','unmatchedSurplusWh')
    values={k:uint(p[k]) for k in keys}
    net=values['productionWh']-values['consumptionWh']
    if not -MAX <= net <= MAX or str(net)!=p['netEnergyWh']: raise ValueError('invalid net')
    available=max(net,0); required=max(-net,0)
    if values['availableWh']!=available or values['requiredWh']!=required: raise ValueError('invalid position')
    if values['matchedBoughtWh']+values['unmatchedDeficitWh']!=required or values['matchedSoldWh']+values['unmatchedSurplusWh']!=available: raise ValueError('invalid allocation accounting')
    if p['role'] != ('SELLER' if net>0 else 'BUYER' if net<0 else 'NEUTRAL'): raise ValueError('invalid role')
    return p


def intent_id(allocation, chain_id, token):
    if not HASH.fullmatch(allocation) or chain_id != '296' or not ADDRESS.fullmatch(token): raise ValueError('invalid testnet intent')
    return digest('mgl850:v2:intent:1',[allocation,chain_id,token])

# Matching-input manifest v1 commits the full economic input, separately from
# the legacy measurement-only snapshot hash. Decimal strings have no exponent.
_DECIMAL = re.compile(r'^(?:0|-?[1-9][0-9]*|-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9])$')
_VERSION = re.compile(r'^[A-Za-z0-9._-]{1,128}$')
_MATCH_FIELDS = ('userId','timeSlot','productionWh','consumptionWh','marketRole','availableWh','requiredWh','energyType','askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh','xKm','yKm','reputation','preferredEnergyType','evmAddress')

def _decimal(value):
    if not isinstance(value, str) or len(value) > 40 or not _DECIMAL.fullmatch(value):
        raise ValueError('canonical decimal required')
    return value

def matching_input_hash(manifest):
    if not isinstance(manifest,dict) or set(manifest) != {'schemaVersion','marketId','snapshotHash','intervalStart','intervalEnd','algorithmVersion','pricingPolicyVersion','maximumDistanceKm','scoringWeights','participants'}: raise ValueError('invalid manifest fields')
    if manifest['schemaVersion']!='1.0.0' or not HASH.fullmatch(manifest['marketId']) or not HASH.fullmatch(manifest['snapshotHash']): raise ValueError('invalid manifest identity')
    if utc(manifest['intervalEnd']) <= utc(manifest['intervalStart']): raise ValueError('invalid interval')
    for k in ('algorithmVersion','pricingPolicyVersion'):
        if not isinstance(manifest[k],str) or not _VERSION.fullmatch(manifest[k]): raise ValueError('invalid version')
    distance=_decimal(manifest['maximumDistanceKm'])
    if distance.startswith('-') or distance=='0': raise ValueError('invalid distance')
    weights=manifest['scoringWeights']; weight_keys=('quantity','price','distance','reputation')
    if not isinstance(weights,dict) or set(weights)!=set(weight_keys): raise ValueError('invalid weights')
    weight_values=[_decimal(weights[k]) for k in weight_keys]
    with localcontext() as ctx:
        ctx.prec=100
        weight_numbers=[Decimal(v) for v in weight_values]
        if any(w<0 or w>1 for w in weight_numbers) or abs(sum(weight_numbers)-1)>Decimal('0.000000001'): raise ValueError('invalid scoring weights')
    if not isinstance(manifest['participants'],list): raise ValueError('invalid participants')
    seen=set(); rows=[]
    for p in manifest['participants']:
        if not isinstance(p,dict) or set(p)!=set(_MATCH_FIELDS) or not isinstance(p['userId'],str) or not UUID.fullmatch(p['userId']) or p['userId'] in seen: raise ValueError('invalid participant')
        seen.add(p['userId'])
        if p['timeSlot']!=manifest['intervalStart'] or not isinstance(p['evmAddress'],str) or not ADDRESS.fullmatch(p['evmAddress']): raise ValueError('invalid participant slot or wallet')
        prod=uint(p['productionWh']); cons=uint(p['consumptionWh']); available=uint(p['availableWh']); required=uint(p['requiredWh']); rep=uint(p['reputation'])
        net=prod-cons; role='SELLER' if net>0 else 'BUYER' if net<0 else 'NEUTRAL'
        if p['marketRole']!=role or available!=max(net,0) or required!=max(-net,0) or rep>100: raise ValueError('invalid participant position')
        if p['preferredEnergyType'] not in ('ANY','SOLAR','WIND','HYDRO','GRID','MIXED'): raise ValueError('invalid preference')
        if p['energyType'] is not None and p['energyType'] not in ('SOLAR','WIND','HYDRO','GRID','MIXED'): raise ValueError('invalid energy type')
        for k in ('askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh'):
            if p[k] is not None and uint(p[k])==0: raise ValueError('invalid price')
        if role=='SELLER' and (p['energyType'] is None or p['askPriceMicrousdPerKwh'] is None or p['maxPriceMicrousdPerKwh'] is not None): raise ValueError('invalid seller terms')
        if role=='BUYER' and (p['energyType'] is not None or p['askPriceMicrousdPerKwh'] is not None or p['maxPriceMicrousdPerKwh'] is None): raise ValueError('invalid buyer terms')
        if role=='NEUTRAL' and any(p[k] is not None for k in ('energyType','askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh')): raise ValueError('invalid neutral terms')
        _decimal(p['xKm']); _decimal(p['yKm']); rows.append([p[k] for k in _MATCH_FIELDS])
    rows.sort(key=lambda row:row[0])
    return digest('mgl850:v2:matching-input:1',[manifest['marketId'],manifest['snapshotHash'],manifest['intervalStart'],manifest['intervalEnd'],manifest['algorithmVersion'],manifest['pricingPolicyVersion'],distance,weight_values,rows])
