/**
 * Experiments E1-E4 (sections 6.2-6.5).
 *   E1 proof mechanization
 *   E2 generator and clean-model integrity (Lemma 1)
 *   E3 defect injection under the exact oracle (Theorem 8)
 *   E4 quantification of the expressiveness separation (Theorem 7)
 */

import { allCatalogs, catalogSwapPair } from '../catalog/domains';
import { deriveRules, setDiff, violationSet } from '../catalog/rules';
import { baselineA, baselineB, baselineDetects } from '../evaluation/baselines';
import { addConfusion, Confusion, confusionFor, emptyConfusion, f1, precision, recall } from '../evaluation/metrics';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { DEFECT_LABEL, DEFECT_TARGET_KIND, DEFECT_TYPES, DefectType, scheduleDefects } from '../injector/defectInjector';
import { applyChanges, graphToModel, normalizeToTypedGraph } from '../model/graph';
import { SysMLLikeModel } from '../model/types';
import { referenceValidate } from '../reference/referenceSemantics';
import { Rng } from '../util/rng';
import { validate } from '../validator/engine';
import { runBoundedExhaustive } from '../verification/boundedExhaustive';
import { runPropertyTests } from '../verification/propertyTests';
import { round } from '../evaluation/stats';

export function runE1(): unknown {
  const exhaustive = runBoundedExhaustive(
    [
      { nodes: 1, maxEdges: 3, attributeVariants: 3 },
      { nodes: 2, maxEdges: 3, attributeVariants: 3 },
      { nodes: 3, maxEdges: 3, attributeVariants: 3 },
      { nodes: 4, maxEdges: 2, attributeVariants: 3 },
    ],
    true,
  );
  const properties = runPropertyTests({ cases: 30, stepsPerCase: 50, seed: 20260201 });
  return {
    experiment: 'E1',
    boundedExhaustive: {
      bounds: exhaustive.bounds,
      graphsEnumerated: exhaustive.graphsEnumerated,
      semanticsChecks: exhaustive.semanticsChecks,
      orderChecks: exhaustive.orderChecks,
      incrementalChecks: exhaustive.incrementalChecks,
      counterexamples: exhaustive.mismatches.length,
      firstCounterexamples: exhaustive.mismatches.slice(0, 3),
      elapsedMs: round(exhaustive.elapsedMs, 1),
    },
    propertyBased: {
      cases: properties.cases,
      changeSteps: properties.steps,
      checks: properties.checks,
      counterexamples: properties.failures.length,
      firstFailures: properties.failures.slice(0, 5),
      elapsedMs: round(properties.elapsedMs, 1),
    },
    smtCrossCheck: 'not executed in this environment (no solver available); reported as a limitation',
  };
}

export interface E2Row {
  catalog: string;
  n: number;
  seeds: number;
  models: number;
  cleanModels: number;
  violationTotal: number;
  referenceChecked: number;
  referenceMismatches: number;
  avgNodes: number;
  avgEdges: number;
}

export function runE2(sizes = [100, 500, 1000, 5000, 10000], seeds = 30): unknown {
  const rows: E2Row[] = [];
  const failures: string[] = [];
  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (const n of sizes) {
      let violationTotal = 0;
      let cleanModels = 0;
      let referenceChecked = 0;
      let referenceMismatches = 0;
      let nodeSum = 0;
      let edgeSum = 0;
      for (let s = 0; s < seeds; s++) {
        const gen = generateCleanModel(catalog, { n, seed: 1000 + s });
        const g = normalizeToTypedGraph(gen.model);
        nodeSum += g.nodes.size;
        edgeSum += g.edges.size;
        const omega = validate(g, catalog, rules);
        violationTotal += omega.length;
        if (omega.length === 0) cleanModels++;
        else failures.push(`${catalog.id} n=${n} seed=${1000 + s}: ${omega.slice(0, 3).map((v) => v.ruleId + '@' + v.witness.join('/')).join(', ')}`);
        if (n <= 500 && s < 5) {
          referenceChecked++;
          const star = violationSet(referenceValidate(g, catalog, rules));
          const eng = violationSet(omega);
          if (setDiff(star, eng).length > 0 || setDiff(eng, star).length > 0) referenceMismatches++;
        }
      }
      rows.push({
        catalog: catalog.id,
        n,
        seeds,
        models: seeds,
        cleanModels,
        violationTotal,
        referenceChecked,
        referenceMismatches,
        avgNodes: round(nodeSum / seeds, 1),
        avgEdges: round(edgeSum / seeds, 1),
      });
    }
  }
  return { experiment: 'E2', rows, failures: failures.slice(0, 10) };
}

