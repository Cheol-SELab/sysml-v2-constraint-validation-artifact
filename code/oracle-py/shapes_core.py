"""SHACL Core variants of the two global rule classes (expressiveness check).

  tracePolicy  Core: property shape with path [ sh:oneOrMorePath [ sh:alternativePath (...) ] ]
               and sh:qualifiedValueShape [ sh:class Target ] ; sh:qualifiedMinCount 1.
               SHACL Core property paths include transitive closure, so no SPARQL is needed.
  acyclic      "x does not reach itself" compares path values with the focus node itself,
               which SHACL Core cannot do directly. With an auxiliary data triple x o:self x
               the constraint becomes Core: path [ sh:oneOrMorePath rel:t ] ; sh:disjoint o:self.
               The grounding is then a node on a cycle (not an edge).
View consistency stays SPARQL-based: it needs inclusion of one path's values in another
path's values; SHACL Core only offers equality, disjointness and order between paths.

usage: python shapes_core.py <input.json> <output.json>   (input format as run_oracle.py)
Runs the SPARQL-variant oracle (shapes.py) and the Core variant on the same data and compares.
"""
import copy
import json
import sys
import time

from rdflib import Graph, URIRef

from rdf_export import BASE, ELEMENT, add_model, rel_iri, type_iri
from run_oracle import parse_report, run_shacl
from shapes import iri, shape_iri, translate
from rdflib.namespace import RDF

SELF = URIRef(BASE + 'self')


def translate_core(catalog):
    base = copy.deepcopy(catalog)
    acyclic, traces = base.pop('acyclic'), base.pop('tracePolicy')
    base['acyclic'], base['tracePolicy'] = [], []
    ttl, rules = translate(base)
    out = [ttl]
    for t in acyclic:
        rid = f'ACYC:{t}'
        ns, ps = shape_iri(rid), shape_iri(rid, 'p')
        rules.append({'id': rid, 'cls': 'acyclic', 'layer': 'core+aux', 'shapes': [ns, ps]})
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass o:Element ; sh:property {iri(ps)} .
{iri(ps)} a sh:PropertyShape ; sh:path [ sh:oneOrMorePath {iri(rel_iri(t))} ] ; sh:disjoint o:self .
""")
    for p in traces:
        rid = f"TRACE:{p['id']}"
        ns, ps = shape_iri(rid), shape_iri(rid, 'p')
        rules.append({'id': rid, 'cls': 'tracePolicy', 'layer': 'core', 'shapes': [ns, ps]})
        if not p['edgeTypes']:
            # T = {}: no path exists, every focus node violates (sh:in () admits no value)
            rules[-1]['shapes'] = [ns]
            out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(p['sourceType']))} ; sh:in ( ) .
""")
            continue
        alt = ' '.join(iri(rel_iri(t)) for t in p['edgeTypes'])
        path = f'[ sh:oneOrMorePath [ sh:alternativePath ( {alt} ) ] ]' if len(p['edgeTypes']) > 1 \
            else f"[ sh:oneOrMorePath {iri(rel_iri(p['edgeTypes'][0]))} ]"
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(p['sourceType']))} ; sh:property {iri(ps)} .
{iri(ps)} a sh:PropertyShape ; sh:path {path} ;
  sh:qualifiedValueShape [ sh:class {iri(type_iri(p['targetType']))} ] ; sh:qualifiedMinCount 1 .
""")
    return '\n'.join(out), rules


def oracle_run(batch, translator, aux_self):
    ttl, rules = translator(batch['catalog'])
    shapes = Graph().parse(data=ttl, format='turtle')
    data = Graph()
    for k, m in enumerate(batch['models']):
        add_model(data, k, m['model'])
    if aux_self:
        for s in list(data.subjects(RDF.type, ELEMENT)):
            data.add((s, SELF, s))
    t0 = time.perf_counter()
    _, report = run_shacl(data, shapes)
    ms = (time.perf_counter() - t0) * 1000
    s2r = {s: r for r in rules for s in r['shapes']}
    return parse_report(report, data, s2r, [m['caseId'] for m in batch['models']]), ms


def main():
    inp, outp = sys.argv[1], sys.argv[2]
    doc = json.load(open(inp, encoding='utf-8'))
    batches = doc['batches'] if 'batches' in doc else [doc]
    stats = {'cases': 0, 'agreeingCases': 0, 'traceViolations': 0, 'acyclicCycleNodes': 0,
             'disagreements': [], 'sparqlMs': 0.0, 'coreMs': 0.0}
    for b in batches:
        sv, ms1 = oracle_run(b, translate, False)
        cv, ms2 = oracle_run(b, translate_core, True)
        stats['sparqlMs'] += ms1
        stats['coreMs'] += ms2
        for m in b['models']:
            cid = m['caseId']
            stats['cases'] += 1
            # SPARQL variant: acyclic edge groundings -> nodes on cycles (endpoints)
            s_keys = set()
            for v in sv[cid]:
                if v['cls'] == 'acyclic':
                    s_keys.add((v['rule'], v['grounding'][1]))
                    s_keys.add((v['rule'], v['grounding'][2]))
                else:
                    s_keys.add((v['rule'], tuple(v['grounding'][:1] if v['cls'] == 'relationType' else v['grounding'])))
            c_keys = set()
            for v in cv[cid]:
                if v['cls'] == 'acyclic':
                    c_keys.add((v['rule'], v['grounding'][0]))
                else:
                    c_keys.add((v['rule'], tuple(v['grounding'][:1] if v['cls'] == 'relationType' else v['grounding'])))
            stats['traceViolations'] += sum(1 for v in cv[cid] if v['cls'] == 'tracePolicy')
            stats['acyclicCycleNodes'] += sum(1 for v in cv[cid] if v['cls'] == 'acyclic')
            if s_keys == c_keys:
                stats['agreeingCases'] += 1
            elif len(stats['disagreements']) < 20:
                stats['disagreements'].append({'caseId': cid, 'sparqlOnly': sorted(map(str, s_keys - c_keys)),
                                               'coreOnly': sorted(map(str, c_keys - s_keys))})
    with open(outp, 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2)


if __name__ == '__main__':
    main()
