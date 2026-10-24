/**
 * Independent-oracle experiments (review items M4, M6): differential testing of the engine
 * against a SHACL oracle (oracle-py/, pySHACL) that derives its shapes from catalog data
 * without the TypeScript rule derivation, plus E3 re-scoring under the oracle and a SHACL
 * baseline comparison (expressiveness, timing).
 *
 *   node dist/cli-oracle.js <independence|shapes|random|e2|e3|e7|scale|all> [--work <dir>] [--out <dir>]
 *
 * Results go to results-v2/oracle/ (never overwritten: an existing target aborts the command).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { aerospaceCatalog, allCatalogs, automotiveCatalog, catalogSwapPair, roboticsCatalog } from './catalog/domains';
import { deriveRules, violationSet } from './catalog/rules';
import { addConfusion, Confusion, emptyConfusion, f1, precision, recall } from './evaluation/metrics';
import { counterexampleCatalog } from './generator/counterexampleFamily';
import { generateCleanModel } from './generator/syntheticModelGenerator';
import { DEFECT_TARGET_KIND, DEFECT_TYPES, DefectType, scheduleDefects } from './injector/defectInjector';
import { applyChanges, graphToModel, normalizeToTypedGraph } from './model/graph';
import { Catalog, SysMLLikeModel } from './model/types';
import { spawnSync } from 'child_process';
import { catalogData, OracleBatchResult, OracleCase, ORACLE_DIR, ORACLE_PY, runOracle, writeShapes } from './oracle/bridge';
import { diff, engineKeys, oracleKeys } from './oracle/compare';
import { randomCatalog, randomModel } from './oracle/randomModels';
import { referenceValidate } from './reference/referenceSemantics';
import { Rng } from './util/rng';
import { timeMedian } from './util/timing';
import { validate } from './validator/engine';

const ROOT = path.join(__dirname, '..');
let OUT = path.join(ROOT, 'results-v2', 'oracle');
let WORK = path.join(OUT, 'work');

function writeResult(name: string, data: unknown): void {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.json`);
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`written: ${path.relative(ROOT, file)}`);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function codeIdentity(): Record<string, string> {
  const files = [
    'src/validator/engine.ts',
    'src/catalog/rules.ts',
    'src/catalog/domains.ts',
    'src/reference/referenceSemantics.ts',
    'src/model/graph.ts',
    'src/injector/defectInjector.ts',
    'src/generator/syntheticModelGenerator.ts',
    'oracle-py/oracle_spec.py',
    'oracle-py/rdf_export.py',
    'oracle-py/shapes.py',
    'oracle-py/run_oracle.py',
  ];
  const out: Record<string, string> = {};
  for (const f of files) {
    const full = f.startsWith('oracle-py/') ? path.join(ORACLE_DIR, f.slice('oracle-py/'.length)) : path.join(ROOT, f);
    out[f] = fs.existsSync(full) ? sha256(full) : 'missing';
  }
  return out;
}

/** The reference implementation enumerates groundings naively (super-linear), so, as in the
 *  original E2, it is only run on models of at most REFERENCE_MAX_NODES nodes. */
const REFERENCE_MAX_NODES = 1000;

function engineRun(model: SysMLLikeModel, c: Catalog) {
  const g = normalizeToTypedGraph(model);
  const rules = deriveRules(c);
  const reference = g.nodes.size <= REFERENCE_MAX_NODES ? referenceValidate(g, c, rules) : undefined;
  return { engine: validate(g, c, rules), reference, rules };
}

interface Mismatch {
  caseId: string;
  catalog: string;
  engineOnly: string[];
  oracleOnly: string[];
  referenceOnlyVsOracle: string[];
  oracleOnlyVsReference: string[];
  model?: SysMLLikeModel;
  catalogData?: Catalog;
}

interface DiffStats {
  cases: number;
  engineViolations: number;
  oracleViolations: number;
  agreeingCases: number;
  mismatchingCases: number;
  mismatchingCasesReference: number;
  engineVsReferenceMismatchingCases: number;
  referenceSkipped: number;
  engineOnlyByRule: Record<string, number>;
  oracleOnlyByRule: Record<string, number>;
  violationsByRuleClass: Record<string, number>;
  ruleCountMismatches: number;
}

function emptyStats(): DiffStats {
  return {
    cases: 0,
    engineViolations: 0,
    oracleViolations: 0,
    agreeingCases: 0,
    mismatchingCases: 0,
    mismatchingCasesReference: 0,
    engineVsReferenceMismatchingCases: 0,
    referenceSkipped: 0,
    engineOnlyByRule: {},
    oracleOnlyByRule: {},
    violationsByRuleClass: {},
    ruleCountMismatches: 0,
  };
}

