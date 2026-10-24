#!/usr/bin/env node
'use strict';
/**
 * R10 mutation analysis driver.
 *
 *   node r10-mutation/run-mutation-r10.js --output <new dir> [--workers 3] [--timeout 180000]
 *        [--ids 1,2,3 | --survivors <m4-mutation-analysis.json>] [--r10-only] [--name <file stem>]
 *
 * Mutant generation is the R8 generator (src/verification/mutationAnalysis.ts: same targets,
 * operators, exclusions and order), re-implemented here so the snapshot sources stay untouched.
 * Before running, the generated list is compared field by field with the stored R8 list
 * (results-v4/mutation/m4-mutation-analysis.json); any difference aborts.
 *
 * Each mutant: one file of the frozen snapshot (results-v4/snapshot/tree/src) is changed on one
 * line, transpiled with ts.transpileModule (same options as R8) and swapped into the worker's
 * private copy of results-v4/snapshot/tree/dist, which also holds r10/harness-r10.js. The child
 * harness runs the R8 stages and then the R10 stages (harness-r10.js header).
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TREE = path.join(ROOT, 'results-v4', 'snapshot', 'tree');
const R8 = path.join(ROOT, 'results-v4', 'mutation', 'm4-mutation-analysis.json');
const HARNESS = path.join(__dirname, 'harness-r10.js');

const TARGETS = [
  { file: 'validator/engine.ts', role: 'engine (rule evaluation)' },
  { file: 'incremental/session.ts', role: 'incremental session' },
  { file: 'witness/acyclicWitness.ts', role: 'witness store (acyclic)' },
  { file: 'witness/traceWitness.ts', role: 'witness store (trace)' },
  { file: 'witness/tarjan.ts', role: 'Tarjan SCC (BatchGlobal)' },
  { file: 'catalog/rules.ts', role: 'shared: rule derivation, value domains, violation keys' },
  { file: 'model/graph.ts', role: 'shared: normalization, change application, neighbourhoods' },
];
const EXCLUDE = [/^\s*(\/\/|\*|\/\*)/, /^\s*import /, /`/, /opCounter/, /\bwork\b/, /fallbacks/, /removedLocal/, /GlobalRules\+\+/, /throw new Error/, /console\./];

function replaceAt(line, idx, len, rep) {
  return line.slice(0, idx) + rep + line.slice(idx + len);
}
function* matches(line, needle) {
  let i = line.indexOf(needle);
  while (i >= 0) {
    yield i;
    i = line.indexOf(needle, i + 1);
  }
}
function lineMutants(line) {
  const out = [];
  const ror = [[' === ', ' !== '], [' !== ', ' === '], [' <= ', ' < '], [' >= ', ' > '], [' < ', ' <= '], [' > ', ' >= ']];
  for (const [a, b] of ror) for (const i of matches(line, a)) out.push({ operator: 'ROR', mutated: replaceAt(line, i, a.length, b) });
  for (const [a, b] of [[' && ', ' || '], [' || ', ' && ']]) for (const i of matches(line, a)) out.push({ operator: 'LCR', mutated: replaceAt(line, i, a.length, b) });
  for (const i of matches(line, 'if (')) {
    let depth = 0;
    let j = i + 3;
    for (; j < line.length; j++) {
      if (line[j] === '(') depth++;
      else if (line[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j < line.length) {
      const cond = line.slice(i + 4, j);
      out.push({ operator: 'NEG', mutated: `${line.slice(0, i)}if (!(${cond}))${line.slice(j + 1)}` });
    }
  }
  for (const [a, b] of [['return true', 'return false'], ['return false', 'return true']]) for (const i of matches(line, a)) out.push({ operator: 'BOOL', mutated: replaceAt(line, i, a.length, b) });
  for (const a of ['continue;', 'break;']) for (const i of matches(line, a)) out.push({ operator: 'STMT', mutated: replaceAt(line, i, a.length, '{}') });
  for (const [a, b] of [['++', '--'], ['--', '++'], [' + 1', ' - 1'], [' - 1', ' + 1']]) for (const i of matches(line, a)) out.push({ operator: 'INC', mutated: replaceAt(line, i, a.length, b) });
  const re = /(<=|>=|<|>|===|!==) (\d+)\b/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const num = Number(m[2]);
    const start = m.index + m[1].length + 1;
    out.push({ operator: 'CONST', mutated: replaceAt(line, start, m[2].length, String(num + 1)) });
  }
  return out.filter((x) => x.mutated !== line);
}
function generate(srcRoot) {
  const out = [];
  let id = 0;
  for (const t of TARGETS) {
    const lines = fs.readFileSync(path.join(srcRoot, t.file), 'utf8').split('\n');
    let legacy = false;
    lines.forEach((line, i) => {
      if (line.includes("engineConfig.viewOrder === 'subject'")) legacy = true;
      if (legacy) {
        if (line.trimEnd() === '      }') legacy = false;
        return;
      }
      if (EXCLUDE.some((re) => re.test(line))) return;
      for (const lm of lineMutants(line)) out.push({ id: id++, file: t.file, line: i + 1, operator: lm.operator, original: line.trim(), mutated: lm.mutated.trim() });
    });
  }
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function runHarness(distRoot, timeoutMs, r10Only) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env };
    if (r10Only) env.R10_ONLY = '1';
    else delete env.R10_ONLY;
    const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(distRoot, 'r10', 'harness-r10.js')], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (ms >= timeoutMs - 50) return resolve({ killedBy: 'timeout', detail: '', ms });
      try {
        const r = JSON.parse(out.trim().split('\n').pop() || '');
        resolve({ ...r, ms });
      } catch {
        resolve({ killedBy: 'crash:load', detail: out.slice(0, 200), ms });
      }
    });
  });
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};

async function main() {
  const outDir = path.resolve(arg('--output'));
  const name = arg('--name', 'm4-mutation-analysis-r10');
  const outFile = path.join(outDir, `${name}.json`);
  if (fs.existsSync(outFile)) throw new Error(`refusing to overwrite ${outFile}`);
  fs.mkdirSync(outDir, { recursive: true });
  const workers = Number(arg('--workers', 3));
  const timeoutMs = Number(arg('--timeout', 180000));
  const r10Only = process.argv.includes('--r10-only');
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

  const all = generate(path.join(TREE, 'src'));
  const stored = JSON.parse(fs.readFileSync(R8, 'utf8'));
  const storedById = new Map(stored.mutants.map((m) => [m.id, m]));
  const storedSurv = new Map(stored.survivors.map((m) => [m.id, m]));
  if (all.length !== stored.mutants.length) throw new Error(`generator drift: ${all.length} vs ${stored.mutants.length}`);
  for (const m of all) {
    const s = storedById.get(m.id);
    if (!s || s.file !== m.file || s.line !== m.line || s.operator !== m.operator) throw new Error(`generator drift at ${m.id}`);
    const sv = storedSurv.get(m.id);
    if (sv && (sv.original !== m.original || sv.mutated !== m.mutated)) throw new Error(`generator drift (text) at ${m.id}`);
  }
  let mutants = all;
  if (arg('--ids')) {
    const ids = new Set(arg('--ids').split(',').map(Number));
    mutants = all.filter((m) => ids.has(m.id));
  } else if (arg('--survivors')) {
    const ids = new Set(JSON.parse(fs.readFileSync(arg('--survivors'), 'utf8')).survivors.map((s) => s.id));
    mutants = all.filter((m) => ids.has(m.id));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-r10-'));
  const dists = [];
  for (let w = 0; w < workers; w++) {
    const d = path.join(tmp, `w${w}`, 'dist');
    copyDir(path.join(TREE, 'dist'), d);
    fs.mkdirSync(path.join(d, 'r10'), { recursive: true });
    fs.copyFileSync(HARNESS, path.join(d, 'r10', 'harness-r10.js'));
    dists.push(d);
  }
  const baseline = await runHarness(dists[0], 1800000, r10Only);
  console.log(`baseline: ${JSON.stringify(baseline)}`);
  if (baseline.killedBy !== null) throw new Error('unmutated harness fails');
  const results = [];
  let next = 0;
  const t0 = Date.now();
  const work = async (w) => {
    const dist = dists[w];
    for (;;) {
      const i = next++;
      if (i >= mutants.length) return;
      const m = mutants[i];
      const lines = fs.readFileSync(path.join(TREE, 'src', m.file), 'utf8').split('\n');
      const orig = lines[m.line - 1];
      const lead = orig.slice(0, orig.length - orig.trimStart().length);
      lines[m.line - 1] = lead + m.mutated;
      const js = ts.transpileModule(lines.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, esModuleInterop: true } }).outputText;
      const target = path.join(dist, m.file.replace(/\.ts$/, '.js'));
      const saved = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, js, 'utf8');
      const r = await runHarness(dist, timeoutMs, r10Only);
      fs.writeFileSync(target, saved, 'utf8');
      results.push({ ...m, killedBy: r.killedBy, detail: r.detail, ms: r.ms, timing: r.timing });
      if (results.length % 25 === 0 || mutants.length < 40) console.log(`mutation-r10: ${results.length}/${mutants.length} (${m.id} -> ${r.killedBy})`);
    }
  };
  await Promise.all(dists.map((_, w) => work(w)));
  results.sort((a, b) => a.id - b.id);
  fs.rmSync(tmp, { recursive: true, force: true });

  const score = (rs) => {
    const killed = rs.filter((r) => r.killedBy !== null).length;
    const byStage = {};
    for (const r of rs) byStage[r.killedBy ?? 'survived'] = (byStage[r.killedBy ?? 'survived'] ?? 0) + 1;
    return { mutants: rs.length, killed, survived: rs.length - killed, mutationScore: rs.length ? Math.round((killed / rs.length) * 10000) / 10000 : null, byStage };
  };
  const result = {
    experiment: 'M4-mutation-analysis-r10',
    command: process.argv.slice(1).join(' '),
    node: process.version,
    startedAt: new Date(t0).toISOString(),
    snapshotTree: TREE,
    snapshotSourceDigest: JSON.parse(fs.readFileSync(path.join(ROOT, 'results-v4', 'snapshot', 'snapshot-sha256.json'), 'utf8')).sourcesDigest ?? null,
    harnessSha256: sha(HARNESS),
    driverSha256: sha(__filename),
    generatorCheckedAgainst: { file: R8, mutants: stored.mutants.length, identical: true },
    workers,
    timeoutMs,
    r10Only,
    harness: r10Only
      ? 'R10 stages only: R10-IN, R10-SES, R10-API (exploration run, not a score)'
      : 'R8 reduced E1 (BE-base -> BE-ext -> PB -> INV, unchanged) then R10-IN (S1 input boundary) -> R10-SES (rejected/reusing change sets; S1, S2, S3, S3e, S3t sessions; scope, fallback and S1 specifications) -> R10-API (applyChanges support ids, groundingNodes, evidencePath); first failing stage recorded',
    baselineHarness: baseline,
    total: score(results),
    byFile: Object.fromEntries(TARGETS.map((t) => [t.file, { role: t.role, ...score(results.filter((r) => r.file === t.file)) }])),
    byOperator: Object.fromEntries(['ROR', 'LCR', 'NEG', 'BOOL', 'STMT', 'INC', 'CONST'].map((o) => [o, score(results.filter((r) => r.operator === o))])),
    survivors: results.filter((r) => r.killedBy === null).map((r) => ({ id: r.id, file: r.file, line: r.line, operator: r.operator, original: r.original, mutated: r.mutated })),
    mutants: results.map((r) => ({ id: r.id, file: r.file, line: r.line, operator: r.operator, killedBy: r.killedBy, detail: (r.detail || '').slice(0, 300), ms: r.ms })),
    elapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(`written: ${outFile} (${((Date.now() - t0) / 1000).toFixed(1)} s) score ${result.total.mutationScore}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
