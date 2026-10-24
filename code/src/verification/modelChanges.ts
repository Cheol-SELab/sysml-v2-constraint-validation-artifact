/**
 * Change application on the exchange model (plain arrays), written independently of
 * model/graph.ts. The incremental checks use it to build the post-change reference model, so
 * that a fault in the graph mutation primitives or in the session's change expansion cannot
 * cancel out between the system under test and its oracle (found by the mutation analysis).
 *
 * Semantics (same as the documented Change semantics):
 *   addNode   insert, or replace type and attributes of an existing node (edges kept)
 *   delNode   remove the node and every incident edge
 *   setAttr   set, or remove when the value is undefined
 *   addEdge   insert when both endpoints exist (identifiers are assumed fresh)
 *   delEdge   remove when present
 */

import { Change, SysMLLikeModel, TypedGraph } from '../model/types';

export function applyChangesToModel(model: SysMLLikeModel, changes: Change[]): SysMLLikeModel {
  const nodes = new Map(model.nodes.map((n) => [n.id, { id: n.id, type: n.type, attrs: { ...n.attrs } }]));
  let edges = model.edges.map((e) => ({ ...e }));
  for (const c of changes) {
    switch (c.kind) {
      case 'addNode':
        nodes.set(c.node.id, { id: c.node.id, type: c.node.type, attrs: { ...c.node.attrs } });
        break;
      case 'delNode':
        if (nodes.delete(c.id)) edges = edges.filter((e) => e.src !== c.id && e.tgt !== c.id);
        break;
      case 'setAttr': {
        const n = nodes.get(c.id);
        if (!n) break;
        if (c.value === undefined) delete n.attrs[c.attr];
        else n.attrs[c.attr] = c.value;
        break;
      }
      case 'addEdge':
        if (nodes.has(c.edge.src) && nodes.has(c.edge.tgt)) edges.push({ ...c.edge });
        break;
      case 'delEdge':
        edges = edges.filter((e) => e.id !== c.id);
        break;
    }
  }
  return { id: model.id, nodes: [...nodes.values()], edges };
}

/** Structural difference between a typed graph and an exchange model ('' when equal). */
export function graphModelDiff(g: TypedGraph, m: SysMLLikeModel): string {
  if (g.nodes.size !== m.nodes.length) return `node count ${g.nodes.size} vs ${m.nodes.length}`;
  if (g.edges.size !== m.edges.length) return `edge count ${g.edges.size} vs ${m.edges.length}`;
  for (const n of m.nodes) {
    const x = g.nodes.get(n.id);
    if (!x || x.type !== n.type || JSON.stringify(Object.entries(x.attrs).sort()) !== JSON.stringify(Object.entries(n.attrs).sort())) return `node ${n.id}`;
  }
  const deg = new Map<string, number>();
  for (const e of m.edges) {
    const x = g.edges.get(e.id);
    if (!x || x.type !== e.type || x.src !== e.src || x.tgt !== e.tgt) return `edge ${e.id}`;
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
    deg.set(`in:${e.tgt}`, (deg.get(`in:${e.tgt}`) ?? 0) + 1);
  }
  for (const n of m.nodes) {
    const out = g.out.get(n.id) ?? [];
    const inn = g.in.get(n.id) ?? [];
    if (out.length !== (deg.get(n.id) ?? 0) || inn.length !== (deg.get(`in:${n.id}`) ?? 0)) return `adjacency of ${n.id}`;
    for (const eid of out) if (g.edges.get(eid)?.src !== n.id) return `out-list of ${n.id}`;
    for (const eid of inn) if (g.edges.get(eid)?.tgt !== n.id) return `in-list of ${n.id}`;
  }
  return '';
}
