/**
 * Property-based tests (section 4.8, second mechanization).
 *
 * Randomly generated models, catalogs, change sequences and defect schedules are checked
 * against the following properties:
 *   P1 (Theorem 1)  engine output equals the reference semantics
 *   P2 (Theorem 2)  output serialization is invariant under rule traversal permutation
 *   P3 (Lemma 1)    generated clean models have no violation
 *   P4 (Theorem 4/6) strategy 3 equals batch validation at every step
 *   P5 (Theorem 6)  strategy 2 equals batch validation at every step
 *   P6 (Theorem 8)  the injection equation holds for the scheduled defect set
 *   P7 (Theorem 6)  global-rule stress: dense dependOn / satisfy / allocate edits (cycles
 *                   created and broken, components and requirements deleted and added);
 *                   strategy 3 equals batch validation of the independently updated model
 *   P1f (Theorem 1) engine output equals the reference semantics on the defect-injected
 *                   model and on every single-defect model (non-empty violation sets)
 */

import { allCatalogs } from '../catalog/domains';
import { deriveRules, serializeViolations, setDiff, violationSet } from '../catalog/rules';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { IncrementalSession } from '../incremental/session';
import { applyChanges, normalizeToTypedGraph } from '../model/graph';
import { applyChangesToModel, graphModelDiff } from './modelChanges';
import { AttrValue, Catalog, Change, ModelNode, Rule, TypedGraph } from '../model/types';
import { referenceValidate } from '../reference/referenceSemantics';
import { Rng } from '../util/rng';
import { validate, validatePermuted } from '../validator/engine';
import { DEFECT_TYPES, scheduleDefects } from '../injector/defectInjector';

export interface PropertyFailure {
  property: string;
  detail: string;
}

export interface PropertyReport {
  cases: number;
  steps: number;
  checks: Record<string, number>;
  /** P1f checks whose reference violation set was non-empty */
  nonEmptyP1f: number;
  failures: PropertyFailure[];
  elapsedMs: number;
}

function randomNodeOfType(g: TypedGraph, type: string, rng: Rng): string | undefined {
  const ids: string[] = [];
  for (const [id, n] of g.nodes) if (n.type === type) ids.push(id);
  if (ids.length === 0) return undefined;
  return ids[rng.int(ids.length)];
}

function randomAttrValue(c: Catalog, type: string, attr: string, rng: Rng): AttrValue | undefined {
  const d = c.domain[`${type}.${attr}`];
  const roll = rng.int(3);
  if (roll === 0) return undefined; // provoke a completeness violation
  if (!d) return `v${rng.int(1000)}`;
  if (d.kind === 'enum') return roll === 1 ? rng.pick(d.values) : 'OUT_OF_DOMAIN';
  if (d.kind === 'range') return roll === 1 ? d.min + (d.max - d.min) * rng.next() : d.max + 1;
  return roll === 1 ? `s${rng.int(100)}` : '';
}

/** Random change set of the requested size against the current graph. */
export function randomChangeSet(g: TypedGraph, c: Catalog, rng: Rng, size: number): Change[] {
  const changes: Change[] = [];
  const nodeIds = [...g.nodes.keys()];
  const edgeIds = [...g.edges.keys()];
  for (let i = 0; i < size; i++) {
    const roll = rng.int(5);
    if (roll === 0 && edgeIds.length > 0) {
      changes.push({ kind: 'delEdge', id: rng.pick(edgeIds) });
    } else if (roll === 1) {
      const et = rng.pick(c.edgeTypes);
      const spec = c.allowed[et];
      const src = spec ? randomNodeOfType(g, rng.pick(spec.src), rng) : undefined;
      const tgt = spec ? randomNodeOfType(g, rng.pick(spec.tgt), rng) : undefined;
      if (src && tgt) changes.push({ kind: 'addEdge', edge: { id: `rnd_${rng.int(1e9)}`, type: et, src, tgt } });
    } else if (roll === 2 && nodeIds.length > 0) {
      const id = rng.pick(nodeIds);
      const n = g.nodes.get(id);
      if (n) {
        const attrs = c.requiredAttr[n.type] ?? [];
        if (attrs.length > 0) {
          const attr = rng.pick(attrs);
          changes.push({ kind: 'setAttr', id, attr, value: randomAttrValue(c, n.type, attr, rng) });
        }
      }
    } else if (roll === 3) {
      const type = rng.pick(c.nodeTypes);
      const node: ModelNode = { id: `new_${rng.int(1e9)}`, type, attrs: {} };
      for (const a of c.requiredAttr[type] ?? []) {
        const v = randomAttrValue(c, type, a, rng);
        if (v !== undefined) node.attrs[a] = v;
      }
      changes.push({ kind: 'addNode', node });
    } else if (nodeIds.length > 0) {
      changes.push({ kind: 'delNode', id: rng.pick(nodeIds) });
    }
  }
  return changes;
}

