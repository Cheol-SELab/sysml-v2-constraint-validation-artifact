/**
 * Bounded random inputs for differential testing against the independent oracle.
 *
 *  randomCatalog(): catalogs over a small vocabulary with random policy entries, so that
 *    the rule derivation S2 itself is exercised (finite upper multiplicities, zero lower
 *    bounds, several acyclic edge types, several trace policies, source = target type,
 *    view policies whose edge roles coincide, numeric enum values, degenerate ranges).
 *  randomModel(): small raw models (before S1) with missing / out-of-domain / wrongly typed
 *    attribute values, parallel edges, self-loops and dangling references.
 */

import { AttrValue, Catalog, DomainSpec, ModelEdge, ModelNode, SysMLLikeModel } from '../model/types';
import { Rng } from '../util/rng';

const NT = ['A', 'B', 'C', 'D', 'E'];
const ET = ['p', 'q', 'r', 's'];
const ATTRS = ['name', 'k', 'w'];

function subset<T>(rng: Rng, items: T[], p: number): T[] {
  return items.filter(() => rng.bernoulli(p));
}

function nonEmptySubset<T>(rng: Rng, items: T[], p: number): T[] {
  const s = subset(rng, items, p);
  return s.length > 0 ? s : [rng.pick(items)];
}

function randomDomain(rng: Rng): DomainSpec {
  const k = rng.int(3);
  if (k === 0) {
    const pool: AttrValue[] = ['x', 'y', 'z', 1, 2, true];
    return { kind: 'enum', values: nonEmptySubset(rng, pool, 0.4) };
  }
  if (k === 1) {
    const lo = rng.range(-2, 3);
    return { kind: 'range', min: lo, max: lo + rng.range(0, 4) };
  }
  return { kind: 'nonEmptyString' };
}

export function randomCatalog(rng: Rng, id: string): Catalog {
  const nodeTypes = [...NT];
  const edgeTypes = [...ET];
  const allowed: Catalog['allowed'] = {};
  for (const t of edgeTypes) {
    if (rng.bernoulli(0.85)) allowed[t] = { src: subset(rng, nodeTypes, 0.5), tgt: subset(rng, nodeTypes, 0.5) };
  }
  const requiredAttr: Catalog['requiredAttr'] = {};
  for (const t of nodeTypes) requiredAttr[t] = subset(rng, ATTRS, 0.35);
  const domain: Catalog['domain'] = {};
  for (const t of nodeTypes) for (const a of ATTRS) if (rng.bernoulli(0.3)) domain[`${t}.${a}`] = randomDomain(rng);
  const multiplicity: Catalog['multiplicity'] = {};
  for (const t of nodeTypes)
    for (const e of edgeTypes)
      for (const dir of ['in', 'out'])
        if (rng.bernoulli(0.12)) {
          const lo = rng.int(3);
          const hi = rng.pick([-1, lo, lo + 1, lo + 2]);
          multiplicity[`${t}|${e}|${dir}`] = [lo, hi];
        }
  const tracePolicy: Catalog['tracePolicy'] = [];
  const nTrace = rng.int(3);
  for (let i = 0; i < nTrace; i++) {
    tracePolicy.push({ id: `T${i}`, sourceType: rng.pick(nodeTypes), edgeTypes: nonEmptySubset(rng, edgeTypes, 0.4), targetType: rng.pick(nodeTypes) });
  }
  const c: Catalog = {
    id,
    nodeTypes,
    edgeTypes,
    allowed,
    requiredAttr,
    domain,
    multiplicity,
    acyclic: subset(rng, edgeTypes, 0.3),
    tracePolicy,
    nonIsolated: subset(rng, nodeTypes, 0.4),
  };
  if (rng.bernoulli(0.75)) {
    c.viewPolicy = {
      viewType: rng.pick(nodeTypes),
      subjectEdgeType: rng.pick(edgeTypes),
      exposeEdgeType: rng.pick(edgeTypes),
      containEdgeType: rng.pick(edgeTypes),
    };
  }
  return c;
}

/** Value pool: in-domain values of the catalog plus deliberately ill-typed or boundary values. */
function valuePool(c: Catalog): AttrValue[] {
  const pool: AttrValue[] = ['', ' ', 'x', 'y', 'out', 'A', 0, 1, 2, -1, 2.5, 10000, 10001, 3000.5, true, false, '1'];
  for (const d of Object.values(c.domain)) {
    if (d.kind === 'enum') pool.push(...d.values);
    if (d.kind === 'range') pool.push(d.min, d.max, d.min - 1, d.max + 1, d.max + 0.5);
  }
  return pool;
}

function attrNames(c: Catalog): string[] {
  const s = new Set<string>(ATTRS);
  for (const as of Object.values(c.requiredAttr)) for (const a of as) s.add(a);
  for (const k of Object.keys(c.domain)) s.add(k.split('.')[1]);
  return [...s];
}

export function randomModel(rng: Rng, c: Catalog, id: string, maxNodes = 6, maxEdges = 9): SysMLLikeModel {
  const pool = valuePool(c);
  const names = attrNames(c);
  const nodes: ModelNode[] = [];
  const n = rng.range(1, maxNodes);
  for (let i = 0; i < n; i++) {
    const attrs: Record<string, AttrValue> = {};
    for (const a of names) if (rng.bernoulli(0.6)) attrs[a] = rng.pick(pool);
    nodes.push({ id: `n${i}`, type: rng.pick(c.nodeTypes), attrs });
  }
  const edges: ModelEdge[] = [];
  const m = rng.range(0, maxEdges);
  for (let i = 0; i < m; i++) {
    const src = rng.bernoulli(0.04) ? 'ghost' : rng.pick(nodes).id;
    const tgt = rng.bernoulli(0.04) ? 'ghost' : rng.pick(nodes).id;
    edges.push({ id: `e${i}`, type: rng.pick(c.edgeTypes), src, tgt });
  }
  return { id, nodes, edges };
}
