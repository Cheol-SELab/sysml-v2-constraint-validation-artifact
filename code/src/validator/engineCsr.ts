/**
 * Review n13: the same full-validation algorithm as validator/engine.ts (same groundings, same
 * Holds evaluations, same BatchGlobal), executed over a compressed-sparse-row (CSR) index of
 * typed arrays instead of string-keyed Map/Set adjacency. Used only to measure whether the
 * super-linear time exponent of E6 comes from the data layout (hash look-ups and pointer
 * chasing over a growing working set) or from the algorithm (whose operation count is linear).
 *
 *   buildCsr(g)       integer node/edge indices, type codes, out/in offsets (Int32Array),
 *                     edge-type buckets and node-type buckets; attribute objects are shared.
 *   validateCsr(...)  returns the same violation keys as validate(g, c, rules) (checked by
 *                     cli-r8 csr-equivalence on generated, hub and random models).
 *
 * Differences that are not data-layout: none in the groundings; the Map engine's batch Tarjan
 * additionally sorts all node ids (stronglyConnectedComponents, `nodes.sort()`), which the CSR
 * version does not need (node order = index order). E6-CSR reports that sort separately.
 */

import { inDomain, makeViolation } from '../catalog/rules';
import { Catalog, ModelNode, Rule, TypedGraph, Violation } from '../model/types';

export interface CsrGraph {
  n: number;
  m: number;
  nodeIds: string[];
  edgeIds: string[];
  nodeAttrs: ModelNode['attrs'][];
  nodeType: Uint16Array;
  edgeType: Uint16Array;
  src: Int32Array;
  tgt: Int32Array;
  outOff: Int32Array;
  outAdj: Int32Array;
  inOff: Int32Array;
  inAdj: Int32Array;
  /** node indices bucketed by node type code */
  byNodeTypeOff: Int32Array;
  byNodeType: Int32Array;
  /** edge indices bucketed by edge type code */
  byEdgeTypeOff: Int32Array;
  byEdgeType: Int32Array;
  nodeTypeCode: Map<string, number>;
  edgeTypeCode: Map<string, number>;
}

function bucket(keys: Uint16Array, k: number): { off: Int32Array; items: Int32Array } {
  const off = new Int32Array(k + 1);
  for (let i = 0; i < keys.length; i++) off[keys[i] + 1]++;
  for (let t = 0; t < k; t++) off[t + 1] += off[t];
  const pos = off.slice(0, k);
  const items = new Int32Array(keys.length);
  for (let i = 0; i < keys.length; i++) items[pos[keys[i]]++] = i;
  return { off, items };
}

export function buildCsr(g: TypedGraph): CsrGraph {
  const n = g.nodes.size;
  const m = g.edges.size;
  const nodeIds = new Array<string>(n);
  const nodeAttrs = new Array<ModelNode['attrs']>(n);
  const nodeType = new Uint16Array(n);
  const nodeTypeCode = new Map<string, number>();
  const index = new Map<string, number>();
  let i = 0;
  for (const [id, node] of g.nodes) {
    nodeIds[i] = id;
    nodeAttrs[i] = node.attrs;
    let c = nodeTypeCode.get(node.type);
    if (c === undefined) {
      c = nodeTypeCode.size;
      nodeTypeCode.set(node.type, c);
    }
    nodeType[i] = c;
    index.set(id, i);
    i++;
  }
  const edgeIds = new Array<string>(m);
  const edgeType = new Uint16Array(m);
  const src = new Int32Array(m);
  const tgt = new Int32Array(m);
  const edgeTypeCode = new Map<string, number>();
  const outOff = new Int32Array(n + 1);
  const inOff = new Int32Array(n + 1);
  let j = 0;
  for (const [id, e] of g.edges) {
    edgeIds[j] = id;
    let c = edgeTypeCode.get(e.type);
    if (c === undefined) {
      c = edgeTypeCode.size;
      edgeTypeCode.set(e.type, c);
    }
    edgeType[j] = c;
    const s = index.get(e.src)!;
    const t = index.get(e.tgt)!;
    src[j] = s;
    tgt[j] = t;
    outOff[s + 1]++;
    inOff[t + 1]++;
    j++;
  }
  for (let v = 0; v < n; v++) {
    outOff[v + 1] += outOff[v];
    inOff[v + 1] += inOff[v];
  }
  const outAdj = new Int32Array(m);
  const inAdj = new Int32Array(m);
  const op = outOff.slice(0, n);
  const ip = inOff.slice(0, n);
  for (let e = 0; e < m; e++) {
    outAdj[op[src[e]]++] = e;
    inAdj[ip[tgt[e]]++] = e;
  }
  const nb = bucket(nodeType, Math.max(1, nodeTypeCode.size));
  const eb = bucket(edgeType, Math.max(1, edgeTypeCode.size));
  return {
    n, m, nodeIds, edgeIds, nodeAttrs, nodeType, edgeType, src, tgt, outOff, outAdj, inOff, inAdj,
    byNodeTypeOff: nb.off, byNodeType: nb.items, byEdgeTypeOff: eb.off, byEdgeType: eb.items, nodeTypeCode, edgeTypeCode,
  };
}

