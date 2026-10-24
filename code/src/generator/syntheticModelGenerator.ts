/**
 * Synthetic SysML v2-like model generator (experiment E2).
 *
 * The generator maintains the six invariants of Lemma 1 (clean-model tightness):
 *   (i)   edges are created only between catalog-allowed type pairs;
 *   (ii)  every required attribute is filled with a value inside its domain;
 *   (iii) per-type, per-direction degree counters stay inside the multiplicity intervals;
 *   (iv)  acyclic-typed edges only ever go from a lower to a higher topological index;
 *   (v)   every trace-policy source is given an explicit witness path;
 *   (vi)  no node is left isolated.
 */

import { AttrValue, Catalog, DomainSpec, ModelEdge, ModelNode, SysMLLikeModel } from '../model/types';
import { Rng } from '../util/rng';

export interface GeneratorOptions {
  /** target number of nodes */
  n: number;
  seed: number;
  /** ports per component (calibrated in E7) */
  portsPerComponent?: number;
  /** probability of an extra dependOn edge per component */
  dependDensity?: number;
  /** maximum containment nesting depth over components */
  depth?: number;
  /** fraction of requirements that receive a redundant satisfy/verify edge */
  redundancy?: number;
}

export interface GeneratedModel {
  model: SysMLLikeModel;
  options: Required<GeneratorOptions>;
  /** topological index per component, used by the defect injector for D6 */
  componentOrder: string[];
  /** component -> contained ports */
  portsOf: Map<string, string[]>;
  /** requirement -> satisfying components */
  satisfiedBy: Map<string, string[]>;
  /** requirement -> verifying cases */
  verifiedBy: Map<string, string[]>;
  /** component -> allocated functions */
  functionsOf: Map<string, string[]>;
  /** view -> subject component */
  subjectOf: Map<string, string>;
}

function valueInDomain(d: DomainSpec | undefined, fallback: string, rng: Rng): AttrValue {
  if (!d) return fallback;
  switch (d.kind) {
    case 'enum':
      return rng.pick(d.values);
    case 'range':
      return Math.round((d.min + (d.max - d.min) * rng.next()) * 100) / 100;
    case 'nonEmptyString':
      return fallback;
  }
}

function fillAttributes(c: Catalog, type: string, id: string, rng: Rng): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {};
  for (const a of c.requiredAttr[type] ?? []) {
    attrs[a] = valueInDomain(c.domain[`${type}.${a}`], `${type.toLowerCase()}_${id}_${a}`, rng);
  }
  return attrs;
}

