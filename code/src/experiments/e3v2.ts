/**
 * E3 v2: defect injection study revised for review item M5.
 *
 *   Part A  single-defect, stratified: every operator x position tier x model; the oracle is
 *           the reference semantics of the single-defect model (no non-interference needed).
 *           FP is measured (engine keys outside expected u base), not fixed to 0.
 *   Part B  multi-defect: the same candidate pool evaluated with the non-interference
 *           scheduler and without it (ablation). The ablation shows how an injection oracle
 *           built as the union of isolated expectations distorts precision and recall.
 *   Part C  mixture sensitivity: per-type additional-detection rates over Baseline B, and
 *           the overall rate under the original mixture, the uniform mixture, the extreme
 *           mixtures, and random Dirichlet(1) mixtures.
 *   Part D  generalized injection equation on a non-clean base model.
 */

import { allCatalogs } from '../catalog/domains';
import { deriveRules, setDiff, violationKey, violationSet } from '../catalog/rules';
import { baselineA, baselineB, BaselineFinding } from '../evaluation/baselines';
import { bootstrapMedianCI, quantile, round } from '../evaluation/stats';
import { generateCleanModel, GeneratedModel } from '../generator/syntheticModelGenerator';
import { DEFECT_TARGET_KIND, DEFECT_TYPES, Defect, DefectType, defectScopePrePost } from '../injector/defectInjector';
import { DefectOperator, OPERATORS, OperatorContext, typeIndex } from '../injector/defectOperators';
import { applyChanges, cloneGraph, graphToModel, normalizeToTypedGraph } from '../model/graph';
import { Catalog, Rule, TypedGraph, Violation } from '../model/types';
import { referenceValidate } from '../reference/referenceSemantics';
import { Rng } from '../util/rng';
import { groundingNodes, validate } from '../validator/engine';
import { randomChangeSet } from '../verification/propertyTests';

type Tier = 'periphery' | 'core' | 'hub' | 'new';

/** Original (v1) per-type instance counts of Table 3, used as one mixture in Part C. */
const V1_MIXTURE: Record<DefectType, number> = { D1: 77, D2: 103, D3: 100, D4: 115, D5: 72, D6: 65, D7: 270, D8: 69 };

function degree(g: TypedGraph, v: string): number {
  return (g.out.get(v)?.length ?? 0) + (g.in.get(v)?.length ?? 0);
}

function tierFn(g: TypedGraph): { tierOf: (v: string) => Tier; p50: number; p90: number } {
  const ds = [...g.nodes.keys()].map((v) => degree(g, v));
  const p50 = quantile(ds, 0.5);
  const p90 = quantile(ds, 0.9);
  return {
    p50,
    p90,
    tierOf: (v: string): Tier => {
      if (!g.nodes.has(v)) return 'new';
      const d = degree(g, v);
      if (d >= p90 && d > p50) return 'hub';
      if (d > p50) return 'core';
      return 'periphery';
    },
  };
}

function baselineKeys(f: BaselineFinding[]): Set<string> {
  return new Set(f.map((x) => `${x.check}|${x.witness.join(',')}`));
}

/** a baseline detects d if a finding absent from the base model mentions a support element */
function baselineDetectsNew(base: Set<string>, findings: BaselineFinding[], support: string[]): boolean {
  const s = new Set(support);
  for (const f of findings) {
    if (base.has(`${f.check}|${f.witness.join(',')}`)) continue;
    for (const w of f.witness) if (s.has(w)) return true;
  }
  return false;
}

interface Evaluated {
  defect: Defect;
  expected: Set<string>;
  /** base violations that the defect removes (must be empty for a clean base) */
  resolved: string[];
  kinds: string[];
}

function evaluateIsolated(g: TypedGraph, c: Catalog, rules: Rule[], baseKeys: Set<string>, d: Defect): Evaluated & { gd: TypedGraph } {
  const gd = cloneGraph(g);
  applyChanges(gd, d.changes);
  const star = referenceValidate(gd, c, rules);
  const starKeys = violationSet(star);
  const expected = new Set<string>();
  const kinds = new Set<string>();
  for (const v of star) {
    const k = violationKey(v);
    if (!baseKeys.has(k)) {
      expected.add(k);
      kinds.add(v.kind);
    }
  }
  return { defect: d, expected, resolved: setDiff(baseKeys, starKeys), kinds: [...kinds].sort(), gd };
}

