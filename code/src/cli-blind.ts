/**
 * n20 (round-2 review): three-way comparison of the engine, the SHACL oracle (oracle-py) and
 * the blind SQL oracle (codes/oracle-blind, written from the manuscript definitions only).
 *
 *   node dist-r8/cli-blind.js --blind <oracle-blind dir> --out <new dir> [--work <dir>]
 *
 * The blind code and its stored output are read-only inputs. The blind oracle is re-run
 * (unmodified, via blind-compare/run_blind_on.py) on a sanitized copy of the input in which
 * edges with a missing endpoint are removed; the stored blind output on the original input is
 * checked for byte-level reproduction first.
 *
 * Key normalization (documented in the report and in the output JSON, field `normalization`):
 *   K1 rule class prefix: blind ATTR:<t>.<a> and engine ATTR:<t>.<a> -> REQ:<t>.<a> (oracle name).
 *   K2 rule instance: blind VIEW (no instance suffix) -> VIEW:<viewPolicy.viewType>; all other
 *      instance names (TYPE:<t>, DOM:<t>.<a>, MULT:<t>|<u>|<dir>, ISO:<t>, ACYC:<t>, TRACE:<id>)
 *      are identical on the three sides.
 *   K3 grounding: evidence ids sorted (violation key MkViol of the manuscript). TYPE uses the
 *      edge id only (oracle grounding (e, src, tgt) -> (e)). ACYC uses the node set of the SCC
 *      (oracle cyclic edges projected to weak components of the cyclic-edge subgraph, as in E2).
 *   K4 duplicates: keys are compared as sets (VIEW (v1,v2)/(v2,v1) and repeated expose edges
 *      collapse to one key on every side).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { deriveRules } from './catalog/rules';
import { normalizeToTypedGraph } from './model/graph';
import { Catalog, SysMLLikeModel } from './model/types';
import { runOracle, OracleCase } from './oracle/bridge';
import { engineKeys, oracleKeys } from './oracle/compare';
import { referenceValidate } from './reference/referenceSemantics';
import { validate } from './validator/engine';

const ROOT = path.join(__dirname, '..');
const SYS_PY = process.env.SYS_PYTHON ?? 'C:/Python311/python.exe';

interface BlindViolation {
  cls: string;
  rule: string;
  grounding: string[];
}
interface Batch {
  catalog: Catalog;
  models: OracleCase[];
}

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  if (dflt === undefined) throw new Error(`missing ${name}`);
  return dflt;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function blindKeys(vs: BlindViolation[], c: Catalog): Set<string> {
  const out = new Set<string>();
  for (const v of vs) {
    let rule = v.rule;
    if (rule.startsWith('ATTR:')) rule = 'REQ:' + rule.slice(5); // K1
    if (rule === 'VIEW') rule = `VIEW:${c.viewPolicy?.viewType}`; // K2
    out.add(`${rule}|${[...v.grounding].sort().join(',')}`); // K3
  }
  return out;
}

function cls(k: string): string {
  return k.split(':', 1)[0].split('|')[0];
}

function danglingIds(m: SysMLLikeModel): Set<string> {
  const ids = new Set(m.nodes.map((n) => n.id));
  return new Set(m.edges.filter((e) => !ids.has(e.src) || !ids.has(e.tgt)).map((e) => e.id));
}

function sanitize(m: SysMLLikeModel): SysMLLikeModel {
  const d = danglingIds(m);
  return { id: m.id, nodes: m.nodes, edges: m.edges.filter((e) => !d.has(e.id)) };
}

function runBlind(blindDir: string, batches: Batch[], work: string, tag: string): Record<string, BlindViolation[]> {
  fs.mkdirSync(work, { recursive: true });
  const inF = path.join(work, `blind-in-${tag}.json`);
  const outF = path.join(work, `blind-out-${tag}.json`);
  fs.writeFileSync(inF, JSON.stringify({ batches }));
  const r = spawnSync(SYS_PY, ['-B', '-I', path.join(ROOT, 'blind-compare', 'run_blind_on.py'), blindDir, inF, outF], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`blind run failed: ${r.stderr}`);
  const res = JSON.parse(fs.readFileSync(outF, 'utf8'));
  fs.unlinkSync(inF);
  fs.unlinkSync(outF);
  return res.violations;
}

type Side = 'E' | 'O' | 'B';

// ------------------------------------------------------------------ probes for the 21 recorded ambiguities

type N = [string, string, Record<string, string | number | boolean>?];
type Ed = [string, string, string, string];
const mk = (id: string, nodes: N[], edges: Ed[]): SysMLLikeModel => ({
  id,
  nodes: nodes.map(([nid, type, attrs]) => ({ id: nid, type, attrs: attrs ?? {} })),
  edges: edges.map(([eid, type, src, tgt]) => ({ id: eid, type, src, tgt })),
});

function probeCatalog(id: string, view: { s: string; x: string; c: string } = { s: 's', x: 'x', c: 'c' }): Catalog {
  return {
    id,
    nodeTypes: ['A', 'B', 'V'],
    edgeTypes: ['p', 'q', 's', 'x', 'c'],
    allowed: { p: { src: ['A'], tgt: ['B'] } },
    requiredAttr: { A: ['k'] },
    domain: { 'A.r': { kind: 'range', min: 0, max: 2 }, 'A.e': { kind: 'enum', values: [1, 'x', true] }, 'A.s': { kind: 'nonEmptyString' }, 'B.e2': { kind: 'enum', values: ['1'] } },
    multiplicity: { 'A|q|out': [1, 1], 'A|q|in': [1, 1], 'B|p|in': [1, -1] },
    acyclic: ['q'],
    tracePolicy: [
      { id: 'T0', sourceType: 'A', edgeTypes: ['p', 'q'], targetType: 'A' },
      { id: 'T1', sourceType: 'B', edgeTypes: [], targetType: 'A' },
      { id: 'T2', sourceType: 'B', edgeTypes: ['p'], targetType: 'V' },
    ],
    nonIsolated: ['A', 'B'],
    viewPolicy: { viewType: 'V', subjectEdgeType: view.s, exposeEdgeType: view.x, containEdgeType: view.c },
  };
}

function A0(id: string, attrs: Record<string, string | number | boolean> = {}): N {
  return [id, 'A', { k: 'ok', ...attrs }];
}

/** One probe per recorded ambiguity that is observable on the typed-graph input. */
function probes(): { item: string; question: string; catalog: Catalog; model: SysMLLikeModel; focus: string[] }[] {
  const A = A0;
  const P = probeCatalog('probe');
  const Pc = probeCatalog('probe-coincide', { s: 'x', x: 'x', c: 'x' });
  return [
    { item: '1', question: 'DOM range closed [min,max]', catalog: P, model: mk('p1', [A('a0', { r: 0 }), A('a1', { r: 2 }), A('a2', { r: 2.5 }), A('a3', { r: -0.5 })], []), focus: ['DOM:A.r'] },
    { item: '2', question: 'DOM range: string "1" and boolean true are not numbers', catalog: P, model: mk('p2', [A('a0', { r: '1' }), A('a1', { r: true }), A('a2', { r: 1 })], []), focus: ['DOM:A.r'] },
    { item: '3', question: 'DOM enum: value and primitive kind must match ("1" != 1, true != 1, 1 == 1.0)', catalog: P, model: mk('p3', [A('a0', { e: '1' }), A('a1', { e: 1.0 }), A('a2', { e: true }), A('a3', { e: false }), A('a4', { e: 'x' }), ['b0', 'B', { e2: 1 }], ['b1', 'B', { e2: '1' }]], []), focus: ['DOM:A.e', 'DOM:B.e2'] },
    { item: '4', question: 'DOM nonEmptyString: " " valid, "" and numbers invalid, no trimming', catalog: P, model: mk('p4', [A('a0', { s: ' ' }), A('a1', { s: '' }), A('a2', { s: 5 })], []), focus: ['DOM:A.s'] },
    { item: '5', question: 'DOM: absent attribute passes (ATTR decides)', catalog: P, model: mk('p5', [A('a0'), ['a1', 'A', {}]], []), focus: ['DOM:', 'REQ:'] },
    { item: '6', question: 'ATTR: present with "", 0 or false counts as defined', catalog: P, model: mk('p6', [['a0', 'A', { k: '' }], ['a1', 'A', { k: 0 }], ['a2', 'A', { k: false }]], []), focus: ['REQ:'] },
    { item: '7', question: 'DOM evaluated for a domain key whose attribute is not required', catalog: P, model: mk('p7', [A('a0', { r: 9 })], []), focus: ['DOM:A.r'] },
    { item: '9', question: 'edge type absent from Allowed / from the catalog: no TYPE rule', catalog: P, model: mk('p9', [A('a0'), ['b0', 'B']], [['e0', 'q', 'b0', 'a0'], ['e1', 'z', 'b0', 'a0']]), focus: ['TYPE:'] },
    { item: '10', question: 'dangling edge: excluded from G (engine/oracle) vs kept (blind)', catalog: P, model: mk('p10', [A('a0'), ['b0', 'B']], [['e0', 'p', 'a0', 'ghost'], ['e1', 'q', 'a0', 'ghost'], ['e2', 'q', 'ghost', 'a0']]), focus: ['TYPE:', 'MULT:', 'ISO:', 'ACYC:'] },
    { item: '11', question: 'MULT counts edges (parallel edges count twice); a self-loop counts once out and once in', catalog: P, model: mk('p11', [A('a0'), A('a1')], [['e0', 'q', 'a0', 'a0'], ['e1', 'q', 'a1', 'a0'], ['e2', 'q', 'a1', 'a0']]), focus: ['MULT:'] },
    { item: '12', question: 'MULT: no edge at all violates a lower bound >= 1', catalog: P, model: mk('p12', [A('a0'), ['b0', 'B']], []), focus: ['MULT:'] },
    { item: '13', question: 'ISO: a self-loop or an edge of an uncatalogued type makes a node non-isolated', catalog: P, model: mk('p13', [A('a0'), A('a1'), ['b0', 'B'], ['b1', 'B']], [['e0', 'z', 'a0', 'a0'], ['e1', 'q', 'b0', 'b0']]), focus: ['ISO:'] },
    {
      item: '14a', question: 'VIEW: any one of several subject edges suffices; contain starts at tgt(e1)', catalog: P,
      model: mk('p14a', [['v0', 'V'], A('a0'), A('a1'), ['b0', 'B'], ['b1', 'B']], [['e0', 's', 'v0', 'a0'], ['e1', 's', 'v0', 'a1'], ['e2', 'c', 'a1', 'b0'], ['e3', 'x', 'v0', 'b0'], ['e4', 'x', 'v0', 'b1'], ['e5', 'c', 'v0', 'b1']]), focus: ['VIEW:'],
    },
    {
      item: '14b', question: 'VIEW: repeated expose edges and mutual exposure collapse to one key', catalog: P,
      model: mk('p14b', [['v0', 'V'], ['v1', 'V'], A('a0')], [['e0', 'x', 'v0', 'v1'], ['e1', 'x', 'v1', 'v0'], ['e2', 'x', 'v0', 'a0'], ['e3', 'x', 'v0', 'a0']]), focus: ['VIEW:'],
    },
    {
      item: '14c', question: 'VIEW: subject, expose and contain edge types coincide (formula applied literally)', catalog: Pc,
      model: mk('p14c', [['v0', 'V'], A('a0'), ['b0', 'B'], ['b1', 'B']], [['e0', 'x', 'v0', 'a0'], ['e1', 'x', 'a0', 'b0'], ['e2', 'x', 'b0', 'b1']]), focus: ['VIEW:'],
    },
    { item: '15', question: 'ACYC: self-loop is a one-node SCC; one key per SCC', catalog: P, model: mk('p15', [A('a0'), A('a1'), A('a2'), A('a3')], [['e0', 'q', 'a0', 'a0'], ['e1', 'q', 'a1', 'a2'], ['e2', 'q', 'a2', 'a3'], ['e3', 'q', 'a3', 'a1'], ['e4', 'q', 'a1', 'a3']]), focus: ['ACYC:'] },
    { item: '16a', question: 'TRACE: path length >= 1; a source of the target type on a cycle reaches itself', catalog: P, model: mk('p16a', [A('a0'), A('a1'), A('a2')], [['e0', 'q', 'a0', 'a0'], ['e1', 'p', 'a1', 'a1']]), focus: ['TRACE:T0'] },
    { item: '16b', question: 'TRACE: empty edge-type set -> every source violates; no target nodes -> every source violates', catalog: P, model: mk('p16b', [['b0', 'B'], ['b1', 'B'], A('a0')], [['e0', 'p', 'a0', 'b0']]), focus: ['TRACE:T1', 'TRACE:T2'] },
    { item: '16c', question: 'TRACE: no source node -> no violation', catalog: P, model: mk('p16c', [A('a0')], []), focus: ['TRACE:T1', 'TRACE:T2'] },
  ];
}

