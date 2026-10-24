/**
 * E6 v2: test of the linear-time prediction (Theorem 3), revised for review item M7.
 *
 *   - sizes up to 10^6 nodes (about 2.5 x 10^6 elements n + m) with the bounded-degree
 *     generator;
 *   - an adversarial hub generator (one component owning half of the ports and being the
 *     subject of half of the views);
 *   - next to wall-clock time, a deterministic operation count (Holds evaluations +
 *     adjacency entries scanned inside Holds + nodes processed by BatchGlobal), so that a
 *     deviation of the time exponent from 1 can be attributed either to the algorithm (the
 *     operation exponent deviates as well) or to the runtime (only the time exponent does);
 *   - per-rule-kind breakdown.
 * x = log(n + m); y = log(median time of `reps` runs after one warm-up) or log(ops).
 * When Node runs with --expose-gc, a full GC precedes every timing block.
 */

import { aerospaceCatalog } from '../catalog/domains';
import { deriveRules } from '../catalog/rules';
import { bootstrapSlopeCI, median, ols, round } from '../evaluation/stats';
import { generateHubModel } from '../generator/hubGenerator';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { normalizeToTypedGraph } from '../model/graph';
import { Catalog, Rule, TypedGraph } from '../model/types';
import { timeMedian } from '../util/timing';
import { engineConfig, opCounter, validate } from '../validator/engine';

const KINDS: Rule['kind'][] = ['relationType', 'requiredAttr', 'attrDomain', 'multiplicity', 'isolated', 'viewConsistency', 'acyclic', 'tracePolicy'];

function gc(): void {
  const f = (global as unknown as { gc?: () => void }).gc;
  if (f) f();
}

function opsOf(g: TypedGraph, c: Catalog, rules: Rule[]): number {
  const a = opCounter.groundings + opCounter.scans + opCounter.globalWork;
  validate(g, c, rules);
  return opCounter.groundings + opCounter.scans + opCounter.globalWork - a;
}

interface Point {
  n: number;
  seed: number;
  nodes: number;
  edges: number;
  time: Record<string, number>;
  ops: Record<string, number>;
  violations: number;
}

function measure(g: TypedGraph, c: Catalog, rules: Rule[], reps: number, kindReps: number): Pick<Point, 'time' | 'ops'> {
  const sets: Record<string, Rule[]> = { all: rules, local: rules.filter((r) => !r.global), global: rules.filter((r) => r.global) };
  for (const k of KINDS) {
    const rs = rules.filter((r) => r.kind === k);
    if (rs.length > 0) sets[k] = rs;
  }
  const time: Record<string, number> = {};
  const ops: Record<string, number> = {};
  for (const [name, rs] of Object.entries(sets)) {
    gc();
    time[name] = timeMedian(() => {
      validate(g, c, rs);
    }, name === 'all' || name === 'local' || name === 'global' ? reps : kindReps);
    ops[name] = opsOf(g, c, rs);
  }
  return { time, ops };
}

function fit(points: Point[], key: string, metric: 'time' | 'ops', minElements = 0): unknown {
  const ps = points.filter((p) => p.nodes + p.edges >= minElements && p[metric][key] !== undefined);
  if (ps.length < 3) return null;
  const xs = ps.map((p) => Math.log(p.nodes + p.edges));
  const ys = ps.map((p) => Math.log(Math.max(1e-6, p[metric][key])));
  const r = ols(xs, ys);
  const ci = bootstrapSlopeCI(xs, ys);
  return { exponent: round(r.slope, 3), ci95: [round(ci.lo, 3), round(ci.hi, 3)], r2: round(r.r2, 4), includesOne: ci.lo <= 1 && ci.hi >= 1, points: ps.length };
}

function summarize(points: Point[], sizes: number[]): unknown[] {
  return sizes.map((n) => {
    const rows = points.filter((p) => p.n === n);
    const keys = Object.keys(rows[0]?.time ?? {});
    return {
      n,
      seeds: rows.length,
      medianNodes: median(rows.map((r) => r.nodes)),
      medianEdges: median(rows.map((r) => r.edges)),
      medianTimeMs: Object.fromEntries(keys.map((k) => [k, round(median(rows.map((r) => r.time[k])), 3)])),
      medianOps: Object.fromEntries(keys.map((k) => [k, median(rows.map((r) => r.ops[k]))])),
      medianOpsPerElement: Object.fromEntries(keys.map((k) => [k, round(median(rows.map((r) => r.ops[k] / (r.nodes + r.edges))), 4)])),
      medianNsPerOp: Object.fromEntries(keys.map((k) => [k, round(median(rows.map((r) => (r.time[k] * 1e6) / Math.max(1, r.ops[k]))), 2)])),
      violations: rows.reduce((s, r) => s + r.violations, 0),
    };
  });
}

function fits(points: Point[], minElements: number): unknown {
  const keys = Object.keys(points[0]?.time ?? {});
  return Object.fromEntries(keys.map((k) => [k, { time: fit(points, k, 'time', minElements), ops: fit(points, k, 'ops', minElements) }]));
}

