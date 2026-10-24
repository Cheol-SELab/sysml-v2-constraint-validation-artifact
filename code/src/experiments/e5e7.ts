/**
 * Experiments E5-E7 (sections 6.6-6.8).
 *   E5 incremental correctness, the Theorem 5 counterexample families, and speedup
 *   E6 test of the complexity prediction of Theorem 3
 *   E7 external validity through public model calibration
 */

import { allCatalogs, aerospaceCatalog } from '../catalog/domains';
import { deriveRules, setDiff, violationSet } from '../catalog/rules';
import { bootstrapMedianCI, bootstrapSlopeCI, ksTwoSample, median, ols, round } from '../evaluation/stats';
import { cycleFamily, traceFamily } from '../generator/counterexampleFamily';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { IncrementalSession, StrategyId } from '../incremental/session';
import { cloneGraph, normalizeToTypedGraph } from '../model/graph';
import { Catalog, Change, SysMLLikeModel, TypedGraph } from '../model/types';
import { Rng } from '../util/rng';
import { timeMedian } from '../util/timing';
import { validate } from '../validator/engine';
import { randomChangeSet } from '../verification/propertyTests';

/** E5, part 1: strategy 3 must agree with batch validation at every step. */
function incrementalCorrectness(sizes: number[], seeds: number, steps: number): unknown {
  const rows: unknown[] = [];
  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (const n of sizes) {
      let comparisons = 0;
      let mismatches = 0;
      for (let s = 0; s < seeds; s++) {
        const gen = generateCleanModel(catalog, { n, seed: 7000 + s });
        const g = normalizeToTypedGraph(gen.model);
        const session = new IncrementalSession(g, catalog, rules, 3);
        const rng = new Rng(9000 + s);
        for (let step = 0; step < steps; step++) {
          const ratio = rng.pick([0.001, 0.01, 0.05, 0.1]);
          const size = Math.max(1, Math.round(g.nodes.size * ratio));
          const changes = randomChangeSet(g, catalog, rng, size);
          if (changes.length === 0) continue;
          const res = session.step(changes);
          const batch = validate(cloneGraph(g), catalog, rules);
          comparisons++;
          const a = violationSet(res.violations);
          const b = violationSet(batch);
          if (setDiff(a, b).length > 0 || setDiff(b, a).length > 0) mismatches++;
        }
      }
      rows.push({ catalog: catalog.id, n, seeds, steps, comparisons, mismatches });
    }
  }
  return rows;
}

/** E5, part 2: the counterexample families of Theorem 5. */
function counterexampleComparison(ks: number[]): unknown {
  const rows: unknown[] = [];
  for (const k of ks) {
    for (const family of [cycleFamily(k), traceFamily(k)]) {
      const catalog = family.catalog;
      const rules = deriveRules(catalog);
      const change: Change[] =
        family.change.kind === 'addEdge' ? [{ kind: 'addEdge', edge: family.change.edge }] : [{ kind: 'delEdge', id: family.change.id }];

      const row: Record<string, unknown> = {
        family: family.model.id.startsWith('cycle') ? 'cycle' : 'trace',
        k,
        nodes: family.model.nodes.length,
        ruleUnderTest: family.ruleId,
      };
      // clean before the change
      const gClean = normalizeToTypedGraph(family.model);
      row.violationsBeforeChange = validate(gClean, catalog, rules).length;

      for (const strategy of [1, 2, 3] as StrategyId[]) {
        const g = normalizeToTypedGraph(family.model);
        const session = new IncrementalSession(g, catalog, rules, strategy, strategy === 1 ? k : undefined);
        const res = session.step(change);
        const batch = validate(cloneGraph(g), catalog, rules);
        const reported = violationSet(res.violations);
        const truth = violationSet(batch);
        const missed = setDiff(truth, reported).filter((key) => key.startsWith(family.ruleId));
        const spurious = setDiff(reported, truth);
        row[`strategy${strategy}Missed`] = missed.length;
        row[`strategy${strategy}Spurious`] = spurious.length;
        row[`strategy${strategy}Radius`] = strategy === 1 ? k : 2;
      }
      rows.push(row);
    }
  }
  return rows;
}

