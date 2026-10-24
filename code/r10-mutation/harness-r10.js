'use strict';
/**
 * R10 mutation harness (round-2 review, survivor follow-up of R8).
 *
 * Installed by run-mutation-r10.js at <dist>/r10/harness-r10.js inside each worker's private
 * copy of the frozen snapshot dist tree (results-v4/snapshot/tree/dist). It lives outside src/
 * and tools/, so the R8 snapshot digest is unchanged; its own sha256 is recorded in the output.
 *
 * Stages (first failing stage recorded, one JSON line on stdout):
 *   BE-base, BE-ext, PB, INV  the R8 reduced-E1 stages, same calls and parameters as
 *                             src/verification/mutationHarness.ts
 *   R10-IN    S1 input boundary: checkModelInput / normalizeToTypedGraph on raw exchange models
 *             with duplicate ids, dangling endpoints and multiple contain owners, against an
 *             expectation written here from the documented policy (graph.ts header, review n21)
 *   R10-SES   incremental sessions on change sets with rejected and identifier-reusing changes
 *             (duplicate edge id, missing endpoint, delete-then-re-add, same-type replacement,
 *             retype, edge id reuse, operations on missing ids), for every session
 *             configuration used by E5: S1 (naive k-hop), S2, S3, S3 with rebuildThreshold, S3
 *             with eagerOutput. Expectations: post-state graph (independent change applier),
 *             violation set (reference semantics on an independently built graph), recomputation
 *             scope |S| = |N_k(G, supp) u N_k(G', supp')| (Fig. 2 lines 8 and 12, k from the rule
 *             radii), fallback count of S3 (validity policy), and for S1 the output defined by
 *             its own specification (kept global violations outside S plus BatchGlobal on G'[S]).
 *             Also runs on bounded-exhaustive small graphs of two extra catalogs (an upper
 *             multiplicity bound of 0; a catalog without view/multiplicity/isolation rules).
 *   R10-API   exported helpers whose results feed experiments or reports: applyChanges (graph
 *             and returned support ids), groundingNodes (E3 Part D), TraceWitness.evidencePath.
 *
 * Env: R10_ONLY=1 skips the four R8 stages (used only for timing and baseline checks).
 */

const path = require('path');
const D = path.join(__dirname, '..');
const req = (m) => require(path.join(D, m));

// ------------------------------------------------------------------ independent helpers

const RADIUS = { relationType: 1, requiredAttr: 0, attrDomain: 0, multiplicity: 1, isolated: 1, viewConsistency: 2 };

function keyOf(v) {
  return `${v.ruleId}|${[...v.witness].sort().join(',')}`;
}
function keySet(vs) {
  return new Set(vs.map(keyOf));
}
function setNeq(a, b) {
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}
function setDiffStr(a, b) {
  const x = [...a].filter((k) => !b.has(k)).sort();
  const y = [...b].filter((k) => !a.has(k)).sort();
  return `only-first=[${x.slice(0, 6).join(' ')}] only-second=[${y.slice(0, 6).join(' ')}]`;
}

/** TypedGraph built from a valid exchange model, without model/graph.ts. */
function build(model) {
  const g = { id: model.id, nodes: new Map(), edges: new Map(), out: new Map(), in: new Map() };
  for (const n of model.nodes) {
    g.nodes.set(n.id, { id: n.id, type: n.type, attrs: { ...n.attrs } });
    g.out.set(n.id, []);
    g.in.set(n.id, []);
  }
  for (const e of model.edges) {
    g.edges.set(e.id, { ...e });
    g.out.get(e.src).push(e.id);
    g.in.get(e.tgt).push(e.id);
  }
  return g;
}

function cloneModel(m) {
  return { id: m.id, nodes: m.nodes.map((n) => ({ id: n.id, type: n.type, attrs: { ...n.attrs } })), edges: m.edges.map((e) => ({ ...e })) };
}

/**
 * Change semantics (section 2.2 and review n21): addNode inserts or replaces type and
 * attributes (edges kept); delNode removes the node and its incident edges; setAttr sets or
 * removes on an existing node; addEdge inserts only when both endpoints exist and the id is
 * unused; delEdge removes when present. Applied in order.
 */
function applySpec(model, changes) {
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
        if (nodes.has(c.edge.src) && nodes.has(c.edge.tgt) && !edges.some((e) => e.id === c.edge.id)) edges.push({ ...c.edge });
        break;
      case 'delEdge':
        edges = edges.filter((e) => e.id !== c.id);
        break;
    }
  }
  return { id: model.id, nodes: [...nodes.values()], edges };
}

