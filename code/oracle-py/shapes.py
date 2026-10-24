"""Oracle-side S2: catalog data (JSON) -> W3C SHACL shapes graph (Turtle text).

Independent of catalog/rules.ts: the translation follows oracle_spec.py. Each catalog entry
becomes one named shape whose IRI encodes the rule id, so validation results map back to rules
through sh:sourceShape. Classes expressible in SHACL Core use Core only; view consistency needs
a SPARQL-based constraint (value comparison across two paths), acyclicity and trace policies
need SPARQL property paths (transitive closure is not expressible in SHACL Core).
"""
import json

from oracle_spec import PREFIX, SHACL_LAYER
from rdf_export import BASE, attr_iri, edgetype_iri, q, rel_iri, type_iri

SHAPE_BASE = BASE + 'shape:'

HEADER = """@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix o: <urn:oracle:> .
"""


def iri(u):
    return f'<{u}>'


def lit(v):
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return f'"{v!r}"^^xsd:decimal' if isinstance(v, float) else f'"{v}"^^xsd:integer'
    return json.dumps(str(v), ensure_ascii=False)


def shape_iri(rule_id, part=''):
    return SHAPE_BASE + q(rule_id) + (('/' + part) if part else '')


def class_or(types):
    if len(types) == 0:
        return 'sh:in ( )'  # nothing allowed
    return 'sh:or ( ' + ' '.join(f'[ sh:class {iri(type_iri(t))} ]' for t in types) + ' )'


def translate(catalog):
    """Returns (turtle_text, rules) where rules maps shape IRI -> rule metadata."""
    out = [HEADER]
    rules = []  # list of dicts {id, cls, shapes: [iri...], layer}

    def rule(cls, key):
        r = {'id': f'{PREFIX[cls]}:{key}', 'cls': cls, 'layer': SHACL_LAYER[cls], 'shapes': []}
        rules.append(r)
        return r

    # relationType
    for t, ends in catalog['allowed'].items():
        r = rule('relationType', t)
        ns, ps, pt = shape_iri(r['id']), shape_iri(r['id'], 'src'), shape_iri(r['id'], 'tgt')
        r['shapes'] += [ns, ps, pt]
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(edgetype_iri(t))} ;
  sh:property {iri(ps)} , {iri(pt)} .
{iri(ps)} a sh:PropertyShape ; sh:path o:src ; {class_or(ends['src'])} .
{iri(pt)} a sh:PropertyShape ; sh:path o:tgt ; {class_or(ends['tgt'])} .
""")

    # requiredAttr
    for T, attrs in catalog['requiredAttr'].items():
        for a in attrs:
            r = rule('requiredAttr', f'{T}.{a}')
            ns, ps = shape_iri(r['id']), shape_iri(r['id'], 'p')
            r['shapes'] += [ns, ps]
            out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(T))} ; sh:property {iri(ps)} .
{iri(ps)} a sh:PropertyShape ; sh:path {iri(attr_iri(a))} ; sh:minCount 1 .
""")

    # attrDomain
    for key, d in catalog['domain'].items():
        T, a = key.split('.', 1)
        r = rule('attrDomain', key)
        ns, ps = shape_iri(r['id']), shape_iri(r['id'], 'p')
        r['shapes'] += [ns, ps]
        if d['kind'] == 'enum':
            body = 'sh:in ( ' + ' '.join(lit(v) for v in d['values']) + ' )'
        elif d['kind'] == 'range':
            body = ('sh:or ( [ sh:datatype xsd:integer ] [ sh:datatype xsd:decimal ] [ sh:datatype xsd:double ] ) ; '
                    f"sh:minInclusive {lit(float(d['min']) if isinstance(d['min'], float) else d['min'])} ; "
                    f"sh:maxInclusive {lit(float(d['max']) if isinstance(d['max'], float) else d['max'])}")
        elif d['kind'] == 'nonEmptyString':
            body = 'sh:datatype xsd:string ; sh:minLength 1'
        else:
            raise ValueError('unknown domain kind ' + d['kind'])
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(T))} ; sh:property {iri(ps)} .
{iri(ps)} a sh:PropertyShape ; sh:path {iri(attr_iri(a))} ; {body} .
""")

    # multiplicity
    for key, (lo, hi) in catalog['multiplicity'].items():
        T, t, direction = key.split('|')
        r = rule('multiplicity', key)
        ns, ps = shape_iri(r['id']), shape_iri(r['id'], 'p')
        r['shapes'] += [ns, ps]
        end = 'o:src' if direction == 'out' else 'o:tgt'
        bounds = f'sh:qualifiedMinCount {lo}'
        if hi != -1:
            bounds += f' ; sh:qualifiedMaxCount {hi}'
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(T))} ; sh:property {iri(ps)} .
{iri(ps)} a sh:PropertyShape ; sh:path [ sh:inversePath {end} ] ;
  sh:qualifiedValueShape [ sh:class {iri(edgetype_iri(t))} ] ; {bounds} .
""")

    # isolated
    for T in catalog.get('nonIsolated', []):
        r = rule('isolated', T)
        ns = shape_iri(r['id'])
        r['shapes'] += [ns]
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(T))} ;
  sh:or ( [ sh:path [ sh:inversePath o:src ] ; sh:minCount 1 ] [ sh:path [ sh:inversePath o:tgt ] ; sh:minCount 1 ] ) .
