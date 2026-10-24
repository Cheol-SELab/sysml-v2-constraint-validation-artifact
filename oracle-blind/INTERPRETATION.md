# Interpretation record (SQL oracle, blind implementation)

Implementation: `sql_oracle/sql_validator.py` (sqlite3 in-memory; tables node, attr, edge; WITH RECURSIVE closure).
Violation record: `{cls, rule, grounding}`; rule = `CLS:detail`.

## Rule classes as implemented

| Class | Rule id | Violation condition implemented |
|---|---|---|
| TYPE | `TYPE:<t>` | edge e with type t, for each t in `allowed`: type(src) not in Src_t OR type(tgt) not in Tgt_t. grounding `[e]` |
| ATTR | `ATTR:<t>.<a>` | node x of type t, a in requiredAttr[t], attribute key a absent. `[x]` |
| DOM | `DOM:<t>.<a>` | node of type t, attribute defined, value not in domain. `[x]` |
| MULT | `MULT:<t>\|<u>\|<dir>` | node x of type t; n = number of edges of type u with src=x (out) / tgt=x (in); violated if n<l or (h != -1 and n>h). `[x]` |
| ISO | `ISO:<t>` | node of type t, t in nonIsolated, no edge with src=x or tgt=x. `[x]` |
| VIEW | `VIEW` | node v of viewType, expose edge e out of v, no subject edge e1 out of v with tgt(e1)=tgt(e) or a contain edge e2 out of tgt(e1) with tgt(e2)=tgt(e). `[v, tgt(e)]` |
| ACYC | `ACYC:<t>` | edge e of type t with reach_t(tgt(e), src(e)) (closure length >= 1). One violation per SCC. `grounding = sorted node ids of SCC of src(e)` |
| TRACE | `TRACE:<id>` | node x of sourceType with no node y of targetType such that reach_T(x,y) (directed src->tgt, length >= 1, edge types in T). `[x]` |

## Ambiguities and decisions

1. **DOM range inclusivity**: closed `[min,max]` (spec: closed interval).
2. **DOM range, non-numeric value**: string or boolean is NOT numeric, so it violates. Booleans are never numbers.
3. **DOM enum strictness**: value and primitive type must both match. Primitive kinds: string, number (int and float are the same kind, so 1 == 1.0), boolean. So "1" != 1, True != 1.
4. **DOM nonEmptyString**: value must be a string of length >= 1, no trimming (" " is valid). Non-string values (number, bool) violate.
5. **DOM when attribute absent**: no violation (spec: bottom passes DOM, ATTR decides).
6. **ATTR**: a present attribute with any value (including "" or 0 or false) counts as defined.
7. **DOM/ATTR rule instances** are generated only for catalog keys (`requiredAttr`, `domain`); attributes not mentioned are unconstrained. A domain key for a type is evaluated even if the attribute is not required.
8. **Node type membership**: each input node has exactly one type string; I use it directly (no specialization closure; View is not also Component). Node types not in nodeTypes are not rejected by any rule except via Allowed/other rules.
9. **Edge types not in `allowed`** (e.g. type absent from catalog or from `allowed`): no TYPE rule exists, so no violation.
10. **Dangling edges** (1351 edges in the input have an endpoint id that is not a node): spec assumes src,tgt are total functions, so this is out of spec. Decision: TYPE flags the edge (an absent node has no type in any Src/Tgt set). MULT/ISO count such an edge for the existing endpoint. Closure/reach traverse it only if the join succeeds (a missing node can still be a reach middle/end id but is never of a target type). Not special-cased otherwise.
11. **MULT counting direction and multiplicity**: edges, not distinct neighbours (spec: ∃^{≥n} over edges; parallel edges are allowed). Self-loops count once in `out` and once in `in`. h=-1 is unbounded.
12. **MULT rule key** includes direction; one rule instance per multiplicity entry; a node with 0 edges violates when l>=1.
13. **ISO**: degree 0 means no incident edge of any type, either direction; a self-loop makes a node non-isolated. Edge type need not be in the catalog.
14. **VIEW**: uses the types named in `viewPolicy`; no policy means no rule. If subject/expose/contain edge types coincide, the formula is applied literally. The view node of the model must have type exactly viewType. Grounding recorded in formula order `[v, tgt(e)]`. Violations are deduplicated by the sorted pair (spec: the violation key sorts evidence, so (v1,v2) and (v2,v1) merge; also several expose edges from v to the same target collapse). Multiple subject edges are allowed; any one satisfying suffices (the ∃ is not unique). The contain edge e2 starts at tgt(e1) (not at the view) as the formula states.
15. **ACYC reporting**: edge-level condition, reported per SCC (Lemma). Grounding is the sorted node list of the SCC, one entry per distinct SCC per rule. SCC computed as {s} ∪ {b : reach(s,b) and reach(b,s)}. A self-loop yields a one-node SCC. Edges of the other types are ignored.
16. **TRACE**: path length >= 1 (so a source cannot trivially satisfy via itself, but if sourceType = targetType a source on a cycle can reach itself, which counts). Edges followed directed. Intermediate nodes are unconstrained in type. Empty edgeTypes means unreachable, so every source violates. A model with no source node gives no violation. A model with no target nodes gives violation for every source.
17. **Rule identity for TRACE** is the policy `id`; for MULT the raw catalog key.
18. **Deduplication of other classes**: not needed (distinct groundings per rule); only VIEW and ACYC are deduplicated by evidence key.
19. **Ordering** of the output list is by class order TYPE, ATTR, DOM, MULT, ISO, VIEW, ACYC, TRACE, then catalog order, then model order; no semantic meaning.
20. **Duplicate ids** were checked absent in the inputs; no handling implemented.
21. **Numeric comparison** goes through float64 (REAL); integers beyond 2^53 are not expected.

Total ambiguities recorded: 21 (items above; items 6, 18 to 21 are minor).