/** Structural comparison of a TypedGraph with an exchange model ('' when equal). */
function graphDiff(g, m) {
  if (g.nodes.size !== m.nodes.length) return `node count ${g.nodes.size} vs ${m.nodes.length}`;
  if (g.edges.size !== m.edges.length) return `edge count ${g.edges.size} vs ${m.edges.length}`;
  for (const n of m.nodes) {
    const x = g.nodes.get(n.id);
    if (!x || x.type !== n.type) return `node ${n.id}`;
    const a = JSON.stringify(Object.entries(x.attrs).sort());
    const b = JSON.stringify(Object.entries(n.attrs).sort());
    if (a !== b) return `attrs of ${n.id}`;
  }
  const outs = new Map();
  const ins = new Map();
  for (const n of m.nodes) {
    outs.set(n.id, []);
    ins.set(n.id, []);
  }
  for (const e of m.edges) {
    const x = g.edges.get(e.id);
    if (!x || x.type !== e.type || x.src !== e.src || x.tgt !== e.tgt) return `edge ${e.id}`;
    outs.get(e.src).push(e.id);
    ins.get(e.tgt).push(e.id);
  }
  for (const n of m.nodes) {
    const o = [...(g.out.get(n.id) || [])].sort().join(',');
    const i = [...(g.in.get(n.id) || [])].sort().join(',');
    if (o !== outs.get(n.id).sort().join(',')) return `out-list of ${n.id}`;
    if (i !== ins.get(n.id).sort().join(',')) return `in-list of ${n.id}`;
  }
  if (g.out.size !== m.nodes.length || g.in.size !== m.nodes.length) return `adjacency index size ${g.out.size}/${g.in.size} vs ${m.nodes.length}`;
  return '';
}

function kOf(rules) {
  let k = 0;
  for (const r of rules) if (!r.global && RADIUS[r.kind] !== undefined && RADIUS[r.kind] > k) k = RADIUS[r.kind];
  return k;
}

/** N_k(seeds) by undirected BFS over the model; seeds that are not nodes are ignored. */
function nhood(model, seeds, k) {
  const ids = new Set(model.nodes.map((n) => n.id));
  const adj = new Map();
  for (const id of ids) adj.set(id, []);
  for (const e of model.edges) {
    adj.get(e.src).push(e.tgt);
    adj.get(e.tgt).push(e.src);
  }
  const seen = new Set();
  let frontier = [];
  for (const s of seeds) if (ids.has(s) && !seen.has(s)) {
    seen.add(s);
    frontier.push(s);
  }
  for (let d = 0; d < k; d++) {
    const next = [];
    for (const v of frontier) for (const w of adj.get(v)) if (!seen.has(w)) {
      seen.add(w);
      next.push(w);
    }
    frontier = next;
  }
  return seen;
}

/** supp(Delta) on the pre-state (Fig. 2 line 8). */
function supportPre(model, changes) {
  const s = new Set();
  const edgeById = new Map(model.edges.map((e) => [e.id, e]));
  for (const c of changes) {
    if (c.kind === 'addNode') s.add(c.node.id);
    else if (c.kind === 'delNode') {
      s.add(c.id);
      for (const e of model.edges) if (e.src === c.id || e.tgt === c.id) {
        s.add(e.src);
        s.add(e.tgt);
      }
    } else if (c.kind === 'setAttr') s.add(c.id);
    else if (c.kind === 'addEdge') {
      s.add(c.edge.src);
      s.add(c.edge.tgt);
    } else if (c.kind === 'delEdge') {
      const e = edgeById.get(c.id);
      if (e) {
        s.add(e.src);
        s.add(e.tgt);
      }
    }
  }
  return s;
}

/** supp of the expanded primitive events, evaluated against the running state (line 12). */
function supportPost(model, changes) {
  const s = new Set();
  let cur = model;
  for (const c of changes) {
    if (c.kind === 'addNode') s.add(c.node.id);
    else if (c.kind === 'delNode') {
      if (cur.nodes.some((n) => n.id === c.id)) {
        for (const e of cur.edges) if (e.src === c.id || e.tgt === c.id) {
          s.add(e.src);
          s.add(e.tgt);
        }
        s.add(c.id);
      }
    } else if (c.kind === 'setAttr') s.add(c.id);
    else if (c.kind === 'addEdge') {
      s.add(c.edge.src);
      s.add(c.edge.tgt);
    } else if (c.kind === 'delEdge') {
      const e = cur.edges.find((x) => x.id === c.id);
      if (e) {
        s.add(e.src);
        s.add(e.tgt);
      }
    }
    cur = applySpec(cur, [c]);
  }
  return s;
}

function scopeSpec(pre, post, changes, k) {
  const s = nhood(pre, supportPre(pre, changes), k);
  for (const v of nhood(post, supportPost(pre, changes), k)) s.add(v);
  return s;
}

/** true when some addNode replaces an existing node with a different type (running state). */
function hasRetype(model, changes) {
  let cur = model;
  for (const c of changes) {
    if (c.kind === 'addNode') {
      const old = cur.nodes.find((n) => n.id === c.node.id);
      if (old && old.type !== c.node.type) return true;
    }
    cur = applySpec(cur, [c]);
  }
  return false;
}

function inducedModel(model, scope) {
  return {
    id: `${model.id}#sub`,
    nodes: model.nodes.filter((n) => scope.has(n.id)),
    edges: model.edges.filter((e) => scope.has(e.src) && scope.has(e.tgt)),
  };
}

function anchorOf(v) {
  return [...v.witness].sort()[0];
}

// ------------------------------------------------------------------ catalogs and models

function catZero(tinyCatalog) {
  const c = tinyCatalog();
  c.id = 'r10-zero';
  c.multiplicity = { 'B|s|out': [1, 1], 'A|r|out': [0, 0], 'C|t|in': [0, 1] };
  return c;
}

