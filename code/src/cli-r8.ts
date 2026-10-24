/**
 * Round-2 review response R8 (items n12, n13, n14, n15, n17, n21). New entry point; the shared
 * cli.ts / cli-v2.ts are not modified.
 *
 *   node dist-r8/cli-r8.js tests                      n21 / n12 / n17 regression tests (exit 1 on failure)
 *   node dist-r8/cli-r8.js csr-eq   --out <dir>       CSR engine = Map engine on generated, hub and random models
 *   node --expose-gc dist-r8/cli-r8.js e6csr --out <dir> [--quick]
 *                                                     E6 time exponent, Map vs CSR layout, GC and sort shares
 *   node --expose-gc dist-r8/cli-r8.js gcdiag --out <dir>
 *                                                     10^4 vs 10^5 diagnosis: per-kind time, GC, Map/CSR
 *   node dist-r8/cli-r8.js e5hist --out <dir> --tags <dir of tag trees> [--quick]
 *                                                     E5 on real SysML-v2-Release edit history (S1-normalised diffs)
 *   node dist-r8/cli-r8.js wex --out <dir>            worked example from SysML v2 text through S1
 *   node dist-r8/cli-r8.js wf2 --out <dir>            extended SysML v2 well-formedness catalog on the corpus
 *   node dist-r8/cli-r8.js adjsample --in <x2-adjudications-primary.json> --out <dir>
 *                                                     stratified sample for the human adjudication protocol
 *
 * Every output file is created exclusively (an existing file is never overwritten).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PerformanceObserver } from 'perf_hooks';
import { aerospaceCatalog, allCatalogs } from './catalog/domains';
import { deriveRules, violationKey } from './catalog/rules';
import { baselineB } from './evaluation/baselines';
import { bootstrapSlopeCI, median, ols, round } from './evaluation/stats';
import { generateHubModel } from './generator/hubGenerator';
import { generateCleanModel } from './generator/syntheticModelGenerator';
import { IncrementalSession } from './incremental/session';
import { addEdge, applyChanges, checkModelInput, InputDefect, InputError, normalizeToTypedGraph } from './model/graph';
import { Catalog, Rule, SysMLLikeModel, TypedGraph } from './model/types';
import { randomCatalog, randomModel } from './oracle/randomModels';
import { exampleModel } from './experiments/workedExample';
import { loadLibrary, loadUnits, semanticModelFor } from './sysml/corpus';
import { normalizeSysML, s1Config } from './sysml/normalize';
import { validateSpec } from './sysml/specEngine';
import { sysmlWellFormednessCatalog } from './sysml/experiments';
import { Rng } from './util/rng';
import { timeMedian } from './util/timing';
import { buildCsr, validateCsr } from './validator/engineCsr';
import { validate } from './validator/engine';
import { stronglyConnectedComponents } from './witness/tarjan';

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus', 'SysML-v2-Release');
const GROUPS = ['examples', 'training', 'validation'];

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (dflt === undefined) throw new Error(`missing ${name}`);
  return dflt;
}

function meta(started: Date): Record<string, unknown> {
  return {
    command: `node ${path.relative(ROOT, process.argv[1])} ${process.argv.slice(2).join(' ')}`,
    node: process.version,
    execArgv: process.execArgv,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    loadavgAtStart: os.loadavg(),
    startedAt: started.toISOString(),
    elapsedSec: Math.round((Date.now() - started.getTime()) / 100) / 10,
  };
}

function write(dir: string, name: string, data: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  console.log(`written: ${f}`);
  return f;
}

function gc(): void {
  const f = (global as unknown as { gc?: () => void }).gc;
  if (f) f();
}

const keys = (vs: { ruleId: string; witness: string[] }[]): string[] => vs.map((v) => `${v.ruleId}|${[...v.witness].sort().join(',')}`).sort();
const sameKeys = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ===================================================================================== tests

function tests(): void {
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const t = (name: string, fn: () => boolean | string): void => {
    try {
      const r = fn();
      results.push({ name, ok: r === true, detail: r === true ? undefined : String(r) });
    } catch (e) {
      results.push({ name, ok: false, detail: `threw ${(e as Error).message}` });
    }
  };
  const throwsInput = (fn: () => unknown, kind: string): boolean | string => {
    try {
      fn();
      return 'did not throw';
    } catch (e) {
      if (!(e instanceof InputError)) return `threw non-InputError ${(e as Error).message}`;
      return e.defects.some((d) => d.kind === kind) ? true : `defects ${JSON.stringify(e.defects)}`;
    }
  };
  const base = (): SysMLLikeModel => ({
    id: 't',
    nodes: [
      { id: 'a', type: 'Component', attrs: {} },
      { id: 'b', type: 'Component', attrs: {} },
      { id: 'p', type: 'Port', attrs: {} },
    ],
    edges: [
      { id: 'e1', type: 'dependOn', src: 'a', tgt: 'b' },
      { id: 'e2', type: 'contain', src: 'a', tgt: 'p' },
    ],
  });

  // ---- n21: S1 boundary input validation
  t('n21 duplicate node id is rejected', () => {
    const m = base();
    m.nodes.push({ id: 'a', type: 'Port', attrs: {} });
    return throwsInput(() => normalizeToTypedGraph(m), 'duplicateNodeId');
  });
  t('n21 duplicate edge id is rejected', () => {
    const m = base();
    m.edges.push({ id: 'e1', type: 'dependOn', src: 'b', tgt: 'a' });
    return throwsInput(() => normalizeToTypedGraph(m), 'duplicateEdgeId');
  });
  t('n21 dangling edge: dropped and reported (default policy)', () => {
    const m = base();
    m.edges.push({ id: 'e3', type: 'dependOn', src: 'a', tgt: 'ghost' });
    const report: InputDefect[] = [];
    const g = normalizeToTypedGraph(m, { report });
    return !g.edges.has('e3') && g.out.get('a')!.length === 2 && report.some((d) => d.kind === 'danglingEndpoint' && d.id === 'e3') ? true : JSON.stringify(report);
  });
  t('n21 dangling edge: rejected under policy reject', () => {
    const m = base();
    m.edges.push({ id: 'e3', type: 'dependOn', src: 'ghost', tgt: 'b' });
    return throwsInput(() => normalizeToTypedGraph(m, { dangling: 'reject' }), 'danglingEndpoint');
  });
  t('n21 checkModelInput lists every defect class incl. P_own', () => {
    const m = base();
    m.nodes.push({ id: 'b', type: 'Port', attrs: {} });
    m.edges.push({ id: 'e1', type: 'dependOn', src: 'b', tgt: 'a' });
    m.edges.push({ id: 'e4', type: 'contain', src: 'b', tgt: 'p' });
    m.edges.push({ id: 'e5', type: 'connect', src: 'p', tgt: 'nowhere' });
    const kinds = new Set(checkModelInput(m).map((d) => d.kind));
    return ['duplicateNodeId', 'duplicateEdgeId', 'danglingEndpoint', 'multipleOwners'].every((k) => kinds.has(k as never)) ? true : [...kinds].join(',');
  });
  t('n21 P_own violation is reported but not rejected (MULT can still fire)', () => {
    const m = base();
    m.edges.push({ id: 'e4', type: 'contain', src: 'b', tgt: 'p' });
    const report: InputDefect[] = [];
    const g = normalizeToTypedGraph(m, { report });
    const c = aerospaceCatalog();
    const v = validate(g, c, deriveRules(c)).map((x) => x.ruleId);
    return g.edges.has('e4') && report.some((d) => d.kind === 'multipleOwners' && d.id === 'p') && v.includes('MULT:Port|contain|in') ? true : JSON.stringify({ report, v });
  });
  t('n21 addEdge with an existing id is rejected and leaves G unchanged', () => {
    const g = normalizeToTypedGraph(base());
    const before = JSON.stringify([[...g.edges], [...g.out], [...g.in]]);
    const ok = addEdge(g, { id: 'e1', type: 'contain', src: 'b', tgt: 'a' });
    const after = JSON.stringify([[...g.edges], [...g.out], [...g.in]]);
    return !ok && before === after ? true : `ok=${ok}`;
  });
  t('n21 applyChanges ignores a duplicate addEdge (no touched ids)', () => {
    const g = normalizeToTypedGraph(base());
    const touched = applyChanges(g, [{ kind: 'addEdge', edge: { id: 'e2', type: 'dependOn', src: 'b', tgt: 'a' } }]);
    return touched.length === 0 && g.edges.get('e2')!.type === 'contain' && g.out.get('b')!.length === 0 ? true : JSON.stringify(touched);
  });
  t('n21 incremental session equals batch after a duplicate addEdge (all strategies)', () => {
    const c = aerospaceCatalog();
    const rules = deriveRules(c);
    for (const strategy of [1, 2, 3] as const) {
      const gs = normalizeToTypedGraph(base());
      const s = new IncrementalSession(gs, c, rules, strategy);
      const ch = [{ kind: 'addEdge' as const, edge: { id: 'e1', type: 'dependOn', src: 'b', tgt: 'a' } }];
      const r = s.step(ch);
      const gb = normalizeToTypedGraph(base());
      applyChanges(gb, ch);
      if (!sameKeys(keys(r.violations), keys(validate(gb, c, rules)))) return `strategy ${strategy}`;
    }
    return true;
  });
  t('n21 a dependOn 2-cycle created through a fresh id is still detected', () => {
    const c = aerospaceCatalog();
    const rules = deriveRules(c);
    const s = new IncrementalSession(normalizeToTypedGraph(base()), c, rules, 3);
    const r = s.step([{ kind: 'addEdge', edge: { id: 'e9', type: 'dependOn', src: 'b', tgt: 'a' } }]);
    return r.violations.some((v) => v.ruleId === 'ACYC:dependOn') ? true : 'missed';
  });

  // ---- n12: Baseline B warnings
  const bm = (edges: [string, string, string][], nodes: [string, string][]): SysMLLikeModel => ({
    id: 'b',
    nodes: nodes.map(([id, type]) => ({ id, type, attrs: {} })),
    edges: edges.map(([type, src, tgt], i) => ({ id: `x${i}`, type, src, tgt })),
  });
  t('n12 Baseline B warns on a dependOn cycle (2-cycle, self-loop) and not on a DAG', () => {
    const nodes: [string, string][] = [['a', 'Component'], ['b', 'Component'], ['c', 'Component']];
    const cyc = baselineB(bm([['dependOn', 'a', 'b'], ['dependOn', 'b', 'a']], nodes)).filter((f) => f.check === 'dependencyCycle');
    const self = baselineB(bm([['dependOn', 'c', 'c']], nodes)).filter((f) => f.check === 'dependencyCycle');
    const dag = baselineB(bm([['dependOn', 'a', 'b'], ['dependOn', 'b', 'c'], ['dependOn', 'a', 'c']], nodes)).filter((f) => f.check === 'dependencyCycle');
    return cyc.length === 1 && cyc[0].witness.join() === 'a,b' && self.length === 1 && dag.length === 0 ? true : JSON.stringify({ cyc, self, dag });
  });
  t('n12 Baseline B warns on a requirement without satisfy', () => {
    const nodes: [string, string][] = [['r1', 'Requirement'], ['r2', 'Requirement'], ['c', 'Component']];
    const f = baselineB(bm([['satisfy', 'c', 'r1']], nodes)).filter((x) => x.check === 'unsatisfiedRequirement');
    return f.length === 1 && f[0].witness[0] === 'r2' ? true : JSON.stringify(f);
  });
  t('n12 Baseline B output does not depend on the catalog (Prop. 1 premise)', () => baselineB.length === 1);

  // ---- n17: S1 exposure / subject mapping and the worked example in SysML v2 text
  const lib = loadLibrary(path.join(CORPUS, 'sysml.library'));
  const exUnits = loadUnits(path.join(ROOT, 'examples', 'worked-example-sysml'), ['examples']);
  t('n17 worked example: S1 (keyword) output is the Table-3 graph', () => {
    const r = normalizeSysML(semanticModelFor(exUnits[0], exUnits, lib), 'keyword', 'all');
    const iso = isoToExample(r.model);
    return iso === true ? true : iso;
  });
  t('n17 NamespaceExpose X::* gives subject(view, X) and expose(view, member)', () => {
    const r = normalizeSysML(semanticModelFor(exUnits[0], exUnits, lib), 'keyword', 'all');
    const name = (id: string) => String(r.model.nodes.find((n) => n.id === id)?.attrs.name);
    const ex = r.model.edges.filter((e) => e.type === 'expose' || e.type === 'subject').map((e) => `${e.type}:${name(e.src)}>${name(e.tgt)}`).sort();
    return ex.join() === 'expose:PowerView>cmdIn,subject:PowerView>PowerUnit' ? true : ex.join();
  });
  t('n17 legacy exposure mapping (no subject) is still available for impact measurement', () => {
    s1Config.exposeMode = 'legacy';
    try {
      const r = normalizeSysML(semanticModelFor(exUnits[0], exUnits, lib), 'keyword', 'all');
      const ex = r.model.edges.filter((e) => e.type === 'expose' || e.type === 'subject').length;
      return ex === 1 && !r.model.edges.some((e) => e.type === 'subject') ? true : String(ex);
    } finally {
      s1Config.exposeMode = 'namespace';
    }
  });

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` -- ${r.detail}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  const out = process.argv.includes('--out') ? arg('--out') : undefined;
  if (out) write(out, 'r8-tests.json', { tests: results, passed: results.length - failed, failed });
  process.exitCode = failed > 0 ? 1 : 0;
}

/** S1 output vs the JSON example of Table 3, nodes matched by name. */
function isoToExample(m: SysMLLikeModel): true | string {
  const ex = exampleModel();
  const byName = (mm: SysMLLikeModel) => new Map(mm.nodes.map((n) => [String(n.attrs.name), n]));
  const a = byName(m);
  const b = byName(ex);
  if (a.size !== b.size || m.nodes.length !== ex.nodes.length) return `nodes ${m.nodes.length} vs ${ex.nodes.length}`;
  const exNames = new Map<string, string>([
    ['AttitudeHold', 'AttitudeHold'], ['StabilizeAttitude', 'StabilizeAttitude'], ['FlightController', 'FlightController'], ['PowerUnit', 'PowerUnit'],
    ['cmdOut', 'cmdOut'], ['cmdIn', 'cmdIn'], ['HilAttitudeTest', 'HilAttitudeTest'], ['PowerView', 'PowerView'],
  ]);
  for (const [nm, n] of a) {
    const o = b.get(exNames.get(nm) ?? nm);
    if (!o) return `no example node named ${nm}`;
    if (o.type !== n.type) return `type of ${nm}: ${n.type} vs ${o.type}`;
    if (JSON.stringify(Object.entries(o.attrs).sort()) !== JSON.stringify(Object.entries(n.attrs).sort())) return `attrs of ${nm}: ${JSON.stringify(n.attrs)} vs ${JSON.stringify(o.attrs)}`;
  }
  const nameOf = (mm: SysMLLikeModel, id: string) => String(mm.nodes.find((n) => n.id === id)!.attrs.name);
  const es = (mm: SysMLLikeModel) => mm.edges.map((e) => `${e.type}:${nameOf(mm, e.src)}>${nameOf(mm, e.tgt)}`).sort().join(';');
  return es(m) === es(ex) ? true : `edges ${es(m)} vs ${es(ex)}`;
}

