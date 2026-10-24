/**
 * Defect injection with the non-interference scheduler of Theorem 8 (section 6.4).
 *
 * A candidate defect is accepted only if its scope
 *     scope(d) = N_k(supp(d)) union Reach_global(supp(d))
 * is disjoint from the scope of every already accepted defect. Discarded candidates are
 * counted and reported, because a silently relaxed condition would bias precision/recall.
 */

import { maxLocalRadius } from '../catalog/rules';
import { GeneratedModel } from '../generator/syntheticModelGenerator';
import { applyChanges, cloneGraph, kHopNodes } from '../model/graph';
import { Catalog, Change, ModelNode, Rule, TypedGraph } from '../model/types';
import { Rng } from '../util/rng';

export type DefectType = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8';

export const DEFECT_TYPES: DefectType[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];

export const DEFECT_LABEL: Record<DefectType, string> = {
  D1: 'wrong relation source/target type',
  D2: 'missing mandatory relation',
  D3: 'missing required attribute',
  D4: 'attribute value outside domain',
  D5: 'broken traceability path',
  D6: 'cyclic dependency',
  D7: 'isolated element',
  D8: 'view-model mismatch',
};

/** Rule kinds each defect type is designed to trigger (construct-validity table). */
export const DEFECT_TARGET_KIND: Record<DefectType, string> = {
  D1: 'relationType',
  D2: 'multiplicity',
  D3: 'requiredAttr',
  D4: 'attrDomain',
  D5: 'tracePolicy',
  D6: 'acyclic',
  D7: 'isolated',
  D8: 'viewConsistency',
};

export interface Defect {
  id: string;
  type: DefectType;
  changes: Change[];
  support: string[];
  /** mutation operator (E3 v2); undefined for the original operators */
  operator?: string;
  /** central node of the injection position (E3 v2) */
  position?: string;
}

/** Edge types that carry global (transitive closure) rules. */
export function globalEdgeTypes(rules: Rule[]): Set<string> {
  const s = new Set<string>();
  for (const r of rules) {
    if (r.kind === 'acyclic') s.add(r.edgeType);
    else if (r.kind === 'tracePolicy') for (const t of r.policy.edgeTypes) s.add(t);
  }
  return s;
}

/** Forward and backward closure over global-rule edge types. */
export function globalReach(g: TypedGraph, seeds: string[], types: Set<string>): Set<string> {
  const seen = new Set<string>(seeds.filter((s) => g.nodes.has(s)));
  const queue = [...seen];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    for (const eid of g.out.get(v) ?? []) {
      const e = g.edges.get(eid)!;
      if (!types.has(e.type)) continue;
      if (!seen.has(e.tgt)) {
        seen.add(e.tgt);
        queue.push(e.tgt);
      }
    }
    for (const eid of g.in.get(v) ?? []) {
      const e = g.edges.get(eid)!;
      if (!types.has(e.type)) continue;
      if (!seen.has(e.src)) {
        seen.add(e.src);
        queue.push(e.src);
      }
    }
  }
  return seen;
}

export function defectScope(g: TypedGraph, rules: Rule[], support: string[]): Set<string> {
  const k = maxLocalRadius(rules);
  const scope = kHopNodes(g, support, k);
  for (const v of globalReach(g, support, globalEdgeTypes(rules))) scope.add(v);
  return scope;
}

/**
 * scope(d) = N_k^G(supp d) u N_k^{G_d}(supp d) u Reach^G(supp d) u Reach^{G_d}(supp d),
 * where G_d is the clean graph with d alone applied. Defects that add edges change the
 * neighborhoods and closures, so the post-defect graph is included (review item M3/M5).
 */
export function defectScopePrePost(g: TypedGraph, rules: Rule[], d: Defect): Set<string> {
  const scope = defectScope(g, rules, d.support);
  const gd = cloneGraph(g);
  applyChanges(gd, d.changes);
  for (const v of defectScope(gd, rules, d.support)) scope.add(v);
  return scope;
}

function edgesOfType(g: TypedGraph, type: string): string[] {
  const out: string[] = [];
  for (const [id, e] of g.edges) if (e.type === type) out.push(id);
  return out;
}

function outEdgesOfType(g: TypedGraph, node: string, type: string): string[] {
  const out: string[] = [];
  for (const eid of g.out.get(node) ?? []) if (g.edges.get(eid)!.type === type) out.push(eid);
  return out;
}

function inEdgesOfType(g: TypedGraph, node: string, type: string): string[] {
  const out: string[] = [];
  for (const eid of g.in.get(node) ?? []) if (g.edges.get(eid)!.type === type) out.push(eid);
  return out;
}

let defectSeq = 0;

/**
 * Builds one candidate defect of the requested type, or undefined when the model offers no
 * position that keeps the defect's effect confined to its intended rule.
 */