/** No view, multiplicity or isolation rules: the last derived local rule has radius 0 < k = 1. */
function catNoView() {
  return {
    id: 'r10-noview',
    nodeTypes: ['A', 'B', 'C'],
    edgeTypes: ['r', 's', 't'],
    allowed: { r: { src: ['A'], tgt: ['B'] }, s: { src: ['B'], tgt: ['C'] }, t: { src: ['C'], tgt: ['C'] } },
    requiredAttr: { A: ['p'] },
    domain: { 'A.p': { kind: 'enum', values: [1, 2] } },
    multiplicity: {},
    acyclic: ['t'],
    tracePolicy: [{ id: 'TP', sourceType: 'A', edgeTypes: ['r', 's'], targetType: 'C' }],
    nonIsolated: [],
  };
}

function attrValue(c, type, attr, rng) {
  const d = c.domain[`${type}.${attr}`];
  const roll = rng.int(4);
  if (roll === 0) return undefined;
  if (!d) return roll === 1 ? '' : `v${rng.int(50)}`;
  if (d.kind === 'enum') return roll === 1 ? 'OUT_OF_DOMAIN' : rng.pick(d.values);
  if (d.kind === 'range') return roll === 1 ? d.max + 1 : roll === 2 ? d.min : d.max;
  return roll === 1 ? '' : `s${rng.int(9)}`;
}

function attrsFor(c, type, rng) {
  const out = {};
  const names = new Set(c.requiredAttr[type] || []);
  for (const k of Object.keys(c.domain)) if (k.startsWith(`${type}.`)) names.add(k.slice(type.length + 1));
  for (const a of names) {
    const v = attrValue(c, type, a, rng);
    if (v !== undefined) out[a] = v;
  }
  return out;
}

function randomValidModel(c, rng, id, maxNodes, maxEdges) {
  const n = rng.range(2, maxNodes);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const type = rng.pick(c.nodeTypes);
    nodes.push({ id: `n${i}`, type, attrs: attrsFor(c, type, rng) });
  }
  const edges = [];
  const m = rng.range(0, maxEdges);
  for (let i = 0; i < m; i++) {
    const et = rng.pick(c.edgeTypes);
    const spec = c.allowed[et];
    let src = rng.pick(nodes).id;
    let tgt = rng.pick(nodes).id;
    if (spec && rng.bernoulli(0.6)) {
      const s = nodes.filter((x) => spec.src.includes(x.type));
      const t = nodes.filter((x) => spec.tgt.includes(x.type));
      if (s.length > 0) src = rng.pick(s).id;
      if (t.length > 0) tgt = rng.pick(t).id;
    }
    edges.push({ id: `e${i}`, type: et, src, tgt });
  }
  return { id, nodes, edges };
}