let seq = 0;
function nextId(): string {
  return `v${seq++}`;
}

// ---------------------------------------------------------------------------
// Part A
// ---------------------------------------------------------------------------

interface ARecord {
  catalog: string;
  n: number;
  seed: number;
  operator: string;
  type: DefectType;
  tier: Tier;
  positionDegree: number;
  expected: number;
  tp: number;
  fp: number;
  fn: number;
  sideEffectKinds: string[];
  targetKindFired: boolean;
  baselineA: boolean;
  baselineB: boolean;
}

function partA(sizes: number[], seeds: number): { records: ARecord[]; unavailable: number; ineffective: number; unbuildable: number; tierThresholds: unknown[] } {
  const records: ARecord[] = [];
  let unavailable = 0;
  let ineffective = 0;
  let unbuildable = 0;
  const tierThresholds: unknown[] = [];
  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (const n of sizes) {
      for (let s = 0; s < seeds; s++) {
        const seed = 51000 + s;
        const gen = generateCleanModel(catalog, { n, seed });
        const g = normalizeToTypedGraph(gen.model);
        const baseStar = referenceValidate(g, catalog, rules);
        const baseKeys = violationSet(baseStar);
        const baseModel = graphToModel(g);
        const bA = baselineKeys(baselineA(baseModel));
        const bB = baselineKeys(baselineB(baseModel));
        const rng = new Rng(seed * 7 + n);
        const ctx: OperatorContext = { g, c: catalog, gen, rng, byType: typeIndex(g) };
        const tiers = tierFn(g);
        if (s === 0) tierThresholds.push({ catalog: catalog.id, n, degreeP50: tiers.p50, degreeP90: tiers.p90 });
        for (const op of OPERATORS) {
          const positions = op.positions(ctx);
          const byTier = new Map<Tier, string[]>();
          for (const p of positions) {
            const t = p === '(new)' ? 'new' : tiers.tierOf(p);
            const l = byTier.get(t) ?? [];
            l.push(p);
            byTier.set(t, l);
          }
          const wanted: Tier[] = positions.length === 1 && positions[0] === '(new)' ? ['new'] : ['periphery', 'core', 'hub'];
          for (const tier of wanted) {
            const pool = rng.shuffle(byTier.get(tier) ?? []);
            if (pool.length === 0) {
              unavailable++;
              continue;
            }
            let done = false;
            for (let a = 0; a < Math.min(10, pool.length) && !done; a++) {
              const d = op.build(ctx, pool[a], nextId());
              if (!d) {
                unbuildable++;
                continue;
              }
              const ev = evaluateIsolated(g, catalog, rules, baseKeys, d);
              if (ev.expected.size === 0) {
                ineffective++;
                continue;
              }
              const reported = violationSet(validate(ev.gd, catalog, rules));
              let tp = 0;
              let fn = 0;
              for (const k of ev.expected) if (reported.has(k)) tp++;
              else fn++;
              let fp = 0;
              for (const k of reported) if (!ev.expected.has(k) && !baseKeys.has(k)) fp++;
              const mf = graphToModel(ev.gd);
              records.push({
                catalog: catalog.id,
                n,
                seed,
                operator: op.name,
                type: op.type,
                tier,
                positionDegree: tier === 'new' ? 0 : degree(g, pool[a]),
                expected: ev.expected.size,
                tp,
                fp,
                fn,
                sideEffectKinds: ev.kinds.filter((k) => k !== DEFECT_TARGET_KIND[op.type]),
                targetKindFired: ev.kinds.includes(DEFECT_TARGET_KIND[op.type]),
                baselineA: baselineDetectsNew(bA, baselineA(mf), d.support),
                baselineB: baselineDetectsNew(bB, baselineB(mf), d.support),
              });
              done = true;
            }
          }
        }
      }
    }
  }
  return { records, unavailable, ineffective, unbuildable, tierThresholds };
}