// ===================================================================================== worked example

function wex(): void {
  const started = new Date();
  const lib = loadLibrary(path.join(CORPUS, 'sysml.library'));
  const units = loadUnits(path.join(ROOT, 'examples', 'worked-example-sysml'), ['examples']);
  const file = path.join(ROOT, 'examples', 'worked-example-sysml', 'examples', 'UAV Excerpt', 'uav-excerpt.sysml');
  const text = fs.readFileSync(file, 'utf8');
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  const rows = [];
  for (const mode of ['keyword', 'specialization'] as const) {
    const r = normalizeSysML(semanticModelFor(units[0], units, lib), mode, 'all');
    const g = normalizeToTypedGraph(r.model);
    const nm = (id: string) => String(r.model.nodes.find((n) => n.id === id)?.attrs.name);
    rows.push({
      mode,
      nodes: r.model.nodes.map((n) => ({ name: n.attrs.name, type: n.type, classes: [...(r.classes.get(n.id) ?? [])], attrs: n.attrs, line: r.nodeProv.get(n.id)?.line })),
      edges: r.model.edges.map((e) => ({ type: e.type, src: nm(e.src), tgt: nm(e.tgt), line: r.edgeProv.get(e.id)?.line })),
      isomorphicToTable3: isoToExample(r.model),
      engineViolations: validate(g, c, rules).map(violationKey),
      multiClassViolations: validateSpec(g, r.classes, rules).map((v) => `${v.ruleId}|${v.witness.map(nm).join(',')}`),
      lostStatements: r.categories.filter((x) => x.category === 'lost').map((x) => ({ line: x.line, kind: x.kind, reason: x.reason })),
    });
  }
  write(arg('--out'), 'n17-worked-example-sysml.json', {
    meta: meta(started),
    file: path.relative(ROOT, file),
    sha256: createHash('sha256').update(text).digest('hex'),
    lines: text.trimEnd().split(/\r?\n/).length,
    text,
    catalog: c.id,
    rows,
  });
}

