"""Relational (sqlite3) validator for the typed-graph rule classes. Stdlib only."""
import sqlite3

SCHEMA = """
CREATE TABLE node(id TEXT PRIMARY KEY, type TEXT);
CREATE TABLE attr(node TEXT, name TEXT, vtype TEXT, vnum REAL, vstr TEXT);
CREATE TABLE edge(id TEXT PRIMARY KEY, type TEXT, src TEXT, tgt TEXT, ord INTEGER);
CREATE INDEX ix_attr ON attr(node,name);
CREATE INDEX ix_edge_s ON edge(src,type);
CREATE INDEX ix_edge_t ON edge(tgt,type);
"""


def vkind(v):
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "num"
    return "str"


def load(con, model):
    con.executescript("DELETE FROM node; DELETE FROM attr; DELETE FROM edge;")
    con.executemany("INSERT INTO node VALUES(?,?)", [(n["id"], n["type"]) for n in model["nodes"]])
    rows = []
    for n in model["nodes"]:
        for k, v in (n.get("attrs") or {}).items():
            kd = vkind(v)
            if kd == "num":
                vn = float(v)
            elif kd == "bool":
                vn = 1.0 if v else 0.0
            else:
                vn = None
            rows.append((n["id"], k, kd, vn, v if kd == "str" else None))
    con.executemany("INSERT INTO attr VALUES(?,?,?,?,?)", rows)
    con.executemany("INSERT INTO edge VALUES(?,?,?,?,?)",
                    [(e["id"], e["type"], e["src"], e["tgt"], i) for i, e in enumerate(model["edges"])])


def reach_pairs(con, types):
    """Transitive closure (path length >= 1) over edges of the given types, as a set of (a,b)."""
    types = list(types)
    if not types:
        return set()
    ph = ",".join("?" * len(types))
    sql = f"""WITH RECURSIVE r(a,b) AS (
        SELECT src,tgt FROM edge WHERE type IN ({ph})
        UNION
        SELECT r.a, e.tgt FROM r JOIN edge e ON e.src=r.b AND e.type IN ({ph}))
      SELECT a,b FROM r"""
    return set(con.execute(sql, types + types))


def _enum_eq(v, vt, vn, vs):
    k = vkind(v)
    if k != vt:
        return False
    if k == "num":
        return float(v) == vn
    if k == "bool":
        return (1.0 if v else 0.0) == vn
    return v == vs


def validate(con, catalog, model):
    load(con, model)
    out = []

    # TYPE
    for t, spec in catalog["allowed"].items():
        src, tgt = set(spec["src"]), set(spec["tgt"])
        for e, st, tt in con.execute(
                "SELECT e.id, s.type, g.type FROM edge e LEFT JOIN node s ON s.id=e.src "
                "LEFT JOIN node g ON g.id=e.tgt WHERE e.type=? ORDER BY e.ord", (t,)).fetchall():
            if st not in src or tt not in tgt:  # None (dangling endpoint) is never in the set
                out.append({"cls": "TYPE", "rule": f"TYPE:{t}", "grounding": [e]})

    # ATTR
    for t, names in catalog["requiredAttr"].items():
        for a in names:
            for (x,) in con.execute(
                    "SELECT id FROM node WHERE type=? AND NOT EXISTS "
                    "(SELECT 1 FROM attr WHERE node=node.id AND name=?)", (t, a)).fetchall():
                out.append({"cls": "ATTR", "rule": f"ATTR:{t}.{a}", "grounding": [x]})

    # DOM
    for key, d in catalog["domain"].items():
        t, a = key.split(".", 1)
        rows = con.execute(
            "SELECT n.id, a.vtype, a.vnum, a.vstr FROM node n JOIN attr a ON a.node=n.id AND a.name=? "
            "WHERE n.type=?", (a, t)).fetchall()
        for x, vt, vn, vs in rows:
            if d["kind"] == "enum":
                ok = any(_enum_eq(v, vt, vn, vs) for v in d["values"])
            elif d["kind"] == "range":
                ok = vt == "num" and d["min"] <= vn <= d["max"]
            else:  # nonEmptyString
                ok = vt == "str" and len(vs) >= 1
            if not ok:
                out.append({"cls": "DOM", "rule": f"DOM:{key}", "grounding": [x]})

    # MULT
    for key, (lo, hi) in catalog["multiplicity"].items():
        t, u, d = key.split("|")
        col = "src" if d == "out" else "tgt"
        for x, c in con.execute(
                f"SELECT n.id, (SELECT COUNT(*) FROM edge e WHERE e.{col}=n.id AND e.type=?) "
                "FROM node n WHERE n.type=?", (u, t)).fetchall():
            if c < lo or (hi != -1 and c > hi):
                out.append({"cls": "MULT", "rule": f"MULT:{key}", "grounding": [x]})

    # ISO
    for t in catalog["nonIsolated"]:
        for (x,) in con.execute(
                "SELECT id FROM node WHERE type=? AND NOT EXISTS "
                "(SELECT 1 FROM edge e WHERE e.src=node.id OR e.tgt=node.id)", (t,)).fetchall():
            out.append({"cls": "ISO", "rule": f"ISO:{t}", "grounding": [x]})

    # VIEW
    vp = catalog.get("viewPolicy")
    if vp:
        seen = set()
        for v, e, y in con.execute(
                "SELECT v.id, e.id, e.tgt FROM node v JOIN edge e ON e.src=v.id AND e.type=? "
                "WHERE v.type=? AND NOT EXISTS ("
                " SELECT 1 FROM edge e1 WHERE e1.src=v.id AND e1.type=? AND ("
                "  e1.tgt=e.tgt OR EXISTS (SELECT 1 FROM edge e2 WHERE e2.src=e1.tgt AND e2.type=? AND e2.tgt=e.tgt)))"
                " ORDER BY e.ord", (vp["exposeEdgeType"], vp["viewType"], vp["subjectEdgeType"],
                                    vp["containEdgeType"])).fetchall():
            k = tuple(sorted((v, y)))
            if k in seen:
                continue
            seen.add(k)
            out.append({"cls": "VIEW", "rule": "VIEW", "grounding": [v, y]})

    # ACYC
    for t in catalog["acyclic"]:
        R = reach_pairs(con, [t])
        seen = set()
        for e, s, g in con.execute("SELECT id,src,tgt FROM edge WHERE type=? ORDER BY ord", (t,)).fetchall():
            if (g, s) in R:
                comp = {s} | {b for (a, b) in R if a == s and (b, s) in R}
                k = tuple(sorted(comp))
                if k in seen:
                    continue
                seen.add(k)
                out.append({"cls": "ACYC", "rule": f"ACYC:{t}", "grounding": list(k)})

    # TRACE
    for p in catalog["tracePolicy"]:
        R = reach_pairs(con, p["edgeTypes"])
        tgts = {r[0] for r in con.execute("SELECT id FROM node WHERE type=?", (p["targetType"],))}
        for (x,) in con.execute("SELECT id FROM node WHERE type=?", (p["sourceType"],)).fetchall():
            if not any((x, y) in R for y in tgts):
                out.append({"cls": "TRACE", "rule": f"TRACE:{p['id']}", "grounding": [x]})
    return out


def new_con():
    con = sqlite3.connect(":memory:")
    con.executescript(SCHEMA)
    return con


def run_all(batches):
    con = new_con()
    res = {}
    for b in batches:
        for m in b["models"]:
            res[m["caseId"]] = validate(con, b["catalog"], m["model"])
    return res