function compare(property: string, a: Set<string>, b: Set<string>, detail: string, report: PropertyReport): void {
  const onlyA = setDiff(a, b);
  const onlyB = setDiff(b, a);
  if (onlyA.length > 0 || onlyB.length > 0) {
    report.failures.push({ property, detail: `${detail} only-first=[${onlyA.join(' ')}] only-second=[${onlyB.join(' ')}]` });
  }
}

export interface PropertyOptions {
  cases: number;
  stepsPerCase: number;
  seed: number;
  minNodes?: number;
  maxNodes?: number;
}

export function runPropertyTests(opts: PropertyOptions): PropertyReport {
  const report: PropertyReport = {
    cases: 0,
    steps: 0,
    checks: { P1: 0, P1f: 0, P2: 0, P3: 0, P4: 0, P5: 0, P6: 0, P7: 0 },
    nonEmptyP1f: 0,
    failures: [],
    elapsedMs: 0,
  };
  const started = Date.now();
  const catalogs = allCatalogs();
  const minNodes = opts.minNodes ?? 40;
  const maxNodes = opts.maxNodes ?? 120;

  for (let caseIndex = 0; caseIndex < opts.cases; caseIndex++) {
    const rng = new Rng(opts.seed + caseIndex * 7919);
    const catalog = catalogs[caseIndex % catalogs.length];
    const rules: Rule[] = deriveRules(catalog);
    const n = rng.range(minNodes, maxNodes);
    const gen = generateCleanModel(catalog, { n, seed: opts.seed + caseIndex });
    report.cases++;

    // P1, P3
    const g0 = normalizeToTypedGraph(gen.model);
    const omega = validate(g0, catalog, rules);
    const omegaStar = referenceValidate(g0, catalog, rules);
    report.checks.P1++;
    compare('P1', violationSet(omega), violationSet(omegaStar), `clean model ${gen.model.id}`, report);
    report.checks.P3++;
    if (omega.length > 0) {
      report.failures.push({ property: 'P3', detail: `clean model ${gen.model.id} has ${omega.length} violations: ${serializeViolations(omega).slice(0, 300)}` });
    }

    // P2
    const perm = rng.shuffle(rules.map((_, i) => i));
    report.checks.P2++;
    if (serializeViolations(validatePermuted(g0, catalog, rules, perm)) !== serializeViolations(omega)) {
      report.failures.push({ property: 'P2', detail: `permutation changed output for ${gen.model.id}` });
    }

    // P6: injection equation
    const sched = scheduleDefects(g0, catalog, gen, rules, DEFECT_TYPES, new Rng(opts.seed + caseIndex * 31));
    const expectedUnion = new Set<string>();
    let overlapping = false;
    for (const d of sched.accepted) {
      const gd = normalizeToTypedGraph(gen.model);
      applyChanges(gd, d.changes);
      const keys = violationSet(referenceValidate(gd, catalog, rules));
      report.checks.P1f++;
      if (keys.size > 0) report.nonEmptyP1f++;
      compare('P1f', violationSet(validate(gd, catalog, rules)), keys, `single defect ${d.type} in ${gen.model.id}`, report);
      for (const k of keys) {
        if (expectedUnion.has(k)) overlapping = true;
        expectedUnion.add(k);
      }
    }
    const gAll = normalizeToTypedGraph(gen.model);
    for (const d of sched.accepted) applyChanges(gAll, d.changes);
    report.checks.P1f++;
    {
      const starAll = violationSet(referenceValidate(gAll, catalog, rules));
      if (starAll.size > 0) report.nonEmptyP1f++;
      compare('P1f', violationSet(validate(gAll, catalog, rules)), starAll, `injected model ${gen.model.id}`, report);
    }
    report.checks.P6++;
    compare('P6', violationSet(referenceValidate(gAll, catalog, rules)), expectedUnion, `injection equation ${gen.model.id}`, report);
    if (overlapping) {
      report.failures.push({ property: 'P6', detail: `expected violation sets overlap in ${gen.model.id}` });
    }

    // P4, P5: change sequences
    for (const strategy of [3, 2] as const) {
      const gs = normalizeToTypedGraph(gen.model);
      const session = new IncrementalSession(gs, catalog, rules, strategy);
      const seqRng = new Rng(opts.seed + caseIndex * 104729 + strategy);
      let refModel = gen.model;
      for (let step = 0; step < opts.stepsPerCase; step++) {
        const size = Math.max(1, Math.round((gs.nodes.size * rng.pick([0.001, 0.01, 0.05, 0.1]))));
        const changes = randomChangeSet(gs, catalog, seqRng, size);
        if (changes.length === 0) continue;
        const res = session.step(changes);
        // oracle: batch validation of the independently updated exchange model
        refModel = applyChangesToModel(refModel, changes);
        const batch = validate(normalizeToTypedGraph(refModel), catalog, rules);
        const gdiff = graphModelDiff(gs, refModel);
        if (gdiff !== '') report.failures.push({ property: strategy === 3 ? 'P4' : 'P5', detail: `change application ${gen.model.id} step ${step}: ${gdiff}` });
        report.steps++;
        const key = strategy === 3 ? 'P4' : 'P5';
        report.checks[key]++;
        compare(key, violationSet(res.violations), violationSet(batch), `${gen.model.id} step ${step}`, report);
        if (report.failures.length > 10) {
          report.elapsedMs = Date.now() - started;
          return report;
        }
      }
    }
  }
  // P7: global-rule stress sequences against the witness stores
  for (let caseIndex = 0; caseIndex < opts.cases; caseIndex++) {
    const catalog = catalogs[caseIndex % catalogs.length];
    const rules: Rule[] = deriveRules(catalog);
    const gen = generateCleanModel(catalog, { n: 40 + (caseIndex % 5) * 20, seed: opts.seed * 7 + caseIndex });
    const gs = normalizeToTypedGraph(gen.model);
    const session = new IncrementalSession(gs, catalog, rules, 3);
    const rng = new Rng(opts.seed * 11 + caseIndex * 613);
    let refModel = gen.model;
    for (let step = 0; step < opts.stepsPerCase; step++) {
      const changes = globalStressChangeSet(gs, rng, 1 + rng.int(4));
      if (changes.length === 0) continue;
      const res = session.step(changes);
      refModel = applyChangesToModel(refModel, changes);
      const batch = validate(normalizeToTypedGraph(refModel), catalog, rules);
      report.checks.P7++;
      report.steps++;
      compare('P7', violationSet(res.violations), violationSet(batch), `${gen.model.id} stress step ${step}`, report);
      if (report.failures.length > 10) {
        report.elapsedMs = Date.now() - started;
        return report;
      }
    }
  }
  report.elapsedMs = Date.now() - started;
  return report;
}

