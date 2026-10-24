/**
 * Production validation engine (Fig. 2, lines 1-7, and EvalLocal_r shared with the
 * incremental session).
 *
 * EvalLocal_r(G, S) is a class-specific evaluator (Table 1) in two phases:
 *   forEachGrounding()  enumerates, through the adjacency indices, the groundings whose
 *                       anchor node lies in S (all groundings when S is absent);
 *   holds()             evaluates phi_r at one grounding; violationOf() builds pi_r.
 * Anchor convention: the node itself for node-anchored rules, the source node for
 * relation-type rules (anchor variable = edge), the view for the view rule.
 *
 * The view rule uses the target-side evaluation order assumed by Theorem 3: the subject set
 * of a view is built once as a hash set, and for every exposed element x the evaluator
 * checks x itself and the owners of x (sources of contain edges entering x) against that set.
 * The owners of an element are resolved once per evaluation, so the in-adjacency of every
 * element is scanned at most once; under the ownership-forest condition (contain in-degree
 * <= 1) the rule costs O(n + m) in total.
 *
 * opCounter counts Holds evaluations, adjacency entries scanned inside Holds and nodes
 * processed by BatchGlobal, so cost can be reported deterministically (E5, E6).
 */

import { inDomain, makeViolation } from '../catalog/rules';
import { Catalog, Rule, TypedGraph, Violation } from '../model/types';
import { nonTrivialComponents } from '../witness/tarjan';

export interface OpCounter {
  /** number of Holds(phi_r, G, C, a) evaluations (local groundings evaluated) */
  groundings: number;
  /** adjacency entries scanned inside Holds (degree counting, containment look-ups) */
  scans: number;
  /** global work units of BatchGlobal: nodes processed (Tarjan: every node; reverse BFS: dequeued nodes) */
  globalWork: number;
}

export const opCounter: OpCounter = { groundings: 0, scans: 0, globalWork: 0 };

/**
 * Evaluation order of the view rule. 'target' (default) is the order assumed by Theorem 3.
 * 'subject' is the earlier nested-loop order (exposed x subjects x out(subject)), kept only
 * for the E6 comparison of the two orders on hub inputs.
 */
export const engineConfig: { viewOrder: 'target' | 'subject' } = { viewOrder: 'target' };

export function resetOpCounter(): void {
  opCounter.groundings = 0;
  opCounter.scans = 0;
  opCounter.globalWork = 0;
}

/** per-evaluation look-up cache of the view rule (subject sets per view, owners per element) */
export interface ViewCache {
  subjects: Map<string, Set<string>>;
  owners: Map<string, string[]>;
}

type LocalRule = Exclude<Rule, { kind: 'acyclic' } | { kind: 'tracePolicy' }>;

function degreeOfType(g: TypedGraph, node: string, edgeType: string, dir: 'out' | 'in'): number {
  const list = (dir === 'out' ? g.out.get(node) : g.in.get(node)) ?? [];
  opCounter.scans += list.length;
  let count = 0;
  for (const eid of list) {
    const e = g.edges.get(eid)!;
    if (e.type === edgeType) count++;
  }
  return count;
}

function nodeTypeOf(r: LocalRule): string | undefined {
  switch (r.kind) {
    case 'requiredAttr':
    case 'attrDomain':
    case 'multiplicity':
    case 'isolated':
      return r.nodeType;
    default:
      return undefined;
  }
}

/**
 * Holds(phi_r, G, C, a): the matrix of a local rule at grounding a = (a0[, a1]).
 * Returns true when the grounding satisfies the rule (no violation).
 */