/** Change sets with rejected and identifier-reusing changes, drawn against the pre-state. */
function edgeCaseChanges(model, c, rng, fresh) {
  const out = [];
  const nodes = model.nodes;
  const edges = model.edges;
  const pickNode = () => (nodes.length > 0 ? rng.pick(nodes) : undefined);
  const nodeOfType = (t) => {
    const l = nodes.filter((n) => n.type === t);
    return l.length > 0 ? rng.pick(l) : undefined;
  };
  const size = 1 + rng.int(4);
  for (let i = 0; i < size; i++) {
    const roll = rng.int(13);
    const x = pickNode();
    const y = pickNode();
    if (roll === 0 && edges.length > 0) {
      // duplicate edge id (rejected); half of them aimed at a trace policy
      const tp = c.tracePolicy.length > 0 && rng.bernoulli(0.5) ? rng.pick(c.tracePolicy) : undefined;
      if (tp) {
        const reuse = edges.filter((e) => tp.edgeTypes.includes(e.type));
        const s = nodeOfType(tp.sourceType);
        const t = nodeOfType(tp.targetType);
        const id = reuse.length > 0 ? rng.pick(reuse).id : rng.pick(edges).id;
        if (s && t) out.push({ kind: 'addEdge', edge: { id, type: rng.pick(tp.edgeTypes), src: s.id, tgt: t.id } });
      } else if (x && y) out.push({ kind: 'addEdge', edge: { id: rng.pick(edges).id, type: rng.pick(c.edgeTypes), src: x.id, tgt: y.id } });
    } else if (roll === 1 && x) {
      const e = { id: `f${fresh.n++}`, type: rng.pick(c.edgeTypes), src: x.id, tgt: 'ghost' };
      if (rng.bernoulli(0.5)) [e.src, e.tgt] = [e.tgt, e.src];
      out.push({ kind: 'addEdge', edge: e });
    } else if (roll === 2 && x && y) {
      out.push({ kind: 'delNode', id: x.id });
      out.push({ kind: 'addEdge', edge: { id: `f${fresh.n++}`, type: rng.pick(c.edgeTypes), src: rng.bernoulli(0.5) ? x.id : y.id, tgt: x.id } });
    } else if (roll === 3 && x) {
      out.push({ kind: 'delNode', id: x.id });
      const type = rng.bernoulli(0.5) ? x.type : rng.pick(c.nodeTypes);
      out.push({ kind: 'addNode', node: { id: x.id, type, attrs: attrsFor(c, type, rng) } });
      if (y && rng.bernoulli(0.7)) out.push({ kind: 'addEdge', edge: { id: `f${fresh.n++}`, type: rng.pick(c.edgeTypes), src: y.id, tgt: x.id } });
    } else if (roll === 4 && x) {
      out.push({ kind: 'addNode', node: { id: x.id, type: x.type, attrs: attrsFor(c, x.type, rng) } });
    } else if (roll === 5 && x) {
      const others = c.nodeTypes.filter((t) => t !== x.type);
      const type = others.length > 0 ? rng.pick(others) : x.type;
      out.push({ kind: 'addNode', node: { id: x.id, type, attrs: attrsFor(c, type, rng) } });
    } else if (roll === 6 && edges.length > 0 && x && y) {
      const e = rng.pick(edges);
      out.push({ kind: 'delEdge', id: e.id });
      out.push({ kind: 'addEdge', edge: { id: e.id, type: rng.bernoulli(0.5) ? e.type : rng.pick(c.edgeTypes), src: x.id, tgt: y.id } });
    } else if (roll === 7) {
      const k = rng.int(3);
      if (k === 0) out.push({ kind: 'delEdge', id: 'no-such-edge' });
      else if (k === 1) out.push({ kind: 'delNode', id: 'no-such-node' });
      else out.push({ kind: 'setAttr', id: 'no-such-node', attr: 'p', value: 1 });
    } else if (roll === 8) {
      const id = `fn${fresh.n++}`;
      const type = rng.pick(c.nodeTypes);
      out.push({ kind: 'addNode', node: { id, type, attrs: attrsFor(c, type, rng) } });
      if (x) out.push({ kind: 'addEdge', edge: { id: `f${fresh.n++}`, type: rng.pick(c.edgeTypes), src: x.id, tgt: id } });
      out.push({ kind: 'delNode', id });
    } else if (roll === 9 && x) {
      const id = `fn${fresh.n++}`;
      const type = rng.pick(c.nodeTypes);
      out.push({ kind: 'addNode', node: { id, type, attrs: attrsFor(c, type, rng) } });
      out.push({ kind: 'addEdge', edge: { id: `f${fresh.n++}`, type: rng.pick(c.edgeTypes), src: rng.bernoulli(0.5) ? x.id : id, tgt: rng.bernoulli(0.5) ? id : x.id } });
    } else if (roll === 10 && x) {
      const names = Object.keys(c.domain).filter((k) => k.startsWith(`${x.type}.`)).map((k) => k.slice(x.type.length + 1));
      for (const a of c.requiredAttr[x.type] || []) names.push(a);
      const attr = names.length > 0 ? rng.pick(names) : 'p';
      out.push({ kind: 'setAttr', id: x.id, attr, value: attrValue(c, x.type, attr, rng) });
    } else if (roll === 11 && x && y) {
      out.push({ kind: 'addEdge', edge: { id: `f${fresh.n++}`, type: rng.pick(c.edgeTypes), src: x.id, tgt: y.id } });
    } else if (edges.length > 0) {
      out.push({ kind: 'delEdge', id: rng.pick(edges).id });
    } else if (x) {
      out.push({ kind: 'delNode', id: x.id });
    }
  }
  return out;
}

// ------------------------------------------------------------------ stage R10-IN

function checkModelInputSpec(model, containType) {
  const out = [];
  const ids = new Set();
  for (const n of model.nodes) {
    if (ids.has(n.id)) out.push({ kind: 'duplicateNodeId', id: n.id });
    ids.add(n.id);
  }
  const eids = new Set();
  const owners = new Map();
  for (const e of model.edges) {
    if (eids.has(e.id)) out.push({ kind: 'duplicateEdgeId', id: e.id });
    eids.add(e.id);
    const missing = [e.src, e.tgt].filter((v) => !ids.has(v));
    if (missing.length > 0) {
      out.push({ kind: 'danglingEndpoint', id: e.id, detail: missing.join(',') });
      continue;
    }
    if (e.type === containType) owners.set(e.tgt, (owners.get(e.tgt) || 0) + 1);
  }
  for (const [x, k] of owners) if (k > 1) out.push({ kind: 'multipleOwners', id: x, detail: String(k) });
  return out;
}

/** normalizeToTypedGraph policy: { throws: defects } or { model, report } */
function normalizeSpec(model, opts) {
  const fatal = [];
  const nodeIds = new Set();
  const nodes = [];
  for (const n of model.nodes) {
    if (nodeIds.has(n.id)) {
      fatal.push({ kind: 'duplicateNodeId', id: n.id });
      continue;
    }
    nodeIds.add(n.id);
    nodes.push(n);
  }
  const seen = new Set();
  const dangling = [];
  const edges = [];
  for (const e of model.edges) {
    if (seen.has(e.id)) {
      fatal.push({ kind: 'duplicateEdgeId', id: e.id });
      continue;
    }
    seen.add(e.id);
    if (!nodeIds.has(e.src) || !nodeIds.has(e.tgt)) {
      dangling.push({ kind: 'danglingEndpoint', id: e.id, detail: [e.src, e.tgt].filter((v) => !nodeIds.has(v)).join(',') });
      continue;
    }
    edges.push(e);
  }
  if (fatal.length > 0) return { throws: fatal };
  if (opts.dangling === 'reject' && dangling.length > 0) return { throws: dangling };
  const report = [...dangling];
  const cnt = new Map();
  for (const e of edges) if (e.type === 'contain') cnt.set(e.tgt, (cnt.get(e.tgt) || 0) + 1);
  for (const [x, k] of cnt) if (k > 1) report.push({ kind: 'multipleOwners', id: x, detail: String(k) });
  return { model: { id: model.id, nodes, edges }, report };
}

