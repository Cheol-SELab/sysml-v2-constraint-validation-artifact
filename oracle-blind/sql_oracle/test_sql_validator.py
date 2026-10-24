import unittest, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sql_validator import new_con, validate


def cat(**kw):
    c = dict(id="t", nodeTypes=[], edgeTypes=[], allowed={}, requiredAttr={}, domain={}, multiplicity={},
             acyclic=[], tracePolicy=[], nonIsolated=[])
    c.update(kw)
    return c


def N(i, t, **a):
    return {"id": i, "type": t, "attrs": a}


def E(i, t, s, g):
    return {"id": i, "type": t, "src": s, "tgt": g}


def run(c, nodes, edges):
    return validate(new_con(), c, {"id": "m", "nodes": nodes, "edges": edges})


class T(unittest.TestCase):
    def test_type(self):
        c = cat(allowed={"r": {"src": ["A"], "tgt": ["B"]}})
        v = run(c, [N("a", "A"), N("b", "B")],
                [E("e1", "r", "a", "b"), E("e2", "r", "b", "a"), E("e3", "r", "a", "zz")])
        self.assertEqual([x["grounding"] for x in v], [["e2"], ["e3"]])

    def test_attr_dom(self):
        c = cat(requiredAttr={"A": ["n"]},
                domain={"A.n": {"kind": "nonEmptyString"}, "A.k": {"kind": "enum", "values": [1, "x"]},
                        "A.m": {"kind": "range", "min": 0, "max": 5}})
        v = run(c, [N("a", "A"), N("b", "A", n=" ", k="1", m=5), N("c", "A", n="", k=1, m=5.01),
                    N("d", "A", n=3, k=True, m=True)], [])
        got = sorted((x["rule"], x["grounding"][0]) for x in v)
        self.assertEqual(got, [("ATTR:A.n", "a"), ("DOM:A.k", "b"), ("DOM:A.k", "d"), ("DOM:A.m", "c"),
                               ("DOM:A.m", "d"), ("DOM:A.n", "c"), ("DOM:A.n", "d")])

    def test_mult(self):
        c = cat(multiplicity={"A|r|out": [1, 2], "B|r|in": [0, -1]})
        v = run(c, [N("a", "A"), N("a2", "A"), N("b", "B")],
                [E("1", "r", "a", "b"), E("2", "r", "a", "b"), E("3", "r", "a", "b")])
        self.assertEqual(sorted(x["grounding"][0] for x in v), ["a", "a2"])

    def test_iso(self):
        c = cat(nonIsolated=["A"])
        v = run(c, [N("a", "A"), N("b", "A"), N("l", "A")], [E("1", "r", "a", "b")])
        self.assertEqual([x["grounding"] for x in v], [["l"]])

    def test_view(self):
        c = cat(viewPolicy={"viewType": "V", "subjectEdgeType": "s", "exposeEdgeType": "x", "containEdgeType": "c"})
        n = [N("v", "V"), N("s", "P"), N("k", "P"), N("o", "P")]
        v = run(c, n, [E("1", "s", "v", "s"), E("2", "c", "s", "k"), E("3", "x", "v", "k"),
                       E("4", "x", "v", "s"), E("5", "x", "v", "o")])
        self.assertEqual([x["grounding"] for x in v], [["v", "o"]])

    def test_acyc(self):
        c = cat(acyclic=["d"])
        v = run(c, [N(i, "A") for i in "abcxy"],
                [E("1", "d", "a", "b"), E("2", "d", "b", "c"), E("3", "d", "c", "a"),
                 E("4", "d", "x", "x"), E("5", "d", "x", "y")])
        self.assertEqual(sorted(x["grounding"] for x in v), [["a", "b", "c"], ["x"]])

    def test_trace(self):
        c = cat(tracePolicy=[{"id": "P", "sourceType": "F", "edgeTypes": ["a", "b"], "targetType": "R"}])
        v = run(c, [N("f1", "F"), N("f2", "F"), N("m", "C"), N("r", "R")],
                [E("1", "a", "f1", "m"), E("2", "b", "m", "r"), E("3", "a", "r", "f2")])
        self.assertEqual([x["grounding"] for x in v], [["f2"]])


if __name__ == "__main__":
    unittest.main()