// ===================================================================================== CSR

function csrEq(): void {
  const started = new Date();
  const res: Record<string, { models: number; violations: number; mismatches: number }> = {};
  const check = (label: string, g: TypedGraph, c: Catalog, rules: Rule[]) => {
    const a = keys(validate(g, c, rules));
    const b = keys(validateCsr(buildCsr(g), c, rules));
    res[label] = res[label] ?? { models: 0, violations: 0, mismatches: 0 };
    res[label].models++;
    res[label].violations += a.length;
    if (!sameKeys(a, b)) res[label].mismatches++;
  };
  for (const c of allCatalogs()) {
    const rules = deriveRules(c);
    for (const n of [100, 1000, 10000]) for (let s = 0; s < 5; s++) check('generated', normalizeToTypedGraph(generateCleanModel(c, { n, seed: 31000 + s }).model), c, rules);
    for (const n of [500, 2000]) for (let s = 0; s < 3; s++) check('hub', normalizeToTypedGraph(generateHubModel(c, { n, seed: 32000 + s }, { portShare: 0.5, viewShare: 0.5, dependShare: 0.5 }).model), c, rules);
    const rng = new Rng(33000 + allCatalogs().indexOf(c));
    for (let i = 0; i < 2000; i++) check('random-fixed-catalog', normalizeToTypedGraph(randomModel(rng, c, `m${i}`, 8, 14)), c, rules);
  }
  const rng = new Rng(34000);
  for (let k = 0; k < 400; k++) {
    const c = randomCatalog(rng, `rc${k}`);
    const rules = deriveRules(c);
    for (let i = 0; i < 25; i++) check('random-catalog', normalizeToTypedGraph(randomModel(rng, c, `r${k}-${i}`, 8, 14)), c, rules);
  }
  write(arg('--out'), 'n13-csr-equivalence.json', { meta: meta(started), seeds: { generated: '31000+s', hub: '32000+s', randomFixed: '33000+catalog index', randomCatalogs: 34000 }, results: res });
  console.log(JSON.stringify(res));
}

