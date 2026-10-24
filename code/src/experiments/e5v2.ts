/**
 * E5 v2: incremental evaluation revised for review item M7.
 *
 * Timing protocol (symmetric): for every (model, change ratio, edit scenario) one change
 * sequence of `steps` change sets is generated in advance. Every path - batch (apply the
 * change set, then full validation), S1 naive k-hop, S2 hybrid, S3 witness maintenance,
 * S3 with the validity threshold - replays the identical sequence on a fresh copy of the
 * model: one untimed warm-up replay, then `reps` timed replays; the per-step time is the
 * replay time divided by the number of steps, and the median over the replays is kept.
 * Copying the model and constructing the session are excluded on every path; applying the
 * change set is included on every path.
 *
 * Deterministic cost: Holds evaluations of local rules and global work units (nodes and
 * edges scanned by BatchGlobal, nodes touched by witness maintenance) per step.
 *
 * Correctness: one further untimed replay compares every strategy with batch validation at
 * every step and counts missed and spurious violations (S1 is expected to be unsound).
 *
 * Edit scenarios: "random" (change targets drawn from the whole model) and "clustered"
 * (all targets drawn from the BFS ball around one random centre, as in a local edit).
 */

import { aerospaceCatalog } from '../catalog/domains';
import { deriveRules, setDiff, violationSet } from '../catalog/rules';
import { bootstrapMedianCI, median, round } from '../evaluation/stats';
import { cycleFamily, traceFamily } from '../generator/counterexampleFamily';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { IncrementalSession, StrategyId } from '../incremental/session';
import { applyChanges, cloneGraph, normalizeToTypedGraph } from '../model/graph';
import { AttrValue, Catalog, Change, ModelNode, Rule, SysMLLikeModel, TypedGraph } from '../model/types';
import { Rng } from '../util/rng';
import { opCounter, validate } from '../validator/engine';
import { randomChangeSet } from '../verification/propertyTests';

type PathId = 'batch' | 'S1' | 'S2' | 'S3' | 'S3t';
const PATHS: PathId[] = ['batch', 'S1', 'S2', 'S3', 'S3t'];
/** validity threshold of S3t: fall back to BatchGlobal when |Delta| > 0.02 (n + m) */
const THRESHOLD = 0.02;

function randomAttr(c: Catalog, type: string, attr: string, rng: Rng): AttrValue | undefined {
  const d = c.domain[`${type}.${attr}`];
  const roll = rng.int(3);
  if (roll === 0) return undefined;
  if (!d) return `v${rng.int(1000)}`;
  if (d.kind === 'enum') return roll === 1 ? rng.pick(d.values) : 'OUT_OF_DOMAIN';
  if (d.kind === 'range') return roll === 1 ? d.min + (d.max - d.min) * rng.next() : d.max + 1;
  return roll === 1 ? `s${rng.int(100)}` : '';
}

