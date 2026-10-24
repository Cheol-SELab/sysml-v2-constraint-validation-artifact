/**
 * Mutation analysis of the verification harness (review item M4).
 *
 * Systematic first-order mutants are generated from the TypeScript sources of the engine,
 * the incremental session, the witness stores, and two modules shared by the engine and the
 * reference semantics (rule derivation/value domains, graph normalization/neighbourhoods).
 * Each mutant is transpiled, swapped into a private copy of the compiled tree, and judged by
 * a reduced E1 harness in a child process (mutationHarness). A mutant is killed when a stage
 * reports a counterexample, when the harness crashes, or when it exceeds the time limit.
 *
 * Operators: ROR (relational operator replacement), LCR (&& <-> ||), NEG (negated if
 * condition), BOOL (return true <-> false), STMT (continue/break removed), INC (++ <-> --,
 * + 1 <-> - 1), CONST (integer literal in a comparison incremented).
 * Excluded lines: comments, imports, template-literal message lines, cost counters
 * (opCounter, work counters, fallback/step statistics), thrown errors.
 *
 * Environment: MUT_ROOT = root holding src/ and dist/ (default: package root);
 * MUT_WORKERS = parallel workers (default 3); MUT_TIMEOUT_MS (default 180000);
 * MUT_LIMIT = maximum mutants per file (default: all); MUT_TS_ROOT = package root holding
 * node_modules/typescript (default: package root).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

interface Mutant {
  id: number;
  file: string;
  line: number;
  operator: string;
  original: string;
  mutated: string;
}

function replaceAt(line: string, idx: number, len: number, rep: string): string {
  return line.slice(0, idx) + rep + line.slice(idx + len);
}

function* matches(line: string, needle: string): Generator<number> {
  let i = line.indexOf(needle);
  while (i >= 0) {
    yield i;
    i = line.indexOf(needle, i + 1);
  }
}

function lineMutants(line: string): Array<{ operator: string; mutated: string }> {
  const out: Array<{ operator: string; mutated: string }> = [];
  const ror: Array<[string, string]> = [
    [' === ', ' !== '],
    [' !== ', ' === '],
    [' <= ', ' < '],
    [' >= ', ' > '],
    [' < ', ' <= '],
    [' > ', ' >= '],
  ];
  for (const [a, b] of ror) for (const i of matches(line, a)) out.push({ operator: 'ROR', mutated: replaceAt(line, i, a.length, b) });
  for (const [a, b] of [
    [' && ', ' || '],
    [' || ', ' && '],
  ] as Array<[string, string]>)
    for (const i of matches(line, a)) out.push({ operator: 'LCR', mutated: replaceAt(line, i, a.length, b) });
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
  for (const [a, b] of [
    ['return true', 'return false'],
    ['return false', 'return true'],
  ] as Array<[string, string]>)
    for (const i of matches(line, a)) out.push({ operator: 'BOOL', mutated: replaceAt(line, i, a.length, b) });
  for (const a of ['continue;', 'break;']) for (const i of matches(line, a)) out.push({ operator: 'STMT', mutated: replaceAt(line, i, a.length, '{}') });
  for (const [a, b] of [
    ['++', '--'],
    ['--', '++'],
    [' + 1', ' - 1'],
    [' - 1', ' + 1'],
  ] as Array<[string, string]>)
    for (const i of matches(line, a)) out.push({ operator: 'INC', mutated: replaceAt(line, i, a.length, b) });
  const re = /(<=|>=|<|>|===|!==) (\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const num = Number(m[2]);
    const start = m.index + m[1].length + 1;
    out.push({ operator: 'CONST', mutated: replaceAt(line, start, m[2].length, String(num + 1)) });
  }
  return out.filter((x) => x.mutated !== line);
}

function generate(srcRoot: string, limit: number): Mutant[] {
  const out: Mutant[] = [];
  let id = 0;
  for (const t of TARGETS) {
    const lines = fs.readFileSync(path.join(srcRoot, t.file), 'utf8').split('\n');
    let count = 0;
    let legacy = false;
    lines.forEach((line, i) => {
      // the subject-side view order is a comparison setting that is off by default; its lines
      // are not part of the configuration under test
      if (line.includes("engineConfig.viewOrder === 'subject'")) legacy = true;
      if (legacy) {
        if (line.trimEnd() === '      }') legacy = false;
        return;
      }
      if (EXCLUDE.some((re) => re.test(line))) return;
      for (const lm of lineMutants(line)) {
        if (count >= limit) return;
        out.push({ id: id++, file: t.file, line: i + 1, operator: lm.operator, original: line.trim(), mutated: lm.mutated.trim() });
        count++;
      }
    });
  }
  return out;
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function runHarness(distRoot: string, timeoutMs: number): Promise<{ killedBy: string | null; detail: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(distRoot, 'verification', 'mutationHarness.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (ms >= timeoutMs - 50) return resolve({ killedBy: 'timeout', detail: '', ms });
      try {
        const lastLine = out.trim().split('\n').pop() ?? '';
        const r = JSON.parse(lastLine) as { killedBy: string | null; detail: string };
        resolve({ ...r, ms });
      } catch {
        resolve({ killedBy: 'crash:load', detail: out.slice(0, 200), ms });
      }
    });
  });
}

export async function runMutationAnalysis(quick = false): Promise<unknown> {
  const root = process.env.MUT_ROOT ?? path.join(__dirname, '..', '..');
  const workers = Number(process.env.MUT_WORKERS ?? 3);
  const timeoutMs = Number(process.env.MUT_TIMEOUT_MS ?? 180000);
  const limit = quick ? 6 : Number(process.env.MUT_LIMIT ?? Infinity);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require(path.join(process.env.MUT_TS_ROOT ?? path.join(__dirname, '..', '..'), 'node_modules', 'typescript')) as typeof import('typescript');
  const mutants = generate(path.join(root, 'src'), limit);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-'));
  const dists: string[] = [];
  for (let w = 0; w < workers; w++) {
    const d = path.join(tmp, `w${w}`, 'dist');
    copyDir(path.join(root, 'dist'), d);
    dists.push(d);
  }
  // sanity: the unmutated harness must pass
  const baseline = await runHarness(dists[0], timeoutMs);
  const results: Array<Mutant & { killedBy: string | null; detail: string; ms: number }> = [];
  let next = 0;
  const work = async (w: number): Promise<void> => {
    const dist = dists[w];
    for (;;) {
      const i = next++;
      if (i >= mutants.length) return;
      const m = mutants[i];
      const srcPath = path.join(root, 'src', m.file);
      const lines = fs.readFileSync(srcPath, 'utf8').split('\n');
      const orig = lines[m.line - 1];
      const lead = orig.slice(0, orig.length - orig.trimStart().length);
      lines[m.line - 1] = lead + m.mutated;
      const js = ts.transpileModule(lines.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, esModuleInterop: true } }).outputText;
      const target = path.join(dist, m.file.replace(/\.ts$/, '.js'));
      const saved = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, js, 'utf8');
      const r = await runHarness(dist, timeoutMs);
      fs.writeFileSync(target, saved, 'utf8');
      results.push({ ...m, ...r });
      if (results.length % 25 === 0) console.log(`mutation: ${results.length}/${mutants.length}`);
    }
  };
  const t0 = Date.now();
  await Promise.all(dists.map((_, w) => work(w)));
  results.sort((a, b) => a.id - b.id);
  fs.rmSync(tmp, { recursive: true, force: true });

  const score = (rs: typeof results): unknown => {
    const killed = rs.filter((r) => r.killedBy !== null).length;
    const byStage: Record<string, number> = {};
    for (const r of rs) {
      const k = r.killedBy ?? 'survived';
      byStage[k] = (byStage[k] ?? 0) + 1;
    }
    return { mutants: rs.length, killed, survived: rs.length - killed, mutationScore: rs.length === 0 ? null : Math.round((killed / rs.length) * 10000) / 10000, byStage };
  };
  return {
    experiment: 'M4-mutation-analysis',
    root,
    workers,
    timeoutMs,
    harness: 'reduced E1: BE-base (n<=2,m<=3; n=3,m<=2; templates T1-T3) -> BE-ext (T4-T10) -> PB (12 cases x 30 steps, P1-P6, P1f) -> INV (9 cases x 10 steps, I1-I3); first failing stage recorded',
    baselineHarness: baseline,
    operators: 'ROR, LCR, NEG, BOOL, STMT, INC, CONST (first-order, one textual change per mutant)',
    excludedLines: EXCLUDE.map((r) => r.source),
    total: score(results),
    byFile: Object.fromEntries(TARGETS.map((t) => [t.file, { role: t.role, ...(score(results.filter((r) => r.file === t.file)) as object) }])),
    byOperator: Object.fromEntries(['ROR', 'LCR', 'NEG', 'BOOL', 'STMT', 'INC', 'CONST'].map((o) => [o, score(results.filter((r) => r.operator === o))])),
    survivors: results.filter((r) => r.killedBy === null).map((r) => ({ id: r.id, file: r.file, line: r.line, operator: r.operator, original: r.original, mutated: r.mutated })),
    mutants: results.map((r) => ({ id: r.id, file: r.file, line: r.line, operator: r.operator, killedBy: r.killedBy, ms: r.ms })),
    elapsedMs: Date.now() - t0,
  };
}
