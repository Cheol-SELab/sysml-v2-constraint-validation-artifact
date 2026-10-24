"""Writes the oracle's RDF encoding of one model and the SHACL shapes of one catalog as files, so that
other SHACL engines (Node.js, JVM) validate exactly the same Turtle as pySHACL (round-2 item N2).

usage: python export_ttl.py <catalog.json> <model.json> <data.ttl> [--shapes <shapes.ttl> --rules <rules.json> [--shapes-core <core.ttl>]]

The encoding is rdf_export.add_model (model index 0) and the shapes are shapes.translate; nothing is
derived from the TypeScript rule code. rules.json maps every shape IRI to {id, cls}.
"""
import json
import sys

from rdflib import Graph, Namespace

SH = Namespace('http://www.w3.org/ns/shacl#')

from rdf_export import add_model
from shapes import translate


def main():
    a = sys.argv[1:]
    cat_f, model_f, data_f = a[0], a[1], a[2]
    with open(cat_f, encoding='utf-8') as f:
        catalog = json.load(f)
    with open(model_f, encoding='utf-8') as f:
        model = json.load(f)
    g = Graph()
    dropped = add_model(g, 0, model)
    g.serialize(destination=data_f, format='turtle', encoding='utf-8')
    info = {'triples': len(g), 'droppedDangling': dropped}
    if '--shapes' in a:
        ttl, rules = translate(catalog)
        with open(a[a.index('--shapes') + 1], 'w', encoding='utf-8') as f:
            f.write(ttl)
        if '--shapes-core' in a:
            # SHACL Core subset: drop the shapes that need SHACL-SPARQL (view, acyclic, trace)
            sg = Graph().parse(data=ttl, format='turtle')
            sparql = [s for s in set(sg.subjects(SH.sparql, None))]
            for s in sparql:
                for _, _, c in list(sg.triples((s, SH.sparql, None))):
                    sg.remove((c, None, None))
                sg.remove((s, None, None))
            sg.serialize(destination=a[a.index('--shapes-core') + 1], format='turtle', encoding='utf-8')
        shape_map = {s: {'id': r['id'], 'cls': r['cls']} for r in rules for s in r['shapes']}
        with open(a[a.index('--rules') + 1], 'w', encoding='utf-8') as f:
            json.dump({'rules': [{'id': r['id'], 'cls': r['cls'], 'layer': r['layer']} for r in rules],
                       'shapeToRule': shape_map}, f, ensure_ascii=False, indent=1)
    print(json.dumps(info))


if __name__ == '__main__':
    main()
