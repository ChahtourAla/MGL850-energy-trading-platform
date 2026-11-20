import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from p2p_energy_shared.v2_identity import matching_input_hash
v=json.loads((Path(__file__).resolve().parents[1]/'fixtures/v2-matching-manifest-vectors.json').read_text())
print(json.dumps([matching_input_hash(v['manifest']),*[matching_input_hash(x['manifest']) for x in v['variants']]]))
