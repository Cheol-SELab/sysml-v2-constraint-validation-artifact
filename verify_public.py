"""Offline publication inventory and source-identity audit; no experiments."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((root / 'PUBLIC-MANIFEST.json').read_text(encoding='utf-8'))['files']
actual = {p.relative_to(root).as_posix() for p in root.rglob('*')
          if p.is_file() and '.git' not in p.relative_to(root).parts}
assert actual == set(manifest) | {'PUBLIC-MANIFEST.json'}, {
    'missing': sorted(set(manifest)-actual),
    'unexpected': sorted(actual-set(manifest)-{'PUBLIC-MANIFEST.json'})}
for name, expected in manifest.items():
    assert sha(root / name) == expected, name
publication = json.loads((root / 'PUBLICATION.json').read_text(encoding='utf-8'))
for name, expected in publication['included_source_files'].items():
    assert sha(root / name) == expected, name
identities = json.loads((root / 'SOURCE-IDENTITIES.json').read_text(encoding='utf-8'))
for row in identities:
    assert sha(root / row['path']) == row['sha256'], row['path']
snapshot = json.loads((root / 'data/results-v4/snapshot/snapshot-sha256.json').read_text(encoding='utf-8'))
for name, expected in snapshot['sources'].items():
    assert sha(root / 'code' / name) == expected, name
assert len(snapshot['sources']) == 85
print(f'PASS: {len(manifest)} published files and 85 historical sources; no experiments rerun')
