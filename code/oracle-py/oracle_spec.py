"""Independent oracle: written-down interpretation of the manuscript (section 2.2 and 4.1-4.2).

This module is the single place where the oracle fixes its reading of the catalog semantics.
It was written from the manuscript text (main.tex, sections "형식적 문제 정의", "전체 구조와
메타모델 카탈로그", "규칙 언어 L_C와 참조 의미론", the worked example in "절차별 적용 예제") and the
catalog *data* (JSON serialised from catalog/domains.ts). It does not import, transcribe or call
the TypeScript rule derivation (catalog/rules.ts), the engine (validator/engine.ts) or the
reference implementation (reference/referenceSemantics.ts).

Interpretation (I = item taken from the manuscript, A = ambiguity resolved by the oracle; every
A-item is a place where the manuscript does not fix the semantics and is reported as such):

S1  Normalisation (typed attributed graph G = (V, E, tau_V, tau_E, attr)).
    I  Elements become V, relations become E, attributes become attr.
    I  "대상이 없는 dangling 참조는 그래프에서 제외" -> an edge whose src or tgt is not an element id
       is dropped.
    A1 Duplicate element/edge ids are outside the oracle's input domain (inputs are checked).

S2  Rule derivation C -> R_C, one rule per catalog entry (worked example: aerospace = 41 rules,
    TYPE 8, REQ 12, DOM 7, MULT 5, ISO 6, VIEW 1, ACYC 1, TRACE 1).
    relationType  Allowed(t) = (S, T): every edge e with tau_E(e) = t needs tau_V(src) in S and
                  tau_V(tgt) in T. Grounding = the edge.
    requiredAttr  RequiredAttr(T) = {a..}: every node of type T has attribute a. Grounding = node.
                  A2 "has attribute" = the key is present (any value, including "" or false).
    attrDomain    Domain("T.a") = D: every node of type T that HAS attribute a satisfies attr in D.
                  A3 an absent attribute is not a domain violation (that is requiredAttr's job).
                  enum: value equal (same JSON type and value) to a listed value.
                  range: numeric value with min <= v <= max (closed interval, A4); a non-numeric
                  value is outside the range.
                  nonEmptyString: string with length >= 1 (A5: whitespace is not trimmed).
    multiplicity  Mult(T, t, dir) = [lo, hi]: for every node x of type T, the number of edges of
                  type t leaving x (dir = out) / entering x (dir = in) lies in [lo, hi]; hi = -1
                  means infinity. Every edge counts (A6: parallel edges are counted separately;
                  the type of the opposite endpoint is not restricted).
    isolated      nonIsolated(T): every node of type T has degree >= 1 over all edge types (A7:
                  a self-loop counts). Grounding = node.
    viewConsistency  viewPolicy (viewType, subject, expose, contain): radius-2 rule. A8: every
                  element x exposed by a view w (expose edge w -> x) must be a subject of w or be
                  contained (one contain edge) by a subject of w. Grounding = (w, x).
    acyclic       Acyclic(t): "Acyclic의 참조 의미론이 비자명 SCC에 속한 엣지 집합과 대응" (proof of
                  Theorem 1). Grounding = every edge of type t inside a non-trivial SCC of the
                  t-subgraph, i.e. edge u -> v with v reaching u over t-edges (A9: a self-loop
                  counts as a cycle).
    tracePolicy   (sourceType, path language, targetType): worked example "F1에서 어떤 Requirement로도
                  allocate|satisfy 경로가 없음" -> every node of sourceType must reach some node of
                  targetType by a directed path of length >= 1 over the listed edge types
                  (A10: intermediate nodes may have any type). Grounding = source node.
"""

RULE_CLASSES = [
    'relationType', 'requiredAttr', 'attrDomain', 'multiplicity',
    'isolated', 'viewConsistency', 'acyclic', 'tracePolicy',
]

# Rule-name prefixes follow the identifiers printed in the manuscript's worked example
# (TYPE:allocate, DOM:Component.criticality, MULT:Requirement|satisfy|in, ACYC:dependOn,
# TRACE:FUN2REQ). Classes without a printed identifier get a descriptive prefix.
PREFIX = {
    'relationType': 'TYPE', 'requiredAttr': 'REQ', 'attrDomain': 'DOM', 'multiplicity': 'MULT',
    'isolated': 'ISO', 'viewConsistency': 'VIEW', 'acyclic': 'ACYC', 'tracePolicy': 'TRACE',
}

# Which SHACL layer the oracle needs for each class (used for the expressiveness table).
SHACL_LAYER = {
    'relationType': 'core', 'requiredAttr': 'core', 'attrDomain': 'core', 'multiplicity': 'core',
    'isolated': 'core', 'viewConsistency': 'sparql', 'acyclic': 'sparql-path', 'tracePolicy': 'sparql-path',
}
