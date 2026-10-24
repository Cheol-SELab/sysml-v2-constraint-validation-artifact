/**
 * Invariance checks for Theorem 2 beyond rule-order reversal.
 *
 *   I1 insertion order : node and edge insertion orders of the exchange model are randomly
 *                        permuted (this permutes adjacency lists, grounding enumeration order
 *                        and Tarjan/BFS visiting order); the rule order is permuted as well.
 *                        The canonical serialization must be byte-identical.
 *   I2 renaming        : a random bijection renames every node and edge identifier (an
 *                        isomorphic copy). Mapping the output back through the inverse
 *                        bijection must give the original violation set.
 *   I3 incremental     : the same change sequence, renamed, is replayed by the witness
 *                        session (strategy 3) on the permuted and renamed copy; the mapped
 *                        violation set must equal the original session's at every step.
 *
 * Models carry violations: each case injects the scheduled defects and then applies random
 * change sets, so the checks are not run on empty outputs only.
 */

import { allCatalogs } from '../catalog/domains';
import { deriveRules, serializeViolations, setDiff, violationSet } from '../catalog/rules';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { DEFECT_TYPES, scheduleDefects } from '../injector/defectInjector';
import { IncrementalSession } from '../incremental/session';
import { applyChanges, graphToModel, normalizeToTypedGraph } from '../model/graph';
import { Change, SysMLLikeModel, Violation } from '../model/types';
import { referenceValidate } from '../reference/referenceSemantics';
import { Rng } from '../util/rng';
import { validate, validatePermuted } from '../validator/engine';
import { randomChangeSet } from './propertyTests';

export interface InvarianceReport {
  cases: number;
  checks: { I1: number; I1reference: number; I2: number; I2reference: number; I3: number };
  nonEmptyOutputs: number;
  meanViolationsPerModel: number;
  failures: Array<{ check: string; detail: string }>;
  elapsedMs: number;
}

function renameMap(model: SysMLLikeModel, rng: Rng): Map<string, string> {
  const ids = [...model.nodes.map((n) => n.id), ...model.edges.map((e) => e.id)];
  const fresh = rng.shuffle(ids.map((_, i) => `q${i.toString(36)}_${rng.int(1e6).toString(36)}`));
  const m = new Map<string, string>();
  ids.forEach((id, i) => m.set(id, fresh[i]));
  return m;
}

function rn(m: Map<string, string>, id: string): string {
  let r = m.get(id);
  if (r === undefined) {
    // identifiers created later by change sets get a deterministic fresh name
    r = `new~${id}`;
    m.set(id, r);
  }
  return r;
}

function renameModel(model: SysMLLikeModel, m: Map<string, string>): SysMLLikeModel {
  return {
    id: model.id,
    nodes: model.nodes.map((n) => ({ id: rn(m, n.id), type: n.type, attrs: { ...n.attrs } })),
    edges: model.edges.map((e) => ({ id: rn(m, e.id), type: e.type, src: rn(m, e.src), tgt: rn(m, e.tgt) })),
  };
}

function renameChanges(changes: Change[], m: Map<string, string>): Change[] {
  return changes.map((c): Change => {
    switch (c.kind) {
      case 'addNode':
        return { kind: 'addNode', node: { id: rn(m, c.node.id), type: c.node.type, attrs: { ...c.node.attrs } } };
      case 'delNode':
        return { kind: 'delNode', id: rn(m, c.id) };
      case 'setAttr':
        return { kind: 'setAttr', id: rn(m, c.id), attr: c.attr, value: c.value };
      case 'addEdge':
        return { kind: 'addEdge', edge: { id: rn(m, c.edge.id), type: c.edge.type, src: rn(m, c.edge.src), tgt: rn(m, c.edge.tgt) } };
      case 'delEdge':
        return { kind: 'delEdge', id: rn(m, c.id) };
    }
  });
}

/** Violation keys mapped back through the inverse renaming. */
function unrenamedKeys(vs: Violation[], inverse: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const v of vs) {
    const w = v.witness.map((x) => inverse.get(x) ?? x).sort();
    out.add(`${v.ruleId}|${w.join(',')}`);
  }
  return out;
}

function permuteModel(model: SysMLLikeModel, rng: Rng): SysMLLikeModel {
  return { id: model.id, nodes: rng.shuffle(model.nodes), edges: rng.shuffle(model.edges) };
}