/** E5, part 3: speedup of strategies 2 and 3 against full batch validation. */
function speedupMeasurement(sizes: number[], ratios: number[], seeds: number): unknown {
  const rows: unknown[] = [];
  const catalog = aerospaceCatalog();
  const rules = deriveRules(catalog);
  for (const n of sizes) {
    for (const ratio of ratios) {
      const speedups3: number[] = [];
      const speedups2: number[] = [];
      const scopeShares: number[] = [];
      const stepsPerRun = 20;
      for (let s = 0; s < seeds; s++) {
        const gen = generateCleanModel(catalog, { n, seed: 11000 + s });

        // batch cost of one full validation on the initial graph
        const gRef = normalizeToTypedGraph(gen.model);
        const tFull = timeMedian(() => {
          validate(gRef, catalog, rules);
        }, 5);

        for (const strategy of [3, 2] as StrategyId[]) {
          const g = normalizeToTypedGraph(gen.model);
          const session = new IncrementalSession(g, catalog, rules, strategy);
          const rng = new Rng(12000 + s);
          const scopes: number[] = [];
          const t0 = process.hrtime.bigint();
          let applied = 0;
          for (let step = 0; step < stepsPerRun; step++) {
            const size = Math.max(1, Math.round(g.nodes.size * ratio));
            const changes = randomChangeSet(g, catalog, rng, size);
            if (changes.length === 0) continue;
            const r = session.step(changes);
            scopes.push(r.scopeSize / Math.max(1, g.nodes.size));
            applied++;
          }
          const t1 = process.hrtime.bigint();
          if (applied === 0) continue;
          const perStepMs = Number(t1 - t0) / 1e6 / applied;
          const speedup = tFull / Math.max(1e-6, perStepMs);
          if (strategy === 3) {
            speedups3.push(speedup);
            scopeShares.push(median(scopes));
          } else speedups2.push(speedup);
        }
      }
      const ci3 = bootstrapMedianCI(speedups3);
      const ci2 = bootstrapMedianCI(speedups2);
      rows.push({
        n,
        changeRatio: ratio,
        seeds: speedups3.length,
        medianScopeShare: round(median(scopeShares)),
        strategy3SpeedupMedian: round(ci3.point, 2),
        strategy3SpeedupCI: [round(ci3.lo, 2), round(ci3.hi, 2)],
        strategy2SpeedupMedian: round(ci2.point, 2),
        strategy2SpeedupCI: [round(ci2.lo, 2), round(ci2.hi, 2)],
      });
    }
  }
  return rows;
}

export function runE5(): unknown {
  return {
    experiment: 'E5',
    correctness: incrementalCorrectness([500, 1000], 3, 50),
    counterexampleFamilies: counterexampleComparison([1, 2, 4, 8]),
    speedup: speedupMeasurement([500, 1000, 5000], [0.001, 0.01, 0.05, 0.1], 10),
  };
}

