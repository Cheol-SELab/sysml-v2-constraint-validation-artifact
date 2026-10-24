/**
 * E1 (revised): proof mechanization after aligning the implementation with Fig. 2.
 *   - bounded exhaustive checking with the extended incremental templates (T1-T11)
 *   - property-based tests, with P1 also applied to defect-injected models (P1f)
 *   - Theorem 2 invariance under insertion-order permutation, identifier renaming and
 *     incremental replay (I1-I3)
 */

import { round } from '../evaluation/stats';
import { runBoundedExhaustive } from '../verification/boundedExhaustive';
import { runInvarianceTests } from '../verification/invarianceTests';
import { runPropertyTests } from '../verification/propertyTests';

export const E1_BOUNDS = [
  { nodes: 1, maxEdges: 3, attributeVariants: 3 },
  { nodes: 2, maxEdges: 3, attributeVariants: 3 },
  { nodes: 3, maxEdges: 3, attributeVariants: 3 },
  { nodes: 4, maxEdges: 2, attributeVariants: 3 },
];

export function runE1v2(): unknown {
  const exhaustive = runBoundedExhaustive(E1_BOUNDS, true, true);
  const properties = runPropertyTests({ cases: 30, stepsPerCase: 50, seed: 20260201 });
  const invariance = runInvarianceTests({ cases: 60, steps: 20, seed: 20261020 });
  return {
    experiment: 'E1-v2',
    boundedExhaustive: {
      bounds: exhaustive.bounds,
      incrementalTemplates:
        'T1 delete first edge; T2 insert t(last,first); T3 set p=3 on first; T4 insert r(last,first); T5 insert s(last,first); ' +
        'T6 insert t self loop on first; T7 delete first node; T8 add C node nx with s(last,nx); T9 retype first node (C<->A, invalid-witness fallback); ' +
        'T10 delete last edge and unset p on first (two-change set). T4-T10 apply when the model has the required elements.',
      graphsEnumerated: exhaustive.graphsEnumerated,
      semanticsChecks: exhaustive.semanticsChecks,
      orderChecks: exhaustive.orderChecks,
      incrementalChecks: exhaustive.incrementalChecks,
      fallbackChecks: exhaustive.fallbackChecks,
      counterexamples: exhaustive.mismatches.length,
      firstCounterexamples: exhaustive.mismatches.slice(0, 3),
      elapsedMs: round(exhaustive.elapsedMs, 1),
    },
    propertyBased: {
      cases: properties.cases,
      changeSteps: properties.steps,
      checks: properties.checks,
      nonEmptyP1f: properties.nonEmptyP1f,
      counterexamples: properties.failures.length,
      firstFailures: properties.failures.slice(0, 5),
      elapsedMs: round(properties.elapsedMs, 1),
    },
    invariance: {
      cases: invariance.cases,
      checks: invariance.checks,
      nonEmptyOutputs: invariance.nonEmptyOutputs,
      meanViolationsPerModel: invariance.meanViolationsPerModel,
      counterexamples: invariance.failures.length,
      firstFailures: invariance.failures.slice(0, 5),
      elapsedMs: round(invariance.elapsedMs, 1),
    },
  };
}