function summarizeGroup(rs: ARecord[]): Record<string, unknown> {
  const tp = rs.reduce((x, r) => x + r.tp, 0);
  const fp = rs.reduce((x, r) => x + r.fp, 0);
  const fn = rs.reduce((x, r) => x + r.fn, 0);
  const add = rs.filter((r) => r.fn === 0 && !r.baselineB).length;
  return {
    instances: rs.length,
    expectedViolations: rs.reduce((x, r) => x + r.expected, 0),
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? null : round(tp / (tp + fp)),
    recall: tp + fn === 0 ? null : round(tp / (tp + fn)),
    detectedBaselineA: rs.filter((r) => r.baselineA).length,
    detectedBaselineB: rs.filter((r) => r.baselineB).length,
    additionalOverBaselineB: add,
    additionalRate: rs.length === 0 ? null : round(add / rs.length),
    withSideEffects: rs.filter((r) => r.sideEffectKinds.length > 0).length,
    targetKindFired: rs.filter((r) => r.targetKindFired).length,
  };
}

// ---------------------------------------------------------------------------
// Part B
// ---------------------------------------------------------------------------

function buildPool(
  ctx: OperatorContext,
  g: TypedGraph,
  c: Catalog,
  rules: Rule[],
  baseKeys: Set<string>,
  size: number,
  rng: Rng,
): Evaluated[] {
  const pool: Evaluated[] = [];
  const types = rng.shuffle(DEFECT_TYPES);
  for (let i = 0; i < size; i++) {
    const t = types[i % types.length];
    const ops = OPERATORS.filter((o) => o.type === t);
    for (let attempt = 0; attempt < 12; attempt++) {
      const op: DefectOperator = rng.pick(ops);
      const ps = op.positions(ctx);
      if (ps.length === 0) continue;
      const d = op.build(ctx, rng.pick(ps), nextId());
      if (!d) continue;
      const ev = evaluateIsolated(g, c, rules, baseKeys, d);
      if (ev.expected.size === 0) continue;
      pool.push({ defect: ev.defect, expected: ev.expected, resolved: ev.resolved, kinds: ev.kinds });
      break;
    }
  }
  return pool;
}

interface InjectionOutcome {
  defects: number;
  equationHolds: boolean;
  oracleSize: number;
  truthSize: number;
  engineEqualsTruth: boolean;
  tp: number;
  fp: number;
  fn: number;
  maskedDefects: number;
  interactionKeys: number;
  sharedKeys: number;
  perType: Record<string, { instances: number; detectedPerOracle: number }>;
}

function injectAndScore(g: TypedGraph, c: Catalog, rules: Rule[], baseKeys: Set<string>, set: Evaluated[]): InjectionOutcome {
  const gAll = cloneGraph(g);
  for (const e of set) applyChanges(gAll, e.defect.changes);
  const truth = violationSet(referenceValidate(gAll, c, rules));
  const reported = violationSet(validate(gAll, c, rules));
  const oracle = new Set<string>(baseKeys);
  const count = new Map<string, number>();
  for (const e of set) for (const k of e.expected) {
    oracle.add(k);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const k of reported) if (oracle.has(k)) tp++;
  else fp++;
  for (const k of oracle) if (!reported.has(k)) fn++;
  const perType: Record<string, { instances: number; detectedPerOracle: number }> = {};
  let masked = 0;
  for (const e of set) {
    const t = e.defect.type;
    perType[t] = perType[t] ?? { instances: 0, detectedPerOracle: 0 };
    perType[t].instances++;
    let all = true;
    let anyMissingInTruth = false;
    for (const k of e.expected) {
      if (!reported.has(k)) all = false;
      if (!truth.has(k)) anyMissingInTruth = true;
    }
    if (all) perType[t].detectedPerOracle++;
    if (anyMissingInTruth) masked++;
  }
  const engineEqualsTruth = setDiff(truth, reported).length === 0 && setDiff(reported, truth).length === 0;
  return {
    defects: set.length,
    equationHolds: setDiff(truth, oracle).length === 0 && setDiff(oracle, truth).length === 0,
    oracleSize: oracle.size,
    truthSize: truth.size,
    engineEqualsTruth,
    tp,
    fp,
    fn,
    maskedDefects: masked,
    interactionKeys: setDiff(truth, oracle).length,
    sharedKeys: [...count.values()].filter((x) => x > 1).length,
    perType,
  };
}

