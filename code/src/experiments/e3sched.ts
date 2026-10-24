/**
 * Scheduler scope comparison (review item M3/M5, coordinator request): the original
 * injection protocol of E3 (one original operator per type, n = 100/500/1000, 30 seeds,
 * three catalogs) run with the original pre-state-only scope and with the pre/post-union
 * scope. Reports accepted/rejected candidates and the Theorem 7 (injection equation)
 * check for both.
 */

import { allCatalogs } from '../catalog/domains';
import { deriveRules, setDiff, violationSet } from '../catalog/rules';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { DEFECT_TYPES, scheduleDefects } from '../injector/defectInjector';
import { applyChanges, normalizeToTypedGraph } from '../model/graph';
import { referenceValidate } from '../reference/referenceSemantics';
import { Rng } from '../util/rng';

export function runE3Sched(quick = false): unknown {
  const sizes = quick ? [100] : [100, 500, 1000];
  const seeds = quick ? 3 : 30;
  const out: Record<string, { runs: number; accepted: number; rejectedOverlap: number; rejectedInfeasible: number; equationChecks: number; equationFailures: number; perType: Record<string, number> }> = {};
  for (const mode of ['pre', 'prepost'] as const) {
    const acc = { runs: 0, accepted: 0, rejectedOverlap: 0, rejectedInfeasible: 0, equationChecks: 0, equationFailures: 0, perType: {} as Record<string, number> };
    for (const catalog of allCatalogs()) {
      const rules = deriveRules(catalog);
      for (const n of sizes) {
        for (let s = 0; s < seeds; s++) {
          const seed = 5000 + s;
          const gen = generateCleanModel(catalog, { n, seed });
          const g = normalizeToTypedGraph(gen.model);
          const sched = scheduleDefects(g, catalog, gen, rules, DEFECT_TYPES, new Rng(seed * 13 + n), mode);
          acc.runs++;
          acc.accepted += sched.accepted.length;
          acc.rejectedOverlap += sched.rejectedOverlap;
          acc.rejectedInfeasible += sched.rejectedInfeasible;
          for (const d of sched.accepted) acc.perType[d.type] = (acc.perType[d.type] ?? 0) + 1;
          if (sched.accepted.length === 0) continue;
          const union = new Set<string>();
          for (const d of sched.accepted) {
            const gd = normalizeToTypedGraph(gen.model);
            applyChanges(gd, d.changes);
            for (const k of violationSet(referenceValidate(gd, catalog, rules))) union.add(k);
          }
          const gAll = normalizeToTypedGraph(gen.model);
          for (const d of sched.accepted) applyChanges(gAll, d.changes);
          const star = violationSet(referenceValidate(gAll, catalog, rules));
          acc.equationChecks++;
          if (setDiff(star, union).length > 0 || setDiff(union, star).length > 0) acc.equationFailures++;
        }
      }
    }
    out[mode] = acc;
  }
  return { experiment: 'E3-scheduler-scope', sizes, seedsPerCell: seeds, catalogs: allCatalogs().map((c) => c.id), byScopeMode: out };
}