interface DefectRecord {
  catalog: string;
  n: number;
  seed: number;
  defectId: string;
  type: DefectType;
  expected: string[];
  detectedByProposed: boolean;
  detectedByBaselineA: boolean;
  detectedByBaselineB: boolean;
  confusion: Confusion;
  firedRuleKinds: string[];
}

export interface E3Result {
  records: DefectRecord[];
  runs: number;
  discardedRuns: number;
  rejectedOverlap: number;
  rejectedInfeasible: number;
  falsePositivesTotal: number;
  oracleEquationChecks: number;
  oracleEquationFailures: number;
}

/** Runs the injection protocol; the records feed both E3 and E4. */
export function runInjectionProtocol(sizes = [100, 500, 1000], seedsPerCell = 30): E3Result {
  const result: E3Result = {
    records: [],
    runs: 0,
    discardedRuns: 0,
    rejectedOverlap: 0,
    rejectedInfeasible: 0,
    falsePositivesTotal: 0,
    oracleEquationChecks: 0,
    oracleEquationFailures: 0,
  };

  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (const n of sizes) {
      for (let s = 0; s < seedsPerCell; s++) {
        const seed = 5000 + s;
        const gen = generateCleanModel(catalog, { n, seed });
        const gClean = normalizeToTypedGraph(gen.model);
        if (validate(gClean, catalog, rules).length !== 0) {
          result.discardedRuns++;
          continue;
        }
        const sched = scheduleDefects(gClean, catalog, gen, rules, DEFECT_TYPES, new Rng(seed * 13 + n));
        result.rejectedOverlap += sched.rejectedOverlap;
        result.rejectedInfeasible += sched.rejectedInfeasible;
        if (sched.accepted.length === 0) {
          result.discardedRuns++;
          continue;
        }

        // expected violation set of each defect, measured in isolation
        const expectedPerDefect = new Map<string, Set<string>>();
        const firedKinds = new Map<string, string[]>();
        for (const d of sched.accepted) {
          const gd = normalizeToTypedGraph(gen.model);
          applyChanges(gd, d.changes);
          const vs = referenceValidate(gd, catalog, rules);
          expectedPerDefect.set(d.id, violationSet(vs));
          firedKinds.set(d.id, [...new Set(vs.map((v) => v.kind))].sort());
        }

        // composed injection and the Theorem 8 equation
        const gAll = normalizeToTypedGraph(gen.model);
        for (const d of sched.accepted) applyChanges(gAll, d.changes);
        const reported = validate(gAll, catalog, rules);
        const reportedKeys = violationSet(reported);
        const union = new Set<string>();
        for (const set of expectedPerDefect.values()) for (const k of set) union.add(k);
        result.oracleEquationChecks++;
        const starKeys = violationSet(referenceValidate(gAll, catalog, rules));
        if (setDiff(starKeys, union).length > 0 || setDiff(union, starKeys).length > 0) {
          result.oracleEquationFailures++;
          result.discardedRuns++;
          continue;
        }
        result.runs++;
        result.falsePositivesTotal += setDiff(reportedKeys, union).length;

        const modelAll = graphToModel(gAll);
        const findingsA = baselineA(modelAll);
        const findingsB = baselineB(modelAll);

        for (const d of sched.accepted) {
          const expected = expectedPerDefect.get(d.id)!;
          const conf = confusionFor(expected, new Set([...reportedKeys].filter((k) => expected.has(k))));
          const missing = setDiff(expected, reportedKeys);
          // A spurious key in a multi-defect run cannot be attributed to one defect, so the
          // per-defect fp field is not a measurement; the measured run-level count is
          // result.falsePositivesTotal, and per-type FP is measured by e3v2 (single-defect models).
          const confusion: Confusion = { tp: conf.tp, fp: 0, fn: missing.length };
          result.records.push({
            catalog: catalog.id,
            n,
            seed,
            defectId: d.id,
            type: d.type,
            expected: [...expected],
            detectedByProposed: missing.length === 0 && expected.size > 0,
            detectedByBaselineA: baselineDetects(findingsA, d.support),
            detectedByBaselineB: baselineDetects(findingsB, d.support),
            confusion,
            firedRuleKinds: firedKinds.get(d.id) ?? [],
          });
        }
      }
    }
  }
  return result;
}