function lastErrorLine(e: unknown): string {
  const lines = String((e as Error).message).split(/\r?\n/).filter((l) => /Error/.test(l));
  return lines.length > 0 ? lines[lines.length - 1].trim() : String((e as Error).message).slice(0, 200);
}

function runProbes(blindDir: string, out: string, work: string): void {
  const ps = probes();
  const batches: Batch[] = ps.map((p) => ({ catalog: p.catalog, models: [{ caseId: `probe-${p.item}`, model: p.model }] }));
  const blind = runBlind(blindDir, batches, work, 'probes');
  const oracle = runOracle(batches.map((b) => ({ catalog: b.catalog, cases: b.models })), path.join(work, 'oracle'));
  const rows = ps.map((p, i) => {
    const g = normalizeToTypedGraph(p.model);
    const rules = deriveRules(p.catalog);
    const E = [...engineKeys(validate(g, p.catalog, rules))].sort();
    const O = [...oracleKeys(oracle[i].violations[`probe-${p.item}`] ?? [])].sort();
    const B = [...blindKeys(blind[`probe-${p.item}`] ?? [], p.catalog)].sort();
    const inFocus = (k: string) => p.focus.some((f) => k.startsWith(f));
    const fE = E.filter(inFocus);
    const fO = O.filter(inFocus);
    const fB = B.filter(inFocus);
    return { item: p.item, question: p.question, engine: fE, oracle: fO, blind: fB, threeAgreeOnFocus: fE.join() === fO.join() && fE.join() === fB.join(), threeAgreeAll: E.join() === O.join() && E.join() === B.join() };
  });
  // duplicate identifiers (ambiguity 20): each implementation is run on its own
  const dupModel = mk('dup', [A0('a0'), A0('a0')], [['e0', 'q', 'a0', 'a0'], ['e0', 'p', 'a0', 'a0']]);
  const dup: Record<string, string> = {};
  try {
    normalizeToTypedGraph(dupModel);
    dup.engine = 'accepted';
  } catch (e) {
    dup.engine = `rejected: ${(e as Error).message}`;
  }
  try {
    runOracle([{ catalog: probeCatalog('dup'), cases: [{ caseId: 'dup', model: dupModel }] }], path.join(work, 'oracle'));
    dup.oracle = 'accepted';
  } catch (e) {
    dup.oracle = `rejected: ${lastErrorLine(e)}`;
  }
  try {
    runBlind(blindDir, [{ catalog: probeCatalog('dup'), models: [{ caseId: 'dup', model: dupModel }] }], work, 'dup');
    dup.blind = 'accepted';
  } catch (e) {
    dup.blind = `rejected: ${lastErrorLine(e)}`;
  }
  const file = path.join(out, 'n20-ambiguity-probes.json');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ experiment: 'n20-ambiguity-probes', note: 'one typed-graph probe per observable ambiguity of oracle-blind/INTERPRETATION.md; items 8 (single type, S1 level), 17-19 (naming, dedup, ordering) and 21 (float64) are not observable as violation-set differences on this input format', rows, duplicateIds: dup }, null, 2), { flag: 'wx' });
  console.log(`written ${file}`);
  for (const r of rows) console.log(`${r.threeAgreeOnFocus ? 'agree   ' : 'DISAGREE'} ${r.item} ${r.question} | E ${r.engine.join(' ')} | O ${r.oracle.join(' ')} | B ${r.blind.join(' ')}`);
  console.log(JSON.stringify(dup));
}

