#!/usr/bin/env node
'use strict';
/**
 * R10: which mutants are caught by the independent oracles (E2 differential).
 *
 *   node r10-mutation/oracle-replay.js cache  --cache <new file.json> [--work <dir>]
 *   node r10-mutation/oracle-replay.js run    --cache <file.json> --mutants <m4 json> [--ids a,b] --output <new file.json> [--workers 3]
 *
 * cache: oracle outputs do not depend on the TypeScript code, so they are computed once.
 *   (R) the random differential inputs of the shared-code fault experiment (cli-oracle random
 *       --fixed 400 --rcat 50: 5 fixed catalogs x 400 models, seeds 910000+i; 50 random catalogs
 *       x 25 models, seed 920000): 3,250 cases, SHACL oracle (oracle-py/run_oracle.py).
 *   (B) the n20 blind input (codes/oracle-blind/inputs/batch-blind.json, 2,900 models): SHACL
 *       oracle on the original input, blind SQL oracle (unmodified, blind-compare/run_blind_on.py)
 *       on the sanitized input (edges with a missing endpoint removed), as in cli-blind.ts.
 *   The unmutated engine must agree with all three oracle outputs on every case (checked).
 * run: for every mutant, the mutated snapshot dist evaluates engine E (normalizeToTypedGraph +
 *   validate) and reference R on every cached case; a case is "caught" when E differs from the
 *   oracle keys or E throws. E vs R is reported too (the E1-style comparison).
 */
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TREE = path.join(ROOT, 'results-v4', 'snapshot', 'tree');
const BLIND = path.resolve(ROOT, '..', 'oracle-blind');
const SYS_PY = process.env.SYS_PYTHON || 'C:/Python311/python.exe';
process.env.ORACLE_DIR = process.env.ORACLE_DIR || path.join(ROOT, 'oracle-py');

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function blindKeys(vs, c) {
  const out = new Set();
  for (const v of vs) {
    let rule = v.rule;
    if (rule.startsWith('ATTR:')) rule = 'REQ:' + rule.slice(5);
    if (rule === 'VIEW') rule = `VIEW:${c.viewPolicy && c.viewPolicy.viewType}`;
    out.add(`${rule}|${[...v.grounding].sort().join(',')}`);
  }
  return out;
}
function sanitize(m) {
  const ids = new Set(m.nodes.map((n) => n.id));
  return { id: m.id, nodes: m.nodes, edges: m.edges.filter((e) => ids.has(e.src) && ids.has(e.tgt)) };
}

