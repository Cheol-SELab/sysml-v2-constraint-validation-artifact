"""Oracle-side S1: SysML-v2-like JSON model -> RDF typed graph (independent of model/graph.ts).

Encoding (vocabulary under urn:oracle:):
  node  <urn:oracle:m{k}:n:{id}>  rdf:type <urn:oracle:type:{T}>, <urn:oracle:Element>
        <urn:oracle:attr:{a}> literal            (one triple per attribute)
  edge  <urn:oracle:m{k}:e:{id}>  rdf:type <urn:oracle:edgetype:{t}>, <urn:oracle:Edge>
        <urn:oracle:src> node ; <urn:oracle:tgt> node   (reified: parallel edges stay distinct)
        plus the direct triple  src <urn:oracle:rel:{t}> tgt  (for SPARQL property paths)
Several models can share one RDF graph; k keeps them disjoint, and every rule of the oracle is
evaluated inside connected structure only, so violations of a disjoint union are the disjoint
union of the violations.
"""
from urllib.parse import quote, unquote

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF

BASE = 'urn:oracle:'
SRC = URIRef(BASE + 'src')
TGT = URIRef(BASE + 'tgt')
ELEMENT = URIRef(BASE + 'Element')
EDGE = URIRef(BASE + 'Edge')


def q(s):
    return quote(str(s), safe='')


def type_iri(t):
    return URIRef(BASE + 'type:' + q(t))


def edgetype_iri(t):
    return URIRef(BASE + 'edgetype:' + q(t))


def rel_iri(t):
    return URIRef(BASE + 'rel:' + q(t))


def attr_iri(a):
    return URIRef(BASE + 'attr:' + q(a))


def node_iri(k, nid):
    return URIRef(f'{BASE}m{k}:n:{q(nid)}')


def edge_iri(k, eid):
    return URIRef(f'{BASE}m{k}:e:{q(eid)}')


def parse_iri(iri):
    """-> (model index, 'n'|'e', id) for model resources, else None."""
    s = str(iri)
    if not s.startswith(BASE + 'm'):
        return None
    rest = s[len(BASE) + 1:]
    k, kind, ident = rest.split(':', 2)
    return int(k), kind, unquote(ident)


def to_literal(v):
    # JSON booleans must be tested before numbers (bool is an int subclass in Python).
    if isinstance(v, bool):
        return Literal(v)
    if isinstance(v, int):
        return Literal(v)
    if isinstance(v, float):
        return Literal(v)
    return Literal(str(v))


def add_model(g, k, model):
    """Adds model k to graph g. Returns the number of dropped dangling edges."""
    node_ids = set()
    for n in model['nodes']:
        if n['id'] in node_ids:
            raise ValueError(f"duplicate node id {n['id']} in model {model.get('id')}")
        node_ids.add(n['id'])
        s = node_iri(k, n['id'])
        g.add((s, RDF.type, ELEMENT))
        g.add((s, RDF.type, type_iri(n['type'])))
        for a, v in (n.get('attrs') or {}).items():
            if v is None:
                continue
            g.add((s, attr_iri(a), to_literal(v)))
    dropped = 0
    edge_ids = set()
    for e in model['edges']:
        if e['id'] in edge_ids:
            raise ValueError(f"duplicate edge id {e['id']} in model {model.get('id')}")
        edge_ids.add(e['id'])
        if e['src'] not in node_ids or e['tgt'] not in node_ids:
            dropped += 1  # S1: dangling references are excluded from the graph
            continue
        x = edge_iri(k, e['id'])
        s, t = node_iri(k, e['src']), node_iri(k, e['tgt'])
        g.add((x, RDF.type, EDGE))
        g.add((x, RDF.type, edgetype_iri(e['type'])))
        g.add((x, SRC, s))
        g.add((x, TGT, t))
        g.add((s, rel_iri(e['type']), t))
    return dropped


def models_to_graph(models):
    g = Graph()
    dropped = 0
    for k, m in enumerate(models):
        dropped += add_model(g, k, m)
    return g, dropped