function bump(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

function ruleOfKey(k: string): string {
  return k.split('|')[0].split(':')[0];
}

/** Compares engine and reference against one oracle batch result. */
function compareBatch(
  stats: DiffStats,
  mismatches: Mismatch[],
  catalog: Catalog,
  cases: OracleCase[],
  res: OracleBatchResult,
  keepModels: boolean,
  maxKept = 60,
): void {
  const engineRuleCount = deriveRules(catalog).length;
  if (engineRuleCount !== res.rules.length) stats.ruleCountMismatches++;
  for (const cs of cases) {
    const { engine, reference } = engineRun(cs.model, catalog);
    const ek = engineKeys(engine);
    const rk = reference ? engineKeys(reference) : undefined;
    if (!rk) stats.referenceSkipped++;
    const ok = oracleKeys(res.violations[cs.caseId] ?? []);
    stats.cases++;
    stats.engineViolations += ek.size;
    stats.oracleViolations += ok.size;
    for (const k of ok) bump(stats.violationsByRuleClass, ruleOfKey(k));
    const d = diff(ek, ok);
    const dr = rk ? diff(rk, ok) : { engineOnly: [], oracleOnly: [] };
    if (dr.engineOnly.length + dr.oracleOnly.length > 0) stats.mismatchingCasesReference++;
    const der = rk ? diff(ek, rk) : { engineOnly: [], oracleOnly: [] };
    if (der.engineOnly.length + der.oracleOnly.length > 0) stats.engineVsReferenceMismatchingCases++;
    if (d.engineOnly.length + d.oracleOnly.length === 0) {
      stats.agreeingCases++;
      continue;
    }
    stats.mismatchingCases++;
    for (const k of d.engineOnly) bump(stats.engineOnlyByRule, ruleOfKey(k));
    for (const k of d.oracleOnly) bump(stats.oracleOnlyByRule, ruleOfKey(k));
    if (mismatches.length < maxKept) {
      mismatches.push({
        caseId: cs.caseId,
        catalog: catalog.id,
        engineOnly: d.engineOnly,
        oracleOnly: d.oracleOnly,
        referenceOnlyVsOracle: dr.engineOnly,
        oracleOnlyVsReference: dr.oracleOnly,
        model: keepModels ? cs.model : undefined,
        catalogData: keepModels ? catalog : undefined,
      });
    }
  }
}

// ---------------------------------------------------------------- independence evidence

function independence(): void {
  const pyFiles = fs.readdirSync(ORACLE_DIR).filter((f) => f.endsWith('.py'));
  const files = pyFiles.map((f) => {
    const text = fs.readFileSync(path.join(ORACLE_DIR, f), 'utf8');
    const imports = text
      .split(/\r?\n/)
      .filter((l) => /^\s*(import|from)\s+\S+/.test(l))
      .map((l) => l.trim());
    const forbidden = ['engine', 'rules.ts', 'referenceSemantics', 'deriveRules', 'inDomain', 'makeViolation', 'normalizeToTypedGraph', 'dist/', '.ts'];
    const hits = forbidden.filter((w) => text.includes(w));
    return { file: `oracle-py/${f}`, sha256: sha256(path.join(ORACLE_DIR, f)), lines: text.split('\n').length, imports, forbiddenTokenHits: hits };
  });
  const tsFiles = fs.readdirSync(path.join(ROOT, 'src', 'oracle')).map((f) => {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'oracle', f), 'utf8');
    const imports = text
      .split(/\r?\n/)
      .filter((l) => /^import /.test(l))
      .map((l) => l.trim());
    return { file: `src/oracle/${f}`, sha256: sha256(path.join(ROOT, 'src', 'oracle', f)), imports };
  });
  writeResult('independence', {
    experiment: 'oracle-independence',
    statement:
      'The oracle derives SHACL shapes from catalog data (JSON.stringify of the objects built in catalog/domains.ts) and converts raw model JSON to RDF itself. ' +
      'No oracle file imports or embeds engine.ts, rules.ts (deriveRules, inDomain, makeViolation), referenceSemantics.ts or model/graph.ts (normalizeToTypedGraph). ' +
      'Validation is performed by pySHACL/rdflib, a third-party SHACL engine. src/oracle/*.ts only serialises data, spawns the oracle and compares outputs.',
    oracleFiles: files,
    bridgeFiles: tsFiles,
    note: 'forbiddenTokenHits lists occurrences of engine identifiers in oracle files; occurrences inside the explanatory docstring of oracle_spec.py (which names the modules it does NOT use) are expected and are not code references.',
    pythonPackages: fs.existsSync(path.join(ORACLE_DIR, 'requirements-lock.txt'))
      ? fs.readFileSync(path.join(ORACLE_DIR, 'requirements-lock.txt'), 'utf8').trim().split(/\r?\n/)
      : [],
    codeIdentity: codeIdentity(),
  });
}