function cache() {
  const out = path.resolve(arg('--cache'));
  if (fs.existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const work = path.resolve(arg('--work', path.join(os.tmpdir(), `oracle-replay-${process.pid}`)));
  const D = path.join(TREE, 'dist');
  const { aerospaceCatalog, automotiveCatalog, roboticsCatalog, catalogSwapPair } = require(path.join(D, 'catalog/domains'));
  const { counterexampleCatalog } = require(path.join(D, 'generator/counterexampleFamily'));
  const { randomCatalog, randomModel } = require(path.join(D, 'oracle/randomModels'));
  const { Rng } = require(path.join(D, 'util/rng'));
  const { runOracle } = require(path.join(D, 'oracle/bridge'));
  const { oracleKeys } = require(path.join(D, 'oracle/compare'));
  const t0 = Date.now();
  const groups = [];
  // (R)
  const fixed = [aerospaceCatalog(), automotiveCatalog(), roboticsCatalog(), catalogSwapPair().c2, counterexampleCatalog()];
  for (const c of fixed) {
    const rng = new Rng(910000 + fixed.indexOf(c));
    const cases = [];
    for (let i = 0; i < 400; i++) cases.push({ caseId: `${c.id}-${i}`, model: randomModel(rng, c, `${c.id}-${i}`, 7, 10) });
    groups.push({ set: 'random', catalog: c, cases });
  }
  const rng = new Rng(920000);
  for (let k = 0; k < 50; k++) {
    const c = randomCatalog(rng, `rc${k}`);
    const cases = [];
    for (let i = 0; i < 25; i++) cases.push({ caseId: `rc${k}-${i}`, model: randomModel(rng, c, `rc${k}-${i}`, 6, 9) });
    groups.push({ set: 'random', catalog: c, cases });
  }
  // (B)
  const blindInput = JSON.parse(fs.readFileSync(path.join(BLIND, 'inputs', 'batch-blind.json'), 'utf8'));
  for (const b of blindInput.batches) groups.push({ set: 'blind', catalog: b.catalog, cases: b.models });
  // SHACL oracle on all groups
  for (let i = 0; i < groups.length; i += 10) {
    const part = groups.slice(i, i + 10);
    const res = runOracle(part.map((g) => ({ catalog: g.catalog, cases: g.cases })), path.join(work, 'oracle'));
    res.forEach((r, j) => {
      part[j].oracle = {};
      for (const cs of part[j].cases) part[j].oracle[cs.caseId] = [...oracleKeys(r.violations[cs.caseId] || [])].sort();
    });
    console.log(`oracle ${Math.min(i + 10, groups.length)}/${groups.length}`);
  }
  // blind SQL oracle on the sanitized blind input
  const blindGroups = groups.filter((g) => g.set === 'blind');
  fs.mkdirSync(work, { recursive: true });
  const inF = path.join(work, 'blind-in.json');
  const outF = path.join(work, 'blind-out.json');
  fs.writeFileSync(inF, JSON.stringify({ batches: blindGroups.map((g) => ({ catalog: g.catalog, models: g.cases.map((cs) => ({ caseId: cs.caseId, model: sanitize(cs.model) })) })) }));
  const r = spawnSync(SYS_PY, ['-B', '-I', path.join(ROOT, 'blind-compare', 'run_blind_on.py'), BLIND, inF, outF], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`blind failed: ${r.stderr}`);
  const bres = JSON.parse(fs.readFileSync(outF, 'utf8'));
  for (const g of blindGroups) {
    g.blindSan = {};
    for (const cs of g.cases) g.blindSan[cs.caseId] = [...blindKeys(bres.violations[cs.caseId] || [], g.catalog)].sort();
  }
  const doc = {
    experiment: 'r10-oracle-cache',
    createdAt: new Date().toISOString(),
    seconds: (Date.now() - t0) / 1000,
    sources: {
      random: 'cli-oracle random --fixed 400 --rcat 50 (seeds 910000+i, 920000)',
      blind: 'oracle-blind/inputs/batch-blind.json',
      blindInputSha256: sha(path.join(BLIND, 'inputs', 'batch-blind.json')),
      sqlValidatorSha256: bres.sqlValidatorSha256,
      oraclePySha256: { run_oracle: sha(path.join(process.env.ORACLE_DIR, 'run_oracle.py')), shapes: sha(path.join(process.env.ORACLE_DIR, 'shapes.py')), rdf_export: sha(path.join(process.env.ORACLE_DIR, 'rdf_export.py')) },
    },
    groups,
  };
  fs.writeFileSync(out, JSON.stringify(doc), { flag: 'wx' });
  console.log(`written ${out} (${doc.seconds.toFixed(1)} s)`);
}

/** Child: evaluate the dist in argv[3] on the cache in argv[4]; prints one JSON line. */
function child() {
  const dist = process.argv[3];
  const doc = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const res = { cases: 0, caughtO: 0, caughtB: 0, crashes: 0, engineVsReference: 0, perSet: {}, example: null };
  let mods;
  try {
    mods = {
      normalize: require(path.join(dist, 'model/graph')).normalizeToTypedGraph,
      deriveRules: require(path.join(dist, 'catalog/rules')).deriveRules,
      validate: require(path.join(dist, 'validator/engine')).validate,
      reference: require(path.join(dist, 'reference/referenceSemantics')).referenceValidate,
      engineKeys: require(path.join(dist, 'oracle/compare')).engineKeys,
    };
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ loadError: String(e).slice(0, 200) })}\n`);
    return;
  }
  const neq = (a, b) => a.size !== b.size || [...a].some((k) => !b.has(k));
  for (const g of doc.groups) {
    const ps = (res.perSet[g.set] = res.perSet[g.set] || { cases: 0, caughtO: 0, caughtB: 0, crashes: 0, engineVsReference: 0 });
    let rules;
    try {
      rules = mods.deriveRules(g.catalog);
    } catch (e) {
      rules = e;
    }
    for (const cs of g.cases) {
      res.cases++;
      ps.cases++;
      let E;
      let R;
      try {
        if (rules instanceof Error) throw rules;
        const gr = mods.normalize(cs.model);
        E = mods.engineKeys(mods.validate(gr, g.catalog, rules));
        R = mods.engineKeys(mods.reference(gr, g.catalog, rules));
      } catch (e) {
        res.crashes++;
        ps.crashes++;
        res.caughtO++;
        ps.caughtO++;
        if (g.set === 'blind') {
          res.caughtB++;
          ps.caughtB++;
        }
        if (!res.example) res.example = { caseId: cs.caseId, error: String(e).slice(0, 160) };
        continue;
      }
      const O = new Set(g.oracle[cs.caseId]);
      if (neq(E, O)) {
        res.caughtO++;
        ps.caughtO++;
        if (!res.example) res.example = { caseId: cs.caseId, engineOnly: [...E].filter((k) => !O.has(k)).slice(0, 4), oracleOnly: [...O].filter((k) => !E.has(k)).slice(0, 4) };
      }
      if (g.set === 'blind') {
        const B = new Set(g.blindSan[cs.caseId]);
        if (neq(E, B)) {
          res.caughtB++;
          ps.caughtB++;
        }
      }
      if (neq(E, R)) {
        res.engineVsReference++;
        ps.engineVsReference++;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(res)}\n`);
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