const canon = (ds) => ds.map((d) => JSON.stringify([d.kind, d.id, d.detail === undefined ? null : d.detail])).sort().join(';');

function stageInput(fail) {
  const { checkModelInput, normalizeToTypedGraph, InputError } = req('model/graph');
  const { Rng } = req('util/rng');
  const rng = new Rng(20261023);
  const types = ['contain', 'r', 'own'];
  for (let i = 0; i < 1500 && fail.length === 0; i++) {
    const n = rng.range(1, 5);
    const nodes = [];
    for (let j = 0; j < n; j++) {
      const dup = j > 0 && rng.bernoulli(0.08);
      nodes.push({ id: dup ? nodes[rng.int(nodes.length)].id : `n${j}`, type: rng.pick(['A', 'B']), attrs: { p: j } });
    }
    const ids = nodes.map((x) => x.id);
    const edges = [];
    const m = rng.range(0, 6);
    for (let j = 0; j < m; j++) {
      const dup = j > 0 && rng.bernoulli(0.08);
      const end = () => (rng.bernoulli(0.12) ? 'ghost' : rng.pick(ids));
      edges.push({ id: dup ? edges[rng.int(edges.length)].id : `e${j}`, type: rng.pick(types), src: end(), tgt: rng.bernoulli(0.35) ? ids[0] : end() });
    }
    const model = { id: `in${i}`, nodes, edges };
    for (const ct of ['contain', 'own']) {
      const got = ct === 'contain' ? checkModelInput(model) : checkModelInput(model, ct);
      const exp = checkModelInputSpec(model, ct);
      if (canon(got) !== canon(exp)) {
        fail.push(`checkModelInput(${ct}) ${JSON.stringify(model)}: got ${canon(got)} expected ${canon(exp)}`);
        return;
      }
    }
    for (const policy of [undefined, 'drop', 'reject']) {
      for (const withReport of [false, true]) {
        const opts = {};
        if (policy) opts.dangling = policy;
        const report = withReport ? [] : undefined;
        if (report) opts.report = report;
        const exp = normalizeSpec(model, opts);
        let g;
        let thrown;
        try {
          g = normalizeToTypedGraph(model, opts);
        } catch (e) {
          thrown = e;
        }
        const tag = `normalize(${JSON.stringify({ policy, withReport })}) ${JSON.stringify(model)}`;
        if (exp.throws) {
          if (!thrown || !(thrown instanceof InputError) || canon(thrown.defects) !== canon(exp.throws)) {
            fail.push(`${tag}: expected InputError ${canon(exp.throws)}, got ${thrown ? String(thrown) : 'no error'}`);
            return;
          }
          continue;
        }
        if (thrown) {
          fail.push(`${tag}: unexpected ${String(thrown)}`);
          return;
        }
        const d = graphDiff(g, exp.model);
        if (d !== '') {
          fail.push(`${tag}: graph ${d}`);
          return;
        }
        if (report && canon(report) !== canon(exp.report)) {
          fail.push(`${tag}: report ${canon(report)} expected ${canon(exp.report)}`);
          return;
        }
      }
    }
  }
}

// ------------------------------------------------------------------ stage R10-SES

const CONFIGS = [
  { name: 'S1', strategy: 1, opts: {} },
  { name: 'S2', strategy: 2, opts: {} },
  { name: 'S3', strategy: 3, opts: {} },
  { name: 'S3e', strategy: 3, opts: { eagerOutput: true } },
  { name: 'S3t0.25', strategy: 3, opts: { rebuildThreshold: 0.25 } },
  { name: 'S3t0.5', strategy: 3, opts: { rebuildThreshold: 0.5 } },
  { name: 'S3t1', strategy: 3, opts: { rebuildThreshold: 1 } },
];