// ---------------------------------------------------------------- SHACL shapes / expressiveness

function shapes(): void {
  const dir = path.join(OUT, 'shapes');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  for (const c of allCatalogs()) {
    const file = path.join(dir, `${c.id}.shapes.ttl`);
    if (fs.existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
    writeShapes(c, file, WORK);
    const text = fs.readFileSync(file, 'utf8');
    const res = runOracle([{ catalog: c, cases: [] }], WORK)[0];
    const byLayer: Record<string, Record<string, number>> = {};
    for (const r of res.rules) {
      byLayer[r.layer] = byLayer[r.layer] ?? {};
      bump(byLayer[r.layer], r.cls);
    }
    rows.push({
      catalog: c.id,
      engineRules: deriveRules(c).length,
      oracleRules: res.rules.length,
      rulesByLayer: byLayer,
      shapesTurtleLines: text.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('@prefix')).length,
      shapesTriples: res.timing.shapesTriples,
      catalogJsonLines: JSON.stringify(c, null, 2).split('\n').length,
      file: path.relative(ROOT, file),
    });
  }
  writeResult('shacl-expressiveness', {
    experiment: 'shacl-expressiveness',
    layers: {
      core: 'SHACL Core only (sh:class/sh:or, sh:minCount, sh:in, sh:datatype, sh:minInclusive/maxInclusive, sh:minLength, sh:qualifiedValueShape with qualifiedMin/MaxCount over sh:inversePath)',
      sparql: 'SHACL-SPARQL constraint without property paths (value comparison across two paths)',
      'sparql-path': 'SHACL-SPARQL constraint with a SPARQL 1.1 property path (transitive closure: *, +); not expressible in SHACL Core',
    },
    incremental: 'SHACL (W3C Recommendation 2017) defines no incremental validation; pySHACL re-validates the whole data graph. No incremental comparison is possible.',
    rows,
  });
}

// ---------------------------------------------------------------- random differential testing

function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}

function random(): void {
  const stats: Record<string, DiffStats> = {};
  const mismatches: Mismatch[] = [];
  const t0 = Date.now();

  // (1) the evaluation catalogs plus the swap / counterexample catalogs, random raw models
  const fixed = [aerospaceCatalog(), automotiveCatalog(), roboticsCatalog(), catalogSwapPair().c2, counterexampleCatalog()];
  const perFixed = argNum('--fixed', 3000);
  for (const c of fixed) {
    const rng = new Rng(910000 + fixed.indexOf(c));
    const cases: OracleCase[] = [];
    for (let i = 0; i < perFixed; i++) cases.push({ caseId: `${c.id}-${i}`, model: randomModel(rng, c, `${c.id}-${i}`, 7, 10) });
    const chunks: { catalog: Catalog; cases: OracleCase[] }[] = [];
    for (let i = 0; i < cases.length; i += 500) chunks.push({ catalog: c, cases: cases.slice(i, i + 500) });
    const res = runOracle(chunks, WORK);
    stats[`fixed:${c.id}`] = emptyStats();
    res.forEach((r, i) => compareBatch(stats[`fixed:${c.id}`], mismatches, c, chunks[i].cases, r, true));
    console.log(`random fixed ${c.id}: ${JSON.stringify(stats[`fixed:${c.id}`])}`);
  }

  // (2) random catalogs (exercise S2), small random models
  const nCatalogs = argNum('--rcat', 400);
  const perCatalog = 25;
  const rng = new Rng(920000);
  const batches: { catalog: Catalog; cases: OracleCase[] }[] = [];
  for (let k = 0; k < nCatalogs; k++) {
    const c = randomCatalog(rng, `rc${k}`);
    const cases: OracleCase[] = [];
    for (let i = 0; i < perCatalog; i++) cases.push({ caseId: `rc${k}-${i}`, model: randomModel(rng, c, `rc${k}-${i}`, 6, 9) });
    batches.push({ catalog: c, cases });
  }
  stats['randomCatalogs'] = emptyStats();
  for (let i = 0; i < batches.length; i += 50) {
    const part = batches.slice(i, i + 50);
    const res = runOracle(part, WORK);
    res.forEach((r, j) => compareBatch(stats['randomCatalogs'], mismatches, part[j].catalog, part[j].cases, r, true));
    console.log(`random catalogs ${i + part.length}/${nCatalogs}: mismatching ${stats['randomCatalogs'].mismatchingCases}`);
  }

  const suffix = process.argv.indexOf('--name') >= 0 ? process.argv[process.argv.indexOf('--name') + 1] : 'differential-random';
  writeResult(suffix, {
    experiment: 'differential-random',
    bounds: { fixedCatalogModels: perFixed, fixedMaxNodes: 7, fixedMaxEdges: 10, randomCatalogs: nCatalogs, modelsPerRandomCatalog: perCatalog, randomMaxNodes: 6, randomMaxEdges: 9 },
    seeds: { fixed: '910000 + catalog index', randomCatalogs: 920000 },
    stats,
    mismatchesKept: mismatches.length,
    mismatches,
    seconds: (Date.now() - t0) / 1000,
    codeIdentity: codeIdentity(),
  });
}