export function runE6(sizes = [100, 200, 500, 1000, 2000, 5000, 10000], seeds = 10): unknown {
  const catalog = aerospaceCatalog();
  const rules = deriveRules(catalog);
  const localOnly = rules.filter((r) => !r.global);
  const globalOnly = rules.filter((r) => r.global);

  const points: Array<{ n: number; nodes: number; edges: number; all: number; local: number; global: number }> = [];
  for (const n of sizes) {
    for (let s = 0; s < seeds; s++) {
      const gen = generateCleanModel(catalog, { n, seed: 21000 + s });
      const g = normalizeToTypedGraph(gen.model);
      const all = timeMedian(() => {
        validate(g, catalog, rules);
      }, 5);
      const loc = timeMedian(() => {
        validate(g, catalog, localOnly);
      }, 5);
      const glob = timeMedian(() => {
        validate(g, catalog, globalOnly);
      }, 5);
      points.push({ n, nodes: g.nodes.size, edges: g.edges.size, all, local: loc, global: glob });
    }
  }

  const fit = (key: 'all' | 'local' | 'global'): unknown => {
    const xs = points.map((p) => Math.log(p.nodes + p.edges));
    const ys = points.map((p) => Math.log(Math.max(1e-6, p[key])));
    const r = ols(xs, ys);
    const ci = bootstrapSlopeCI(xs, ys);
    return {
      exponent: round(r.slope, 3),
      ci95: [round(ci.lo, 3), round(ci.hi, 3)],
      r2: round(r.r2, 4),
      includesOne: ci.lo <= 1 && ci.hi >= 1,
    };
  };

  const perSize = sizes.map((n) => {
    const rows = points.filter((p) => p.n === n);
    return {
      n,
      medianNodes: median(rows.map((r) => r.nodes)),
      medianEdges: median(rows.map((r) => r.edges)),
      medianTimeAllMs: round(median(rows.map((r) => r.all)), 3),
      medianTimeLocalMs: round(median(rows.map((r) => r.local)), 3),
      medianTimeGlobalMs: round(median(rows.map((r) => r.global)), 3),
    };
  });

  return {
    experiment: 'E6',
    perSize,
    regression: { all: fit('all'), localRules: fit('local'), globalRules: fit('global') },
    protocol: 'x = log(n + m), y = log(median runtime of 5 repetitions after one warm-up); OLS with percentile bootstrap CI',
  };
}

// ---------------------------------------------------------------------------
// E7: public model calibration
// ---------------------------------------------------------------------------

export interface StructureStats {
  nodes: number;
  edges: number;
  degrees: number[];
  containmentDepths: number[];
  distanceToRequirement: number[];
}

export function structureStats(model: SysMLLikeModel): StructureStats {
  const g = normalizeToTypedGraph(model);
  const degrees: number[] = [];
  for (const id of g.nodes.keys()) degrees.push((g.out.get(id)?.length ?? 0) + (g.in.get(id)?.length ?? 0));

  const parent = new Map<string, string>();
  for (const e of g.edges.values()) if (e.type === 'contain') parent.set(e.tgt, e.src);
  const depthOf = (v: string): number => {
    let d = 0;
    let cur = v;
    const guard = new Set<string>();
    while (parent.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      cur = parent.get(cur)!;
      d++;
    }
    return d;
  };
  const containmentDepths = [...g.nodes.keys()].map(depthOf);

  const distanceToRequirement: number[] = [];
  for (const [id, n] of g.nodes) {
    if (n.type !== 'Component') continue;
    // BFS over all edge types, forward direction
    const seen = new Set<string>([id]);
    let frontier = [id];
    let d = 0;
    let found = -1;
    while (frontier.length > 0 && d < 10) {
      d++;
      const next: string[] = [];
      for (const v of frontier) {
        for (const eid of g.out.get(v) ?? []) {
          const e = g.edges.get(eid)!;
          if (seen.has(e.tgt)) continue;
          seen.add(e.tgt);
          if (g.nodes.get(e.tgt)!.type === 'Requirement') {
            found = d;
            break;
          }
          next.push(e.tgt);
        }
        if (found > 0) break;
      }
      if (found > 0) break;
      frontier = next;
    }
    distanceToRequirement.push(found > 0 ? found : 10);
  }

  return { nodes: g.nodes.size, edges: g.edges.size, degrees, containmentDepths, distanceToRequirement };
}

function pooled(stats: StructureStats[]): StructureStats {
  return {
    nodes: stats.reduce((s, x) => s + x.nodes, 0),
    edges: stats.reduce((s, x) => s + x.edges, 0),
    degrees: stats.flatMap((x) => x.degrees),
    containmentDepths: stats.flatMap((x) => x.containmentDepths),
    distanceToRequirement: stats.flatMap((x) => x.distanceToRequirement),
  };
}