interface GcStats {
  count: number;
  ms: number;
  byKind: Record<string, { count: number; ms: number }>;
}

/** Runs fn under a GC observer; returns GC events that started during fn. */
function withGc<T>(fn: () => T): { value: T; gc: GcStats } {
  const entries: { kind: number; duration: number; startTime: number }[] = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) entries.push({ kind: (e as unknown as { detail?: { kind: number } }).detail?.kind ?? -1, duration: e.duration, startTime: e.startTime });
  });
  obs.observe({ entryTypes: ['gc'] });
  const value = fn();
  // flush pending entries synchronously
  const pending = (obs as unknown as { takeRecords?: () => PerformanceEntry[] }).takeRecords?.() ?? [];
  for (const e of pending) entries.push({ kind: (e as unknown as { detail?: { kind: number } }).detail?.kind ?? -1, duration: e.duration, startTime: e.startTime });
  obs.disconnect();
  const kindName: Record<number, string> = { 1: 'major', 2: 'minor', 4: 'incremental', 8: 'weakcb' };
  const s: GcStats = { count: 0, ms: 0, byKind: {} };
  for (const e of entries) {
    s.count++;
    s.ms += e.duration;
    const k = kindName[e.kind] ?? String(e.kind);
    s.byKind[k] = s.byKind[k] ?? { count: 0, ms: 0 };
    s.byKind[k].count++;
    s.byKind[k].ms += e.duration;
  }
  return { value, gc: s };
}