function typeMask(g: CsrGraph, types: string[]): Uint8Array {
  const mask = new Uint8Array(Math.max(1, g.nodeTypeCode.size));
  for (const t of types) {
    const c = g.nodeTypeCode.get(t);
    if (c !== undefined) mask[c] = 1;
  }
  return mask;
}

function nodesOfType(g: CsrGraph, t: string, fn: (v: number) => void): void {
  const c = g.nodeTypeCode.get(t);
  if (c === undefined) return;
  for (let k = g.byNodeTypeOff[c]; k < g.byNodeTypeOff[c + 1]; k++) fn(g.byNodeType[k]);
}

/** Reusable scratch buffers (stamps) so that repeated validations do not allocate per node. */
interface Scratch {
  stampA: Int32Array;
  stampB: Int32Array;
  epoch: number;
}

function scratch(g: CsrGraph): Scratch {
  return { stampA: new Int32Array(g.n), stampB: new Int32Array(g.n), epoch: 0 };
}

function evalLocal(g: CsrGraph, r: Rule, sc: Scratch, out: Violation[]): void {
  switch (r.kind) {
    case 'relationType': {
      const c = g.edgeTypeCode.get(r.edgeType);
      if (c === undefined) return;
      const sm = typeMask(g, r.srcTypes);
      const tm = typeMask(g, r.tgtTypes);
      for (let k = g.byEdgeTypeOff[c]; k < g.byEdgeTypeOff[c + 1]; k++) {
        const e = g.byEdgeType[k];
        if (sm[g.nodeType[g.src[e]]] === 1 && tm[g.nodeType[g.tgt[e]]] === 1) continue;
        out.push(makeViolation(r.id, r.kind, [g.edgeIds[e]], 'relation type', g.nodeIds[g.src[e]]));
      }
      return;
    }
    case 'requiredAttr':
      nodesOfType(g, r.nodeType, (v) => {
        if (g.nodeAttrs[v][r.attr] === undefined) out.push(makeViolation(r.id, r.kind, [g.nodeIds[v]], 'missing', g.nodeIds[v]));
      });
      return;
    case 'attrDomain':
      nodesOfType(g, r.nodeType, (v) => {
        const x = g.nodeAttrs[v][r.attr];
        if (!(x === undefined || inDomain(x, r.domain))) out.push(makeViolation(r.id, r.kind, [g.nodeIds[v]], 'domain', g.nodeIds[v]));
      });
      return;
    case 'multiplicity': {
      const u = g.edgeTypeCode.get(r.edgeType);
      const off = r.dir === 'out' ? g.outOff : g.inOff;
      const adj = r.dir === 'out' ? g.outAdj : g.inAdj;
      nodesOfType(g, r.nodeType, (v) => {
        let count = 0;
        if (u !== undefined) for (let k = off[v]; k < off[v + 1]; k++) if (g.edgeType[adj[k]] === u) count++;
        if (!(count >= r.min && (r.max < 0 || count <= r.max))) out.push(makeViolation(r.id, r.kind, [g.nodeIds[v]], 'multiplicity', g.nodeIds[v]));
      });
      return;
    }
    case 'isolated':
      nodesOfType(g, r.nodeType, (v) => {
        if (g.outOff[v + 1] - g.outOff[v] + g.inOff[v + 1] - g.inOff[v] === 0) out.push(makeViolation(r.id, r.kind, [g.nodeIds[v]], 'isolated', g.nodeIds[v]));
      });
      return;
    case 'viewConsistency': {
      const p = r.policy;
      const ex = g.edgeTypeCode.get(p.exposeEdgeType);
      if (ex === undefined) return;
      const sb = g.edgeTypeCode.get(p.subjectEdgeType) ?? -1;
      const ct = g.edgeTypeCode.get(p.containEdgeType) ?? -1;
      nodesOfType(g, p.viewType, (v) => {
        // stampA marks the subjects of v, stampB the exposed targets already visited (epoch per view)
        const ep = ++sc.epoch;
        for (let k = g.outOff[v]; k < g.outOff[v + 1]; k++) {
          const e = g.outAdj[k];
          if (g.edgeType[e] === sb) sc.stampA[g.tgt[e]] = ep;
        }
        for (let k = g.outOff[v]; k < g.outOff[v + 1]; k++) {
          const e = g.outAdj[k];
          if (g.edgeType[e] !== ex) continue;
          const x = g.tgt[e];
          if (sc.stampB[x] === ep) continue;
          sc.stampB[x] = ep;
          if (sc.stampA[x] === ep) continue;
          let ok = false;
          for (let q = g.inOff[x]; q < g.inOff[x + 1]; q++) {
            const ce = g.inAdj[q];
            if (g.edgeType[ce] === ct && sc.stampA[g.src[ce]] === ep) {
              ok = true;
              break;
            }
          }
          if (!ok) out.push(makeViolation(r.id, r.kind, [g.nodeIds[v], g.nodeIds[x]], 'view', g.nodeIds[v]));
        }
      });
      return;
    }
    default:
      return;
  }
}

