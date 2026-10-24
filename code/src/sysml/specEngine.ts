/**
 * Specialization-aware rule evaluation: every type atom t(x) of L_C is read as
 * tau_V(x) <= A(t) (conformance to the catalog anchor through the specialization
 * closure) instead of string equality. The closure is precomputed by S1 into a class
 * set per node; with singleton class sets {tau_V(x)} the evaluator coincides with the
 * production engine (checked by `crossCheckAgainstEngine`).
 *
 * The evaluator mirrors validator/engine.ts rule by rule; only the type test differs.
 */

import { inDomain, makeViolation, violationKey } from '../catalog/rules';
import { kHopNodes } from '../model/graph';
import { Catalog, Rule, TypedGraph, Violation } from '../model/types';
import { evaluateGlobalRuleBatch, validate } from '../validator/engine';

export type ClassMap = Map<string, Set<string>>;

function has(classes: ClassMap, g: TypedGraph, id: string, t: string): boolean {
  const c = classes.get(id);
  if (c) return c.has(t);
  return g.nodes.get(id)?.type === t;
}

function scopedNodes(g: TypedGraph, scope: Set<string> | undefined): Iterable<string> {
  if (!scope) return g.nodes.keys();
  const live: string[] = [];
  for (const v of scope) if (g.nodes.has(v)) live.push(v);
  return live;
}

function scopedEdges(g: TypedGraph, scope: Set<string> | undefined): Iterable<string> {
  if (!scope) return g.edges.keys();
  const ids = new Set<string>();
  for (const v of scope) for (const eid of g.out.get(v) ?? []) ids.add(eid);
  return ids;
}

export function evaluateLocalRuleSpec(g: TypedGraph, classes: ClassMap, r: Rule, scope?: Set<string>): Violation[] {
  const out: Violation[] = [];
  switch (r.kind) {
    case 'relationType': {
      for (const eid of scopedEdges(g, scope)) {
        const e = g.edges.get(eid);
        if (!e || e.type !== r.edgeType) continue;
        const okS = r.srcTypes.some((t) => has(classes, g, e.src, t));
        const okT = r.tgtTypes.some((t) => has(classes, g, e.tgt, t));
        if (!okS || !okT) {
          const s = g.nodes.get(e.src)!;
          const t = g.nodes.get(e.tgt)!;
          out.push(makeViolation(r.id, r.kind, [e.id], `relation ${e.id}:${e.type} connects ${s.type} -> ${t.type}`, e.src));
        }
      }
      break;
    }
    case 'requiredAttr': {
      for (const id of scopedNodes(g, scope)) {
        if (!has(classes, g, id, r.nodeType)) continue;
        if (g.nodes.get(id)!.attrs[r.attr] === undefined) out.push(makeViolation(r.id, r.kind, [id], `missing required attribute ${r.attr}`, id));
      }
      break;
    }
    case 'attrDomain': {
      for (const id of scopedNodes(g, scope)) {
        if (!has(classes, g, id, r.nodeType)) continue;
        const v = g.nodes.get(id)!.attrs[r.attr];
        if (v === undefined) continue;
        if (!inDomain(v, r.domain)) out.push(makeViolation(r.id, r.kind, [id], `attribute ${r.attr}=${String(v)} outside domain`, id));
      }
      break;
    }
    case 'multiplicity': {
      for (const id of scopedNodes(g, scope)) {
        if (!has(classes, g, id, r.nodeType)) continue;
        const list = (r.dir === 'out' ? g.out.get(id) : g.in.get(id)) ?? [];
        let count = 0;
        for (const eid of list) if (g.edges.get(eid)!.type === r.edgeType) count++;
        const upperOk = r.max < 0 || count <= r.max;
        if (count < r.min || !upperOk) {
          out.push(makeViolation(r.id, r.kind, [id], `${r.dir} degree of ${r.edgeType} is ${count}, expected [${r.min}, ${r.max < 0 ? 'inf' : r.max}]`, id));
        }
      }
      break;
    }
    case 'isolated': {
      for (const id of scopedNodes(g, scope)) {
        if (!has(classes, g, id, r.nodeType)) continue;
        const deg = (g.out.get(id)?.length ?? 0) + (g.in.get(id)?.length ?? 0);
        if (deg === 0) out.push(makeViolation(r.id, r.kind, [id], `isolated ${g.nodes.get(id)!.type}`, id));
      }
      break;
    }
    case 'viewConsistency': {
      const p = r.policy;
      for (const id of scopedNodes(g, scope)) {
        if (!has(classes, g, id, p.viewType)) continue;
        const subjects: string[] = [];
        const exposed: string[] = [];
        for (const eid of g.out.get(id) ?? []) {
          const e = g.edges.get(eid)!;
          if (e.type === p.subjectEdgeType) subjects.push(e.tgt);
          else if (e.type === p.exposeEdgeType) exposed.push(e.tgt);
        }
        for (const x of exposed) {
          let ok = false;
          for (const s of subjects) {
            if (s === x) ok = true;
            for (const eid of g.out.get(s) ?? []) {
              const e = g.edges.get(eid)!;
              if (e.type === p.containEdgeType && e.tgt === x) ok = true;
            }
            if (ok) break;
          }
          if (!ok) out.push(makeViolation(r.id, r.kind, [id, x], `view ${id} exposes ${x} outside its subject scope`, id));
        }
      }
      break;
    }
    default:
      break;
  }
  return out;
}