function makeRunner(mods) {
  const { IncrementalSession } = mods;
  const { referenceValidate } = mods;
  /**
   * Replays one change sequence in one configuration and checks every step.
   * Returns '' or a failure description.
   */
  return function replay(model0, c, rules, cfg, steps) {
    const k = kOf(rules);
    const glob = rules.filter((r) => r.global);
    const loc = rules.filter((r) => !r.global);
    const nStores = glob.filter((r) => r.kind === 'acyclic' || r.kind === 'tracePolicy').length;
    const nTrace = glob.filter((r) => r.kind === 'tracePolicy').length;
    const g = build(model0);
    const s = new IncrementalSession(g, c, rules, cfg.strategy, undefined, cfg.opts);
    let model = cloneModel(model0);
    // S1 specification state: global violations as (key, anchor)
    let s1Global = cfg.strategy === 1 ? referenceValidate(build(model), c, glob).map((v) => ({ key: keyOf(v), anchor: anchorOf(v) })) : undefined;
    for (let i = 0; i < steps.length; i++) {
      const changes = steps[i];
      const pre = model;
      const post = applySpec(pre, changes);
      let res;
      let viol;
      try {
        res = s.step(changes);
        viol = res.violations;
      } catch (e) {
        return `${cfg.name} step ${i} threw ${String(e).slice(0, 120)} changes=${JSON.stringify(changes)}`;
      }
      const tag = `${cfg.name} ${c.id} ${model0.id} step ${i} changes=${JSON.stringify(changes)}`;
      const gd = graphDiff(g, post);
      if (gd !== '') return `${tag}: graph ${gd}`;
      const scope = scopeSpec(pre, post, changes, k);
      if (res.scopeSize !== scope.size) return `${tag}: scopeSize ${res.scopeSize} expected ${scope.size}`;
      const ref = referenceValidate(build(post), c, rules);
      let expected;
      if (cfg.strategy === 1) {
        const ids = new Set([...post.nodes.map((n) => n.id), ...post.edges.map((e) => e.id)]);
        const kept = s1Global.filter((v) => !scope.has(v.anchor) && ids.has(v.anchor));
        const sub = referenceValidate(build(inducedModel(post, scope)), c, glob)
          .map((v) => ({ key: keyOf(v), anchor: anchorOf(v) }))
          .filter((v) => scope.has(v.anchor));
        s1Global = [...kept, ...sub];
        expected = keySet(referenceValidate(build(post), c, loc));
        for (const v of s1Global) expected.add(v.key);
      } else {
        expected = keySet(ref);
      }
      const got = keySet(viol);
      if (setNeq(got, expected)) return `${tag}: violations ${setDiffStr(got, expected)}`;
      if (cfg.strategy === 3) {
        const theta = cfg.opts.rebuildThreshold;
        const hit = theta !== undefined && changes.length > theta * (pre.nodes.length + pre.edges.length);
        const expBatch = hit ? nStores : hasRetype(pre, changes) ? nTrace : 0;
        if (res.batchGlobalRules !== expBatch || res.incrementalGlobalRules !== nStores - expBatch) {
          return `${tag}: global path batch=${res.batchGlobalRules} incremental=${res.incrementalGlobalRules} expected batch=${expBatch} of ${nStores}`;
        }
      }
      model = post;
    }
    return '';
  };
}

/** Bounded small graphs (n <= 2, m <= 2) of a catalog, attribute variants on the first node. */
function* smallGraphs(c) {
  const slots = [];
  for (let n = 1; n <= 2; n++) {
    const sl = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (const t of c.edgeTypes) sl.push([i, j, t]);
    slots.push([n, sl]);
  }
  for (const [n, sl] of slots) {
    const T = c.nodeTypes.length;
    for (let ta = 0; ta < Math.pow(T, n); ta++) {
      const types = [];
      let rest = ta;
      for (let i = 0; i < n; i++) {
        types.push(c.nodeTypes[rest % T]);
        rest = Math.floor(rest / T);
      }
      for (let variant = 0; variant < 3; variant++) {
        const nodes = types.map((t, i) => ({ id: `n${i}`, type: t, attrs: i === 0 ? (variant === 0 ? {} : variant === 1 ? { p: 1 } : { p: 3 }) : t === 'A' ? { p: 1 } : {} }));
        const combos = [[]];
        for (let a = 0; a < sl.length; a++) combos.push([a]);
        for (let a = 0; a < sl.length; a++) for (let b = a + 1; b < sl.length; b++) combos.push([a, b]);
        for (const combo of combos) {
          const edges = combo.map((si, idx) => ({ id: `e${idx}`, type: sl[si][2], src: `n${sl[si][0]}`, tgt: `n${sl[si][1]}` }));
          yield { id: `sg-n${n}-t${ta}-v${variant}-${combo.join('.')}`, nodes, edges };
        }
      }
    }
  }
}

/** Deterministic one-step templates with rejected / reusing changes for a small graph. */
function smallTemplates(model) {
  const out = [];
  const first = model.nodes[0].id;
  const last = model.nodes[model.nodes.length - 1].id;
  const ft = model.nodes[0].type;
  if (model.edges.length > 0) {
    const e0 = model.edges[0];
    out.push([{ kind: 'addEdge', edge: { id: e0.id, type: 's', src: last, tgt: first } }]);
    out.push([{ kind: 'delEdge', id: e0.id }, { kind: 'addEdge', edge: { id: e0.id, type: e0.type, src: e0.tgt, tgt: e0.src } }]);
  }
  out.push([{ kind: 'addEdge', edge: { id: 'g1', type: 'r', src: first, tgt: 'ghost' } }]);
  out.push([{ kind: 'delNode', id: first }, { kind: 'addEdge', edge: { id: 'g2', type: 't', src: last, tgt: first } }]);
  out.push([{ kind: 'delNode', id: first }, { kind: 'addNode', node: { id: first, type: ft, attrs: {} } }, { kind: 'addEdge', edge: { id: 'g3', type: 'r', src: first, tgt: last } }]);
  out.push([{ kind: 'addNode', node: { id: first, type: ft, attrs: { p: 2 } } }]);
  out.push([{ kind: 'addNode', node: { id: 'gx', type: 'C', attrs: {} } }, { kind: 'addEdge', edge: { id: 'g4', type: 's', src: last, tgt: 'gx' } }, { kind: 'delNode', id: 'gx' }]);
  out.push([{ kind: 'delNode', id: 'no-such-node' }, { kind: 'setAttr', id: 'no-such-node', attr: 'p', value: 1 }, { kind: 'delEdge', id: 'no-such-edge' }]);
  out.push([{ kind: 'addEdge', edge: { id: 'g5', type: 'r', src: first, tgt: last } }, { kind: 'addEdge', edge: { id: 'g6', type: 'r', src: first, tgt: first } }]);
  return out;
}

