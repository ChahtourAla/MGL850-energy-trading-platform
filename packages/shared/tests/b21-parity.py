import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from p2p_energy_shared.v2_validation import validate_v2
vectors=json.loads((Path(__file__).resolve().parents[1]/'fixtures/v2-validation-vectors.json').read_text())
out=[]
for case in vectors:
    try: validate_v2(case['kind'],case['value'],context=case.get('context')); ok=True
    except Exception: ok=False
    out.append({'name':case['name'],'accepted':ok})
print(json.dumps(out,separators=(',',':')))