export function evaluateGlobalRuleSpec(g: TypedGraph, classes: ClassMap, r: Rule): Violation[] {
  if (r.kind === 'acyclic') return evaluateGlobalRuleBatch(g, r); // type-independent
  if (r.kind !== 'tracePolicy') return [];
  const p = r.policy;
  const allowed = new Set(p.edgeTypes);
  const reaches = new Set<string>();
  const queue: string[] = [];
  for (const id of g.nodes.keys()) if (has(classes, g, id, p.targetType)) queue.push(id);
  let head = 0;
  while (head < queue.length) {
    const w = queue[head++];
    for (const eid of g.in.get(w) ?? []) {
      const e = g.edges.get(eid)!;
      if (!allowed.has(e.type) || reaches.has(e.src)) continue;
      reaches.add(e.src);
      queue.push(e.src);
    }
  }
  const out: Violation[] = [];
  for (const id of g.nodes.keys()) {
    if (!has(classes, g, id, p.sourceType)) continue;
    if (!reaches.has(id)) out.push(makeViolation(r.id, r.kind, [id], `no ${p.edgeTypes.join('|')} path from ${id} to any ${p.targetType}`, id));
  }
  return out;
}

export function validateSpec(g: TypedGraph, classes: ClassMap, rules: Rule[]): Violation[] {
  const out: Violation[] = [];
  for (const r of rules) {
    if (r.global) out.push(...evaluateGlobalRuleSpec(g, classes, r));
    else out.push(...evaluateLocalRuleSpec(g, classes, r));
  }
  return out;
}

/**
 * Scope-restricted re-validation (local rules on N_k(delta), global rules in batch):
 * the "hybrid" strategy of Algorithm 1, generalized to class sets.
 */
export function revalidateScoped(
  g: TypedGraph,
  classes: ClassMap,
  rules: Rule[],
  previous: Violation[],
  seeds: string[],
  k: number,
  /** pre-state graph: the scope is N_k(delta) in the pre-state united with N_k(delta) in the post-state */
  gPre?: TypedGraph,
): { violations: Violation[]; scopeSize: number } {
  const scope = kHopNodes(g, seeds, k);
  if (gPre) for (const v of kHopNodes(gPre, seeds, k)) scope.add(v);
  for (const s of seeds) scope.add(s);
  const out = new Map<string, Violation>();
  for (const v of previous) {
    if (v.kind === 'acyclic' || v.kind === 'tracePolicy') continue;
    if (scope.has(v.anchor)) continue;
    if (!g.nodes.has(v.anchor) && !g.edges.has(v.anchor)) continue;
    out.set(violationKey(v), v);
  }
  for (const r of rules) {
    if (r.global) {
      for (const v of evaluateGlobalRuleSpec(g, classes, r)) out.set(violationKey(v), v);
    } else {
      for (const v of evaluateLocalRuleSpec(g, classes, r, scope)) if (scope.has(v.anchor)) out.set(violationKey(v), v);
    }
  }
  return { violations: [...out.values()], scopeSize: scope.size };
}

/** Engine-equivalence check: with singleton classes the evaluator must equal validate(). */
export function crossCheckAgainstEngine(g: TypedGraph, c: Catalog, rules: Rule[]): { equal: boolean; engine: number; spec: number } {
  const singleton: ClassMap = new Map();
  for (const [id, n] of g.nodes) singleton.set(id, new Set([n.type]));
  const a = new Set(validate(g, c, rules).map(violationKey));
  const b = new Set(validateSpec(g, singleton, rules).map(violationKey));
  let equal = a.size === b.size;
  if (equal) for (const x of a) if (!b.has(x)) equal = false;
  return { equal, engine: a.size, spec: b.size };
}