function schedule(g: TypedGraph, rules: Rule[], pool: Evaluated[], claimsInit: Set<string>): { accepted: Evaluated[]; rejectedOverlap: number; rejectedResolving: number } {
  const claimed = new Set<string>(claimsInit);
  const accepted: Evaluated[] = [];
  let rejectedOverlap = 0;
  let rejectedResolving = 0;
  for (const e of pool) {
    if (e.resolved.length > 0) {
      rejectedResolving++;
      continue;
    }
    const scope = defectScopePrePost(g, rules, e.defect);
    let overlap = false;
    for (const v of scope) if (claimed.has(v)) {
      overlap = true;
      break;
    }
    if (overlap) {
      rejectedOverlap++;
      continue;
    }
    for (const v of scope) claimed.add(v);
    accepted.push(e);
  }
  return { accepted, rejectedOverlap, rejectedResolving };
}

function partB(sizes: number[], seeds: number, densities: number[]): unknown {
  const rows: unknown[] = [];
  const agg = new Map<string, { runs: number; eqFail: number; engineMismatch: number; tp: number; fp: number; fn: number; masked: number; defects: number; interaction: number; shared: number; accepted: number; pool: number; rejected: number; perType: Record<string, { instances: number; detectedPerOracle: number }> }>();
  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (const n of sizes) {
      for (let s = 0; s < seeds; s++) {
        const seed = 61000 + s;
        const gen: GeneratedModel = generateCleanModel(catalog, { n, seed });
        const g = normalizeToTypedGraph(gen.model);
        const baseKeys = violationSet(referenceValidate(g, catalog, rules));
        for (const density of densities) {
          const rng = new Rng(seed * 31 + n + density);
          const ctx: OperatorContext = { g, c: catalog, gen, rng, byType: typeIndex(g) };
          const pool = buildPool(ctx, g, catalog, rules, baseKeys, density, rng);
          const sched = schedule(g, rules, pool, new Set());
          for (const [mode, set] of [
            ['scheduled', sched.accepted],
            ['ablation', pool],
          ] as Array<[string, Evaluated[]]>) {
            const o = injectAndScore(g, catalog, rules, baseKeys, set);
            const key = `${mode}|${n}|${density}`;
            const a = agg.get(key) ?? { runs: 0, eqFail: 0, engineMismatch: 0, tp: 0, fp: 0, fn: 0, masked: 0, defects: 0, interaction: 0, shared: 0, accepted: 0, pool: 0, rejected: 0, perType: {} };
            a.runs++;
            if (!o.equationHolds) a.eqFail++;
            if (!o.engineEqualsTruth) a.engineMismatch++;
            a.tp += o.tp;
            a.fp += o.fp;
            a.fn += o.fn;
            a.masked += o.maskedDefects;
            a.defects += o.defects;
            a.interaction += o.interactionKeys;
            a.shared += o.sharedKeys;
            a.accepted += set.length;
            a.pool += pool.length;
            a.rejected += mode === 'scheduled' ? sched.rejectedOverlap : 0;
            for (const [t, v] of Object.entries(o.perType)) {
              a.perType[t] = a.perType[t] ?? { instances: 0, detectedPerOracle: 0 };
              a.perType[t].instances += v.instances;
              a.perType[t].detectedPerOracle += v.detectedPerOracle;
            }
            agg.set(key, a);
          }
        }
      }
    }
  }
  for (const [key, a] of agg) {
    const [mode, n, density] = key.split('|');
    rows.push({
      mode,
      n: Number(n),
      requestedDefectsPerRun: Number(density),
      runs: a.runs,
      injectedDefects: a.defects,
      candidatePool: a.pool,
      rejectedByScheduler: a.rejected,
      equationFailures: a.eqFail,
      equationFailureRate: round(a.eqFail / a.runs),
      engineVsReferenceMismatches: a.engineMismatch,
      oracleTP: a.tp,
      oracleFP: a.fp,
      oracleFN: a.fn,
      oraclePrecision: round(a.tp / Math.max(1, a.tp + a.fp)),
      oracleRecall: round(a.tp / Math.max(1, a.tp + a.fn)),
      maskedDefects: a.masked,
      maskedDefectRate: round(a.masked / Math.max(1, a.defects)),
      interactionBornViolations: a.interaction,
      sharedExpectedKeys: a.shared,
      perTypeDetectionPerOracle: Object.fromEntries(
        DEFECT_TYPES.map((t) => [t, a.perType[t] ? round(a.perType[t].detectedPerOracle / Math.max(1, a.perType[t].instances)) : null]),
      ),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Part C
// ---------------------------------------------------------------------------

function partC(records: ARecord[]): unknown {
  const perType: Record<string, { rate: number; ci: [number, number]; instances: number }> = {};
  for (const t of DEFECT_TYPES) {
    const rs = records.filter((r) => r.type === t);
    // bootstrap over models (catalog, n, seed): per-model additional-detection rate
    const byModel = new Map<string, ARecord[]>();
    for (const r of rs) {
      const k = `${r.catalog}|${r.n}|${r.seed}`;
      const l = byModel.get(k) ?? [];
      l.push(r);
      byModel.set(k, l);
    }
    const perModel = [...byModel.values()].map((l) => l.filter((r) => r.fn === 0 && !r.baselineB).length / l.length);
    const ci = bootstrapMedianCI(perModel);
    const add = rs.filter((r) => r.fn === 0 && !r.baselineB).length;
    perType[t] = { rate: round(add / Math.max(1, rs.length)), ci: [round(ci.lo), round(ci.hi)], instances: rs.length };
  }
  const mix = (w: Record<string, number>): number => {
    const tot = Object.values(w).reduce((a, b) => a + b, 0);
    let s = 0;
    for (const t of DEFECT_TYPES) s += (w[t] / tot) * perType[t].rate;
    return round(s);
  };
  const uniform = Object.fromEntries(DEFECT_TYPES.map((t) => [t, 1]));
  const rates = DEFECT_TYPES.map((t) => perType[t].rate);
  const rng = new Rng(20261020);
  const draws: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const w: Record<string, number> = {};
    for (const t of DEFECT_TYPES) w[t] = -Math.log(Math.max(1e-12, rng.next()));
    draws.push(mix(w));
  }
  // overall rate as a function of the share of D7 (the only type Baseline B detects)
  const d7Sweep = [0, 0.1, 0.2, 0.31, 0.5, 0.75, 1].map((share) => {
    const w: Record<string, number> = {};
    for (const t of DEFECT_TYPES) w[t] = t === 'D7' ? share : (1 - share) / 7;
    return { d7Share: share, overallRate: mix(w) };
  });
  return {
    perTypeAdditionalRate: perType,
    overallUnderV1Mixture: mix(V1_MIXTURE),
    overallUnderUniformMixture: mix(uniform),
    overallRange: [round(Math.min(...rates)), round(Math.max(...rates))],
    dirichlet1Mixtures: { draws: draws.length, p05: round(quantile(draws, 0.05)), median: round(quantile(draws, 0.5)), p95: round(quantile(draws, 0.95)) },
    d7ShareSweep: d7Sweep,
    note: 'the overall rate is a convex combination of per-type rates; any value in overallRange is attainable by choosing the mixture',
  };
}

// ---------------------------------------------------------------------------
// Part D
// ---------------------------------------------------------------------------

function partD(n: number, seeds: number, density: number): unknown {
  let checks = 0;
  let failures = 0;
  let accepted = 0;
  let pooled = 0;
  let rejectedResolving = 0;
  let rejectedOverlap = 0;
  let baseViolations = 0;
  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (let s = 0; s < seeds; s++) {
      const seed = 71000 + s;
      const gen = generateCleanModel(catalog, { n, seed });
      const g = normalizeToTypedGraph(gen.model);
      const pre = new Rng(seed);
      for (let i = 0; i < 2; i++) applyChanges(g, randomChangeSet(g, catalog, pre, Math.max(1, Math.round(g.nodes.size * 0.02))));
      const base: Violation[] = referenceValidate(g, catalog, rules);
      const baseKeys = violationSet(base);
      baseViolations += baseKeys.size;
      const claims = new Set<string>();
      for (const v of base) for (const x of groundingNodes(g, v)) claims.add(x);
      const rng = new Rng(seed * 17);
      const ctx: OperatorContext = { g, c: catalog, gen, rng, byType: typeIndex(g) };
      const pool = buildPool(ctx, g, catalog, rules, baseKeys, density, rng);
      pooled += pool.length;
      const sched = schedule(g, rules, pool, claims);
      accepted += sched.accepted.length;
      rejectedResolving += sched.rejectedResolving;
      rejectedOverlap += sched.rejectedOverlap;
      const o = injectAndScore(g, catalog, rules, baseKeys, sched.accepted);
      checks++;
      if (!o.equationHolds) failures++;
    }
  }
  return {
    description: 'base = clean model + 2 random change sets (2% of nodes each); generalized equation Omega*(M_faulty) = Omega*(M_base) disjoint-union U_i (Omega*(M_di) minus Omega*(M_base))',
    n,
    runs: checks,
    meanBaseViolations: round(baseViolations / Math.max(1, checks), 1),
    candidatePool: pooled,
    acceptedDefects: accepted,
    rejectedOverlap,
    rejectedResolving,
    equationChecks: checks,
    equationFailures: failures,
  };
}

export function runE3v2(quick = false): unknown {
  const sizes = quick ? [100] : [100, 500, 1000];
  const seeds = quick ? 2 : 10;
  const t0 = Date.now();
  const a = partA(sizes, seeds);
  const tA = Date.now() - t0;
  const byType = Object.fromEntries(DEFECT_TYPES.map((t) => [t, summarizeGroup(a.records.filter((r) => r.type === t))]));
  const byOperator = Object.fromEntries(OPERATORS.map((o) => [o.name, { type: o.type, description: o.description, ...summarizeGroup(a.records.filter((r) => r.operator === o.name)) }]));
  const byTier = Object.fromEntries((['periphery', 'core', 'hub', 'new'] as Tier[]).map((t) => [t, summarizeGroup(a.records.filter((r) => r.tier === t))]));
  const byTypeTier = Object.fromEntries(
    DEFECT_TYPES.map((t) => [
      t,
      Object.fromEntries((['periphery', 'core', 'hub', 'new'] as Tier[]).map((tier) => {
        const rs = a.records.filter((r) => r.type === t && r.tier === tier);
        return [tier, rs.length === 0 ? null : { instances: rs.length, recall: summarizeGroup(rs).recall, additionalRate: summarizeGroup(rs).additionalRate }];
      })),
    ]),
  );
  const t1 = Date.now();
  const b = partB(quick ? [200] : [100, 200, 500], quick ? 2 : 10, quick ? [8] : [8, 16, 32, 64]);
  const tB = Date.now() - t1;
  const t2 = Date.now();
  const d = partD(quick ? 200 : 500, quick ? 2 : 10, 8);
  const tD = Date.now() - t2;
  return {
    experiment: 'E3-v2',
    operators: OPERATORS.map((o) => ({ name: o.name, type: o.type, description: o.description })),
    partA: {
      design: 'single defect per model; every operator x degree tier (periphery <= p50 < core < p90 <= hub; new-node operators form tier "new"); oracle = reference semantics of the single-defect model minus base; FP = engine keys outside expected and base',
      sizes,
      seedsPerCell: seeds,
      catalogs: allCatalogs().map((c) => c.id),
      tierThresholds: a.tierThresholds,
      instances: a.records.length,
      positionsUnavailable: a.unavailable,
      candidatesUnbuildable: a.unbuildable,
      candidatesIneffective: a.ineffective,
      total: summarizeGroup(a.records),
      byType,
      byOperator,
      byTier,
      byTypeTier,
      elapsedMs: tA,
    },
    partB: { design: 'one candidate pool per run, evaluated with the non-interference scheduler (scheduled) and without it (ablation); oracle = base u union of isolated expectations', rows: b, elapsedMs: tB },
    partC: partC(a.records),
    partD: { ...(d as object), elapsedMs: tD },
    rawRecordsPartA: a.records,
  };
}
