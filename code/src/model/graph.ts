/**
 * NormalizeToTypedGraph (Algorithm 1, line 1), change application, and k-hop neighborhoods.
 */

import { AttrValue, Change, ModelEdge, ModelNode, SysMLLikeModel, TypedGraph } from './types';

/**
 * S1 boundary checks on a model given as exchange JSON (input that did not come from the
 * SysML v2 text normaliser, e.g. a tool export or a generated test model). Policy (review n21):
 *
 *   duplicateNodeId / duplicateEdgeId  always rejected (InputError): identifiers are the keys
 *                                      of V and E, so a duplicate leaves no well-defined graph.
 *   danglingEndpoint                   src or tgt is not a node of the input. Such an element is
 *                                      not an edge of G (src, tgt : E -> V are total), so it is
 *                                      never a rule violation. Policy 'drop' (default) removes it
 *                                      from G and reports it as an input defect (Baseline A shows
 *                                      the same finding); policy 'reject' refuses the input.
 *   multipleOwners                     contain in-degree > 1, i.e. the ownership-forest condition
 *                                      (P_own) of Theorem 3 fails. Reported, never rejected: the
 *                                      condition bounds the cost of the view rule only, and the
 *                                      catalog rule MULT(Port|contain|in) must be able to report
 *                                      a second owner as a violation (defect operator D2).
 */
export interface InputDefect {
  kind: 'duplicateNodeId' | 'duplicateEdgeId' | 'danglingEndpoint' | 'multipleOwners';
  id: string;
  detail?: string;
}

export class InputError extends Error {
  constructor(readonly defects: InputDefect[]) {
    super(`invalid model input: ${defects.slice(0, 5).map((d) => `${d.kind}(${d.id})`).join(', ')}${defects.length > 5 ? ', ...' : ''}`);
  }
}

export function checkModelInput(model: SysMLLikeModel, containEdgeType = 'contain'): InputDefect[] {
  const out: InputDefect[] = [];
  const ids = new Set<string>();
  for (const n of model.nodes) {
    if (ids.has(n.id)) out.push({ kind: 'duplicateNodeId', id: n.id });
    ids.add(n.id);
  }
  const eids = new Set<string>();
  const owners = new Map<string, number>();
  for (const e of model.edges) {
    if (eids.has(e.id)) out.push({ kind: 'duplicateEdgeId', id: e.id });
    eids.add(e.id);
    const missing = [e.src, e.tgt].filter((x) => !ids.has(x));
    if (missing.length > 0) {
      out.push({ kind: 'danglingEndpoint', id: e.id, detail: missing.join(',') });
      continue;
    }
    if (e.type === containEdgeType) owners.set(e.tgt, (owners.get(e.tgt) ?? 0) + 1);
  }
  for (const [x, k] of owners) if (k > 1) out.push({ kind: 'multipleOwners', id: x, detail: String(k) });
  return out;
}

export interface NormalizeOptions {
  /** treatment of edges whose endpoint is not a node: 'drop' (default) or 'reject' */
  dangling?: 'drop' | 'reject';
  /** receives the dropped dangling edges and P_own reports (input defects, not violations) */
  report?: InputDefect[];
}