export function holds(g: TypedGraph, c: Catalog, r: Rule, a0: string, a1?: string, cache?: ViewCache): boolean {
  opCounter.groundings++;
  void c;
  switch (r.kind) {
    case 'relationType': {
      const e = g.edges.get(a0)!;
      const s = g.nodes.get(e.src)!;
      const t = g.nodes.get(e.tgt)!;
      return r.srcTypes.includes(s.type) && r.tgtTypes.includes(t.type);
    }
    case 'requiredAttr':
      return g.nodes.get(a0)!.attrs[r.attr] !== undefined;
    case 'attrDomain': {
      const v = g.nodes.get(a0)!.attrs[r.attr];
      return v === undefined || inDomain(v, r.domain);
    }
    case 'multiplicity': {
      const count = degreeOfType(g, a0, r.edgeType, r.dir);
      const upperOk = r.max < 0 || count <= r.max;
      return count >= r.min && upperOk;
    }
    case 'isolated':
      return (g.out.get(a0)?.length ?? 0) + (g.in.get(a0)?.length ?? 0) > 0;
    case 'viewConsistency': {
      const p = r.policy;
      const x = a1!;
      if (engineConfig.viewOrder === 'subject') {
        for (const eid of g.out.get(a0) ?? []) {
          opCounter.scans++;
          const e = g.edges.get(eid)!;
          if (e.type !== p.subjectEdgeType) continue;
          if (e.tgt === x) return true;
          for (const cid of g.out.get(e.tgt) ?? []) {
            opCounter.scans++;
            const ce = g.edges.get(cid)!;
            if (ce.type === p.containEdgeType && ce.tgt === x) return true;
          }
        }
        return false;
      }
      // subject set of the view, built once per view and evaluation (target-side order)
      let subjects = cache?.subjects.get(a0);
      if (!subjects) {
        subjects = new Set<string>();
        for (const eid of g.out.get(a0) ?? []) {
          opCounter.scans++;
          const e = g.edges.get(eid)!;
          if (e.type === p.subjectEdgeType) subjects.add(e.tgt);
        }
        cache?.subjects.set(a0, subjects);
      }
      if (subjects.has(x)) return true;
      // owners of x (sources of contain edges entering x), resolved once per element
      let owners = cache?.owners.get(x);
      if (!owners) {
        owners = [];
        for (const eid of g.in.get(x) ?? []) {
          opCounter.scans++;
          const e = g.edges.get(eid)!;
          if (e.type === p.containEdgeType) owners.push(e.src);
        }
        cache?.owners.set(x, owners);
      }
      for (const o of owners) {
        opCounter.scans++;
        if (subjects.has(o)) return true;
      }
      return false;
    }
    default:
      return true;
  }
}

/** MakeViolation(r, a): canonical violation item of a failed grounding. */
export function violationOf(g: TypedGraph, r: Rule, a0: string, a1?: string): Violation {
  switch (r.kind) {
    case 'relationType': {
      const e = g.edges.get(a0)!;
      const s = g.nodes.get(e.src)!;
      const t = g.nodes.get(e.tgt)!;
      return makeViolation(r.id, r.kind, [e.id], `relation ${e.id}:${e.type} connects ${s.type} -> ${t.type}`, e.src);
    }
    case 'requiredAttr':
      return makeViolation(r.id, r.kind, [a0], `missing required attribute ${r.attr}`, a0);
    case 'attrDomain':
      return makeViolation(r.id, r.kind, [a0], `attribute ${r.attr}=${String(g.nodes.get(a0)!.attrs[r.attr])} outside domain`, a0);
    case 'multiplicity': {
      const count = degreeOfType(g, a0, r.edgeType, r.dir);
      return makeViolation(
        r.id,
        r.kind,
        [a0],
        `${r.dir} degree of ${r.edgeType} is ${count}, expected [${r.min}, ${r.max < 0 ? 'inf' : r.max}]`,
        a0,
      );
    }
    case 'isolated':
      return makeViolation(r.id, r.kind, [a0], `isolated ${g.nodes.get(a0)!.type}`, a0);
    case 'viewConsistency':
      return makeViolation(r.id, r.kind, [a0, a1!], `view ${a0} exposes ${a1} outside its subject scope`, a0);
    default:
      throw new Error(`not a local rule: ${r.id}`);
  }
}

/**
 * Groundings of r whose anchor node lies in S (every grounding when S is undefined).
 * Each grounding is visited exactly once.
 */
export function forEachGrounding(g: TypedGraph, r: Rule, scope: Set<string> | undefined, fn: (a0: string, a1?: string) => void): void {
  switch (r.kind) {
    case 'relationType': {
      if (!scope) {
        for (const [eid, e] of g.edges) if (e.type === r.edgeType) fn(eid);
        return;
      }
      for (const v of scope) {
        for (const eid of g.out.get(v) ?? []) {
          if (g.edges.get(eid)!.type === r.edgeType) fn(eid);
        }
      }
      return;
    }
    case 'requiredAttr':
    case 'attrDomain':
    case 'multiplicity':
    case 'isolated': {
      const t = nodeTypeOf(r)!;
      if (!scope) {
        for (const [id, n] of g.nodes) if (n.type === t) fn(id);
        return;
      }
      for (const v of scope) {
        const n = g.nodes.get(v);
        if (n && n.type === t) fn(v);
      }
      return;
    }
    case 'viewConsistency': {
      const p = r.policy;
      // guard: View(v) and expose(v, x); a grounding is visited once per (v, x) pair
      const fromView = (v: string): void => {
        const done = new Set<string>();
        for (const eid of g.out.get(v) ?? []) {
          const e = g.edges.get(eid)!;
          if (e.type !== p.exposeEdgeType || done.has(e.tgt)) continue;
          done.add(e.tgt);
          fn(v, e.tgt);
        }
      };
      if (!scope) {
        for (const [id, n] of g.nodes) if (n.type === p.viewType) fromView(id);
        return;
      }
      for (const v of scope) {
        const n = g.nodes.get(v);
        if (n && n.type === p.viewType) fromView(v);
      }
      return;
    }
    default:
      return;
  }
}

