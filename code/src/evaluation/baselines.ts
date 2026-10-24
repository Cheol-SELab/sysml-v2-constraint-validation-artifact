/**
 * Catalog-independent baselines (section 6.5).
 *
 * Both baselines satisfy the catalog-independence property of Theorem 7: their output is a
 * function of the model alone, never of the catalog. They are given every check a
 * catalog-independent tool can plausibly perform, including an orphan-element warning, so
 * that the reported separation is not an artifact of a weak baseline.
 */

import { SysMLLikeModel } from '../model/types';

export interface BaselineFinding {
  check: string;
  witness: string[];
}

const LANGUAGE_NODE_TYPES = new Set(['Requirement', 'Function', 'Component', 'Interface', 'Port', 'VerificationCase', 'View']);
const LANGUAGE_EDGE_TYPES = new Set(['satisfy', 'verify', 'allocate', 'connect', 'contain', 'dependOn', 'expose', 'subject']);
const CONTAINMENT_EDGE_TYPE = 'contain';
const DEPENDENCY_EDGE_TYPE = 'dependOn';
const SATISFY_EDGE_TYPE = 'satisfy';
const REQUIREMENT_NODE_TYPE = 'Requirement';

/** Non-trivial SCCs (size >= 2 or a self-loop) of the dependOn edges between existing nodes (iterative Tarjan). */
function dependencyCycles(model: SysMLLikeModel, ids: Set<string>): string[][] {
  const adj = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const e of model.edges) {
    if (e.type !== DEPENDENCY_EDGE_TYPE || !ids.has(e.src) || !ids.has(e.tgt)) continue;
    if (e.src === e.tgt) selfLoop.add(e.src);
    const l = adj.get(e.src);
    if (l) l.push(e.tgt);
    else adj.set(e.src, [e.tgt]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comps: string[][] = [];
  let next = 0;
  for (const root of adj.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1];
      const succ = adj.get(top.v) ?? [];
      if (top.i < succ.length) {
        const w = succ[top.i++];
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const p = work[work.length - 1].v;
        low.set(p, Math.min(low.get(p)!, low.get(top.v)!));
      }
      if (low.get(top.v) === index.get(top.v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.v);
        if (comp.length > 1 || selfLoop.has(top.v)) comps.push(comp.sort());
      }
    }
  }
  return comps;
}

/** Baseline A: JSON schema conformance and reference existence. */
export function baselineA(model: SysMLLikeModel): BaselineFinding[] {
  const out: BaselineFinding[] = [];
  const ids = new Set<string>();
  for (const n of model.nodes) {
    if (ids.has(n.id)) out.push({ check: 'duplicateNodeId', witness: [n.id] });
    ids.add(n.id);
    if (typeof n.id !== 'string' || n.id.length === 0) out.push({ check: 'malformedId', witness: [String(n.id)] });
    if (typeof n.type !== 'string' || n.type.length === 0) out.push({ check: 'malformedType', witness: [n.id] });
  }
  const edgeIds = new Set<string>();
  for (const e of model.edges) {
    if (edgeIds.has(e.id)) out.push({ check: 'duplicateEdgeId', witness: [e.id] });
    edgeIds.add(e.id);
    if (!ids.has(e.src)) out.push({ check: 'danglingReference', witness: [e.id, e.src] });
    if (!ids.has(e.tgt)) out.push({ check: 'danglingReference', witness: [e.id, e.tgt] });
  }
  return out;
}

/**
 * Baseline B: syntax/reference/type-vocabulary diagnostics of the kind a SysML v2 parser or
 * language server provides, plus ownership well-formedness, a dependency-cycle warning, an
 * unsatisfied-requirement warning and an orphan warning. The last three use the fixed
 * language vocabulary (dependOn, satisfy, Requirement), never the catalog.
 */
export function baselineB(model: SysMLLikeModel): BaselineFinding[] {
  const out: BaselineFinding[] = [...baselineA(model)];
  const ids = new Set(model.nodes.map((n) => n.id));

  for (const n of model.nodes) {
    if (!LANGUAGE_NODE_TYPES.has(n.type)) out.push({ check: 'unknownNodeType', witness: [n.id] });
  }
  for (const e of model.edges) {
    if (!LANGUAGE_EDGE_TYPES.has(e.type)) out.push({ check: 'unknownEdgeType', witness: [e.id] });
  }

  // ownership must form a forest: at most one owner, no containment cycle, no self ownership
  const owner = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.type !== CONTAINMENT_EDGE_TYPE) continue;
    if (e.src === e.tgt) out.push({ check: 'selfOwnership', witness: [e.tgt] });
    const list = owner.get(e.tgt);
    if (list) list.push(e.src);
    else owner.set(e.tgt, [e.src]);
  }
  for (const [child, parents] of owner) {
    if (parents.length > 1) out.push({ check: 'multipleOwners', witness: [child] });
  }
  const state = new Map<string, number>();
  const walk = (v: string): void => {
    state.set(v, 1);
    for (const p of owner.get(v) ?? []) {
      const s = state.get(p) ?? 0;
      if (s === 1) out.push({ check: 'ownershipCycle', witness: [v, p] });
      else if (s === 0) walk(p);
    }
    state.set(v, 2);
  };
  for (const v of ids) if ((state.get(v) ?? 0) === 0) walk(v);

  // dependency-cycle warning (review n12): language-level check offered by catalog-independent
  // tools (cyclic dependOn among existing elements); one finding per non-trivial SCC
  for (const comp of dependencyCycles(model, ids)) out.push({ check: 'dependencyCycle', witness: comp });

  // unsatisfied-requirement warning (review n12): a requirement that no element satisfies
  const satisfied = new Set<string>();
  for (const e of model.edges) if (e.type === SATISFY_EDGE_TYPE && ids.has(e.src) && ids.has(e.tgt)) satisfied.add(e.tgt);
  for (const n of model.nodes) {
    if (n.type === REQUIREMENT_NODE_TYPE && !satisfied.has(n.id)) out.push({ check: 'unsatisfiedRequirement', witness: [n.id] });
  }

  // orphan warning: an element with no relationship at all
  const degree = new Map<string, number>();
  for (const n of model.nodes) degree.set(n.id, 0);
  for (const e of model.edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.tgt, (degree.get(e.tgt) ?? 0) + 1);
  }
  for (const n of model.nodes) {
    if ((degree.get(n.id) ?? 0) === 0) out.push({ check: 'orphanElement', witness: [n.id] });
  }
  return out;
}

/** A defect is "detected" by a baseline if some finding mentions one of its support ids. */
export function baselineDetects(findings: BaselineFinding[], support: string[]): boolean {
  const s = new Set(support);
  for (const f of findings) for (const w of f.witness) if (s.has(w)) return true;
  return false;
}