function main(): void {
  if (process.argv[2] === 'probes') {
    const out = path.resolve(arg('--out'));
    runProbes(path.resolve(arg('--blind')), out, path.resolve(arg('--work', path.join(out, 'work'))));
    return;
  }
  const blindDir = path.resolve(arg('--blind'));
  const out = path.resolve(arg('--out'));
  const work = path.resolve(arg('--work', path.join(out, 'work')));
  fs.mkdirSync(out, { recursive: true });
  const outFile = path.join(out, 'n20-blind-threeway.json');
  if (fs.existsSync(outFile)) throw new Error(`refusing to overwrite ${outFile}`);
  const t0 = Date.now();

  const inputFile = path.join(blindDir, 'inputs', 'batch-blind.json');
  const storedFile = path.join(blindDir, 'out', 'violations-blind.json');
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as { batches: Batch[] };
  const stored = JSON.parse(fs.readFileSync(storedFile, 'utf8')) as Record<string, BlindViolation[]>;

  // 0. reproduction of the stored blind output with the unmodified code
  const reBlind = runBlind(blindDir, input.batches, work, 'orig');
  const storedReproduced = JSON.stringify(reBlind) === JSON.stringify(stored);

  // 1. sanitized input (dangling edges removed)
  const sanBatches: Batch[] = input.batches.map((b) => ({ catalog: b.catalog, models: b.models.map((m) => ({ caseId: m.caseId, model: sanitize(m.model) })) }));
  const blindSan = runBlind(blindDir, sanBatches, work, 'san');

  // 2. oracle on the original input (oracle-py drops dangling edges itself: rdf_export.add_model)
  const oracleRes: Record<string, ReturnType<typeof oracleKeys>> = {};
  for (let i = 0; i < input.batches.length; i += 4) {
    const part = input.batches.slice(i, i + 4);
    const res = runOracle(part.map((b) => ({ catalog: b.catalog, cases: b.models })), path.join(work, 'oracle'));
    for (const r of res) for (const [cid, vs] of Object.entries(r.violations)) oracleRes[cid] = oracleKeys(vs);
    console.log(`oracle batches ${Math.min(i + 4, input.batches.length)}/${input.batches.length}`);
  }

  // 3. engine and reference on the original input (normalizeToTypedGraph drops dangling edges)
  const totals = { E: 0, O: 0, B: 0, Bsan: 0, R: 0 };
  const perClass: Record<string, Record<string, number>> = {};
  const patterns: Record<string, number> = {};
  const patternsSan: Record<string, number> = {};
  const byClassPattern: Record<string, Record<string, number>> = {};
  const byClassPatternSan: Record<string, Record<string, number>> = {};
  const examples: Record<string, unknown[]> = {};
  const mismatchCases = { EvsO: 0, EvsB: 0, OvsB: 0, EvsBsan: 0, OvsBsan: 0, EvsRef: 0 };
  let models = 0;
  let edges = 0;
  let dangling = 0;
  let modelsWithDangling = 0;
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const bump2 = (m: Record<string, Record<string, number>>, a: string, b: string) => {
    m[a] = m[a] ?? {};
    bump(m[a], b);
  };

  for (const b of input.batches) {
    const rules = deriveRules(b.catalog);
    for (const cs of b.models) {
      models++;
      const d = danglingIds(cs.model);
      edges += cs.model.edges.length;
      dangling += d.size;
      if (d.size > 0) modelsWithDangling++;
      const g = normalizeToTypedGraph(cs.model);
      const E = engineKeys(validate(g, b.catalog, rules));
      const R = engineKeys(referenceValidate(g, b.catalog, rules));
      const O = oracleRes[cs.caseId];
      const B = blindKeys(reBlind[cs.caseId] ?? [], b.catalog);
      const Bs = blindKeys(blindSan[cs.caseId] ?? [], b.catalog);
      totals.E += E.size;
      totals.O += O.size;
      totals.B += B.size;
      totals.Bsan += Bs.size;
      totals.R += R.size;
      for (const k of B) bump2(perClass, 'B', cls(k));
      for (const k of E) bump2(perClass, 'E', cls(k));
      for (const k of O) bump2(perClass, 'O', cls(k));
      for (const k of Bs) bump2(perClass, 'Bsan', cls(k));
      const neq = (x: Set<string>, y: Set<string>) => x.size !== y.size || [...x].some((k) => !y.has(k));
      if (neq(E, O)) mismatchCases.EvsO++;
      if (neq(E, B)) mismatchCases.EvsB++;
      if (neq(O, B)) mismatchCases.OvsB++;
      if (neq(E, Bs)) mismatchCases.EvsBsan++;
      if (neq(O, Bs)) mismatchCases.OvsBsan++;
      if (neq(E, R)) mismatchCases.EvsRef++;
      const classify = (Bset: Set<string>, pat: Record<string, number>, bcp: Record<string, Record<string, number>>, tag: string) => {
        const all = new Set<string>([...E, ...O, ...Bset]);
        for (const k of all) {
          const sides = (['E', 'O', 'B'] as Side[]).filter((s) => (s === 'E' ? E : s === 'O' ? O : Bset).has(k)).join('');
          if (sides === 'EOB') continue;
          const p = `${sides}`;
          bump(pat, p);
          bump2(bcp, cls(k), p);
          const ek = `${tag}:${cls(k)}:${p}`;
          examples[ek] = examples[ek] ?? [];
          if (examples[ek].length < 6) {
            const touches = k.split('|')[1].split(',').some((id) => d.has(id) || cs.model.edges.some((e) => d.has(e.id) && (e.src === id || e.tgt === id)));
            examples[ek].push({ caseId: cs.caseId, key: k, modelHasDangling: d.size > 0, evidenceTouchesDanglingEdge: touches });
          }
        }
      };
      classify(B, patterns, byClassPattern, 'orig');
      classify(Bs, patternsSan, byClassPatternSan, 'san');
    }
  }

  const result = {
    experiment: 'n20-blind-threeway',
    inputs: {
      batchBlind: path.relative(ROOT, inputFile),
      batchBlindSha256: sha256(inputFile),
      storedBlindOutputSha256: sha256(storedFile),
      sqlValidatorSha256: sha256(path.join(blindDir, 'sql_oracle', 'sql_validator.py')),
      interpretationSha256: sha256(path.join(blindDir, 'INTERPRETATION.md')),
      generator: 'codes/_mk_blind_inputs.js: oracle/randomModels.randomModel (dangling endpoint "ghost" with p = 0.04 per endpoint), 3 evaluation catalogs x 300 (seed 20261022) + 20 random catalogs x 100 (seeds 7000+k)',
    },
    normalization: {
      K1: 'ATTR:<t>.<a> (blind, engine) -> REQ:<t>.<a> (oracle rule name)',
      K2: 'blind VIEW -> VIEW:<viewPolicy.viewType>; other rule instance names identical',
      K3: 'evidence ids sorted; TYPE evidence = edge id (oracle (e,src,tgt) projected to e); ACYC evidence = SCC node set (oracle cyclic edges -> weak components)',
      K4: 'keys compared as sets',
      dangling: 'engine (model/graph.normalizeToTypedGraph) and oracle (rdf_export.add_model) remove edges with a missing endpoint; the blind oracle keeps them. "sanitized" = the same input with those edges removed before the blind oracle runs.',
    },
    storedBlindOutputReproduced: storedReproduced,
    models,
    edges,
    danglingEdges: dangling,
    modelsWithDanglingEdges: modelsWithDangling,
    totals,
    perClass,
    mismatchingModels: mismatchCases,
    keyPatternsOriginal: patterns,
    keyPatternsSanitized: patternsSan,
    byClassPatternOriginal: byClassPattern,
    byClassPatternSanitized: byClassPatternSan,
    patternLegend: 'sides holding the key: E engine, O SHACL oracle, B blind SQL oracle; keys held by all three are omitted',
    examples,
    seconds: (Date.now() - t0) / 1000,
  };
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(`written ${outFile}`);
  console.log(JSON.stringify({ storedReproduced, totals, mismatchCases, patterns, patternsSan }, null, 1));
}

main();