function stageSessions(fail) {
  const mods = {
    IncrementalSession: req('incremental/session').IncrementalSession,
    referenceValidate: req('reference/referenceSemantics').referenceValidate,
  };
  const { deriveRules } = req('catalog/rules');
  const { Rng } = req('util/rng');
  const { allCatalogs } = req('catalog/domains');
  const { tinyCatalog, candidateChanges } = req('verification/boundedExhaustive');
  const replay = makeRunner(mods);

  // (1) bounded small graphs of the two extra catalogs, R8 templates T1-T10 plus R10 templates
  for (const c of [catZero(tinyCatalog), catNoView()]) {
    const rules = deriveRules(c);
    for (const model of smallGraphs(c)) {
      const templates = [...candidateChanges(model, true), ...smallTemplates(model)];
      for (const changes of templates) {
        for (const cfg of CONFIGS) {
          const r = replay(model, c, rules, cfg, [changes]);
          if (r !== '') {
            fail.push(r);
            return;
          }
        }
      }
    }
  }
  // (2) random sequences of edge-case change sets
  const catalogs = [tinyCatalog(), catZero(tinyCatalog), catNoView(), ...allCatalogs()];
  for (let ci = 0; ci < catalogs.length; ci++) {
    const c = catalogs[ci];
    const rules = deriveRules(c);
    for (let cs = 0; cs < 6; cs++) {
      const rng = new Rng(20261023 + ci * 1009 + cs * 17);
      const model0 = randomValidModel(c, rng, `rs-${c.id}-${cs}`, 8, 12);
      const fresh = { n: 0 };
      const steps = [];
      let m = model0;
      for (let i = 0; i < 15; i++) {
        const ch = edgeCaseChanges(m, c, rng, fresh);
        steps.push(ch);
        m = applySpec(m, ch);
      }
      for (const cfg of CONFIGS) {
        const r = replay(model0, c, rules, cfg, steps);
        if (r !== '') {
          fail.push(r);
          return;
        }
      }
    }
  }
}

// ------------------------------------------------------------------ stage R10-API

function touchedSpec(model, changes) {
  const t = new Set();
  let cur = model;
  for (const c of changes) {
    if (c.kind === 'addNode') t.add(c.node.id);
    else if (c.kind === 'delNode') {
      for (const e of cur.edges) if (e.src === c.id || e.tgt === c.id) {
        t.add(e.src);
        t.add(e.tgt);
        t.add(e.id);
      }
      t.add(c.id);
    } else if (c.kind === 'setAttr') t.add(c.id);
    else if (c.kind === 'addEdge') {
      const ok = cur.nodes.some((n) => n.id === c.edge.src) && cur.nodes.some((n) => n.id === c.edge.tgt) && !cur.edges.some((e) => e.id === c.edge.id);
      if (ok) {
        t.add(c.edge.id);
        t.add(c.edge.src);
        t.add(c.edge.tgt);
      }
    } else if (c.kind === 'delEdge') {
      const e = cur.edges.find((x) => x.id === c.id);
      if (e) {
        t.add(e.id);
        t.add(e.src);
        t.add(e.tgt);
      }
    }
    cur = applySpec(cur, [c]);
  }
  return t;
}