let stressSeq = 0;

/** Change sets concentrated on the edge types of the global rules (dependOn, satisfy, allocate). */
export function globalStressChangeSet(g: TypedGraph, rng: Rng, size: number): Change[] {
  const byType = new Map<string, string[]>();
  for (const [id, n] of g.nodes) {
    const l = byType.get(n.type) ?? [];
    l.push(id);
    byType.set(n.type, l);
  }
  const comps = byType.get('Component') ?? [];
  const reqs = byType.get('Requirement') ?? [];
  const funs = byType.get('Function') ?? [];
  const ofType = (t: string): string[] => {
    const out: string[] = [];
    for (const [id, e] of g.edges) if (e.type === t) out.push(id);
    return out;
  };
  const changes: Change[] = [];
  for (let i = 0; i < size; i++) {
    const roll = rng.int(10);
    const id = `st${stressSeq++}`;
    if (roll <= 2 && comps.length > 0) {
      changes.push({ kind: 'addEdge', edge: { id, type: 'dependOn', src: rng.pick(comps), tgt: rng.pick(comps) } });
    } else if (roll === 3) {
      const ds = ofType('dependOn');
      if (ds.length > 0) changes.push({ kind: 'delEdge', id: rng.pick(ds) });
    } else if (roll === 4 && comps.length > 0 && reqs.length > 0) {
      changes.push({ kind: 'addEdge', edge: { id, type: 'satisfy', src: rng.pick(comps), tgt: rng.pick(reqs) } });
    } else if (roll === 5) {
      const ss = [...ofType('satisfy'), ...ofType('allocate')];
      if (ss.length > 0) changes.push({ kind: 'delEdge', id: rng.pick(ss) });
    } else if (roll === 6 && funs.length > 0 && comps.length > 0) {
      changes.push({ kind: 'addEdge', edge: { id, type: 'allocate', src: rng.pick(funs), tgt: rng.pick(comps) } });
    } else if (roll === 7 && comps.length > 0) {
      changes.push({ kind: 'delNode', id: rng.pick(comps) });
    } else if (roll === 8 && reqs.length > 0) {
      changes.push({ kind: 'delNode', id: rng.pick(reqs) });
    } else if (comps.length > 0) {
      const nid = `stn${stressSeq++}`;
      changes.push({ kind: 'addNode', node: { id: nid, type: rng.bernoulli(0.5) ? 'Component' : 'Requirement', attrs: {} } });
      changes.push({ kind: 'addEdge', edge: { id, type: 'dependOn', src: rng.pick(comps), tgt: nid } });
      changes.push({ kind: 'addEdge', edge: { id: `${id}b`, type: 'dependOn', src: nid, tgt: rng.pick(comps) } });
    }
  }
  return changes;
}
