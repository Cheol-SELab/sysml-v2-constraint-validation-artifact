/**
 * Round-2 review item N2: same-runtime and JVM SHACL baselines.
 *
 *   node dist-review2/cli-bench-shacl.js gen --out <new dir> [--sizes 1000,10000,100000] [--seeds 1000,1001,1002]
 *       generated models (aerospace catalog, generator seeds) with random edits that create violations
 *       (the X3 (a) edit vocabulary), engine full validation time, reference-implementation time,
 *       incremental single-edit step time (strategy 3), and post-edit models for SHACL re-validation
 *   node dist-review2/cli-bench-shacl.js compare --out <dir>
 *       maps every SHACL engine's raw results (bench-shacl/run-js.mjs, bench-shacl/jena) to the oracle's
 *       comparison keys and compares them with the engine's violation keys
 *
 * Turtle files and shapes are written by oracle-py/export_ttl.py (oracle encoding and shapes.translate),
 * so all SHACL engines validate the same RDF and the same shapes as pySHACL.
 */

import * as fs from 'fs';
import * as path from 'path';
import { aerospaceCatalog } from './catalog/domains';
import { deriveRules } from './catalog/rules';
import { generateCleanModel } from './generator/syntheticModelGenerator';
import { IncrementalSession } from './incremental/session';
import { applyChanges, cloneGraph, graphToModel, normalizeToTypedGraph } from './model/graph';
import { Change, Rule, TypedGraph } from './model/types';
import { OracleViolation } from './oracle/bridge';
import { diff, engineKeys, oracleKeys } from './oracle/compare';
import { referenceValidate } from './reference/referenceSemantics';
import { Rng } from './util/rng';
import { validate } from './validator/engine';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function timeSamples(fn: () => void, reps: number, warmup = 1): number[] {
  for (let i = 0; i < warmup; i++) fn();
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    out.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return out;
}

/** The X3 (a) edit vocabulary: attribute set/unset, edge deletion, edge addition of a random type. */
function randomEdit(g: TypedGraph, rng: Rng, tag: string): Change {
  const nodeIds = [...g.nodes.keys()];
  const edgeIds = [...g.edges.keys()];
  const roll = rng.next();
  if (roll < 0.35) {
    const attr = rng.pick(['name', 'mass', 'criticality', 'priority', 'direction', 'method']);
    const val = rng.bernoulli(0.5) ? undefined : rng.pick(['A', 'high', 'in', 'test', 12000, 50, 'x']);
    return { kind: 'setAttr', id: rng.pick(nodeIds), attr, value: val };
  }
  if (roll < 0.65 && edgeIds.length > 0) return { kind: 'delEdge', id: rng.pick(edgeIds) };
  const t = rng.pick(['contain', 'satisfy', 'connect', 'allocate', 'dependOn', 'verify']);
  return { kind: 'addEdge', edge: { id: `edit#${tag}`, type: t, src: rng.pick(nodeIds), tgt: rng.pick(nodeIds) } };
}

/** Rule classes the SHACL Core subset expresses (no sh:sparql): everything but VIEW, ACYC, TRACE. */
function coreRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => r.kind !== 'viewConsistency' && r.kind !== 'acyclic' && r.kind !== 'tracePolicy');
}

