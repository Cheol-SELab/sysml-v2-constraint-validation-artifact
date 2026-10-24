"""pySHACL on the same Turtle files as the other SHACL engines (round-2 item N2).

usage: python time_pyshacl.py <shapes.ttl> <data.ttl> <out.json> [--reps N] [--warmup W]

Output has the same shape as bench-shacl/run-js.mjs: raw results (focus, shape, value) plus timings.
"""
import json
import os
import sys
import time

import pyshacl
from pyshacl import validate
from rdflib import Graph
from rdflib.namespace import Namespace

SH = Namespace('http://www.w3.org/ns/shacl#')


def main():
    a = sys.argv[1:]
    shapes_f, data_f, out_f = a[0], a[1], a[2]
    reps = int(a[a.index('--reps') + 1]) if '--reps' in a else 3
    warmup = int(a[a.index('--warmup') + 1]) if '--warmup' in a else 1
    out = {'engine': 'pyshacl', 'version': pyshacl.__version__, 'file': os.path.basename(data_f), 'supportsSparql': True}
    t0 = time.perf_counter()
    shapes = Graph().parse(shapes_f, format='turtle')
    data = Graph().parse(data_f, format='turtle')
    out['parseMs'] = (time.perf_counter() - t0) * 1000
    out['dataTriples'] = len(data)

    def run():
        return validate(data, shacl_graph=shapes, inference='none', advanced=False, meta_shacl=False,
                        abort_on_first=False, allow_warnings=False, debug=False)

    for _ in range(warmup):
        run()
    samples, res = [], None
    for _ in range(reps):
        t = time.perf_counter()
        res = run()
        samples.append((time.perf_counter() - t) * 1000)
    s = sorted(samples)
    m = len(s) // 2
    out.update({'warmup': warmup, 'validateSamplesMs': samples,
                'validateMs': s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2, 'conforms': bool(res[0])})
    report = res[1]
    results = []
    for r in report.subjects(SH.resultSeverity, None):
        v = report.value(r, SH.value)
        results.append({'focus': str(report.value(r, SH.focusNode)), 'shape': str(report.value(r, SH.sourceShape)),
                        'value': str(v) if v is not None else None})
    out['results'] = results
    with open(out_f, 'w', encoding='utf-8') as f:
        json.dump(out, f)
    print(f"pyshacl {out['file']}: validate {out['validateMs']:.1f} ms, {len(results)} results")


if __name__ == '__main__':
    main()