function run(label: string, sizes: number[], seedsFor: (n: number) => number, repsFor: (n: number) => number, make: (n: number, seed: number) => TypedGraph): { points: Point[] } {
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  const points: Point[] = [];
  for (const n of sizes) {
    for (let s = 0; s < seedsFor(n); s++) {
      const g = make(n, 21000 + s);
      const violations = validate(g, c, rules).length;
      const reps = repsFor(n);
      const m = measure(g, c, rules, reps, Math.max(3, reps - 2));
      points.push({ n, seed: 21000 + s, nodes: g.nodes.size, edges: g.edges.size, violations, ...m });
      console.log(`E6 ${label} n=${n} seed=${s} all=${m.time.all.toFixed(2)}ms ops=${m.ops.all}`);
    }
  }
  return { points };
}

export function runE6v2(quick = false): unknown {
  const c = aerospaceCatalog();
  const t0 = Date.now();
  const sizes = quick ? [1000, 3000, 10000] : [1000, 3000, 10000, 30000, 100000, 300000, 1000000];
  const base = run(
    'bounded',
    sizes,
    (n) => (quick ? 2 : n <= 10000 ? 10 : n <= 100000 ? 5 : 3),
    (n) => (n >= 300000 ? 3 : 5),
    (n, seed) => normalizeToTypedGraph(generateCleanModel(c, { n, seed }).model),
  );
  const t1 = Date.now();
  const hubSizes = quick ? [500, 1000, 2000] : [500, 1000, 2000, 5000, 10000];
  const hubOpts = { portShare: 0.5, viewShare: 0.5, dependShare: 0.5 };
  const hub = run(
    'hub',
    hubSizes,
    () => (quick ? 1 : 3),
    () => 3,
    (n, seed) => normalizeToTypedGraph(generateHubModel(c, { n, seed }, hubOpts).model),
  );
  const t2 = Date.now();
  const hubFixedSizes = quick ? [1000, 3000, 10000] : [1000, 3000, 10000, 30000, 100000];
  const hubFixedOpts = { portShare: 0.5, viewShare: 0, hubViews: 4, dependShare: 0.5 };
  const hubFixed = run(
    'hub-fixed-views',
    hubFixedSizes,
    () => (quick ? 1 : 3),
    () => 3,
    (n, seed) => normalizeToTypedGraph(generateHubModel(c, { n, seed }, hubFixedOpts).model),
  );
  const t3 = Date.now();
  return {
    experiment: 'E6-v2',
    catalog: 'aerospace',
    gcBeforeTiming: typeof (global as unknown as { gc?: unknown }).gc === 'function',
    opsDefinition: 'Holds evaluations + adjacency entries scanned inside Holds + nodes processed by BatchGlobal',
    bounded: {
      generator: 'generateCleanModel (bounded degree)',
      perSize: summarize(base.points, sizes),
      regressionAll: fits(base.points, 0),
      regressionFrom1e4Elements: fits(base.points, 1e4),
      points: base.points,
      elapsedMs: t1 - t0,
    },
    hub: {
      generator: `generateHubModel ${JSON.stringify(hubOpts)}`,
      perSize: summarize(hub.points, hubSizes),
      regressionAll: fits(hub.points, 0),
      points: hub.points,
      elapsedMs: t2 - t1,
    },
    hubFixedViews: {
      generator: `generateHubModel ${JSON.stringify(hubFixedOpts)} (m stays linear in n; the hub views' exposure lists and the hub degree grow with n)`,
      perSize: summarize(hubFixed.points, hubFixedSizes),
      regressionAll: fits(hubFixed.points, 0),
      points: hubFixed.points,
      elapsedMs: t3 - t2,
    },
  };
}

/**
 * E6 v2 supplement: the two evaluation orders of the view rule on the hub-fixed-views
 * generator (4 hub views; m linear in n). The subject-side order is the earlier nested loop.
 */
export function runE6Order(quick = false): unknown {
  const c = aerospaceCatalog();
  const sizes = quick ? [1000, 3000] : [1000, 3000, 10000, 30000];
  const hubFixedOpts = { portShare: 0.5, viewShare: 0, hubViews: 4, dependShare: 0.5 };
  const out: Record<string, unknown> = {};
  for (const order of ['subject', 'target'] as const) {
    engineConfig.viewOrder = order;
    const r = run(`order-${order}`, sizes, () => 3, () => 3, (n, seed) => normalizeToTypedGraph(generateHubModel(c, { n, seed }, hubFixedOpts).model));
    out[order] = { perSize: summarize(r.points, sizes), regressionAll: fits(r.points, 0), points: r.points };
  }
  engineConfig.viewOrder = 'target';
  return { experiment: 'E6-v2-view-order', generator: `generateHubModel ${JSON.stringify(hubFixedOpts)}`, gcBeforeTiming: typeof (global as unknown as { gc?: unknown }).gc === 'function', byOrder: out };
}