export function normalizeToTypedGraph(model: SysMLLikeModel, opts: NormalizeOptions = {}): TypedGraph {
  const g: TypedGraph = {
    id: model.id,
    nodes: new Map(),
    edges: new Map(),
    out: new Map(),
    in: new Map(),
  };
  const fatal: InputDefect[] = [];
  for (const n of model.nodes) {
    if (g.nodes.has(n.id)) {
      fatal.push({ kind: 'duplicateNodeId', id: n.id });
      continue;
    }
    g.nodes.set(n.id, { id: n.id, type: n.type, attrs: { ...n.attrs } });
    g.out.set(n.id, []);
    g.in.set(n.id, []);
  }
  const seen = new Set<string>();
  const dangling: InputDefect[] = [];
  for (const e of model.edges) {
    if (seen.has(e.id)) {
      fatal.push({ kind: 'duplicateEdgeId', id: e.id });
      continue;
    }
    seen.add(e.id);
    // an edge with a missing endpoint is not an edge of G; it is an input defect (Baseline A
    // reports the same finding), never a rule violation
    if (!g.nodes.has(e.src) || !g.nodes.has(e.tgt)) {
      dangling.push({ kind: 'danglingEndpoint', id: e.id, detail: [e.src, e.tgt].filter((x) => !g.nodes.has(x)).join(',') });
      continue;
    }
    g.edges.set(e.id, { ...e });
    g.out.get(e.src)!.push(e.id);
    g.in.get(e.tgt)!.push(e.id);
  }
  if (fatal.length > 0) throw new InputError(fatal);
  if (opts.dangling === 'reject' && dangling.length > 0) throw new InputError(dangling);
  if (opts.report) {
    opts.report.push(...dangling);
    for (const [x, list] of g.in) {
      let k = 0;
      for (const eid of list) if (g.edges.get(eid)!.type === 'contain') k++;
      if (k > 1) opts.report.push({ kind: 'multipleOwners', id: x, detail: String(k) });
    }
  }
  return g;
}

export function graphToModel(g: TypedGraph): SysMLLikeModel {
  return {
    id: g.id,
    nodes: [...g.nodes.values()].map((n) => ({ id: n.id, type: n.type, attrs: { ...n.attrs } })),
    edges: [...g.edges.values()].map((e) => ({ ...e })),
  };
}

export function cloneGraph(g: TypedGraph): TypedGraph {
  const c: TypedGraph = { id: g.id, nodes: new Map(), edges: new Map(), out: new Map(), in: new Map() };
  for (const [id, n] of g.nodes) {
    c.nodes.set(id, { id: n.id, type: n.type, attrs: { ...n.attrs } });
    c.out.set(id, [...(g.out.get(id) ?? [])]);
    c.in.set(id, [...(g.in.get(id) ?? [])]);
  }
  for (const [id, e] of g.edges) c.edges.set(id, { ...e });
  return c;
}

function removeFrom(list: string[] | undefined, id: string): void {
  if (!list) return;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

export function addNode(g: TypedGraph, node: ModelNode): void {
  g.nodes.set(node.id, { id: node.id, type: node.type, attrs: { ...node.attrs } });
  if (!g.out.has(node.id)) g.out.set(node.id, []);
  if (!g.in.has(node.id)) g.in.set(node.id, []);
}

/**
 * Primitive edge addition of a change set. Rejected (returns false, G unchanged) when an
 * endpoint is not a node or when the edge id is already in use: re-adding an existing id
 * would otherwise overwrite E while leaving a second adjacency entry (review n21). Rewiring
 * an edge is a deletion followed by an addition (section 2.2).
 */
export function addEdge(g: TypedGraph, edge: ModelEdge): boolean {
  if (!g.nodes.has(edge.src) || !g.nodes.has(edge.tgt)) return false;
  if (g.edges.has(edge.id)) return false;
  g.edges.set(edge.id, { ...edge });
  g.out.get(edge.src)!.push(edge.id);
  g.in.get(edge.tgt)!.push(edge.id);
  return true;
}

export function delEdge(g: TypedGraph, edgeId: string): ModelEdge | undefined {
  const e = g.edges.get(edgeId);
  if (!e) return undefined;
  removeFrom(g.out.get(e.src), edgeId);
  removeFrom(g.in.get(e.tgt), edgeId);
  g.edges.delete(edgeId);
  return e;
}

export function delNode(g: TypedGraph, nodeId: string): void {
  if (!g.nodes.has(nodeId)) return;
  for (const eid of [...(g.out.get(nodeId) ?? []), ...(g.in.get(nodeId) ?? [])]) delEdge(g, eid);
  g.out.delete(nodeId);
  g.in.delete(nodeId);
  g.nodes.delete(nodeId);
}

export function setAttr(g: TypedGraph, nodeId: string, attr: string, value: AttrValue | undefined): void {
  const n = g.nodes.get(nodeId);
  if (!n) return;
  if (value === undefined) delete n.attrs[attr];
  else n.attrs[attr] = value;
}

/** Applies a change set in order. Returns the ids touched (support of the change set). */
export function applyChanges(g: TypedGraph, changes: Change[]): string[] {
  const touched: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case 'addNode':
        addNode(g, c.node);
        touched.push(c.node.id);
        break;
      case 'delNode': {
        for (const eid of [...(g.out.get(c.id) ?? []), ...(g.in.get(c.id) ?? [])]) {
          const e = g.edges.get(eid);
          if (e) touched.push(e.src, e.tgt, e.id);
        }
        delNode(g, c.id);
        touched.push(c.id);
        break;
      }
      case 'setAttr':
        setAttr(g, c.id, c.attr, c.value);
        touched.push(c.id);
        break;
      case 'addEdge':
        if (addEdge(g, c.edge)) touched.push(c.edge.id, c.edge.src, c.edge.tgt);
        break;
      case 'delEdge': {
        const e = g.edges.get(c.id);
        if (e) touched.push(e.id, e.src, e.tgt);
        delEdge(g, c.id);
        break;
      }
    }
  }
  return [...new Set(touched)];
}

