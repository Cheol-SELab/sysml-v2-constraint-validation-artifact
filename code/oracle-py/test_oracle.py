"""Hand-written oracle checks. Expected values come from the manuscript's worked example
(Tables "예제 모델" / "단계 S4의 결함 노출", S5 paragraph) and from oracle_spec.py, not from the
TypeScript implementation.  Run: .venv/Scripts/python.exe -B -m unittest test_oracle.py
"""
import copy
import json
import os
import unittest

from rdflib import Graph

from rdf_export import add_model
from run_oracle import parse_report, run_shacl
from shapes import translate

HERE = os.path.dirname(os.path.abspath(__file__))

AEROSPACE = {
    'id': 'aerospace',
    'allowed': {
        'satisfy': {'src': ['Component'], 'tgt': ['Requirement']},
        'verify': {'src': ['VerificationCase'], 'tgt': ['Requirement']},
        'allocate': {'src': ['Function'], 'tgt': ['Component']},
        'connect': {'src': ['Port'], 'tgt': ['Port']},
        'contain': {'src': ['Component'], 'tgt': ['Component', 'Port']},
        'dependOn': {'src': ['Component'], 'tgt': ['Component']},
        'expose': {'src': ['View'], 'tgt': ['Component', 'Port']},
        'subject': {'src': ['View'], 'tgt': ['Component']},
    },
    'requiredAttr': {
        'Requirement': ['name', 'priority'], 'Function': ['name'],
        'Component': ['name', 'criticality', 'mass'], 'Interface': ['name'],
        'Port': ['name', 'direction'], 'VerificationCase': ['name', 'method'], 'View': ['name'],
    },
    'domain': {
        'Component.criticality': {'kind': 'enum', 'values': ['A', 'B', 'C', 'D']},
        'Component.mass': {'kind': 'range', 'min': 0, 'max': 10000},
        'Requirement.priority': {'kind': 'enum', 'values': ['high', 'medium', 'low']},
        'Port.direction': {'kind': 'enum', 'values': ['in', 'out']},
        'VerificationCase.method': {'kind': 'enum', 'values': ['test', 'analysis', 'inspection', 'demonstration']},
        'Component.name': {'kind': 'nonEmptyString'},
        'Requirement.name': {'kind': 'nonEmptyString'},
    },
    'multiplicity': {
        'Requirement|satisfy|in': [1, -1], 'Requirement|verify|in': [1, -1],
        'Function|allocate|out': [1, 1], 'Port|contain|in': [1, 1], 'View|subject|out': [1, 1],
    },
    'acyclic': ['dependOn'],
    'tracePolicy': [{'id': 'FUN2REQ', 'sourceType': 'Function', 'edgeTypes': ['allocate', 'satisfy'], 'targetType': 'Requirement'}],
    'nonIsolated': ['Requirement', 'Function', 'Component', 'Interface', 'Port', 'VerificationCase'],
    'viewPolicy': {'viewType': 'View', 'subjectEdgeType': 'subject', 'exposeEdgeType': 'expose', 'containEdgeType': 'contain'},
}


def n(i, t, **a):
    return {'id': i, 'type': t, 'attrs': a}


def e(i, t, s, g):
    return {'id': i, 'type': t, 'src': s, 'tgt': g}


# Table "예제 모델" (manuscript). Names are added where the catalog requires them; the table
# lists only the attributes relevant to the example.
EXAMPLE = {
    'id': 'example',
    'nodes': [
        n('R1', 'Requirement', name='AttitudeHold', priority='high'),
        n('F1', 'Function', name='StabilizeAttitude'),
        n('C1', 'Component', name='C1', criticality='A', mass=2.5),
        n('C2', 'Component', name='C2', criticality='B', mass=4.0),
        n('P1', 'Port', name='P1', direction='out'),
        n('P2', 'Port', name='P2', direction='in'),
        n('V1', 'VerificationCase', name='V1', method='test'),
        n('W1', 'View', name='PowerView'),
    ],
    'edges': [
        e('e1', 'contain', 'C1', 'P1'), e('e2', 'contain', 'C2', 'P2'), e('e3', 'connect', 'P1', 'P2'),
        e('e4', 'allocate', 'F1', 'C1'), e('e5', 'satisfy', 'C1', 'R1'), e('e6', 'verify', 'V1', 'R1'),
        e('e7', 'subject', 'W1', 'C2'), e('e8', 'expose', 'W1', 'P2'), e('e9', 'dependOn', 'C1', 'C2'),
    ],
}


def oracle(model, catalog=AEROSPACE):
    ttl, rules = translate(catalog)
    shapes = Graph().parse(data=ttl, format='turtle')
    data = Graph()
    add_model(data, 0, model)
    _, report = run_shacl(data, shapes)
    s2r = {s: r for r in rules for s in r['shapes']}
    return parse_report(report, data, s2r, ['x'])['x'], rules


def rules_of(vs):
    return sorted({v['rule'] for v in vs})


