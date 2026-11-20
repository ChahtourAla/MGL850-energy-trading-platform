import json, sys
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from p2p_energy_shared.v2_identity import matching_input_hash
from p2p_energy_shared.v2_validation import validate_v2
from p2p_energy_shared.v2_models import V2MatchingManifest
vectors=json.loads((Path(__file__).resolve().parents[1]/'fixtures/v2-matching-manifest-vectors.json').read_text())

def test_manifest_base_and_reordered_input():
    m=vectors['manifest']
    assert validate_v2('matchingManifest',m)==m
    assert V2MatchingManifest.model_validate(m).root==m
    assert matching_input_hash(m)==vectors['hash']
    assert matching_input_hash({**m,'participants':list(reversed(m['participants']))})==vectors['hash']

@pytest.mark.parametrize('case',vectors['variants'],ids=lambda case:case['name'])
def test_every_matching_term_changes_commitment(case):
    assert matching_input_hash(case['manifest'])==case['hash']
    assert case['hash']!=vectors['hash']

@pytest.mark.parametrize('mutation', [lambda m:m.update(maximumDistanceKm='01'), lambda m:m['participants'][0].update(xKm='1.0'), lambda m:m['participants'].append(m['participants'][0]), lambda m:m['participants'][0].pop('evmAddress')])
def test_invalid_manifest_rejected(mutation):
    import copy
    m=copy.deepcopy(vectors['manifest']);mutation(m)
    with pytest.raises(ValueError):validate_v2('matchingManifest',m)