/** Non-trivial SCCs of the edges of one type (iterative Tarjan over CSR, index order). */
function acyclic(g: CsrGraph, r: Extract<Rule, { kind: 'acyclic' }>, out: Violation[]): void {
  const t = g.edgeTypeCode.get(r.edgeType);
  if (t === undefined) return;
  const n = g.n;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const workV = new Int32Array(n);
  const workK = new Int32Array(n);
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    let wp = 0;
    index[root] = low[root] = counter++;
    stack[sp++] = root;
    onStack[root] = 1;
    workV[wp] = root;
    workK[wp++] = g.outOff[root];
    while (wp > 0) {
      const v = workV[wp - 1];
      let k = workK[wp - 1];
      let pushed = false;
      while (k < g.outOff[v + 1]) {
        const e = g.outAdj[k++];
        if (g.edgeType[e] !== t) continue;
        const w = g.tgt[e];
        if (index[w] === -1) {
          workK[wp - 1] = k;
          index[w] = low[w] = counter++;
          stack[sp++] = w;
          onStack[w] = 1;
          workV[wp] = w;
          workK[wp++] = g.outOff[w];
          pushed = true;
          break;
        } else if (onStack[w] === 1 && index[w] < low[v]) low[v] = index[w];
      }
      if (pushed) continue;
      workK[wp - 1] = k;
      wp--;
      if (wp > 0) {
        const p = workV[wp - 1];
        if (low[v] < low[p]) low[p] = low[v];
      }
      if (low[v] === index[v]) {
        let size = 0;
        const comp: string[] = [];
        let w: number;
        do {
          w = stack[--sp];
          onStack[w] = 0;
          comp.push(g.nodeIds[w]);
          size++;
        } while (w !== v);
        let selfLoop = false;
        if (size === 1) {
          for (let q = g.outOff[v]; q < g.outOff[v + 1]; q++) {
            const e = g.outAdj[q];
            if (g.edgeType[e] === t && g.tgt[e] === v) {
              selfLoop = true;
              break;
            }
          }
        }
        if (size > 1 || selfLoop) {
          comp.sort();
          out.push(makeViolation(r.id, r.kind, comp, 'cycle', comp[0]));
        }
      }
    }
  }
}

function trace(g: CsrGraph, r: Extract<Rule, { kind: 'tracePolicy' }>, out: Violation[]): void {
  const p = r.policy;
  const allowed = new Uint8Array(Math.max(1, g.edgeTypeCode.size));
  for (const t of p.edgeTypes) {
    const c = g.edgeTypeCode.get(t);
    if (c !== undefined) allowed[c] = 1;
  }
  const reaches = new Uint8Array(g.n);
  const queue = new Int32Array(g.n);
  let qt = 0;
  nodesOfType(g, p.targetType, (v) => {
    queue[qt++] = v;
  });
  // every node is expanded once: targets as starts, other nodes when first reached
  const enq = new Uint8Array(g.n);
  for (let k = 0; k < qt; k++) enq[queue[k]] = 1;
  let head = 0;
  while (head < qt) {
    const w = queue[head++];
    for (let k = g.inOff[w]; k < g.inOff[w + 1]; k++) {
      const e = g.inAdj[k];
      if (allowed[g.edgeType[e]] !== 1) continue;
      const s = g.src[e];
      reaches[s] = 1;
      if (enq[s] === 1) continue;
      enq[s] = 1;
      queue[qt++] = s;
    }
  }
  nodesOfType(g, p.sourceType, (v) => {
    if (reaches[v] !== 1) out.push(makeViolation(r.id, r.kind, [g.nodeIds[v]], 'trace', g.nodeIds[v]));
  });
}

export function validateCsr(g: CsrGraph, c: Catalog, rules: Rule[]): Violation[] {
  void c;
  const out: Violation[] = [];
  const sc = scratch(g);
  for (const r of rules) {
    if (r.kind === 'acyclic') acyclic(g, r, out);
    else if (r.kind === 'tracePolicy') trace(g, r, out);
    else evalLocal(g, r, sc, out);
  }
  return out;
}