class WorkedExample(unittest.TestCase):
    def test_rule_counts_match_manuscript(self):
        _, rules = oracle(EXAMPLE)
        counts = {}
        for r in rules:
            counts[r['cls']] = counts.get(r['cls'], 0) + 1
        self.assertEqual(len(rules), 41)
        self.assertEqual(counts, {'relationType': 8, 'requiredAttr': 12, 'attrDomain': 7, 'multiplicity': 5,
                                  'isolated': 6, 'viewConsistency': 1, 'acyclic': 1, 'tracePolicy': 1})

    def test_clean(self):
        vs, _ = oracle(EXAMPLE)
        self.assertEqual(vs, [])

    def test_edit_retarget_allocate(self):
        m = copy.deepcopy(EXAMPLE)
        m['edges'][3]['tgt'] = 'R1'
        vs, _ = oracle(m)
        # Table S4 reports only TYPE:allocate. F1 -allocate-> R1 still reaches a Requirement,
        # so the trace policy holds under A10 (path language over edge types only).
        self.assertEqual(rules_of(vs), ['TYPE:allocate'])

    def test_edit_domain(self):
        m = copy.deepcopy(EXAMPLE)
        m['nodes'][3]['attrs']['criticality'] = 'X'
        vs, _ = oracle(m)
        self.assertEqual(rules_of(vs), ['DOM:Component.criticality'])

    def test_edit_cycle(self):
        m = copy.deepcopy(EXAMPLE)
        m['edges'].append(e('e10', 'dependOn', 'C2', 'C1'))
        vs, _ = oracle(m)
        self.assertEqual(rules_of(vs), ['ACYC:dependOn'])
        self.assertEqual(sorted(v['grounding'][0] for v in vs), ['e10', 'e9'])

    def test_s5_delete_satisfy(self):
        m = copy.deepcopy(EXAMPLE)
        m['edges'] = [x for x in m['edges'] if x['id'] != 'e5']
        vs, _ = oracle(m)
        self.assertEqual(rules_of(vs), ['MULT:Requirement|satisfy|in', 'TRACE:FUN2REQ'])


class Spec(unittest.TestCase):
    def test_domain_types_and_bounds(self):
        m = copy.deepcopy(EXAMPLE)
        m['nodes'][2]['attrs']['mass'] = 10000      # closed upper bound: valid
        m['nodes'][3]['attrs']['mass'] = '4.0'      # string is not numeric: invalid
        vs, _ = oracle(m)
        self.assertEqual([(v['rule'], v['grounding']) for v in vs], [('DOM:Component.mass', ['C2'])])

    def test_empty_name_and_missing(self):
        m = copy.deepcopy(EXAMPLE)
        m['nodes'][2]['attrs']['name'] = ''
        del m['nodes'][3]['attrs']['mass']
        vs, _ = oracle(m)
        self.assertEqual(sorted((v['rule'], v['grounding'][0]) for v in vs),
                         [('DOM:Component.name', 'C1'), ('REQ:Component.mass', 'C2')])

    def test_dangling_dropped_and_isolated(self):
        m = copy.deepcopy(EXAMPLE)
        m['nodes'].append(n('C3', 'Component', name='C3', criticality='A', mass=1))
        m['edges'].append(e('e11', 'dependOn', 'C3', 'NOPE'))
        vs, _ = oracle(m)
        self.assertEqual([(v['rule'], v['grounding']) for v in vs], [('ISO:Component', ['C3'])])

    def test_view_consistency(self):
        m = copy.deepcopy(EXAMPLE)
        m['edges'].append(e('e12', 'expose', 'W1', 'P1'))   # P1 is contained by C1, not by subject C2
        vs, _ = oracle(m)
        self.assertEqual([(v['rule'], v['grounding']) for v in vs], [('VIEW:View', ['W1', 'P1'])])

    def test_multiplicity_upper(self):
        m = copy.deepcopy(EXAMPLE)
        m['edges'].append(e('e13', 'allocate', 'F1', 'C2'))
        vs, _ = oracle(m)
        self.assertEqual(rules_of(vs), ['MULT:Function|allocate|out'])

    def test_self_loop_cycle(self):
        m = copy.deepcopy(EXAMPLE)
        m['edges'].append(e('e14', 'dependOn', 'C2', 'C2'))
        vs, _ = oracle(m)
        self.assertEqual([(v['rule'], v['grounding']) for v in vs], [('ACYC:dependOn', ['e14', 'C2', 'C2'])])

    def test_trace_with_empty_edge_type_set(self):
        # review n20 probe 16b: T = {} gives the empty path language, so every source violates
        cat = copy.deepcopy(AEROSPACE)
        cat['tracePolicy'] = [{'id': 'EMPTY', 'sourceType': 'Function', 'edgeTypes': [], 'targetType': 'Requirement'}]
        vs, _ = oracle(copy.deepcopy(EXAMPLE), cat)
        self.assertEqual([(v['rule'], v['grounding']) for v in vs], [('TRACE:EMPTY', ['F1'])])


if __name__ == '__main__':
    unittest.main()