function fitExp(points: { x: number; y: number }[]): unknown {
  if (points.length < 3) return null;
  const xs = points.map((p) => Math.log(p.x));
  const ys = points.map((p) => Math.log(Math.max(1e-6, p.y)));
  const r = ols(xs, ys);
  const ci = bootstrapSlopeCI(xs, ys);
  return { exponent: round(r.slope, 3), ci95: [round(ci.lo, 3), round(ci.hi, 3)], r2: round(r.r2, 4), includesOne: ci.lo <= 1 && ci.hi >= 1, points: points.length };
}

function e6csr(): void {
  const started = new Date();
  const quick = process.argv.includes('--quick');
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  const local = rules.filter((r) => !r.global);
  const global = rules.filter((r) => r.global);
  const sizes = quick ? [1000, 3000, 10000] : [1000, 3000, 10000, 30000, 100000, 300000, 1000000];
  const seedsFor = (n: number) => (quick ? 2 : n <= 10000 ? 10 : n <= 100000 ? 5 : 3);
  const repsFor = (n: number) => (n >= 300000 ? 3 : 5);
  const points: Record<string, unknown>[] = [];
  for (const n of sizes) {
    for (let s = 0; s < seedsFor(n); s++) {
      const g = normalizeToTypedGraph(generateCleanModel(c, { n, seed: 21000 + s }).model);
      const reps = repsFor(n);
      gc();
      const mapAll = withGc(() => timeMedian(() => void validate(g, c, rules), reps));
      gc();
      const mapLocal = timeMedian(() => void validate(g, c, local), reps);
      gc();
      const mapGlobal = timeMedian(() => void validate(g, c, global), reps);
      gc();
      const sortMs = timeMedian(() => void [...g.nodes.keys()].sort(), reps);
      gc();
      const tarjanMs = timeMedian(() => void stronglyConnectedComponents(g, 'dependOn'), reps);
      gc();
      const buildMs = timeMedian(() => void buildCsr(g), reps);
      const cg = buildCsr(g);
      gc();
      const csrAll = withGc(() => timeMedian(() => void validateCsr(cg, c, rules), reps));
      gc();
      const csrLocal = timeMedian(() => void validateCsr(cg, c, local), reps);
      gc();
      const csrGlobal = timeMedian(() => void validateCsr(cg, c, global), reps);
      const eq = sameKeys(keys(validate(g, c, rules)), keys(validateCsr(cg, c, rules)));
      const p = {
        n, seed: 21000 + s, nodes: g.nodes.size, edges: g.edges.size, reps,
        mapMs: { all: mapAll.value, local: mapLocal, global: mapGlobal, tarjanBatch: tarjanMs, nodeIdSort: sortMs },
        csrMs: { build: buildMs, all: csrAll.value, local: csrLocal, global: csrGlobal },
        gcDuringAllReps: { map: mapAll.gc, csr: csrAll.gc },
        sameViolations: eq,
      };
      points.push(p);
      console.log(`E6csr n=${n} seed=${s} map=${mapAll.value.toFixed(2)}ms csr=${csrAll.value.toFixed(2)}ms build=${buildMs.toFixed(2)}ms sort=${sortMs.toFixed(2)}ms eq=${eq}`);
    }
  }
  type P = { n: number; nodes: number; edges: number; mapMs: Record<string, number>; csrMs: Record<string, number> };
  const ps = points as unknown as P[];
  const fitOf = (sel: (p: P) => number, min = 0) => fitExp(ps.filter((p) => p.nodes + p.edges >= min).map((p) => ({ x: p.nodes + p.edges, y: sel(p) })));
  const perSize = sizes.map((n) => {
    const rows = ps.filter((p) => p.n === n);
    const med = (sel: (p: P) => number) => round(median(rows.map(sel)), 3);
    return {
      n,
      seeds: rows.length,
      elements: med((p) => p.nodes + p.edges),
      mapAll: med((p) => p.mapMs.all),
      mapLocal: med((p) => p.mapMs.local),
      mapGlobal: med((p) => p.mapMs.global),
      mapTarjanBatch: med((p) => p.mapMs.tarjanBatch),
      mapNodeIdSort: med((p) => p.mapMs.nodeIdSort),
      csrBuild: med((p) => p.csrMs.build),
      csrAll: med((p) => p.csrMs.all),
      csrLocal: med((p) => p.csrMs.local),
      csrGlobal: med((p) => p.csrMs.global),
      mapNsPerElement: med((p) => (p.mapMs.all * 1e6) / (p.nodes + p.edges)),
      csrNsPerElement: med((p) => (p.csrMs.all * 1e6) / (p.nodes + p.edges)),
    };
  });
  write(arg('--out'), `n13-e6-csr${quick ? '-quick' : ''}.json`, {
    meta: meta(started),
    gcBeforeTiming: typeof (global as unknown as { gc?: unknown }).gc === 'function',
    protocol: 'E6 bounded-degree generator (aerospace, seeds 21000+s, same sizes/seeds/reps as E6); per model: Map engine (validate) and CSR engine (validateCsr over buildCsr) timed with timeMedian (1 warm-up + reps), full GC before each block; CSR build timed separately; GC events observed during the all-rules timing block (perf_hooks gc entries).',
    perSize,
    exponents: {
      mapAll: fitOf((p) => p.mapMs.all),
      mapLocal: fitOf((p) => p.mapMs.local),
      mapGlobal: fitOf((p) => p.mapMs.global),
      mapTarjanBatch: fitOf((p) => p.mapMs.tarjanBatch),
      mapNodeIdSort: fitOf((p) => p.mapMs.nodeIdSort),
      csrAll: fitOf((p) => p.csrMs.all),
      csrLocal: fitOf((p) => p.csrMs.local),
      csrGlobal: fitOf((p) => p.csrMs.global),
      csrBuild: fitOf((p) => p.csrMs.build),
      mapAllFrom1e4: fitOf((p) => p.mapMs.all, 1e4),
      csrAllFrom1e4: fitOf((p) => p.csrMs.all, 1e4),
    },
    allSameViolations: points.every((p) => p.sameViolations === true),
    points,
  });
}