function gen(out: string): void {
  if (fs.existsSync(out)) throw new Error(`refusing to reuse ${out}`);
  fs.mkdirSync(out, { recursive: true });
  const sizes = arg('--sizes', '1000,10000,100000').split(',').map(Number);
  const seeds = arg('--seeds', '1000,1001,1002').split(',').map(Number);
  const refMax = Number(arg('--reference-max', '10000'));
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(c, null, 1));
  const cases: unknown[] = [];
  for (const n of sizes) {
    for (const seed of seeds) {
      const id = `n${n}-s${seed}`;
      const dir = path.join(out, id);
      fs.mkdirSync(dir);
      const rng = new Rng(seed * 7 + 3);
      const g = normalizeToTypedGraph(generateCleanModel(c, { n, seed }).model);
      const nEdits = Math.max(20, Math.round(n * 0.02));
      const defects: Change[] = [];
      for (let i = 0; i < nEdits; i++) {
        const ch = randomEdit(g, rng, `d${i}`);
        applyChanges(g, [ch]);
        defects.push(ch);
      }
      const model = graphToModel(g);
      model.id = id;
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model));
      const reps = n >= 100000 ? 5 : 7;
      const g2 = normalizeToTypedGraph(model);
      const normalizeMs = median(timeSamples(() => void normalizeToTypedGraph(model), reps));
      const fullSamples = timeSamples(() => void validate(g2, c, rules), reps);
      const core = coreRules(rules);
      const coreSamples = timeSamples(() => void validate(g2, c, core), reps);
      const viol = validate(g2, c, rules);
      let reference: { samplesMs: number[]; equal: boolean } | undefined;
      if (n <= refMax) {
        const rs = timeSamples(() => void referenceValidate(g2, c, rules), n >= 10000 ? 1 : 3, n >= 10000 ? 0 : 1);
        const rk = engineKeys(referenceValidate(g2, c, rules));
        const ek = engineKeys(viol);
        const d = diff(ek, rk);
        reference = { samplesMs: rs, equal: d.engineOnly.length + d.oracleOnly.length === 0 };
      }
      // incremental: single edits on the defected model, strategy 3 (witness maintenance)
      const incEdits: Change[] = [];
      for (let j = 0; j < 20; j++) incEdits.push(randomEdit(g2, rng, `i${j}`));
      for (let w = 0; w < 3; w++) new IncrementalSession(cloneGraph(g2), c, rules, 3).step([incEdits[w]]); // warm-up
      const stepMs: number[] = [];
      const post: { edit: Change; violations: string[]; batchEqual: boolean }[] = [];
      for (let j = 0; j < incEdits.length; j++) {
        const gs = cloneGraph(g2);
        const s = new IncrementalSession(gs, c, rules, 3);
        const t0 = process.hrtime.bigint();
        s.step([incEdits[j]]);
        stepMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        if (j < 3) {
          const ek = engineKeys(s.violations());
          const bk = engineKeys(validate(gs, c, rules));
          const d = diff(ek, bk);
          const pm = graphToModel(gs);
          pm.id = `${id}-post${j}`;
          fs.writeFileSync(path.join(dir, `post${j}.json`), JSON.stringify(pm));
          post.push({ edit: incEdits[j], violations: [...ek].sort(), batchEqual: d.engineOnly.length + d.oracleOnly.length === 0 });
        }
      }
      const row = {
        id,
        n,
        seed,
        nodes: g2.nodes.size,
        edges: g2.edges.size,
        defectEdits: defects.length,
        violations: viol.length,
        violationsByClass: viol.reduce((m: Record<string, number>, v) => ((m[v.kind] = (m[v.kind] ?? 0) + 1), m), {}),
        engine: {
          normalizeMs,
          validateSamplesMs: fullSamples,
          validateMs: median(fullSamples),
          validateCoreSamplesMs: coreSamples,
          validateCoreMs: median(coreSamples),
        },
        reference: reference ? { ...reference, medianMs: median(reference.samplesMs) } : 'skipped (n > reference-max)',
        incremental: { strategy: 3, edits: incEdits.length, stepSamplesMs: stepMs, stepMedianMs: median(stepMs) },
        post,
      };
      fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ ...row, violationKeys: [...engineKeys(viol)].sort() }, null, 1));
      cases.push(row);
      console.log(`${id}: V=${row.nodes} E=${row.edges} viol=${row.violations} engine=${row.engine.validateMs.toFixed(2)}ms core=${row.engine.validateCoreMs.toFixed(2)}ms step=${row.incremental.stepMedianMs.toFixed(3)}ms ref=${reference ? median(reference.samplesMs).toFixed(0) : '-'}ms`);
    }
  }
  fs.writeFileSync(path.join(out, 'engine-cases.json'), JSON.stringify({ catalog: c.id, machine: machineInfo(), cases }, null, 1));
}

function machineInfo(): Record<string, unknown> {
  const os = require('os');
  return { node: process.version, platform: process.platform, cpus: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30) };
}

interface RawResult {
  focus: string;
  shape: string;
  value?: string | null;
}

interface EngineRun {
  engine: string;
  version: string;
  file: string;
  supportsSparql: boolean;
  parseMs: number;
  prepareMs?: number;
  validateSamplesMs: number[];
  validateMs: number;
  results: RawResult[];
  error?: string;
}

const BASE = 'urn:oracle:';
function parseIri(iri: string): { k: number; kind: string; ident: string } | undefined {
  if (!iri.startsWith(BASE + 'm')) return undefined;
  const rest = iri.slice(BASE.length + 1);
  const i1 = rest.indexOf(':');
  const i2 = rest.indexOf(':', i1 + 1);
  return { k: Number(rest.slice(0, i1)), kind: rest.slice(i1 + 1, i2), ident: decodeURIComponent(rest.slice(i2 + 1)) };
}

