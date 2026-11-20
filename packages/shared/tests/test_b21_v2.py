import json
import sys
from pathlib import Path
import pytest
from jsonschema import Draft202012Validator
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from p2p_energy_shared.v2_identity import market_id, snapshot_hash, allocation_id, payment_parts, uint
ROOT=Path(__file__).resolve().parents[1]
V=json.loads((ROOT/'fixtures/v2-identity-vectors.json').read_text())
SCHEMA=json.loads((ROOT/'schemas/v2-market.schema.json').read_text())

def test_schema_is_draft_2020():
    Draft202012Validator.check_schema(SCHEMA)

def test_shared_vectors():
    assert market_id(*V['market']['args'])==V['market']['id']
    assert snapshot_hash(V['snapshot']['marketId'],V['snapshot']['participants'])==V['snapshot']['hash']
    assert allocation_id(*V['allocation']['args'])==V['allocation']['id']
    assert payment_parts('900','12345')==('11110',500)

def test_identity_changes():
    args=V['market']['args']; assert market_id('simulation:demo','SIMULATION',args[2],args[3]) != V['market']['id']
    a=V['allocation']['args'].copy(); a[7]='12346'; assert allocation_id(*a)!=V['allocation']['id']
    p=list(reversed(V['snapshot']['participants'])); assert snapshot_hash(V['snapshot']['marketId'],p)==V['snapshot']['hash']

def test_bad_data_and_overflow():
    for value in ('-1','01','9223372036854775808',1):
        with pytest.raises(ValueError): uint(value)
    with pytest.raises(ValueError): payment_parts('9223372036854775807','9223372036854775807')
    with pytest.raises(ValueError): market_id('hourly','HOURLY','2026-02-30T00:00:00.000Z','2026-02-30T01:00:00.000Z')
    with pytest.raises(ValueError): snapshot_hash(V['snapshot']['marketId'],V['snapshot']['participants']*2)


def test_position_accounting():
    from p2p_energy_shared.v2_identity import validate_position
    p=dict(productionWh='0',consumptionWh='100',netEnergyWh='-100',role='BUYER',availableWh='0',requiredWh='100',matchedBoughtWh='30',matchedSoldWh='0',unmatchedDeficitWh='70',unmatchedSurplusWh='0')
    assert validate_position(p)==p
    with pytest.raises(ValueError): validate_position({**p,'matchedBoughtWh':'31'})


def test_intent_vector():
    from p2p_energy_shared.v2_identity import intent_id
    assert intent_id(*V['intent']['args'])==V['intent']['id']


def test_pydantic_wrappers_validate_shared_cases():
    import json
    from pydantic import ValidationError
    from p2p_energy_shared import v2_models as models
    classes={'market':models.V2Market,'snapshot':models.V2Snapshot,'position':models.V2Position,'allocation':models.V2Allocation,'intent':models.V2SettlementIntent,'attempt':models.V2SettlementAttempt,'evidence':models.V2SettlementEvidence,'snapshotPayload':models.V2SnapshotPayload,'matchingManifest':models.V2MatchingManifest,'snapshotMeasurement':models.V2SnapshotMeasurement,'allocationPlan':models.V2AllocationPlan}
    cases=[c for c in json.loads((ROOT/'fixtures/v2-validation-vectors.json').read_text()) if 'context' not in c]
    for case in cases:
        if case['valid']:
            assert classes[case['kind']].model_validate(case['value']).root==case['value']
        else:
            with pytest.raises(ValidationError): classes[case['kind']].model_validate(case['value'])
