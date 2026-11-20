"""Emit fixed-vector PostgreSQL assertions for the isolated B21 test harness."""
import json
from pathlib import Path
v=json.loads(Path('packages/shared/fixtures/v2-matching-manifest-vectors.json').read_text())
for entry in [dict(manifest=v['manifest'],hash=v['hash']),*v['variants']]:
    value=json.dumps(entry['manifest'],separators=(',',':'))
    print('DO $body$ BEGIN IF "v2_matching_manifest_hash"($json$'+value+"$json$::jsonb)<>'"+entry['hash']+"' THEN RAISE EXCEPTION 'manifest hash mismatch'; END IF; END $body$;")
