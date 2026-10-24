"""Shared-code fault injection: shows which faults in code shared by the engine and the
reference implementation (S1 normalisation in model/graph.ts, S2 rule derivation and value
domains in catalog/rules.ts) are visible to (a) the engine-vs-reference comparison used by
E1/E2/E3 and (b) the independent SHACL oracle.

usage: python shared_code_mutants.py <snapshot-src-dir> <work-dir> <out-dir> <tsc.js> [--e2-only]
  --e2-only runs, per mutant, only the engine-only clean-model check (cli-oracle e2quick) that
  mirrors E2 (expected 0 violations on generated clean models), and writes
  shared-code-mutants-e2.json.
  <snapshot-src-dir> is a copy of the prototype (src/, examples/, tsconfig.json) that already
  contains src/oracle and src/cli-oracle.ts. Each mutant is applied to a fresh copy; the
  original snapshot is never modified. Mutated sources are not kept.
"""
import json
import os
import shutil
import subprocess
import sys

MUTANTS = [
    ('S2-mult-direction', 'src/catalog/rules.ts',
     "rules.push({ id: `MULT:${key}`, kind: 'multiplicity', radius: 1, global: false, nodeType: nt, edgeType: et, dir, min, max });",
     "rules.push({ id: `MULT:${key}`, kind: 'multiplicity', radius: 1, global: false, nodeType: nt, edgeType: et, dir: dir === 'out' ? 'in' : 'out', min, max });",
     'multiplicity direction reversed in rule derivation'),
    ('S2-mult-upper-off-by-one', 'src/catalog/rules.ts',
     'const [min, max] = c.multiplicity[key];',
     'const [min, max0] = c.multiplicity[key]; const max = max0 < 0 ? max0 : max0 + 1;',
     'finite upper multiplicity bound derived one too large'),
    ('S2-required-first-only', 'src/catalog/rules.ts',
     'for (const attr of c.requiredAttr[nt] ?? []) {',
     'for (const attr of (c.requiredAttr[nt] ?? []).slice(0, 1)) {',
     'only the first required attribute of each type becomes a rule'),
    ('DOM-range-lower-exclusive', 'src/catalog/rules.ts',
     "return typeof v === 'number' && v >= d.min && v <= d.max;",
     "return typeof v === 'number' && v > d.min && v <= d.max;",
     'range lower bound treated as exclusive'),
    ('DOM-range-upper-exclusive', 'src/catalog/rules.ts',
     "return typeof v === 'number' && v >= d.min && v <= d.max;",
     "return typeof v === 'number' && v >= d.min && v < d.max;",
     'range upper bound treated as exclusive'),
    ('DOM-nonempty-accepts-empty', 'src/catalog/rules.ts',
     "return typeof v === 'string' && v.length > 0;",
     "return typeof v === 'string' && v.length >= 0;",
     'empty string accepted as non-empty'),
    ('DOM-enum-loose-equality', 'src/catalog/rules.ts',
     'return d.values.includes(v);',
     'return d.values.some((x) => String(x) === String(v));',
     'enum membership by string coercion (1 == "1")'),
    ('S1-drop-self-loops', 'src/model/graph.ts',
     'g.edges.set(e.id, { ...e });',
     'if (e.src === e.tgt) continue; g.edges.set(e.id, { ...e });',
     'normalisation silently drops self-loop relations'),
]


def main():
    snap, work, out, tsc = sys.argv[1:5]
    if '--e2-only' in sys.argv:
        return e2_only(snap, work, out, tsc)
    os.makedirs(out, exist_ok=True)
    summary = []
    for mid, rel, old, new, desc in MUTANTS:
        d = os.path.join(work, 'mut-' + mid)
        if os.path.exists(d):
            shutil.rmtree(d)
        shutil.copytree(snap, d, ignore=shutil.ignore_patterns('dist', 'node_modules', 'results-v2'))
        f = os.path.join(d, rel)
        text = open(f, encoding='utf-8').read()
        if text.count(old) != 1:
            raise RuntimeError(f'{mid}: pattern found {text.count(old)} times')
        open(f, 'w', encoding='utf-8').write(text.replace(old, new))
        subprocess.run(['node', tsc, '-p', '.'], cwd=d, capture_output=True)  # type errors from missing @types are ignored
        name = 'mutant-' + mid
        r = subprocess.run(['node', 'dist/cli-oracle.js', 'random', '--fixed', '400', '--rcat', '50',
                            '--name', name, '--out', out, '--work', os.path.join(work, 'w-' + mid)],
                           cwd=d, capture_output=True, text=True,
                           env=dict(os.environ, ORACLE_DIR=os.path.dirname(os.path.abspath(__file__))))
        res = json.load(open(os.path.join(out, name + '.json'), encoding='utf-8'))
        st = res['stats']
        row = {
            'mutant': mid, 'file': rel, 'description': desc,
            'cases': sum(s['cases'] for s in st.values()),
            'engineVsReferenceMismatchingCases': sum(s['engineVsReferenceMismatchingCases'] for s in st.values()),
            'engineVsOracleMismatchingCases': sum(s['mismatchingCases'] for s in st.values()),
            'referenceVsOracleMismatchingCases': sum(s['mismatchingCasesReference'] for s in st.values()),
            'exit': r.returncode,
        }
        summary.append(row)
        print(json.dumps(row), flush=True)
        shutil.rmtree(d)
    with open(os.path.join(out, 'shared-code-mutants.json'), 'x', encoding='utf-8') as fh:
        json.dump({'experiment': 'shared-code-mutants',
                   'method': 'each mutant applied to a copy of the snapshot; random differential run with --fixed 400 (x5 catalogs) --rcat 50 (x25 models); same seeds for all mutants',
                   'rows': summary}, fh, indent=2)


def e2_only(snap, work, out, tsc):
    rows = []
    for mid, rel, old, new, desc in [('original', None, None, None, 'unmutated snapshot')] + MUTANTS:
        d = os.path.join(work, 'e2-' + mid)
        if os.path.exists(d):
            shutil.rmtree(d)
        shutil.copytree(snap, d, ignore=shutil.ignore_patterns('dist', 'node_modules', 'results-v2'))
        if rel:
            f = os.path.join(d, rel)
            text = open(f, encoding='utf-8').read()
            assert text.count(old) == 1
            open(f, 'w', encoding='utf-8').write(text.replace(old, new))
        subprocess.run(['node', tsc, '-p', '.'], cwd=d, capture_output=True)
        name = 'e2quick-' + mid
        subprocess.run(['node', 'dist/cli-oracle.js', 'e2quick', '--name', name, '--out', os.path.join(work, 'e2out')],
                       cwd=d, capture_output=True, text=True)
        res = json.load(open(os.path.join(work, 'e2out', name + '.json'), encoding='utf-8'))
        row = {'mutant': mid, 'description': desc,
               'cleanModels': sum(r['models'] for r in res['rows']),
               'cleanModelsWithViolations': sum(r['modelsWithViolations'] for r in res['rows']),
               'violations': sum(r['violations'] for r in res['rows'])}
        rows.append(row)
        print(json.dumps(row), flush=True)
        shutil.rmtree(d)
    with open(os.path.join(out, 'shared-code-mutants-e2.json'), 'x', encoding='utf-8') as fh:
        json.dump({'experiment': 'shared-code-mutants-e2',
                   'method': 'engine on generated clean models (3 catalogs x n in {100, 500} x seeds 1000-1009), the E2 check; expected 0 violations',
                   'rows': rows}, fh, indent=2)


if __name__ == '__main__':
    main()