/** BFS ball of at least `want` nodes around a random centre (undirected). */
function ball(g: TypedGraph, rng: Rng, want: number): string[] {
  const ids = [...g.nodes.keys()];
  const centre = ids[rng.int(ids.length)];
  const seen = new Set<string>([centre]);
  let frontier = [centre];
  while (seen.size < want && frontier.length > 0) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const list of [g.out.get(v), g.in.get(v)]) {
        for (const eid of list ?? []) {
          const e = g.edges.get(eid)!;
          const w = e.src === v ? e.tgt : e.src;
          if (!seen.has(w)) {
            seen.add(w);
            next.push(w);
          }
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * Clustered change set: the same operation mix as randomChangeSet, but every touched
 * element lies in one BFS ball of about 4 x size nodes.
 */
export function clusteredChangeSet(g: TypedGraph, c: Catalog, rng: Rng, size: number): Change[] {
  const region = ball(g, rng, Math.max(8, 4 * size));
  const regionSet = new Set(region);
  const byType = new Map<string, string[]>();
  for (const v of region) {
    const t = g.nodes.get(v)!.type;
    const l = byType.get(t) ?? [];
    l.push(v);
    byType.set(t, l);
  }
  const regionEdges: string[] = [];
  for (const v of region) for (const eid of g.out.get(v) ?? []) if (regionSet.has(g.edges.get(eid)!.tgt)) regionEdges.push(eid);
  const changes: Change[] = [];
  for (let i = 0; i < size; i++) {
    const roll = rng.int(5);
    if (roll === 0 && regionEdges.length > 0) {
      changes.push({ kind: 'delEdge', id: rng.pick(regionEdges) });
    } else if (roll === 1) {
      const et = rng.pick(c.edgeTypes);
      const spec = c.allowed[et];
      const ss = spec ? byType.get(rng.pick(spec.src)) : undefined;
      const ts = spec ? byType.get(rng.pick(spec.tgt)) : undefined;
      if (ss && ts && ss.length > 0 && ts.length > 0) changes.push({ kind: 'addEdge', edge: { id: `cl_${rng.int(1e9)}`, type: et, src: rng.pick(ss), tgt: rng.pick(ts) } });
    } else if (roll === 2) {
      const id = rng.pick(region);
      const n = g.nodes.get(id)!;
      const attrs = c.requiredAttr[n.type] ?? [];
      if (attrs.length > 0) {
        const attr = rng.pick(attrs);
        changes.push({ kind: 'setAttr', id, attr, value: randomAttr(c, n.type, attr, rng) });
      }
    } else if (roll === 3) {
      const type = rng.pick(c.nodeTypes);
      const node: ModelNode = { id: `cn_${rng.int(1e9)}`, type, attrs: {} };
      for (const a of c.requiredAttr[type] ?? []) {
        const v = randomAttr(c, type, a, rng);
        if (v !== undefined) node.attrs[a] = v;
      }
      changes.push({ kind: 'addNode', node });
    } else {
      changes.push({ kind: 'delNode', id: rng.pick(region) });
    }
  }
  return changes;
}

function makeSequence(model: SysMLLikeModel, c: Catalog, ratio: number, scenario: string, steps: number, seed: number): Change[][] {
  const g = normalizeToTypedGraph(model);
  const rng = new Rng(seed);
  const seq: Change[][] = [];
  for (let s = 0; s < steps; s++) {
    const size = Math.max(1, Math.round(g.nodes.size * ratio));
    const ch = scenario === 'clustered' ? clusteredChangeSet(g, c, rng, size) : randomChangeSet(g, c, rng, size);
    if (ch.length === 0) continue;
    applyChanges(g, ch);
    seq.push(ch);
  }
  return seq;
}

interface Runner {
  step(ch: Change[]): void;
}

function makeRunner(path: PathId, model: SysMLLikeModel, c: Catalog, rules: Rule[]): Runner {
  const g = normalizeToTypedGraph(model);
  if (path === 'batch') {
    return {
      step: (ch) => {
        applyChanges(g, ch);
        validate(g, c, rules);
      },
    };
  }
  const strategy: StrategyId = path === 'S1' ? 1 : path === 'S2' ? 2 : 3;
  const s = new IncrementalSession(g, c, rules, strategy, undefined, path === 'S3t' ? { rebuildThreshold: THRESHOLD } : {});
  return { step: (ch) => void s.step(ch) };
}

function timeReplay(path: PathId, model: SysMLLikeModel, c: Catalog, rules: Rule[], seq: Change[][], reps: number): { perStepMs: number; samples: number[] } {
  const once = (): number => {
    const r = makeRunner(path, model, c, rules);
    const t0 = process.hrtime.bigint();
    for (const ch of seq) r.step(ch);
    return Number(process.hrtime.bigint() - t0) / 1e6 / seq.length;
  };
  once(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) samples.push(once());
  return { perStepMs: median(samples), samples };
}

interface Audit {
  ops: Record<PathId, { groundings: number; scans: number; globalWork: number }>;
  scopeShare: number;
  s1Missed: number;
  s1Spurious: number;
  s2Mismatch: number;
  s3Mismatch: number;
  s3tMismatch: number;
  s3tFallbackSteps: number;
}

/** Untimed replay: operation counts per step and correctness against batch validation. */
function audit(model: SysMLLikeModel, c: Catalog, rules: Rule[], seq: Change[][]): Audit {
  const gb = normalizeToTypedGraph(model);
  const sessions: Record<'S1' | 'S2' | 'S3' | 'S3t', IncrementalSession> = {
    S1: new IncrementalSession(normalizeToTypedGraph(model), c, rules, 1),
    S2: new IncrementalSession(normalizeToTypedGraph(model), c, rules, 2),
    S3: new IncrementalSession(normalizeToTypedGraph(model), c, rules, 3),
    S3t: new IncrementalSession(normalizeToTypedGraph(model), c, rules, 3, undefined, { rebuildThreshold: THRESHOLD }),
  };
  const ops = Object.fromEntries(PATHS.map((p) => [p, { groundings: 0, scans: 0, globalWork: 0 }])) as Audit['ops'];
  const a: Audit = { ops, scopeShare: 0, s1Missed: 0, s1Spurious: 0, s2Mismatch: 0, s3Mismatch: 0, s3tMismatch: 0, s3tFallbackSteps: 0 };
  const shares: number[] = [];
  for (const ch of seq) {
    const g0 = opCounter.groundings;
    const s0 = opCounter.scans;
    const w0 = opCounter.globalWork;
    applyChanges(gb, ch);
    const truth = violationSet(validate(gb, c, rules));
    ops.batch.groundings += opCounter.groundings - g0;
    ops.batch.scans += opCounter.scans - s0;
    ops.batch.globalWork += opCounter.globalWork - w0;
    for (const k of ['S1', 'S2', 'S3', 'S3t'] as const) {
      const r = sessions[k].step(ch);
      ops[k].groundings += r.groundingsEvaluated;
      ops[k].scans += r.localScans;
      ops[k].globalWork += r.globalWork;
      const got = violationSet(r.violations);
      const missed = setDiff(truth, got).length;
      const spurious = setDiff(got, truth).length;
      if (k === 'S1') {
        a.s1Missed += missed;
        a.s1Spurious += spurious;
      } else if (k === 'S2') a.s2Mismatch += missed + spurious > 0 ? 1 : 0;
      else if (k === 'S3') {
        a.s3Mismatch += missed + spurious > 0 ? 1 : 0;
        shares.push(r.scopeSize / Math.max(1, gb.nodes.size));
      } else {
        a.s3tMismatch += missed + spurious > 0 ? 1 : 0;
        if (r.batchGlobalRules > 0) a.s3tFallbackSteps++;
      }
    }
  }
  for (const p of PATHS) {
    ops[p].groundings /= seq.length;
    ops[p].scans /= seq.length;
    ops[p].globalWork /= seq.length;
  }
  a.scopeShare = median(shares);
  return a;
}

function speedup(sizes: number[], ratios: number[], scenarios: string[], seeds: number, steps: number, reps: number): unknown[] {
  const catalog = aerospaceCatalog();
  const rules = deriveRules(catalog);
  const rows: unknown[] = [];
  for (const n of sizes) {
    for (const scenario of scenarios) {
      for (const ratio of ratios) {
        const sp: Record<string, number[]> = { S1: [], S2: [], S3: [], S3t: [] };
        const opsRatio: Record<string, number[]> = { S1: [], S2: [], S3: [], S3t: [] };
        const times: Record<string, number[]> = { batch: [], S1: [], S2: [], S3: [], S3t: [] };
        const opsAbs: Record<string, number[]> = { batch: [], S1: [], S2: [], S3: [], S3t: [] };
        const shares: number[] = [];
        let s1Missed = 0;
        let s1Spurious = 0;
        let s2Mismatch = 0;
        let s3Mismatch = 0;
        let s3tMismatch = 0;
        let s3tFallbackSteps = 0;
        let stepsTotal = 0;
        let nodes = 0;
        let edges = 0;
        for (let s = 0; s < seeds; s++) {
          const gen = generateCleanModel(catalog, { n, seed: 11000 + s });
          nodes += gen.model.nodes.length;
          edges += gen.model.edges.length;
          const seq = makeSequence(gen.model, catalog, ratio, scenario, steps, 12000 + s);
          if (seq.length === 0) continue;
          stepsTotal += seq.length;
          const t: Record<string, number> = {};
          for (const p of PATHS) t[p] = timeReplay(p, gen.model, catalog, rules, seq, reps).perStepMs;
          const au = audit(gen.model, catalog, rules, seq);
          const opsOf = (p: PathId): number => au.ops[p].groundings + au.ops[p].scans + au.ops[p].globalWork;
          for (const p of PATHS) {
            times[p].push(t[p]);
            opsAbs[p].push(opsOf(p));
          }
          for (const p of ['S1', 'S2', 'S3', 'S3t'] as const) {
            sp[p].push(t.batch / Math.max(1e-6, t[p]));
            opsRatio[p].push(opsOf('batch') / Math.max(1, opsOf(p)));
          }
          shares.push(au.scopeShare);
          s1Missed += au.s1Missed;
          s1Spurious += au.s1Spurious;
          s2Mismatch += au.s2Mismatch;
          s3Mismatch += au.s3Mismatch;
          s3tMismatch += au.s3tMismatch;
          s3tFallbackSteps += au.s3tFallbackSteps;
        }
        const ci = (xs: number[]): { median: number; ci95: [number, number] } => {
          const r = bootstrapMedianCI(xs);
          return { median: round(r.point, 3), ci95: [round(r.lo, 3), round(r.hi, 3)] };
        };
        rows.push({
          n,
          meanNodes: round(nodes / seeds, 1),
          meanEdges: round(edges / seeds, 1),
          scenario,
          changeRatio: ratio,
          seeds,
          stepsPerSeed: steps,
          medianScopeShareS3: round(median(shares), 4),
          medianStepMs: Object.fromEntries(PATHS.map((p) => [p, round(median(times[p]), 4)])),
          medianOpsPerStep: Object.fromEntries(PATHS.map((p) => [p, round(median(opsAbs[p]), 1)])),
          speedupTime: { kHopS1: ci(sp.S1), hybridS2: ci(sp.S2), witnessS3: ci(sp.S3), witnessThresholdS3t: ci(sp.S3t) },
          speedupOps: { kHopS1: ci(opsRatio.S1), hybridS2: ci(opsRatio.S2), witnessS3: ci(opsRatio.S3), witnessThresholdS3t: ci(opsRatio.S3t) },
          correctness: { steps: stepsTotal, s1MissedViolations: s1Missed, s1SpuriousViolations: s1Spurious, s2MismatchSteps: s2Mismatch, s3MismatchSteps: s3Mismatch, s3tMismatchSteps: s3tMismatch, s3tFallbackSteps },
        });
        console.log(`E5 n=${n} ${scenario} ratio=${ratio} done`);
      }
    }
  }
  return rows;
}

function counterexamples(ks: number[]): unknown[] {
  const rows: unknown[] = [];
  for (const k of ks) {
    for (const family of [cycleFamily(k), traceFamily(k)]) {
      const catalog = family.catalog;
      const rules = deriveRules(catalog);
      const change: Change[] = family.change.kind === 'addEdge' ? [{ kind: 'addEdge', edge: family.change.edge }] : [{ kind: 'delEdge', id: family.change.id }];
      const row: Record<string, unknown> = { family: family.model.id.startsWith('cycle') ? 'cycle' : 'trace', k, nodes: family.model.nodes.length, ruleUnderTest: family.ruleId };
      for (const strategy of [1, 2, 3] as StrategyId[]) {
        const g = normalizeToTypedGraph(family.model);
        const session = new IncrementalSession(g, catalog, rules, strategy, strategy === 1 ? k : undefined);
        const res = session.step(change);
        const truth = violationSet(validate(cloneGraph(g), catalog, rules));
        const got = violationSet(res.violations);
        row[`S${strategy}Missed`] = setDiff(truth, got).length;
        row[`S${strategy}Spurious`] = setDiff(got, truth).length;
        row[`S${strategy}SpuriousKeys`] = setDiff(got, truth).slice(0, 10);
      }
      rows.push(row);
    }
  }
  return rows;
}

export function runE5v2(quick = false): unknown {
  // optional partition of the run (environment): E5_SIZES, E5_RATIOS, E5_SEEDS, E5_SCENARIOS,
  // E5_STEPS, E5_REPS (comma lists / numbers) and E5_SKIP_LARGE / E5_ONLY_LARGE (1)
  const env = (k: string): string | undefined => process.env[k];
  const list = (k: string, d: number[]): number[] => (env(k) ? env(k)!.split(',').map(Number) : d);
  const t0 = Date.now();
  const onlyLarge = env('E5_ONLY_LARGE') === '1';
  const main = quick
    ? speedup([500], [0.01], ['random', 'clustered'], 2, 5, 2)
    : onlyLarge
      ? []
      : speedup(
          list('E5_SIZES', [500, 1000, 5000, 20000]),
          list('E5_RATIOS', [0.001, 0.01, 0.05, 0.1]),
          env('E5_SCENARIOS') ? env('E5_SCENARIOS')!.split(',') : ['random', 'clustered'],
          Number(env('E5_SEEDS') ?? 10),
          Number(env('E5_STEPS') ?? 20),
          Number(env('E5_REPS') ?? 5),
        );
  const t1 = Date.now();
  const large = quick || env('E5_SKIP_LARGE') === '1' ? [] : speedup([100000], [0.001, 0.01], ['random', 'clustered'], Number(env('E5_LARGE_SEEDS') ?? 3), 10, 3);
  const t2 = Date.now();
  return {
    experiment: 'E5-v2',
    catalog: 'aerospace',
    protocol:
      'per (model, ratio, scenario): one pre-generated change sequence replayed by every path on a fresh model copy; ' +
      'one untimed warm-up replay, then reps timed replays; per-step time = replay time / steps; median over replays; ' +
      'change application included and model copy / session construction excluded on every path; speedup = batch per-step time / strategy per-step time, ' +
      'median over seeds with percentile bootstrap CI (2000 resamples)',
    paths: {
      batch: 'apply change set, then full validation',
      S1: 'naive k-hop: every rule re-evaluated on the induced subgraph of N_k(delta), k = max local radius = 2',
      S2: 'hybrid: local rules scope-restricted, global rules recomputed in batch every step',
      S3: 'witness maintenance: local rules scope-restricted, global rules through witness stores',
      S3t: `S3 with the validity threshold: stores declared invalid and rebuilt when |Delta| > ${THRESHOLD} (n + m)`,
    },
    opsDefinition: 'ops per step = Holds evaluations of local rules + adjacency entries scanned inside Holds + global work units (nodes processed by BatchGlobal; nodes touched by witness maintenance)',
    partition: { E5_SIZES: env('E5_SIZES') ?? null, E5_RATIOS: env('E5_RATIOS') ?? null, E5_SEEDS: env('E5_SEEDS') ?? null, E5_SKIP_LARGE: env('E5_SKIP_LARGE') ?? null, E5_ONLY_LARGE: env('E5_ONLY_LARGE') ?? null, E5_LARGE_SEEDS: env('E5_LARGE_SEEDS') ?? null },
    counterexampleFamilies: counterexamples([1, 2, 4, 8]),
    speedup: main,
    speedupLarge: large,
    elapsedMs: { main: t1 - t0, large: t2 - t1 },
  };
}
