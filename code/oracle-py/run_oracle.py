"""Runs the independent SHACL oracle (pySHACL) on a batch of models under one catalog.

usage: python run_oracle.py <input.json> <output.json> [--shapes-out shapes.ttl] [--per-model] [--reps N]

input  : {"catalog": {...catalog data...}, "models": [{"caseId": str, "model": {id,nodes,edges}}]}
         or {"batches": [<input>, ...]} (output is then {"batches": [<output>, ...]})
output : {"rules": [...], "violations": {caseId: [{rule, cls, grounding}]}, "timing": {...}}

--per-model validates each model in its own data graph (used for timing per size);
otherwise all models of the batch share one data graph (disjoint IRIs per model).
Times are wall-clock ms: rdfMs (JSON -> RDF), shapesMs (catalog -> SHACL), validateMs (pySHACL),
reportMs (validation report -> violation tuples).
"""
import json
import sys
import time

from pyshacl import validate
from rdflib import Graph, URIRef
from rdflib.namespace import Namespace

from rdf_export import SRC, TGT, add_model, parse_iri
from shapes import translate

SH = Namespace('http://www.w3.org/ns/shacl#')


def now():
    return time.perf_counter() * 1000.0


def run_shacl(data, shapes):
    conforms, report, _ = validate(data, shacl_graph=shapes, inference='none', advanced=False,
                                   meta_shacl=False, abort_on_first=False, allow_warnings=False,
                                   debug=False)
    return conforms, report


def parse_report(report, data, shape_to_rule, case_ids):
    out = {cid: set() for cid in case_ids}
    for res in report.subjects(SH.resultSeverity, None):
        src_shape = str(report.value(res, SH.sourceShape))
        rule = shape_to_rule.get(src_shape)
        if rule is None:
            raise RuntimeError('result from unknown shape ' + src_shape)
        focus = report.value(res, SH.focusNode)
        k, kind, ident = parse_iri(focus)
        cls = rule['cls']
        if cls == 'viewConsistency':
            value = report.value(res, SH.value)
            k2, _, x = parse_iri(value)
            assert k2 == k
            grounding = (ident, x)
        elif kind == 'e':
            # edge groundings also carry endpoints, so they can be compared at node level
            s = parse_iri(data.value(URIRef(focus), SRC))[2]
            t = parse_iri(data.value(URIRef(focus), TGT))[2]
            grounding = (ident, s, t)
        else:
            grounding = (ident,)
        out[case_ids[k]].add((rule['id'], cls, grounding))
    return {cid: [{'rule': r, 'cls': c, 'grounding': list(g)} for (r, c, g) in sorted(vs)]
            for cid, vs in out.items()}


def run_batch(batch, per_model=False, shapes_out=None, reps=1):
    t0 = now()
    ttl, rules = translate(batch['catalog'])
    shapes = Graph().parse(data=ttl, format='turtle')
    shapes_ms = now() - t0
    if shapes_out:
        with open(shapes_out, 'w', encoding='utf-8') as f:
            f.write(ttl)
    shape_to_rule = {s: r for r in rules for s in r['shapes']}

    models = batch['models']
    violations = {}
    timing = {'shapesMs': shapes_ms, 'shapesTriples': len(shapes), 'shapesTurtleLines': ttl.count(chr(10))}
    if per_model:
        per = []
        for m in models:
            t1 = now(); data = Graph(); dropped = add_model(data, 0, m['model']); t2 = now()
            samples = []
            for _ in range(reps):
                ta = now(); conforms, report = run_shacl(data, shapes); samples.append(now() - ta)
            t3 = now()
            v = parse_report(report, data, shape_to_rule, [m['caseId']]); t4 = now()
            violations.update(v)
            samples.sort()
            per.append({'caseId': m['caseId'], 'nodes': len(m['model']['nodes']), 'edges': len(m['model']['edges']),
                        'triples': len(data), 'droppedDangling': dropped, 'rdfMs': t2 - t1,
                        'validateMs': samples[len(samples) // 2], 'validateSamplesMs': samples,
                        'reportMs': t4 - t3, 'violations': len(v[m['caseId']])})
        timing['perModel'] = per
    else:
        # Each model gets its own data graph: rdflib/pySHACL costs grow with graph size, so a
        # shared graph would only add work (results are identical: models are disjoint).
        rdf_ms = val_ms = rep_ms = 0.0; triples = 0; dropped = 0
        for m in models:
            t1 = now(); data = Graph(); dropped += add_model(data, 0, m['model']); t2 = now()
            conforms, report = run_shacl(data, shapes); t3 = now()
            violations.update(parse_report(report, data, shape_to_rule, [m['caseId']])); t4 = now()
            rdf_ms += t2 - t1; val_ms += t3 - t2; rep_ms += t4 - t3; triples += len(data)
        timing.update({'models': len(models), 'triples': triples, 'droppedDangling': dropped,
                       'rdfMs': rdf_ms, 'validateMs': val_ms, 'reportMs': rep_ms})
    return {
        'catalog': batch['catalog'].get('id'),
        'rules': [{'id': r['id'], 'cls': r['cls'], 'layer': r['layer']} for r in rules],
        'violations': violations,
        'timing': timing,
    }


def main():
    args = sys.argv[1:]
    inp, outp = args[0], args[1]
    shapes_out = args[args.index('--shapes-out') + 1] if '--shapes-out' in args else None
    reps = int(args[args.index('--reps') + 1]) if '--reps' in args else 1
    per_model = '--per-model' in args
    with open(inp, encoding='utf-8') as f:
        doc = json.load(f)
    if 'batches' in doc:
        result = {'batches': [run_batch(b, per_model, None, reps) for b in doc['batches']]}
    else:
        result = run_batch(doc, per_model, shapes_out, reps)
    with open(outp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == '__main__':
    main()