/** Grounding nodes of a local violation, read from the graph in which it was produced. */
export function groundingNodes(g: TypedGraph, v: Violation): string[] {
  if (v.kind === 'relationType') {
    const e = g.edges.get(v.witness[0]);
    return e ? [e.src, e.tgt] : [v.anchor];
  }
  return v.witness;
}

/** EvalLocal_r(G, S): local rule evaluation over the groundings anchored in S. */
export function evaluateLocalRule(g: TypedGraph, c: Catalog, r: Rule, scope?: Set<string>): Violation[] {
  const out: Violation[] = [];
  if (r.global) return out;
  const cache: ViewCache = { subjects: new Map(), owners: new Map() };
  forEachGrounding(g, r, scope, (a0, a1) => {
    if (!holds(g, c, r, a0, a1, cache)) out.push(violationOf(g, r, a0, a1));
  });
  return out;
}

/** BatchGlobal: a global rule evaluated from scratch, without witness reuse. */
export function evaluateGlobalRuleBatch(g: TypedGraph, r: Rule): Violation[] {
  const out: Violation[] = [];
  if (r.kind === 'acyclic') {
    // work unit = node processed (same unit as the witness stores' work counters)
    opCounter.globalWork += g.nodes.size;
    for (const comp of nonTrivialComponents(g, r.edgeType)) {
      out.push(makeViolation(r.id, r.kind, comp, `cyclic ${r.edgeType} dependency over {${comp.join(', ')}}`, comp[0]));
    }
    return out;
  }
  if (r.kind === 'tracePolicy') {
    const p = r.policy;
    const allowed = new Set(p.edgeTypes);
    // one reverse BFS from all target-type nodes
    const reaches = new Set<string>();
    const queue: string[] = [];
    for (const [id, n] of g.nodes) if (n.type === p.targetType) queue.push(id);
    let head = 0;
    while (head < queue.length) {
      const w = queue[head++];
      for (const eid of g.in.get(w) ?? []) {
        const e = g.edges.get(eid)!;
        if (!allowed.has(e.type)) continue;
        if (reaches.has(e.src)) continue;
        reaches.add(e.src);
        queue.push(e.src);
      }
    }
    // work unit = node processed (dequeued), as in TraceWitness.rebuild
    opCounter.globalWork += queue.length;
    for (const [id, n] of g.nodes) {
      if (n.type !== p.sourceType) continue;
      if (!reaches.has(id)) {
        out.push(makeViolation(r.id, r.kind, [id], `no ${p.edgeTypes.join('|')} path from ${id} to any ${p.targetType}`, id));
      }
    }
    return out;
  }
  return out;
}

/** Full validation: Omega(G, C, R) (Fig. 2 with Delta absent). */
export function validate(g: TypedGraph, c: Catalog, rules: Rule[]): Violation[] {
  const out: Violation[] = [];
  for (const r of rules) {
    if (r.global) out.push(...evaluateGlobalRuleBatch(g, r));
    else out.push(...evaluateLocalRule(g, c, r, undefined));
  }
  return out;
}

/** Validation with a permuted rule order (used by the Theorem 2 checks). */
export function validatePermuted(g: TypedGraph, c: Catalog, rules: Rule[], perm: number[]): Violation[] {
  const out: Violation[] = [];
  for (const i of perm) {
    const r = rules[i];
    if (r.global) out.push(...evaluateGlobalRuleBatch(g, r));
    else out.push(...evaluateLocalRule(g, c, r, undefined));
  }
  return out;
}

/** Induced subgraph on a node set (used by the naive k-hop incremental strategy). */
export function inducedSubgraph(g: TypedGraph, nodes: Set<string>): TypedGraph {
  const sub: TypedGraph = { id: `${g.id}#sub`, nodes: new Map(), edges: new Map(), out: new Map(), in: new Map() };
  for (const v of nodes) {
    const n = g.nodes.get(v);
    if (!n) continue;
    sub.nodes.set(v, n);
    sub.out.set(v, []);
    sub.in.set(v, []);
  }
  for (const v of sub.nodes.keys()) {
    for (const eid of g.out.get(v) ?? []) {
      const e = g.edges.get(eid)!;
      if (!sub.nodes.has(e.tgt)) continue;
      sub.edges.set(eid, e);
      sub.out.get(e.src)!.push(eid);
      sub.in.get(e.tgt)!.push(eid);
    }
  }
  return sub;
}