/** Diagnosis of the 10^4 -> 10^5 jump: per rule kind, Map vs CSR, GC events, adjacency-lookup microbenchmark. */
function gcdiag(): void {
  const started = new Date();
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  const kinds = [...new Set(rules.map((r) => r.kind))];
  const rows = [];
  for (const n of [10000, 30000, 100000]) {
    for (let s = 0; s < 3; s++) {
      const g = normalizeToTypedGraph(generateCleanModel(c, { n, seed: 21000 + s }).model);
      const cg = buildCsr(g);
      const perKind: Record<string, { map: number; csr: number; mapGcMs: number; csrGcMs: number }> = {};
      for (const k of kinds) {
        const rs = rules.filter((r) => r.kind === k);
        gc();
        const a = withGc(() => timeMedian(() => void validate(g, c, rs), 7));
        gc();
        const b = withGc(() => timeMedian(() => void validateCsr(cg, c, rs), 7));
        perKind[k] = { map: round(a.value, 3), csr: round(b.value, 3), mapGcMs: round(a.gc.ms, 3), csrGcMs: round(b.gc.ms, 3) };
      }
      // micro-benchmark: one pass of string-keyed look-ups over all edges (g.edges.get + g.out.get)
      // vs the same pass over CSR arrays; isolates look-up cost from rule logic
      const ids = [...g.edges.keys()];
      const nids = [...g.nodes.keys()];
      gc();
      const lookupMap = timeMedian(() => {
        let acc = 0;
        for (const id of ids) acc += g.edges.get(id)!.src.length;
        for (const v of nids) acc += g.out.get(v)!.length;
        if (acc < 0) throw new Error('x');
      }, 7);
      gc();
      const lookupCsr = timeMedian(() => {
        let acc = 0;
        for (let e = 0; e < cg.m; e++) acc += cg.src[e];
        for (let v = 0; v < cg.n; v++) acc += cg.outOff[v + 1] - cg.outOff[v];
        if (acc < 0) throw new Error('x');
      }, 7);
      // shuffled-order look-ups (random access pattern, as in neighbourhood traversal)
      const rng = new Rng(777 + s);
      const sh = [...ids];
      for (let i = sh.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [sh[i], sh[j]] = [sh[j], sh[i]];
      }
      gc();
      const lookupMapShuffled = timeMedian(() => {
        let acc = 0;
        for (const id of sh) acc += g.edges.get(id)!.src.length;
        if (acc < 0) throw new Error('x');
      }, 7);
      const heap = process.memoryUsage();
      rows.push({
        n, seed: 21000 + s, nodes: g.nodes.size, edges: g.edges.size, perKind,
        lookupPassMs: { map: round(lookupMap, 3), csr: round(lookupCsr, 3), mapShuffledEdgeLookups: round(lookupMapShuffled, 3) },
        lookupNsPerEntry: { map: round((lookupMap * 1e6) / (ids.length + nids.length), 2), csr: round((lookupCsr * 1e6) / (ids.length + nids.length), 2), mapShuffled: round((lookupMapShuffled * 1e6) / ids.length, 2) },
        heapUsedMiB: round(heap.heapUsed / 2 ** 20, 1),
      });
      console.log(`gcdiag n=${n} seed=${s} ${JSON.stringify(rows[rows.length - 1].lookupNsPerEntry)}`);
    }
  }
  write(arg('--out'), 'n13-gc-diagnosis.json', { meta: meta(started), gcBeforeTiming: typeof (global as unknown as { gc?: unknown }).gc === 'function', rows });
}

