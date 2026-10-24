"""Multi-type SHACL oracle (round-2 review item N1): every node may belong to several catalog types.

usage: python run_oracle_multi.py <input.json> <output.json> --types flat|rdfs

input : {"batches": [{"catalog": {...}, "models": [{"caseId": str, "model": M}]}]}
        M = {id, nodes: [{id, type, types?, attrs}], edges: [...], hierarchy?: H}
        H = {"nodeClass": {nodeId: classKey}, "subClassOf": [[sub, super], ...],
             "anchors": {catalogType: classKey}}

--types flat : each node gets rdf:type for every catalog type in node['types'] (the class set the
               TypeScript S1 computed); no inference. This checks the multi-class evaluator only.
--types rdfs : each node gets rdf:type <class:nodeClass>; the direct generalizations are exported as
               rdfs:subClassOf between class keys, and every library anchor A(t) as
               <class:A(t)> rdfs:subClassOf <type:t>. pySHACL runs with inference='rdfs', so the
               specialization closure (and therefore the catalog-type set of every node) is computed
               by the RDFS entailment of owlrl, not by the TypeScript code. Output then also lists
               the inferred catalog-type set per node.

The catalog -> shapes translation is the unchanged shapes.translate (oracle side, independent of
the TypeScript rule derivation). The single-type field 'type' is ignored in both modes.
"""
import json
import sys
import time

from pyshacl import validate
from rdflib import Graph, URIRef
from rdflib.namespace import RDF, RDFS

from rdf_export import BASE, EDGE, ELEMENT, SRC, TGT, attr_iri, edge_iri, edgetype_iri, node_iri, parse_iri, q, \
    rel_iri, to_literal, type_iri
from run_oracle import parse_report
from shapes import translate

TYPE_PREFIX = BASE + 'type:'


def class_iri(key):
    return URIRef(BASE + 'class:' + q(key))


def add_model_multi(g, k, model, mode):
    node_ids = set()
    for n in model['nodes']:
        if n['id'] in node_ids:
            raise ValueError(f"duplicate node id {n['id']}")
        node_ids.add(n['id'])
        s = node_iri(k, n['id'])
        g.add((s, RDF.type, ELEMENT))
        if mode == 'flat':
            for t in n['types']:
                g.add((s, RDF.type, type_iri(t)))
        for a, v in (n.get('attrs') or {}).items():
            if v is None:
                continue
            g.add((s, attr_iri(a), to_literal(v)))
    if mode == 'rdfs':
        h = model['hierarchy']
        for nid, key in h['nodeClass'].items():
            if nid not in node_ids:
                raise ValueError('hierarchy names unknown node ' + nid)
            g.add((node_iri(k, nid), RDF.type, class_iri(key)))
        for sub, sup in h['subClassOf']:
            g.add((class_iri(sub), RDFS.subClassOf, class_iri(sup)))
        for t, key in h['anchors'].items():
            g.add((class_iri(key), RDFS.subClassOf, type_iri(t)))
    dropped = 0
    for e in model['edges']:
        if e['src'] not in node_ids or e['tgt'] not in node_ids:
            dropped += 1
            continue
        x = edge_iri(k, e['id'])
        s, t = node_iri(k, e['src']), node_iri(k, e['tgt'])
        g.add((x, RDF.type, EDGE))
        g.add((x, RDF.type, edgetype_iri(e['type'])))
        g.add((x, SRC, s))
        g.add((x, TGT, t))
        g.add((s, rel_iri(e['type']), t))
    return dropped


def inferred_types(data, mode):
    """Catalog types per node after RDFS entailment (computed on a separate expanded copy)."""
    if mode != 'rdfs':
        return None
    import owlrl
    g = Graph()
    for t in data:
        g.add(t)
    owlrl.DeductiveClosure(owlrl.RDFS_Semantics).expand(g)
    out = {}
    for s, _, o in g.triples((None, RDF.type, None)):
        so = str(o)
        if not so.startswith(TYPE_PREFIX):
            continue
        p = parse_iri(s)
        if not p or p[1] != 'n':
            continue
        out.setdefault(p[2], set()).add(so[len(TYPE_PREFIX):])
    from urllib.parse import unquote
    return {nid: sorted(unquote(t) for t in ts) for nid, ts in out.items()}


def run_batch(batch, mode):
    ttl, rules = translate(batch['catalog'])
    shapes = Graph().parse(data=ttl, format='turtle')
    shape_to_rule = {s: r for r in rules for s in r['shapes']}
    violations, classes, ms = {}, {}, 0.0
    for m in batch['models']:
        data = Graph()
        add_model_multi(data, 0, m['model'], mode)
        t0 = time.perf_counter()
        _, report, _ = validate(data, shacl_graph=shapes, inference='rdfs' if mode == 'rdfs' else 'none',
                                advanced=False, meta_shacl=False, abort_on_first=False, allow_warnings=False,
                                debug=False)
        ms += (time.perf_counter() - t0) * 1000
        # parse_report reads edge endpoints from the data graph (not altered by inference)
        violations.update(parse_report(report, data, shape_to_rule, [m['caseId']]))
        it = inferred_types(data, mode)
        if it is not None:
            classes[m['caseId']] = it
    out = {'catalog': batch['catalog'].get('id'),
           'rules': [{'id': r['id'], 'cls': r['cls'], 'layer': r['layer']} for r in rules],
           'violations': violations, 'timing': {'validateMs': ms, 'models': len(batch['models'])}}
    if mode == 'rdfs':
        out['inferredClasses'] = classes
    return out


def main():
    args = sys.argv[1:]
    inp, outp = args[0], args[1]
    mode = args[args.index('--types') + 1]
    if mode not in ('flat', 'rdfs'):
        raise SystemExit('--types must be flat or rdfs')
    with open(inp, encoding='utf-8') as f:
        doc = json.load(f)
    result = {'mode': mode, 'batches': [run_batch(b, mode) for b in doc['batches']]}
    with open(outp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == '__main__':
    main()
