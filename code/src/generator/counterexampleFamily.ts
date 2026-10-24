/**
 * Counterexample families of Theorem 5 (section 4.7).
 *
 * For every fixed radius k these constructions produce a change whose effect on a global
 * rule is invisible inside N_k(delta): the cycle family closes a directed path of length
 * N = 2k + 3, and the trace family cuts a path in its middle. Both models are clean before
 * the change, so the only violation after the change is the one under test.
 */

import { Catalog, ModelEdge, ModelNode, SysMLLikeModel } from '../model/types';
import { aerospaceCatalog } from '../catalog/domains';

/** Catalog with an additional long-range trace policy over dependOn chains. */
export function counterexampleCatalog(): Catalog {
  const c = aerospaceCatalog();
  c.id = 'counterexample';
  c.tracePolicy = [
    { id: 'FUN2REQ', sourceType: 'Function', edgeTypes: ['allocate', 'satisfy'], targetType: 'Requirement' },
    { id: 'COMP2REQ', sourceType: 'Component', edgeTypes: ['dependOn', 'satisfy'], targetType: 'Requirement' },
  ];
  return c;
}

interface FamilyBase {
  nodes: ModelNode[];
  edges: ModelEdge[];
  components: string[];
}

function chain(n: number, satisfyingComponentIndex: number): FamilyBase {
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  const components: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `C${i}`;
    components.push(id);
    nodes.push({ id, type: 'Component', attrs: { name: id, criticality: 'A', mass: 10 } });
  }
  for (let i = 0; i + 1 < n; i++) {
    edges.push({ id: `dep${i}`, type: 'dependOn', src: components[i], tgt: components[i + 1] });
  }
  nodes.push({ id: 'R0', type: 'Requirement', attrs: { name: 'R0', priority: 'high' } });
  nodes.push({ id: 'V0', type: 'VerificationCase', attrs: { name: 'V0', method: 'test' } });
  nodes.push({ id: 'F0', type: 'Function', attrs: { name: 'F0' } });
  const host = components[satisfyingComponentIndex];
  edges.push({ id: 'sat0', type: 'satisfy', src: host, tgt: 'R0' });
  edges.push({ id: 'ver0', type: 'verify', src: 'V0', tgt: 'R0' });
  edges.push({ id: 'alloc0', type: 'allocate', src: 'F0', tgt: host });
  return { nodes, edges, components };
}

export interface Family {
  model: SysMLLikeModel;
  catalog: Catalog;
  /** the change whose effect lies outside N_k(delta) */
  change: { kind: 'addEdge'; edge: ModelEdge } | { kind: 'delEdge'; id: string };
  /** rule id whose violation must appear (cycle) or appear (trace) after the change */
  ruleId: string;
  k: number;
  n: number;
}

/**
 * Cycle family: a directed dependOn path of N = 2k + 3 components, closed by one edge.
 * The resulting SCC spans the whole path, so any k-hop restricted re-evaluation misses it.
 */
export function cycleFamily(k: number): Family {
  const n = 2 * k + 3;
  const base = chain(n, n - 1);
  const model: SysMLLikeModel = { id: `cycle-k${k}`, nodes: base.nodes, edges: base.edges };
  return {
    model,
    catalog: counterexampleCatalog(),
    change: { kind: 'addEdge', edge: { id: 'close', type: 'dependOn', src: base.components[n - 1], tgt: base.components[0] } },
    ruleId: 'ACYC:dependOn',
    k,
    n,
  };
}

/**
 * Trace family: a dependOn chain whose last component satisfies the requirement. Cutting
 * the middle edge makes every upstream component violate COMP2REQ, including components at
 * distance greater than k from the deleted edge.
 */
export function traceFamily(k: number): Family {
  const n = 2 * k + 3;
  const base = chain(n, n - 1);
  const model: SysMLLikeModel = { id: `trace-k${k}`, nodes: base.nodes, edges: base.edges };
  const cutIndex = k + 1; // edge (C_{k+1}, C_{k+2})
  return {
    model,
    catalog: counterexampleCatalog(),
    change: { kind: 'delEdge', id: `dep${cutIndex}` },
    ruleId: 'TRACE:COMP2REQ',
    k,
    n,
  };
}