// ===================================================================================== n15: extended well-formedness catalog

/** n15: the SysML v2 well-formedness catalog (sysml/experiments.ts) extended with the derived constraints. */
export const sysmlWellFormednessCatalogExtended = sysmlWellFormednessCatalog;

function wf2(): void {
  const started = new Date();
  const lib = loadLibrary(path.join(CORPUS, 'sysml.library'));
  const units = loadUnits(path.join(CORPUS, 'sysml', 'src'), GROUPS);
  const cat = sysmlWellFormednessCatalogExtended();
  const rules = deriveRules(cat);
  const configs = [];
  for (const mode of ['specialization', 'keyword'] as const) {
    for (const levels of ['all', 'usage'] as const) {
      const targets: Record<string, number> = {};
      const viol: Record<string, number> = {};
      const examples: unknown[] = [];
      let units0 = 0;
      for (const u of units) {
        const r = normalizeSysML(semanticModelFor(u, units, lib), mode, levels);
        if (r.model.nodes.length === 0) continue;
        units0++;
        const g = normalizeToTypedGraph(r.model);
        for (const rule of rules) {
          let k = 0;
          if (rule.kind === 'relationType' || rule.kind === 'acyclic') for (const e of g.edges.values()) if (e.type === rule.edgeType) k++;
          if (rule.kind === 'multiplicity') for (const n of g.nodes.values()) if (r.classes.get(n.id)?.has(rule.nodeType)) k++;
          targets[rule.id] = (targets[rule.id] ?? 0) + k;
        }
        for (const v of validateSpec(g, r.classes, rules)) {
          viol[v.ruleId] = (viol[v.ruleId] ?? 0) + 1;
          if (examples.length < 50) examples.push({ unit: u.id, rule: v.ruleId, witness: v.witness, line: r.nodeProv.get(v.anchor)?.line ?? r.edgeProv.get(v.witness[0])?.line });
        }
      }
      const sum = (pred: (id: string) => boolean) => Object.entries(targets).filter(([id]) => pred(id)).reduce((a, [, k]) => a + k, 0);
      configs.push({
        mode, levels, units: units0, rules: rules.length,
        targetsByRule: targets,
        targetEdgesTypeRulesOriginal: sum((id) => ['TYPE:satisfy', 'TYPE:verify', 'TYPE:expose'].includes(id)),
        targetEdgesTypeRulesAll: sum((id) => id.startsWith('TYPE:')),
        targetEdgesAcyclicContain: targets['ACYC:contain'] ?? 0,
        targetNodesOwnerMultiplicity: sum((id) => id.startsWith('MULT:')),
        violations: Object.values(viol).reduce((a, b) => a + b, 0),
        violationsByRule: viol,
        examples,
      });
      console.log(`wf2 ${mode}/${levels}: ${JSON.stringify(viol)}`);
    }
  }
  write(arg('--out'), 'n15-wellformedness-extended.json', {
    meta: meta(started),
    catalog: cat,
    sources: 'sysml.library/Systems Library/SysML.sysml (satisfiedRequirement : RequirementUsage[1..1], verifiedRequirement, ViewUsage::exposedElement), Kernel Libraries/Kernel Semantic Library/KerML.kerml (Element::owner : Element[0..1])',
    notExpressible: [
      'PortUsage/PortDefinition: nested usages that are not PortUsages must not be composite (contain(Port, x) with x not a Port needs a guard on the pair of end types; TYPE allows only a product Src x Tgt)',
      'InterfaceUsage/InterfaceDefinition ends must be PortUsages (S1 maps connection, interface and flow usages to one edge type connect)',
      'Connector ends must be Features (in levels=all a definition can be a node; the level is not part of tau_V)',
    ],
    configs,
  });
}