/** Node ids touched by a change set, evaluated against the pre-state graph. */
export function changeSupportNodes(g: TypedGraph, changes: Change[]): string[] {
  const s = new Set<string>();
  for (const c of changes) {
    switch (c.kind) {
      case 'addNode':
        s.add(c.node.id);
        break;
      case 'delNode':
        s.add(c.id);
        for (const eid of [...(g.out.get(c.id) ?? []), ...(g.in.get(c.id) ?? [])]) {
          const e = g.edges.get(eid);
          if (e) {
            s.add(e.src);
            s.add(e.tgt);
          }
        }
        break;
      case 'setAttr':
        s.add(c.id);
        break;
      case 'addEdge':
        s.add(c.edge.src);
        s.add(c.edge.tgt);
        break;
      case 'delEdge': {
        const e = g.edges.get(c.id);
        if (e) {
          s.add(e.src);
          s.add(e.tgt);
        }
        break;
      }
    }
  }
  return [...s];
}

/**
 * N_k(seed): nodes within undirected distance k of the seed nodes.
 * Used for the scope-restricted evaluation of local rules (Algorithm 1, line 3).
 */
export function kHopNodes(g: TypedGraph, seeds: string[], k: number): Set<string> {
  const seen = new Set<string>();
  let frontier: string[] = [];
  for (const s of seeds) {
    if (g.nodes.has(s) && !seen.has(s)) {
      seen.add(s);
      frontier.push(s);
    }
  }
  for (let d = 0; d < k; d++) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const eid of g.out.get(v) ?? []) {
        const e = g.edges.get(eid)!;
        if (!seen.has(e.tgt)) {
          seen.add(e.tgt);
          next.push(e.tgt);
        }
      }
      for (const eid of g.in.get(v) ?? []) {
        const e = g.edges.get(eid)!;
        if (!seen.has(e.src)) {
          seen.add(e.src);
          next.push(e.src);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Edge ids with at least one endpoint in the node scope. */
export function incidentEdges(g: TypedGraph, nodeScope: Set<string>): Set<string> {
  const s = new Set<string>();
  for (const v of nodeScope) {
    for (const eid of g.out.get(v) ?? []) s.add(eid);
    for (const eid of g.in.get(v) ?? []) s.add(eid);
  }
  return s;
}

export function nodeCount(g: TypedGraph): number {
  return g.nodes.size;
}

export function edgeCount(g: TypedGraph): number {
  return g.edges.size;
}
