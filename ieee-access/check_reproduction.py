"""Static attachment dependency/preparation audit; executes no benchmark."""
import json
from pathlib import Path
import re
import sys


def check(root):
    code = root / 'code'
    driver = (code / 'tools/run-r8-final.sh').read_text()
    required = {
        'tools/pin.ps1', 'tools/snapshot-r8.js', 'tools/fetch-corpus.py',
        'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.r8.json',
        'oracle-py/requirements-lock.txt', 'oracle-py/shared_code_mutants.py',
        'oracle-py/test_oracle.py', 'corpus-manifest.json',
    }
    # All literal CLI entry points in the retained driver must have included sources.
    entries = set(re.findall(r'dist-r8/([\w-]+)\.js', driver))
    required.update('src/' + entry + '.ts' for entry in entries)
    for relative in sorted(required):
        assert (code / relative).is_file(), relative
    assert (root / 'oracle-blind/spec/definitions-sec2-sec4_2.tex').is_file()
    assert (root / 'oracle-blind/sql_oracle').is_dir()
    config = json.loads((code / 'tsconfig.r8.json').read_text())
    assert config['compilerOptions']['outDir'] == 'dist-r8'
    assert 'OUT="$ROOT/results-v4"' in driver
    assert '$ROOT/tools/pin.ps1' in driver
    snapshot = (code / 'tools/snapshot-r8.js').read_text()
    assert "path.join(ROOT, 'results-v4', 'snapshot')" in snapshot
    assert "refusing to overwrite" in snapshot
    assert not (code / 'results-v4').exists(), 'Use a fresh extracted working copy for reproduction'
    identities = json.loads((root / 'SOURCE-IDENTITIES.json').read_text())
    pin = next(r for r in identities if r['path'] == 'code/tools/pin.ps1')
    assert pin['identity'].startswith('supplemental current source')
    print(json.dumps({'passed': True, 'required_files': len(required), 'cli_sources': len(entries),
                      'output': 'fresh-copy/code/results-v4',
                      'scope': 'Static dependency and path checks only; no benchmark, affinity or performance validation'}))


if __name__ == '__main__':
    check(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent)