function runChild(dist, cacheFile) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--max-old-space-size=4096', __filename, 'child', dist, cacheFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => c.kill('SIGKILL'), 600000);
    c.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        resolve({ loadError: `no output: ${out.slice(0, 160)}` });
      }
    });
  });
}

async function run() {
  const cacheFile = path.resolve(arg('--cache'));
  const outFile = path.resolve(arg('--output'));
  if (fs.existsSync(outFile)) throw new Error(`refusing to overwrite ${outFile}`);
  const mjson = JSON.parse(fs.readFileSync(path.resolve(arg('--mutants')), 'utf8'));
  let list = mjson.survivors;
  if (arg('--ids')) {
    const ids = new Set(arg('--ids').split(',').map(Number));
    list = list.filter((m) => ids.has(m.id));
  }
  const workers = Number(arg('--workers', 3));
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-replay-'));
  const dists = [];
  for (let w = 0; w < workers; w++) {
    const d = path.join(tmp, `w${w}`, 'dist');
    copyDir(path.join(TREE, 'dist'), d);
    dists.push(d);
  }
  const baseline = await runChild(dists[0], cacheFile);
  console.log(`baseline ${JSON.stringify(baseline)}`);
  if (baseline.loadError || baseline.caughtO !== 0 || baseline.caughtB !== 0 || baseline.engineVsReference !== 0) throw new Error('unmutated engine disagrees with the cached oracles');
  const rows = [];
  let next = 0;
  const work = async (w) => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const m = list[i];
      const lines = fs.readFileSync(path.join(TREE, 'src', m.file), 'utf8').split('\n');
      const orig = lines[m.line - 1];
      if (orig.trim() !== m.original) throw new Error(`line mismatch for mutant ${m.id}`);
      lines[m.line - 1] = orig.slice(0, orig.length - orig.trimStart().length) + m.mutated;
      const js = ts.transpileModule(lines.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, esModuleInterop: true } }).outputText;
      const target = path.join(dists[w], m.file.replace(/\.ts$/, '.js'));
      const saved = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, js, 'utf8');
      const r = await runChild(dists[w], cacheFile);
      fs.writeFileSync(target, saved, 'utf8');
      rows.push({ id: m.id, file: m.file, line: m.line, operator: m.operator, ...r });
      console.log(`${rows.length}/${list.length} mutant ${m.id}: O ${r.caughtO} B ${r.caughtB} crash ${r.crashes} E-vs-R ${r.engineVsReference}`);
    }
  };
  const t0 = Date.now();
  await Promise.all(dists.map((_, w) => work(w)));
  rows.sort((a, b) => a.id - b.id);
  fs.rmSync(tmp, { recursive: true, force: true });
  const doc = {
    experiment: 'r10-oracle-replay',
    command: process.argv.slice(1).join(' '),
    cache: { file: cacheFile, sha256: sha(cacheFile) },
    mutantsFrom: path.resolve(arg('--mutants')),
    method: 'mutated snapshot dist; per case E = engineKeys(validate(normalizeToTypedGraph(model))); caughtO = E differs from the cached SHACL-oracle keys or E throws; caughtB = same against the blind SQL oracle on the sanitized blind input (blind set only); engineVsReference = E differs from the mutated reference implementation',
    baseline,
    rows,
    seconds: (Date.now() - t0) / 1000,
    toolSha256: sha(__filename),
  };
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2), { flag: 'wx' });
  console.log(`written ${outFile}`);
}

const cmd = process.argv[2];
if (cmd === 'cache') cache();
else if (cmd === 'child') child();
else if (cmd === 'run') run().catch((e) => {
  console.error(e);
  process.exit(1);
});
else {
  console.error('usage: oracle-replay.js cache|run ...');
  process.exit(2);
}