export function runInvarianceTests(opts: { cases: number; steps: number; seed: number }): InvarianceReport {
  const report: InvarianceReport = {
    cases: 0,
    checks: { I1: 0, I1reference: 0, I2: 0, I2reference: 0, I3: 0 },
    nonEmptyOutputs: 0,
    meanViolationsPerModel: 0,
    failures: [],
    elapsedMs: 0,
  };
  const started = Date.now();
  const catalogs = allCatalogs();
  let violationSum = 0;
  let outputs = 0;
  const fail = (check: string, detail: string): void => {
    if (report.failures.length < 20) report.failures.push({ check, detail });
  };

  for (let ci = 0; ci < opts.cases; ci++) {
    const rng = new Rng(opts.seed + ci * 7907);
    const catalog = catalogs[ci % catalogs.length];
    const rules = deriveRules(catalog);
    const gen = generateCleanModel(catalog, { n: rng.range(40, 160), seed: opts.seed + ci });
    const g0 = normalizeToTypedGraph(gen.model);
    const sched = scheduleDefects(g0, catalog, gen, rules, DEFECT_TYPES, new Rng(opts.seed + ci * 31));
    for (const d of sched.accepted) applyChanges(g0, d.changes);
    // extra random edits so that the model carries violations of many rule kinds
    // independent streams: identical seeds would regenerate the same fresh identifiers
    const pre = new Rng(opts.seed * 3 + ci * 131 + 1);
    for (let i = 0; i < 3; i++) applyChanges(g0, randomChangeSet(g0, catalog, pre, Math.max(1, Math.round(g0.nodes.size * 0.05))));
    const base = graphToModel(g0);
    report.cases++;

    const gb = normalizeToTypedGraph(base);
    const omega = validate(gb, catalog, rules);
    const canon = serializeViolations(omega);
    violationSum += violationSet(omega).size;
    outputs++;
    if (omega.length > 0) report.nonEmptyOutputs++;

    // I1: insertion order and rule order
    for (let rep = 0; rep < 3; rep++) {
      const pm = permuteModel(base, rng);
      const gp = normalizeToTypedGraph(pm);
      const perm = rng.shuffle(rules.map((_, i) => i));
      report.checks.I1++;
      if (serializeViolations(validatePermuted(gp, catalog, rules, perm)) !== canon) fail('I1', `${base.id} rep ${rep}`);
      report.checks.I1reference++;
      if (serializeViolations(referenceValidate(gp, catalog, rules)) !== canon) fail('I1reference', `${base.id} rep ${rep}`);
    }

    // I2: renaming (with permutation)
    const m = renameMap(base, rng);
    const renamed = permuteModel(renameModel(base, m), rng);
    const inverse = new Map<string, string>();
    const gr = normalizeToTypedGraph(renamed);
    const out = validate(gr, catalog, rules);
    for (const [a, b] of m) inverse.set(b, a);
    const orig = violationSet(omega);
    report.checks.I2++;
    const back = unrenamedKeys(out, inverse);
    if (setDiff(back, orig).length > 0 || setDiff(orig, back).length > 0) {
      fail('I2', `${base.id} only-renamed=[${setDiff(back, orig).slice(0, 3).join(' ')}] only-original=[${setDiff(orig, back).slice(0, 3).join(' ')}]`);
    }
    report.checks.I2reference++;
    const backRef = unrenamedKeys(referenceValidate(gr, catalog, rules), inverse);
    if (setDiff(backRef, orig).length > 0 || setDiff(orig, backRef).length > 0) fail('I2reference', base.id);

    // I3: incremental replay on the renamed and permuted copy
    const gA = normalizeToTypedGraph(base);
    const gB = normalizeToTypedGraph(renamed);
    const sA = new IncrementalSession(gA, catalog, rules, 3);
    const sB = new IncrementalSession(gB, catalog, rules, 3);
    const seq = new Rng(opts.seed * 5 + ci * 104723 + 2);
    for (let st = 0; st < opts.steps; st++) {
      const changes = randomChangeSet(gA, catalog, seq, Math.max(1, Math.round(gA.nodes.size * seq.pick([0.01, 0.05, 0.1]))));
      if (changes.length === 0) continue;
      const rA = sA.step(changes);
      const rB = sB.step(renameChanges(changes, m));
      for (const [a, b] of m) inverse.set(b, a);
      report.checks.I3++;
      const ka = violationSet(rA.violations);
      const kb = unrenamedKeys(rB.violations, inverse);
      if (setDiff(ka, kb).length > 0 || setDiff(kb, ka).length > 0) {
        fail('I3', `${base.id} step ${st} only-original=[${setDiff(ka, kb).slice(0, 3).join(' ')}] only-renamed=[${setDiff(kb, ka).slice(0, 3).join(' ')}]`);
      }
    }
  }
  report.meanViolationsPerModel = Math.round((violationSum / Math.max(1, outputs)) * 10) / 10;
  report.elapsedMs = Date.now() - started;
  return report;
}