function ksSummary(a: StructureStats, b: StructureStats): unknown {
  const d1 = ksTwoSample(a.degrees, b.degrees);
  const d2 = ksTwoSample(a.containmentDepths, b.containmentDepths);
  const d3 = ksTwoSample(a.distanceToRequirement, b.distanceToRequirement);
  return {
    degree: { d: round(d1.d, 3), critical005: round(d1.criticalValue005, 3), reject005: d1.reject005 },
    containmentDepth: { d: round(d2.d, 3), critical005: round(d2.criticalValue005, 3), reject005: d2.reject005 },
    distanceToRequirement: { d: round(d3.d, 3), critical005: round(d3.criticalValue005, 3), reject005: d3.reject005 },
    sumD: round(d1.d + d2.d + d3.d, 3),
  };
}

function sumD(a: StructureStats, b: StructureStats): number {
  return (
    ksTwoSample(a.degrees, b.degrees).d +
    ksTwoSample(a.containmentDepths, b.containmentDepths).d +
    ksTwoSample(a.distanceToRequirement, b.distanceToRequirement).d
  );
}

export function runE7(publicModels: SysMLLikeModel[], catalog: Catalog = aerospaceCatalog()): unknown {
  const rules = deriveRules(catalog);
  const publicStats = publicModels.map(structureStats);
  const target = pooled(publicStats);
  const avgN = Math.round(target.nodes / publicModels.length);

  const synthesize = (opts: { portsPerComponent: number; depth: number; dependDensity: number; redundancy: number }): StructureStats => {
    const stats: StructureStats[] = [];
    for (let s = 0; s < publicModels.length * 5; s++) {
      const gen = generateCleanModel(catalog, {
        n: avgN,
        seed: 31000 + s,
        portsPerComponent: opts.portsPerComponent,
        depth: opts.depth,
        dependDensity: opts.dependDensity,
        redundancy: opts.redundancy,
      });
      stats.push(structureStats(gen.model));
    }
    return pooled(stats);
  };

  const defaults = { portsPerComponent: 0.8, depth: 3, dependDensity: 0.5, redundancy: 0.4 };
  const before = synthesize(defaults);

  let best = defaults;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const portsPerComponent of [0.4, 0.8, 1.2, 2]) {
    for (const depth of [1, 2, 3, 4]) {
      for (const dependDensity of [0, 0.25, 0.5, 0.75]) {
        for (const redundancy of [0, 0.2, 0.4, 0.6]) {
          const cand = { portsPerComponent, depth, dependDensity, redundancy };
          const score = sumD(target, synthesize(cand));
          if (score < bestScore) {
            bestScore = score;
            best = cand;
          }
        }
      }
    }
  }
  const after = synthesize(best);

  const perModel = publicModels.map((m, i) => {
    const g: TypedGraph = normalizeToTypedGraph(m);
    const vs = validate(g, catalog, rules);
    const byRule = new Map<string, number>();
    for (const v of vs) byRule.set(v.ruleId, (byRule.get(v.ruleId) ?? 0) + 1);
    return {
      model: m.id,
      nodes: publicStats[i].nodes,
      edges: publicStats[i].edges,
      violations: vs.length,
      byRule: [...byRule.entries()].sort().map(([ruleId, count]) => ({ ruleId, count })),
      classification:
        'violations originating from catalog policy elements absent in the public model (verification cases, views, functions) are policy-driven, not model defects',
    };
  });

  return {
    experiment: 'E7',
    publicModels: publicModels.map((m, i) => ({ id: m.id, nodes: publicStats[i].nodes, edges: publicStats[i].edges })),
    calibration: {
      defaultParameters: defaults,
      calibratedParameters: best,
      ksBeforeCalibration: ksSummary(target, before),
      ksAfterCalibration: ksSummary(target, after),
      note: 'public sample is small, so the KS test has low power; the statistic is reported as a calibration diagnostic, not as an equivalence claim',
    },
    validationOfPublicModels: perModel,
  };
}
