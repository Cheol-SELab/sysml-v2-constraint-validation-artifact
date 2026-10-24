/**
 * Child-process harness for the mutation analysis (review item M4).
 *
 * Runs a reduced E1 against the modules of the dist tree it lives in, in four stages, and
 * stops at the first stage that reports a counterexample:
 *   BE-base   bounded exhaustive (n<=2 with m<=3, n=3 with m<=2), original templates T1-T3
 *   BE-ext    same bounds, extended templates T4-T10
 *   PB        property-based tests (12 cases x 30 steps, P1-P6 and P1f)
 *   INV       invariance checks I1-I3 (9 cases x 10 steps)
 * Output (stdout, one JSON line): { killedBy: stage | null, detail }.
 * An exception is reported as killedBy = "crash:<stage>".
 */

import { runBoundedExhaustive } from './boundedExhaustive';
import { runInvarianceTests } from './invarianceTests';
import { runPropertyTests } from './propertyTests';

const BOUNDS = [
  { nodes: 1, maxEdges: 3, attributeVariants: 3 },
  { nodes: 2, maxEdges: 3, attributeVariants: 3 },
  { nodes: 3, maxEdges: 2, attributeVariants: 3 },
];

function main(): void {
  const stages: Array<[string, () => string | null]> = [
    [
      'BE-base',
      () => {
        const r = runBoundedExhaustive(BOUNDS, true, false, 1);
        return r.mismatches.length > 0 ? `${r.mismatches[0].check}: ${r.mismatches[0].detail.slice(0, 200)}` : null;
      },
    ],
    [
      'BE-ext',
      () => {
        const r = runBoundedExhaustive(BOUNDS, true, true, 1);
        return r.mismatches.length > 0 ? `${r.mismatches[0].check}: ${r.mismatches[0].detail.slice(0, 200)}` : null;
      },
    ],
    [
      'PB',
      () => {
        const r = runPropertyTests({ cases: 12, stepsPerCase: 30, seed: 20260201 });
        return r.failures.length > 0 ? `${r.failures[0].property}: ${r.failures[0].detail.slice(0, 200)}` : null;
      },
    ],
    [
      'INV',
      () => {
        const r = runInvarianceTests({ cases: 9, steps: 10, seed: 42 });
        return r.failures.length > 0 ? `${r.failures[0].check}: ${r.failures[0].detail.slice(0, 200)}` : null;
      },
    ],
  ];
  for (const [name, fn] of stages) {
    let detail: string | null;
    try {
      detail = fn();
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ killedBy: `crash:${name}`, detail: String(e).slice(0, 200) })}\n`);
      return;
    }
    if (detail !== null) {
      process.stdout.write(`${JSON.stringify({ killedBy: name, detail })}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify({ killedBy: null, detail: '' })}\n`);
}

main();