export function generateCleanModel(c: Catalog, opts: GeneratorOptions): GeneratedModel {
  const options: Required<GeneratorOptions> = {
    n: opts.n,
    seed: opts.seed,
    portsPerComponent: opts.portsPerComponent ?? 0.8,
    dependDensity: opts.dependDensity ?? 0.5,
    depth: opts.depth ?? 3,
    redundancy: opts.redundancy ?? 0.4,
  };
  const rng = new Rng(options.seed);
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  let edgeSeq = 0;
  const mkEdge = (type: string, src: string, tgt: string): void => {
    edges.push({ id: `e${edgeSeq++}`, type, src, tgt });
  };

  // ---- type budget ----
  // components fix the structural backbone; the port count follows portsPerComponent, and
  // the remaining budget is split over requirements, functions, verification cases, views.
  const n = Math.max(12, options.n);
  const nComp = Math.max(2, Math.round(n * 0.25));
  const nPort = Math.max(2, Math.round(nComp * options.portsPerComponent));
  const rest = Math.max(5, n - nComp - nPort);
  const nReq = Math.max(2, Math.round(rest * 0.35));
  const nFun = Math.max(1, Math.round(rest * 0.35));
  const nVc = Math.max(1, Math.round(rest * 0.2));
  const nView = Math.max(1, rest - nReq - nFun - nVc);

  const addNode = (type: string, id: string): void => {
    nodes.push({ id, type, attrs: fillAttributes(c, type, id, rng) });
  };

  // ---- components with containment hierarchy (invariant iv for contain) ----
  const components: string[] = [];
  const compDepth = new Map<string, number>();
  // components with depth < depth - 1, kept in index order (same list as filtering
  // components[0..i-1] at step i, maintained incrementally so generation stays linear)
  const shallow: string[] = [];
  for (let i = 0; i < nComp; i++) {
    const id = `C${i}`;
    addNode('Component', id);
    components.push(id);
    if (i === 0) {
      compDepth.set(id, 0);
    } else {
      const candidates = shallow;
      if (candidates.length > 0 && rng.bernoulli(0.7)) {
        const parent = rng.pick(candidates);
        mkEdge('contain', parent, id);
        compDepth.set(id, (compDepth.get(parent) ?? 0) + 1);
      } else {
        compDepth.set(id, 0);
      }
    }
    if ((compDepth.get(id) ?? 0) < options.depth - 1) shallow.push(id);
  }
  const componentIndex = new Map<string, number>();
  components.forEach((id, idx) => componentIndex.set(id, idx));

  // ---- ports, each contained by exactly one component (invariant iii) ----
  const portsOf = new Map<string, string[]>();
  for (const cmp of components) portsOf.set(cmp, []);
  const ports: string[] = [];
  for (let i = 0; i < nPort; i++) {
    const id = `P${i}`;
    addNode('Port', id);
    ports.push(id);
    const owner = components[i % components.length];
    mkEdge('contain', owner, id);
    portsOf.get(owner)!.push(id);
  }
  // connect ports pairwise (no multiplicity constraint on connect)
  for (let i = 0; i + 1 < ports.length; i += 2) {
    mkEdge('connect', ports[i], ports[i + 1]);
  }

  // ---- verification cases ----
  const vcs: string[] = [];
  for (let i = 0; i < nVc; i++) {
    const id = `V${i}`;
    addNode('VerificationCase', id);
    vcs.push(id);
  }

  // ---- requirements with satisfy/verify witnesses (invariant iii) ----
  const requirements: string[] = [];
  const satisfiedBy = new Map<string, string[]>();
  const verifiedBy = new Map<string, string[]>();
  for (let i = 0; i < nReq; i++) {
    const id = `R${i}`;
    addNode('Requirement', id);
    requirements.push(id);
    const primary = components[i % components.length];
    mkEdge('satisfy', primary, id);
    satisfiedBy.set(id, [primary]);
    const vc = vcs[i % vcs.length];
    mkEdge('verify', vc, id);
    verifiedBy.set(id, [vc]);
    if (rng.bernoulli(options.redundancy) && components.length > 1) {
      const extra = components[(i + 1 + rng.int(components.length - 1)) % components.length];
      if (extra !== primary) {
        mkEdge('satisfy', extra, id);
        satisfiedBy.get(id)!.push(extra);
      }
    }
    if (rng.bernoulli(options.redundancy) && vcs.length > 1) {
      const extra = vcs[(i + 1 + rng.int(vcs.length - 1)) % vcs.length];
      if (extra !== vc) {
        mkEdge('verify', extra, id);
        verifiedBy.get(id)!.push(extra);
      }
    }
  }

  // ---- functions allocated to satisfying components (invariant v) ----
  const satisfyingComponents = [...new Set([...satisfiedBy.values()].flat())];
  const functionsOf = new Map<string, string[]>();
  for (const cmp of components) functionsOf.set(cmp, []);
  for (let i = 0; i < nFun; i++) {
    const id = `F${i}`;
    addNode('Function', id);
    const owner = satisfyingComponents[i % satisfyingComponents.length];
    mkEdge('allocate', id, owner);
    functionsOf.get(owner)!.push(id);
  }

  // ---- dependOn edges, strictly increasing index (invariant iv) ----
  for (let i = 0; i < components.length; i++) {
    if (!rng.bernoulli(options.dependDensity)) continue;
    const j = i + 1 + rng.int(Math.max(1, components.length - i - 1));
    if (j < components.length) mkEdge('dependOn', components[i], components[j]);
  }

  // ---- views over components that own ports ----
  const subjectOf = new Map<string, string>();
  const viewCandidates = components.filter((cmp) => (portsOf.get(cmp) ?? []).length > 0);
  for (let i = 0; i < nView; i++) {
    const id = `W${i}`;
    addNode('View', id);
    const subject = viewCandidates.length > 0 ? viewCandidates[i % viewCandidates.length] : components[i % components.length];
    mkEdge('subject', id, subject);
    subjectOf.set(id, subject);
    mkEdge('expose', id, subject);
    for (const p of portsOf.get(subject) ?? []) mkEdge('expose', id, p);
  }

  // ---- invariant (vi): remove isolation ----
  const degree = new Map<string, number>();
  for (const nd of nodes) degree.set(nd.id, 0);
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.tgt, (degree.get(e.tgt) ?? 0) + 1);
  }
  for (const nd of nodes) {
    if ((degree.get(nd.id) ?? 0) > 0) continue;
    if (nd.type === 'Component') {
      const idx = componentIndex.get(nd.id) ?? -1;
      if (idx > 0) mkEdge('dependOn', components[idx - 1], nd.id);
      else if (components.length > 1) mkEdge('dependOn', nd.id, components[1]);
      degree.set(nd.id, 1);
    } else if (nd.type === 'VerificationCase' && requirements.length > 0) {
      const r = requirements[0];
      mkEdge('verify', nd.id, r);
      verifiedBy.get(r)!.push(nd.id);
      degree.set(nd.id, 1);
    } else if (nd.type === 'Port') {
      const owner = components[0];
      mkEdge('contain', owner, nd.id);
      portsOf.get(owner)!.push(nd.id);
      degree.set(nd.id, 1);
    }
  }

  return {
    model: { id: `${c.id}-n${options.n}-s${options.seed}`, nodes, edges },
    options,
    componentOrder: components,
    portsOf,
    satisfiedBy,
    verifiedBy,
    functionsOf,
    subjectOf,
  };
}