function stageApi(fail) {
  const { applyChanges } = req('model/graph');
  const { groundingNodes, validate } = req('validator/engine');
  const { TraceWitness } = req('witness/traceWitness');
  const { deriveRules } = req('catalog/rules');
  const { Rng } = req('util/rng');
  const { allCatalogs } = req('catalog/domains');
  const { tinyCatalog } = req('verification/boundedExhaustive');
  const catalogs = [tinyCatalog(), catZero(tinyCatalog), catNoView(), ...allCatalogs()];
  for (let ci = 0; ci < catalogs.length; ci++) {
    const c = catalogs[ci];
    const rules = deriveRules(c);
    for (let cs = 0; cs < 20; cs++) {
      const rng = new Rng(77001 + ci * 131 + cs);
      let model = randomValidModel(c, rng, `api-${c.id}-${cs}`, 8, 14);
      const fresh = { n: 0 };
      for (let step = 0; step < 6; step++) {
        const changes = edgeCaseChanges(model, c, rng, fresh);
        const g = build(model);
        let touched;
        try {
          touched = new Set(applyChanges(g, changes));
        } catch (e) {
          fail.push(`applyChanges threw ${String(e).slice(0, 120)}`);
          return;
        }
        const post = applySpec(model, changes);
        const tag = `${c.id} ${model.id} step ${step} changes=${JSON.stringify(changes)}`;
        const gd = graphDiff(g, post);
        if (gd !== '') {
          fail.push(`applyChanges graph ${tag}: ${gd}`);
          return;
        }
        const exp = touchedSpec(model, changes);
        if (setNeq(touched, exp)) {
          fail.push(`applyChanges support ${tag}: ${setDiffStr(touched, exp)}`);
          return;
        }
        model = post;
        // groundingNodes (E3 Part D): endpoints of the relation for TYPE, the witness otherwise
        const gp = build(post);
        const byId = new Map(post.edges.map((e) => [e.id, e]));
        for (const v of validate(gp, c, rules)) {
          if (v.kind === 'acyclic' || v.kind === 'tracePolicy') continue;
          const want = v.kind === 'relationType' ? [byId.get(v.witness[0]).src, byId.get(v.witness[0]).tgt] : v.witness;
          let got;
          try {
            got = groundingNodes(gp, v);
          } catch (e) {
            fail.push(`groundingNodes threw ${String(e).slice(0, 120)}`);
            return;
          }
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            fail.push(`groundingNodes ${keyOf(v)} in ${model.id}: ${JSON.stringify(got)} expected ${JSON.stringify(want)}`);
            return;
          }
        }
        // evidencePath: a satisfied source has a path of policy edges ending at a target node;
        // a violating source has none
        for (const r of rules) {
          if (r.kind !== 'tracePolicy') continue;
          const p = r.policy;
          let tw;
          try {
            tw = new TraceWitness(gp, r);
          } catch (e) {
            fail.push(`TraceWitness threw ${String(e).slice(0, 120)}`);
            return;
          }
          const violating = new Set(tw.report().map((v) => v.witness[0]));
          const typeOf = new Map(post.nodes.map((n) => [n.id, n.type]));
          for (const n of post.nodes) {
            if (n.type !== p.sourceType) continue;
            let path;
            try {
              path = tw.evidencePath(n.id);
            } catch (e) {
              fail.push(`evidencePath(${n.id}) threw ${String(e).slice(0, 120)} in ${model.id}`);
              return;
            }
            if (violating.has(n.id)) {
              if (path.length !== 0) {
                fail.push(`evidencePath(${n.id}) of a violating source is ${JSON.stringify(path)}`);
                return;
              }
              continue;
            }
            let cur = n.id;
            let ok = path.length > 0;
            for (const eid of path) {
              const e = byId.get(eid);
              if (!e || e.src !== cur || !p.edgeTypes.includes(e.type)) {
                ok = false;
                break;
              }
              cur = e.tgt;
            }
            if (!ok || typeOf.get(cur) !== p.targetType) {
              fail.push(`evidencePath(${n.id}) ${JSON.stringify(path)} is not a ${p.edgeTypes.join('|')} path to a ${p.targetType} in ${model.id}`);
              return;
            }
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ main

function r8Stages() {
  const { runBoundedExhaustive } = req('verification/boundedExhaustive');
  const { runInvarianceTests } = req('verification/invarianceTests');
  const { runPropertyTests } = req('verification/propertyTests');
  const BOUNDS = [
    { nodes: 1, maxEdges: 3, attributeVariants: 3 },
    { nodes: 2, maxEdges: 3, attributeVariants: 3 },
    { nodes: 3, maxEdges: 2, attributeVariants: 3 },
  ];
  return [
    ['BE-base', () => {
      const r = runBoundedExhaustive(BOUNDS, true, false, 1);
      return r.mismatches.length > 0 ? `${r.mismatches[0].check}: ${r.mismatches[0].detail.slice(0, 200)}` : null;
    }],
    ['BE-ext', () => {
      const r = runBoundedExhaustive(BOUNDS, true, true, 1);
      return r.mismatches.length > 0 ? `${r.mismatches[0].check}: ${r.mismatches[0].detail.slice(0, 200)}` : null;
    }],
    ['PB', () => {
      const r = runPropertyTests({ cases: 12, stepsPerCase: 30, seed: 20260201 });
      return r.failures.length > 0 ? `${r.failures[0].property}: ${r.failures[0].detail.slice(0, 200)}` : null;
    }],
    ['INV', () => {
      const r = runInvarianceTests({ cases: 9, steps: 10, seed: 42 });
      return r.failures.length > 0 ? `${r.failures[0].check}: ${r.failures[0].detail.slice(0, 200)}` : null;
    }],
  ];
}

const wrap = (fn) => () => {
  const fail = [];
  fn(fail);
  return fail.length > 0 ? fail[0].slice(0, 400) : null;
};

function main() {
  const stages = [];
  if (process.env.R10_ONLY !== '1') stages.push(...r8Stages());
  stages.push(['R10-IN', wrap(stageInput)], ['R10-SES', wrap(stageSessions)], ['R10-API', wrap(stageApi)]);
  const timing = {};
  for (const [name, fn] of stages) {
    const t0 = Date.now();
    let detail;
    try {
      detail = fn();
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ killedBy: `crash:${name}`, detail: String(e).slice(0, 300), timing })}\n`);
      return;
    }
    timing[name] = Date.now() - t0;
    if (detail !== null) {
      process.stdout.write(`${JSON.stringify({ killedBy: name, detail, timing })}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify({ killedBy: null, detail: '', timing })}\n`);
}

if (require.main === module) main();
module.exports = { applySpec, build, graphDiff, scopeSpec, checkModelInputSpec, normalizeSpec };