""")

    # viewConsistency (SHACL-SPARQL)
    vp = catalog.get('viewPolicy')
    if vp:
        r = rule('viewConsistency', vp['viewType'])
        ns = shape_iri(r['id'])
        r['shapes'] += [ns]
        ex, sb, ct = rel_iri(vp['exposeEdgeType']), rel_iri(vp['subjectEdgeType']), rel_iri(vp['containEdgeType'])
        query = (f'SELECT $this ?value WHERE {{ $this {iri(ex)} ?value . '
                 f'FILTER NOT EXISTS {{ $this {iri(sb)} ?value }} '
                 f'FILTER NOT EXISTS {{ $this {iri(sb)} ?s . ?s {iri(ct)} ?value }} }}')
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(vp['viewType']))} ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:select {json.dumps(query)} ] .
""")

    # acyclic (SHACL-SPARQL with a property path)
    for t in catalog['acyclic']:
        r = rule('acyclic', t)
        ns = shape_iri(r['id'])
        r['shapes'] += [ns]
        query = (f'SELECT $this WHERE {{ $this <{BASE}src> ?u ; <{BASE}tgt> ?v . '
                 f'?v {iri(rel_iri(t))}* ?u . }}')
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(edgetype_iri(t))} ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:select {json.dumps(query)} ] .
""")

    # tracePolicy (SHACL-SPARQL with a property path)
    for p in catalog['tracePolicy']:
        r = rule('tracePolicy', p['id'])
        ns = shape_iri(r['id'])
        r['shapes'] += [ns]
        path = '|'.join(iri(rel_iri(t)) for t in p['edgeTypes'])
        # The type test sits in an inner FILTER so that rdflib evaluates the path from the bound
        # focus node first; as a plain BGP rdflib reorders it to enumerate all target nodes and
        # test the path for each (quadratic). Both forms have the same SPARQL semantics.
        query = (f'SELECT $this WHERE {{ FILTER NOT EXISTS {{ $this ({path})+ ?r . '
                 f'FILTER EXISTS {{ ?r a {iri(type_iri(p["targetType"]))} }} }} }}')
        if not p['edgeTypes']:
            # T = {} : the path language T+ is empty, no source reaches a target, so every focus
            # node violates (review n20 probe 16b; an empty alternative is not valid SPARQL)
            query = 'SELECT $this WHERE { }'
        out.append(f"""{iri(ns)} a sh:NodeShape ; sh:targetClass {iri(type_iri(p['sourceType']))} ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:select {json.dumps(query)} ] .
""")

    return '\n'.join(out), rules