export function summarizeE3(res: E3Result): unknown {
  const byType = new Map<DefectType, { conf: Confusion; instances: number; kinds: Set<string> }>();
  for (const t of DEFECT_TYPES) byType.set(t, { conf: emptyConfusion(), instances: 0, kinds: new Set() });
  for (const r of res.records) {
    const acc = byType.get(r.type)!;
    acc.conf = addConfusion(acc.conf, r.confusion);
    acc.instances++;
    for (const k of r.firedRuleKinds) acc.kinds.add(k);
  }
  const rows = DEFECT_TYPES.map((t) => {
    const acc = byType.get(t)!;
    return {
      defect: t,
      label: DEFECT_LABEL[t],
      targetRuleKind: DEFECT_TARGET_KIND[t],
      instances: acc.instances,
      tp: acc.conf.tp,
      fp: acc.conf.fp,
      fn: acc.conf.fn,
      precision: round(precision(acc.conf)),
      recall: round(recall(acc.conf)),
      f1: round(f1(acc.conf)),
      observedRuleKinds: [...acc.kinds].sort(),
    };
  });
  const total = res.records.reduce((c, r) => addConfusion(c, r.confusion), emptyConfusion());
  return {
    experiment: 'E3',
    rows,
    total: {
      instances: res.records.length,
      tp: total.tp,
      fp: total.fp,
      fn: total.fn,
      precision: round(precision(total)),
      recall: round(recall(total)),
      f1: round(f1(total)),
    },
    runs: res.runs,
    discardedRuns: res.discardedRuns,
    discardRate: round(res.discardedRuns / Math.max(1, res.runs + res.discardedRuns)),
    rejectedOverlapCandidates: res.rejectedOverlap,
    rejectedInfeasibleCandidates: res.rejectedInfeasible,
    runLevelFalsePositives: res.falsePositivesTotal,
    oracleEquationChecks: res.oracleEquationChecks,
    oracleEquationFailures: res.oracleEquationFailures,
  };
}

export function summarizeE4(res: E3Result): unknown {
  const rows = DEFECT_TYPES.map((t) => {
    const recs = res.records.filter((r) => r.type === t);
    const proposed = recs.filter((r) => r.detectedByProposed).length;
    const a = recs.filter((r) => r.detectedByBaselineA).length;
    const b = recs.filter((r) => r.detectedByBaselineB).length;
    const additional = recs.filter((r) => r.detectedByProposed && !r.detectedByBaselineB).length;
    return {
      defect: t,
      label: DEFECT_LABEL[t],
      instances: recs.length,
      detectedProposed: proposed,
      detectedBaselineA: a,
      detectedBaselineB: b,
      additionalOverBaselineB: additional,
    };
  });
  const instances = res.records.length;
  const additional = res.records.filter((r) => r.detectedByProposed && !r.detectedByBaselineB).length;

  // Theorem 7 catalog-swap check on a fixed small model
  const { c1, c2, changedEntry } = catalogSwapPair();
  const swapModel: SysMLLikeModel = {
    id: 'swap-witness',
    nodes: [
      { id: 'F', type: 'Function', attrs: { name: 'F' } },
      { id: 'C', type: 'Component', attrs: { name: 'C', criticality: 'A', mass: 1 } },
      { id: 'R', type: 'Requirement', attrs: { name: 'R', priority: 'high' } },
      { id: 'V', type: 'VerificationCase', attrs: { name: 'V', method: 'test' } },
    ],
    edges: [
      { id: 'a1', type: 'allocate', src: 'F', tgt: 'C' },
      { id: 's1', type: 'satisfy', src: 'C', tgt: 'R' },
      { id: 'v1', type: 'verify', src: 'V', tgt: 'R' },
    ],
  };
  const g1 = normalizeToTypedGraph(swapModel);
  const g2 = normalizeToTypedGraph(swapModel);
  const out1 = validate(g1, c1, deriveRules(c1));
  const out2 = validate(g2, c2, deriveRules(c2));
  const bA = baselineA(swapModel);
  const bB = baselineB(swapModel);

  return {
    experiment: 'E4',
    rows,
    additionalDetectionRate: round(additional / Math.max(1, instances)),
    instances,
    baselineDescription: {
      A: 'JSON schema conformance and reference existence',
      B: 'A plus type-vocabulary conformance, ownership forest well-formedness, orphan-element warning (catalog-independent)',
      note: 'Baselines are reimplementations of the catalog-independent diagnostic class, not the OMG pilot implementation; see limitations.',
    },
    catalogSwap: {
      changedEntry,
      proposedWithC1: out1.map((v) => v.ruleId + '@' + v.witness.join('/')),
      proposedWithC2: out2.map((v) => v.ruleId + '@' + v.witness.join('/')),
      baselineAFindings: bA.length,
      baselineBFindings: bB.length,
      baselineOutputIndependentOfCatalog: 'by construction: the baseline signatures take the model only',
    },
  };
}