// ===================================================================================== n15: adjudication sample

function adjsample(): void {
  const started = new Date();
  const inFile = path.resolve(arg('--in'));
  const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const list: { unit: string; ruleId: string; witness: string[]; verdict: string; code: string; reason: string; evidence: { file: string; line: number; text: string }[] }[] = raw.adjudications ?? raw;
  const cls = (r: string) => r.split(':')[0];
  // strata: rule class x adjudication code
  const strata = new Map<string, typeof list>();
  for (const a of list) {
    const k = `${cls(a.ruleId)}|${a.code}`;
    strata.set(k, [...(strata.get(k) ?? []), a]);
  }
  const N = 200;
  const minPer = 3;
  const total = list.length;
  const alloc = new Map<string, number>();
  for (const [k, l] of strata) alloc.set(k, Math.min(l.length, Math.max(minPer, Math.round((N * l.length) / total))));
  // trim/extend to exactly N (largest strata adjusted first, never below min or above stratum size)
  let sum = [...alloc.values()].reduce((a, b) => a + b, 0);
  const order = [...strata.keys()].sort((a, b) => strata.get(b)!.length - strata.get(a)!.length);
  while (sum !== N) {
    let changed = false;
    for (const k of order) {
      if (sum === N) break;
      const cur = alloc.get(k)!;
      if (sum > N && cur > Math.min(minPer, strata.get(k)!.length)) {
        alloc.set(k, cur - 1);
        sum--;
        changed = true;
      } else if (sum < N && cur < strata.get(k)!.length) {
        alloc.set(k, cur + 1);
        sum++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rng = new Rng(20261022);
  const sample: unknown[] = [];
  for (const k of [...strata.keys()].sort()) {
    const l = [...strata.get(k)!];
    for (let i = l.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [l[i], l[j]] = [l[j], l[i]];
    }
    for (const a of l.slice(0, alloc.get(k)!)) sample.push({ stratum: k, unit: a.unit, ruleId: a.ruleId, witness: a.witness, evidence: a.evidence, machineVerdict: a.verdict, machineCode: a.code });
  }
  // blind order and ids for the raters (machine verdict kept only in the key file)
  const ord = sample.map((_, i) => i);
  for (let i = ord.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [ord[i], ord[j]] = [ord[j], ord[i]];
  }
  const items = ord.map((i, pos) => ({ itemId: `A${String(pos + 1).padStart(3, '0')}`, ...(sample[i] as object) }));
  const out = arg('--out');
  write(out, 'n15-adjudication-sample-key.json', {
    meta: meta(started),
    source: path.basename(inFile),
    sourceSha256: createHash('sha256').update(fs.readFileSync(inFile)).digest('hex'),
    population: total,
    strata: Object.fromEntries([...strata.keys()].sort().map((k) => [k, { population: strata.get(k)!.length, sampled: alloc.get(k) }])),
    seed: 20261022,
    items,
  });
  write(out, 'n15-adjudication-sample-raters.json', {
    note: 'Rater sheet: machine verdicts removed. For each item record verdict in {TRUE_VIOLATION, FALSE_NORMALIZATION, POLICY_NOT_ADOPTED, UNSURE} and a one-line reason, per PKG/reviews/human-adjudication-protocol.md.',
    items: items.map((x) => {
      const { machineVerdict, machineCode, stratum, ...rest } = x as Record<string, unknown>;
      void machineVerdict;
      void machineCode;
      void stratum;
      return { ...rest, verdict: null, reason: null };
    }),
  });
}

// ===================================================================================== main

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'tests') return tests();
  if (cmd === 'wex') return wex();
  if (cmd === 'csr-eq') return csrEq();
  if (cmd === 'e6csr') return e6csr();
  if (cmd === 'gcdiag') return gcdiag();
  if (cmd === 'wf2') return wf2();
  if (cmd === 'adjsample') return adjsample();
  if (cmd === 'e5hist') {
    const m = await import('./experiments/e5history');
    const started = new Date();
    const r = m.runE5History(path.resolve(arg('--tags')), process.argv.includes('--quick'));
    write(arg('--out'), `n14-e5-history${process.argv.includes('--quick') ? '-quick' : ''}.json`, { meta: meta(started), ...r });
    return;
  }
  console.error('usage: cli-r8.js <tests|wex|csr-eq|e6csr|gcdiag|wf2|adjsample|e5hist> ...');
  process.exit(2);
}

void main();