function toOracle(results: RawResult[], shapeToRule: Record<string, { id: string; cls: string }>, edges: Map<string, { src: string; tgt: string }>): { vs: OracleViolation[]; unknownShapes: number } {
  const vs: OracleViolation[] = [];
  const seen = new Set<string>();
  let unknownShapes = 0;
  for (const r of results) {
    const rule = shapeToRule[r.shape];
    if (!rule) {
      unknownShapes++;
      continue;
    }
    const f = parseIri(r.focus)!;
    let grounding: string[];
    if (rule.cls === 'viewConsistency') grounding = [f.ident, parseIri(r.value!)!.ident];
    else if (f.kind === 'e') {
      const e = edges.get(f.ident)!;
      grounding = [f.ident, e.src, e.tgt];
    } else grounding = [f.ident];
    const key = `${rule.id}|${rule.cls}|${grounding.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    vs.push({ rule: rule.id, cls: rule.cls, grounding });
  }
  return { vs, unknownShapes };
}

function compare(out: string): void {
  const rulesDoc = JSON.parse(fs.readFileSync(path.join(out, 'rules.json'), 'utf8'));
  const shapeToRule = rulesDoc.shapeToRule as Record<string, { id: string; cls: string }>;
  const sparqlClasses = new Set(['viewConsistency', 'acyclic', 'tracePolicy']);
  const rows: unknown[] = [];
  for (const id of fs.readdirSync(out).filter((d) => /^n\d+-s\d+$/.test(d))) {
    const dir = path.join(out, id);
    const eng = JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8'));
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('shacl-') && f.endsWith('.json'));
    for (const f of files) {
      const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EngineRun;
      const which = run.file.replace(/\.ttl$/, '');
      const modelFile = which === 'data' ? 'model.json' : `${which.replace('data-', '')}.json`;
      const model = JSON.parse(fs.readFileSync(path.join(dir, modelFile), 'utf8'));
      const edges = new Map<string, { src: string; tgt: string }>(model.edges.map((e: { id: string; src: string; tgt: string }) => [e.id, e]));
      let expected: Set<string>;
      if (which === 'data') expected = new Set(eng.violationKeys as string[]);
      else expected = new Set(eng.post[Number(which.replace('data-post', ''))].violations as string[]);
      const row: Record<string, unknown> = { id, n: eng.n, file: run.file, engine: run.engine, version: run.version, error: run.error };
      if (!run.error) {
        const { vs, unknownShapes } = toOracle(run.results, shapeToRule, edges);
        const got = oracleKeys(vs);
        const restrict = (s: Set<string>) => (run.supportsSparql ? s : new Set([...s].filter((k) => !sparqlKey(k, rulesDoc.rules))));
        const d = diff(restrict(expected), restrict(got));
        Object.assign(row, {
          supportsSparql: run.supportsSparql,
          comparedRuleClasses: run.supportsSparql ? 'all' : 'SHACL Core subset (VIEW, ACYC, TRACE excluded)',
          expected: restrict(expected).size,
          shacl: restrict(got).size,
          engineOnly: d.engineOnly.length,
          shaclOnly: d.oracleOnly.length,
          engineOnlyExamples: d.engineOnly.slice(0, 5),
          shaclOnlyExamples: d.oracleOnly.slice(0, 5),
          unknownShapes,
          parseMs: run.parseMs,
          prepareMs: run.prepareMs,
          validateMs: run.validateMs,
          validateSamplesMs: run.validateSamplesMs,
          engineValidateMs: run.supportsSparql ? eng.engine.validateMs : eng.engine.validateCoreMs,
          ratio: run.validateMs / (run.supportsSparql ? eng.engine.validateMs : eng.engine.validateCoreMs),
          incrementalStepMs: which === 'data' ? undefined : eng.incremental.stepMedianMs,
          ratioVsIncrementalStep: which === 'data' ? undefined : run.validateMs / eng.incremental.stepMedianMs,
        });
        void sparqlClasses;
      }
      rows.push(row);
    }
  }
  fs.writeFileSync(path.join(out, 'compare.json'), JSON.stringify({ rows }, null, 1));
  console.log(`compared ${rows.length} runs -> ${path.join(out, 'compare.json')}`);
}

function sparqlKey(k: string, rules: { id: string; cls: string }[]): boolean {
  const rid = k.split('|')[0];
  const r = rules.find((x) => x.id === rid);
  return !!r && (r.cls === 'viewConsistency' || r.cls === 'acyclic' || r.cls === 'tracePolicy');
}

const cmd = process.argv[2];
const out = path.resolve(arg('--out', ''));
if (cmd === 'gen') gen(out);
else if (cmd === 'compare') compare(out);
else console.error('usage: cli-bench-shacl.js gen|compare --out <dir>');