export function buildCandidate(
  g: TypedGraph,
  c: Catalog,
  gen: GeneratedModel,
  type: DefectType,
  rng: Rng,
): Defect | undefined {
  const id = `d${defectSeq++}`;
  switch (type) {
    case 'D1': {
      const candidates = rng.shuffle(edgesOfType(g, 'connect'));
      const components = rng.shuffle(gen.componentOrder);
      if (candidates.length === 0 || components.length === 0) return undefined;
      const eid = candidates[0];
      const e = g.edges.get(eid)!;
      const target = components[0];
      return {
        id,
        type,
        changes: [
          { kind: 'delEdge', id: eid },
          { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'connect', src: e.src, tgt: target } },
        ],
        support: [e.src, e.tgt, target],
      };
    }
    case 'D2': {
      // requirement with exactly one verify edge whose verification case has spare edges
      for (const r of rng.shuffle([...gen.verifiedBy.keys()])) {
        const verifies = inEdgesOfType(g, r, 'verify');
        if (verifies.length !== 1) continue;
        const e = g.edges.get(verifies[0])!;
        if (outEdgesOfType(g, e.src, 'verify').length < 2) continue;
        return { id, type, changes: [{ kind: 'delEdge', id: e.id }], support: [e.src, e.tgt] };
      }
      return undefined;
    }
    case 'D3': {
      const attr = (c.requiredAttr.Component ?? [])[1] ?? 'criticality';
      for (const cmp of rng.shuffle(gen.componentOrder)) {
        return { id, type, changes: [{ kind: 'setAttr', id: cmp, attr, value: undefined }], support: [cmp] };
      }
      return undefined;
    }
    case 'D4': {
      for (const cmp of rng.shuffle(gen.componentOrder)) {
        return { id, type, changes: [{ kind: 'setAttr', id: cmp, attr: 'mass', value: -1 }], support: [cmp] };
      }
      return undefined;
    }
    case 'D5': {
      // component with exactly one satisfy edge, hosting at least one function,
      // whose requirement keeps another satisfying component
      for (const cmp of rng.shuffle(gen.componentOrder)) {
        const funcs = gen.functionsOf.get(cmp) ?? [];
        if (funcs.length === 0) continue;
        const sats = outEdgesOfType(g, cmp, 'satisfy');
        if (sats.length !== 1) continue;
        const e = g.edges.get(sats[0])!;
        if (inEdgesOfType(g, e.tgt, 'satisfy').length < 2) continue;
        return { id, type, changes: [{ kind: 'delEdge', id: e.id }], support: [cmp, e.tgt] };
      }
      return undefined;
    }
    case 'D6': {
      const deps = rng.shuffle(edgesOfType(g, 'dependOn'));
      if (deps.length === 0) return undefined;
      const e = g.edges.get(deps[0])!;
      if (e.src === e.tgt) return undefined;
      return {
        id,
        type,
        changes: [{ kind: 'addEdge', edge: { id: `${e.id}_${id}`, type: 'dependOn', src: e.tgt, tgt: e.src } }],
        support: [e.src, e.tgt],
      };
    }
    case 'D7': {
      const node: ModelNode = { id: `I_${id}`, type: 'Interface', attrs: {} };
      for (const a of c.requiredAttr.Interface ?? []) node.attrs[a] = `interface_${id}_${a}`;
      return { id, type, changes: [{ kind: 'addNode', node }], support: [node.id] };
    }
    case 'D8': {
      for (const w of rng.shuffle([...gen.subjectOf.keys()])) {
        const subject = gen.subjectOf.get(w)!;
        const exposeEdges = outEdgesOfType(g, w, 'expose').filter((eid) => g.edges.get(eid)!.tgt !== subject);
        if (exposeEdges.length === 0) continue;
        const foreignPort = rng
          .shuffle([...gen.portsOf.entries()].filter(([cmp, ports]) => cmp !== subject && ports.length > 0))
          .map(([, ports]) => ports[0])[0];
        if (!foreignPort) continue;
        const eid = exposeEdges[0];
        return {
          id,
          type,
          changes: [
            { kind: 'delEdge', id: eid },
            { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'expose', src: w, tgt: foreignPort } },
          ],
          support: [w, g.edges.get(eid)!.tgt, foreignPort],
        };
      }
      return undefined;
    }
  }
}

export interface ScheduleResult {
  accepted: Defect[];
  /** candidates rejected because their scope overlapped an accepted defect */
  rejectedOverlap: number;
  /** candidates that could not be constructed at all */
  rejectedInfeasible: number;
}

/**
 * Non-interference scheduler: accepts at most one defect per requested type, in random
 * order, keeping all accepted scopes pairwise disjoint.
 */
export function scheduleDefects(
  g: TypedGraph,
  c: Catalog,
  gen: GeneratedModel,
  rules: Rule[],
  types: DefectType[],
  rng: Rng,
  /** 'prepost' (default): scope on G and G_d; 'pre': original pre-state-only scope */
  scopeMode: 'pre' | 'prepost' = 'prepost',
): ScheduleResult {
  const accepted: Defect[] = [];
  const claimed = new Set<string>();
  let rejectedOverlap = 0;
  let rejectedInfeasible = 0;
  const probe = cloneGraph(g);

  for (const t of rng.shuffle(types)) {
    let placed = false;
    for (let attempt = 0; attempt < 8 && !placed; attempt++) {
      const cand = buildCandidate(probe, c, gen, t, rng);
      if (!cand) {
        rejectedInfeasible++;
        break;
      }
      const scope = scopeMode === 'pre' ? defectScope(probe, rules, cand.support) : defectScopePrePost(probe, rules, cand);
      let overlaps = false;
      for (const v of scope) {
        if (claimed.has(v)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        rejectedOverlap++;
        continue;
      }
      for (const v of scope) claimed.add(v);
      accepted.push(cand);
      placed = true;
    }
  }
  return { accepted, rejectedOverlap, rejectedInfeasible };
}