// ---------------------------------------------------------------- SHACL Core variants of the global rules

function variants(): void {
  const fixed = [aerospaceCatalog(), automotiveCatalog(), roboticsCatalog(), catalogSwapPair().c2, counterexampleCatalog()];
  const batches: { catalog: unknown; models: OracleCase[] }[] = [];
  for (const c of fixed) {
    const rng = new Rng(930000 + fixed.indexOf(c));
    const cases: OracleCase[] = [];
    for (let i = 0; i < 1000; i++) cases.push({ caseId: `${c.id}-${i}`, model: randomModel(rng, c, `${c.id}-${i}`, 7, 10) });
    batches.push({ catalog: catalogData(c), models: cases });
  }
  const rng = new Rng(940000);
  for (let k = 0; k < 100; k++) {
    const c = randomCatalog(rng, `vc${k}`);
    const cases: OracleCase[] = [];
    for (let i = 0; i < 25; i++) cases.push({ caseId: `vc${k}-${i}`, model: randomModel(rng, c, `vc${k}-${i}`, 6, 9) });
    batches.push({ catalog: catalogData(c), models: cases });
  }
  fs.mkdirSync(WORK, { recursive: true });
  const inFile = path.join(WORK, `variants-in-${process.pid}.json`);
  const outFile = path.join(WORK, `variants-out-${process.pid}.json`);
  fs.writeFileSync(inFile, JSON.stringify({ batches }));
  const r = spawnSync(ORACLE_PY, ['-B', path.join(ORACLE_DIR, 'shapes_core.py'), inFile, outFile], { cwd: ORACLE_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.unlinkSync(inFile);
  fs.unlinkSync(outFile);
  writeResult('shacl-core-variants', {
    experiment: 'shacl-core-variants',
    method: 'Same random models (5 fixed catalogs x 1000, seeds 930000+i; 100 random catalogs x 25, seed 940000) validated with the SPARQL-based oracle and with the SHACL Core variants of tracePolicy (oneOrMorePath + qualifiedMinCount) and acyclic (oneOrMorePath + sh:disjoint over an auxiliary o:self triple). Acyclic compared as the set of nodes on cycles.',
    ...res,
  });
}

// ---------------------------------------------------------------- real SysML v2 inputs (R2's S1 normaliser)

function sysml(): void {
  // loaded lazily: the S1 normaliser exists only in the revised code base
  /* eslint-disable @typescript-eslint/no-var-requires */
  const corpus = require('./sysml/corpus');
  const norm = require('./sysml/normalize');
  const exps = require('./sysml/experiments');
  const ci = process.argv.indexOf('--corpus');
  const corpusDir = ci >= 0 ? path.resolve(process.argv[ci + 1]) : path.join(ROOT, 'corpus', 'SysML-v2-Release');
  const lib = corpus.loadLibrary(path.join(corpusDir, 'sysml.library'));
  const units = corpus.loadUnits(path.join(corpusDir, 'sysml', 'src'), ['examples', 'training', 'validation']);
  const catalogs: Catalog[] = [...allCatalogs(), exps.sysmlWellFormednessCatalog()];
  const rows = [];
  const mismatches: Mismatch[] = [];
  for (const mode of ['keyword', 'specialization']) {
    const cases: OracleCase[] = [];
    let nodes = 0;
    let edges = 0;
    for (const u of units) {
      const sm = corpus.semanticModelFor(u, units, lib);
      const r = norm.normalizeSysML(sm, mode, 'all');
      const model = r.model as SysMLLikeModel;
      nodes += model.nodes.length;
      edges += model.edges.length;
      cases.push({ caseId: `${mode}:${u.id}`, model });
    }
    for (const c of catalogs) {
      const res = runOracle([{ catalog: c, cases }], WORK)[0];
      const st = emptyStats();
      compareBatch(st, mismatches, c, cases, res, true, 20);
      rows.push({ mode, catalog: c.id, units: cases.length, nodes, edges, ...st });
      console.log(`sysml ${mode} ${c.id}: ${JSON.stringify(st)}`);
    }
  }
  writeResult('differential-sysml', {
    experiment: 'differential-sysml',
    input: 'public SysML v2 textual models (SysML-v2-Release tag 2026-08, examples/training/validation) normalised by src/sysml (keyword and specialization class modes, levels=all); the engine sees the same typed-graph JSON as the oracle',
    note: 'in specialization mode a node may belong to several classes; the typed-graph JSON keeps one type per node, so both validators see the same single-type projection',
    rows,
    mismatches,
    codeIdentity: codeIdentity(),
  });
}

// ---------------------------------------------------------------- E2-style generator check only (no oracle)

function e2quick(): void {
  // engine violations on generated clean models: the only check in E1-E3 whose expected
  // value (0) does not come from the shared rule derivation
  const rows = [];
  for (const c of allCatalogs()) {
    const rules = deriveRules(c);
    for (const n of [100, 500]) {
      let models = 0;
      let flagged = 0;
      let violations = 0;
      for (let s = 0; s < 10; s++) {
        const g = normalizeToTypedGraph(generateCleanModel(c, { n, seed: 1000 + s }).model);
        const v = validate(g, c, rules).length;
        models++;
        violations += v;
        if (v > 0) flagged++;
      }
      rows.push({ catalog: c.id, n, models, modelsWithViolations: flagged, violations });
    }
  }
  const name = process.argv.indexOf('--name') >= 0 ? process.argv[process.argv.indexOf('--name') + 1] : 'e2quick';
  writeResult(name, { experiment: 'e2quick', rows });
}

// ---------------------------------------------------------------- E2 clean models

function e2(): void {
  const sizes = [100, 500, 1000, 5000, 10000];
  const full = process.argv.includes('--full-e2');
  // pySHACL needs tens of seconds per 1000 nodes, so by default the two largest sizes use the
  // first 5 of the 30 generator seeds (--full-e2 runs all 30)
  const seedsFor = (n: number): number => (full || n < 5000 ? 30 : 5);
  const rows = [];
  const mismatches: Mismatch[] = [];
  const t0 = Date.now();
  for (const c of allCatalogs()) {
    for (const n of sizes) {
      const seeds = seedsFor(n);
      const st = emptyStats();
      const chunk = n >= 5000 ? 2 : n >= 1000 ? 10 : 30;
      for (let s0 = 0; s0 < seeds; s0 += chunk) {
        const cases: OracleCase[] = [];
        for (let s = s0; s < Math.min(seeds, s0 + chunk); s++) {
          const gen = generateCleanModel(c, { n, seed: 1000 + s });
          cases.push({ caseId: `${c.id}-${n}-${1000 + s}`, model: gen.model });
        }
        const res = runOracle([{ catalog: c, cases }], WORK)[0];
        compareBatch(st, mismatches, c, cases, res, false);
      }
      console.log(`E2 ${c.id} n=${n}: ${JSON.stringify(st)}`);
      rows.push({ catalog: c.id, n, seeds, ...st });
    }
  }
  writeResult('differential-e2', { experiment: 'differential-e2', rows, mismatches, seconds: (Date.now() - t0) / 1000, codeIdentity: codeIdentity() });
}

// ---------------------------------------------------------------- E3 re-scoring

interface DefectRow {
  catalog: string;
  n: number;
  seed: number;
  defectId: string;
  type: DefectType;
  referenceExpected: string[];
  oracleExpected: string[];
  goldAgrees: boolean;
  tp: number;
  fn: number;
  detected: boolean;
  oracleRuleClasses: string[];
}

function e3(): void {
  const t0 = Date.now();
  const sizes = [100, 500, 1000];
  const seedsPerCell = 30;
  const defects: DefectRow[] = [];
  const runsOut: { catalog: string; n: number; seed: number; defects: number; oracleCleanViolations: number; theorem8EquationHoldsUnderOracle: boolean; goldAllSize: number; reportedSize: number; fp: number; fn: number; fpKeys: string[]; fnKeys: string[]; referenceAllEqualsOracleAll: boolean }[] = [];
  let runs = 0;
  let discarded = 0;
  for (const catalog of allCatalogs()) {
    const rules = deriveRules(catalog);
    for (const n of sizes) {
      // build all runs of the cell, then one oracle call for the cell
      const cell: {
        seed: number;
        clean: SysMLLikeModel;
        isolated: { id: string; type: DefectType; model: SysMLLikeModel; refKeys: Set<string> }[];
        all: SysMLLikeModel;
        reported: Set<string>;
        refAll: Set<string>;
      }[] = [];
      for (let s = 0; s < seedsPerCell; s++) {
        const seed = 5000 + s;
        const gen = generateCleanModel(catalog, { n, seed });
        const gClean = normalizeToTypedGraph(gen.model);
        if (validate(gClean, catalog, rules).length !== 0) {
          discarded++;
          continue;
        }
        const sched = scheduleDefects(gClean, catalog, gen, rules, DEFECT_TYPES, new Rng(seed * 13 + n));
        if (sched.accepted.length === 0) {
          discarded++;
          continue;
        }
        const isolated = sched.accepted.map((d) => {
          const gd = normalizeToTypedGraph(gen.model);
          applyChanges(gd, d.changes);
          return { id: d.id, type: d.type, model: graphToModel(gd), refKeys: engineKeys(referenceValidate(gd, catalog, rules)) };
        });
        const gAll = normalizeToTypedGraph(gen.model);
        for (const d of sched.accepted) applyChanges(gAll, d.changes);
        cell.push({
          seed,
          clean: gen.model,
          isolated,
          all: graphToModel(gAll),
          reported: engineKeys(validate(gAll, catalog, rules)),
          refAll: engineKeys(referenceValidate(gAll, catalog, rules)),
        });
      }
      const cases: OracleCase[] = [];
      for (const r of cell) {
        cases.push({ caseId: `${r.seed}:clean`, model: r.clean });
        cases.push({ caseId: `${r.seed}:all`, model: r.all });
        for (const d of r.isolated) cases.push({ caseId: `${r.seed}:${d.id}`, model: d.model });
      }
      const chunks: { catalog: Catalog; cases: OracleCase[] }[] = [];
      const size = n >= 1000 ? 20 : 60;
      for (let i = 0; i < cases.length; i += size) chunks.push({ catalog, cases: cases.slice(i, i + size) });
      const res = runOracle(chunks, WORK);
      const ov: Record<string, Set<string>> = {};
      for (const b of res) for (const [k, vs] of Object.entries(b.violations)) ov[k] = oracleKeys(vs);

      for (const r of cell) {
        runs++;
        const goldAll = ov[`${r.seed}:all`];
        const clean = ov[`${r.seed}:clean`];
        const union = new Set<string>();
        for (const d of r.isolated) for (const k of ov[`${r.seed}:${d.id}`]) union.add(k);
        const eq = diff(union, goldAll);
        const fpKeys = [...r.reported].filter((k) => !goldAll.has(k));
        const fnKeys = [...goldAll].filter((k) => !r.reported.has(k));
        runsOut.push({
          catalog: catalog.id,
          n,
          seed: r.seed,
          defects: r.isolated.length,
          oracleCleanViolations: clean.size,
          theorem8EquationHoldsUnderOracle: eq.engineOnly.length + eq.oracleOnly.length === 0,
          goldAllSize: goldAll.size,
          reportedSize: r.reported.size,
          fp: fpKeys.length,
          fn: fnKeys.length,
          fpKeys,
          fnKeys,
          referenceAllEqualsOracleAll: diff(r.refAll, goldAll).engineOnly.length + diff(r.refAll, goldAll).oracleOnly.length === 0,
        });
        for (const d of r.isolated) {
          const gold = ov[`${r.seed}:${d.id}`];
          const tp = [...gold].filter((k) => r.reported.has(k)).length;
          const dd = diff(d.refKeys, gold);
          defects.push({
            catalog: catalog.id,
            n,
            seed: r.seed,
            defectId: d.id,
            type: d.type,
            referenceExpected: [...d.refKeys].sort(),
            oracleExpected: [...gold].sort(),
            goldAgrees: dd.engineOnly.length + dd.oracleOnly.length === 0,
            tp,
            fn: gold.size - tp,
            detected: gold.size > 0 && tp === gold.size,
            oracleRuleClasses: [...new Set([...gold].map((k) => k.split(':')[0]))].sort(),
          });
        }
      }
      console.log(`E3 ${catalog.id} n=${n}: runs so far ${runs}, defects ${defects.length}`);
    }
  }

  // per-type table; run-level FP attributed to the defect type whose target rule class matches
  const kindPrefix: Record<string, string> = {
    relationType: 'TYPE', multiplicity: 'MULT', requiredAttr: 'REQ', attrDomain: 'DOM', tracePolicy: 'TRACE', acyclic: 'ACYC', isolated: 'ISO', viewConsistency: 'VIEW',
  };
  const rows = DEFECT_TYPES.map((t) => {
    const ds = defects.filter((d) => d.type === t);
    let fp = 0;
    for (const r of runsOut) fp += r.fpKeys.filter((k) => k.startsWith(kindPrefix[DEFECT_TARGET_KIND[t]] + ':')).length;
    const conf: Confusion = { tp: ds.reduce((a, d) => a + d.tp, 0), fp, fn: ds.reduce((a, d) => a + d.fn, 0) };
    return {
      defect: t,
      instances: ds.length,
      oracleGoldViolations: ds.reduce((a, d) => a + d.oracleExpected.length, 0),
      tp: conf.tp,
      fp: conf.fp,
      fn: conf.fn,
      precision: precision(conf),
      recall: recall(conf),
      f1: f1(conf),
      detectedInstances: ds.filter((d) => d.detected).length,
      goldAgreesWithReference: ds.filter((d) => d.goldAgrees).length,
      oracleRuleClasses: [...new Set(ds.flatMap((d) => d.oracleRuleClasses))].sort(),
    };
  });
  const totalFp = runsOut.reduce((a, r) => a + r.fp, 0);
  const total = rows.reduce((c, r) => addConfusion(c, { tp: r.tp, fp: 0, fn: r.fn }), emptyConfusion());
  total.fp = totalFp;
  // reproduction check against the stored raw records of the run being reproduced
  const stored = path.join(ROOT, 'results', 'e3-raw-records.json');
  let storedCheck: unknown = 'no stored results/e3-raw-records.json';
  if (fs.existsSync(stored)) {
    const recs = (JSON.parse(fs.readFileSync(stored, 'utf8')) as { records: { catalog: string; n: number; seed: number; defectId: string; type: string; expected: string[] }[] }).records;
    const norm = (ks: string[]) => ks.map((k) => (k.startsWith('ATTR:') ? 'REQ:' + k.slice(5) : k)).sort().join(';');
    const mine = new Map(defects.map((d) => [`${d.catalog}|${d.n}|${d.seed}|${d.defectId}`, d]));
    let same = 0;
    let missing = 0;
    let differ = 0;
    for (const r of recs) {
      const d = mine.get(`${r.catalog}|${r.n}|${r.seed}|${r.defectId}`);
      if (!d) missing++;
      else if (d.type === r.type && norm(r.expected) === norm(d.referenceExpected)) same++;
      else differ++;
    }
    storedCheck = { storedRecords: recs.length, regeneratedRecords: defects.length, identical: same, differing: differ, notRegenerated: missing };
  }
  writeResult('e3-oracle-rescoring', {
    reproductionOfStoredE3: storedCheck,
    experiment: 'e3-oracle-rescoring',
    gold: 'independent SHACL oracle (pySHACL) on the isolated single-defect model; FP counted at run level against the oracle on the composed model',
    runs,
    discardedRuns: discarded,
    defectInstances: defects.length,
    rows,
    total: { ...total, precision: precision(total), recall: recall(total), f1: f1(total), runLevelFalsePositives: totalFp, runLevelFalseNegatives: runsOut.reduce((a, r) => a + r.fn, 0) },
    oracleCleanModelsWithViolations: runsOut.filter((r) => r.oracleCleanViolations > 0).length,
    theorem8EquationFailuresUnderOracle: runsOut.filter((r) => !r.theorem8EquationHoldsUnderOracle).length,
    referenceVsOracleComposedDisagreements: runsOut.filter((r) => !r.referenceAllEqualsOracleAll).length,
    goldDisagreementsReferenceVsOracle: defects.filter((d) => !d.goldAgrees).length,
    seconds: (Date.now() - t0) / 1000,
    codeIdentity: codeIdentity(),
  });
  writeResult('e3-oracle-raw', { runs: runsOut, defects });
}

// ---------------------------------------------------------------- E7 public models

function e7(): void {
  const dir = path.join(ROOT, 'examples', 'public-models');
  const models = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SysMLLikeModel);
  const rows = [];
  const mismatches: Mismatch[] = [];
  for (const c of allCatalogs()) {
    const cases = models.map((m) => ({ caseId: `${c.id}:${m.id}`, model: m }));
    const res = runOracle([{ catalog: c, cases }], WORK)[0];
    const st = emptyStats();
    compareBatch(st, mismatches, c, cases, res, false);
    rows.push({ catalog: c.id, ...st });
  }
  writeResult('differential-e7', { experiment: 'differential-e7', models: models.map((m) => m.id), rows, mismatches, codeIdentity: codeIdentity() });
}

// ---------------------------------------------------------------- timing vs SHACL

function scale(): void {
  const sizes = [100, 500, 1000, 2000, 5000, 10000];
  const seeds = [1000, 1001, 1002];
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  const rows = [];
  for (const n of sizes) {
    const cases: OracleCase[] = [];
    const eng: Record<string, { normalizeMs: number; validateMs: number; nodes: number; edges: number; violations: number }> = {};
    for (const seed of seeds) {
      const model = generateCleanModel(c, { n, seed }).model;
      const caseId = `${n}-${seed}`;
      cases.push({ caseId, model });
      const normalizeMs = timeMedian(() => void normalizeToTypedGraph(model), 5);
      const g = normalizeToTypedGraph(model);
      const validateMs = timeMedian(() => void validate(g, c, rules), 5);
      eng[caseId] = { normalizeMs, validateMs, nodes: g.nodes.size, edges: g.edges.size, violations: validate(g, c, rules).length };
    }
    const res = runOracle([{ catalog: c, cases }], WORK, { perModel: true, reps: n >= 5000 ? 1 : 3 })[0];
    for (const p of res.timing.perModel!) {
      const e = eng[p.caseId];
      rows.push({
        n,
        seed: p.caseId.split('-')[1],
        nodes: e.nodes,
        edges: e.edges,
        triples: p.triples,
        engineNormalizeMs: e.normalizeMs,
        engineValidateMs: e.validateMs,
        shaclRdfConversionMs: p.rdfMs,
        shaclValidateMs: p.validateMs,
        shaclValidateSamplesMs: p.validateSamplesMs,
        shaclReportParseMs: p.reportMs,
        engineViolations: e.violations,
        shaclViolations: p.violations,
        ratioValidate: p.validateMs / e.validateMs,
      });
      console.log(`scale n=${n} ${p.caseId}: engine ${e.validateMs.toFixed(2)} ms, shacl ${p.validateMs.toFixed(0)} ms (rdf ${p.rdfMs.toFixed(0)} ms)`);
    }
  }
  writeResult('shacl-timing', {
    experiment: 'shacl-timing',
    catalog: c.id,
    method:
      'Same generated clean models (aerospace, generator seeds 1000-1002). Engine: median of 5 runs after 1 warm-up (util/timing.timeMedian), normalisation timed separately. ' +
      'pySHACL 0.40.1 / rdflib 7.6.0 (Python 3.11): median of 3 validate() calls (1 call for n >= 5000), no warm-up; JSON->RDF conversion and report parsing timed separately. ' +
      'Both are full (non-incremental) validation; SHACL has no incremental mode.',
    machine: 'same Windows host as the other experiments; single process each',
    rows,
    codeIdentity: codeIdentity(),
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const wi = args.indexOf('--work');
  if (wi >= 0) WORK = path.resolve(args[wi + 1]);
  const oi = args.indexOf('--out');
  if (oi >= 0) OUT = path.resolve(args[oi + 1]);
  const t0 = Date.now();
  const all = cmd === 'all';
  if (cmd === 'independence' || all) independence();
  if (cmd === 'shapes' || all) shapes();
  if (cmd === 'e7' || all) e7();
  if (cmd === 'random' || all) random();
  if (cmd === 'e2' || all) e2();
  if (cmd === 'e3' || all) e3();
  if (cmd === 'scale' || all) scale();
  if (cmd === 'variants' || all) variants();
  if (cmd === 'e2quick') e2quick();
  if (cmd === 'sysml') sysml();
  if (!['independence', 'shapes', 'random', 'e2', 'e3', 'e7', 'scale', 'variants', 'e2quick', 'sysml', 'all'].includes(cmd)) {
    console.error('usage: node dist/cli-oracle.js <independence|shapes|random|e2|e3|e7|scale|all> [--work <dir>] [--out <dir>]');
    process.exit(2);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main();
