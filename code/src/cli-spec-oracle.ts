/**
 * Round-2 review item N1: specialization semantics under the independent SHACL oracle.
 *
 *   node dist/cli-spec-oracle.js corpus --out <new dir>   83 public models, specialization mode
 *   node dist/cli-spec-oracle.js x3     --out <new dir>   X3 (a)/(b) edits re-judged by the oracle,
 *                                                        plus (a') attribute edits of elements with a
 *                                                        non-empty down-set, propagated through S1
 *
 * The oracle (oracle-py/run_oracle_multi.py) receives every node with
 *   flat : the full class set computed by S1 (one rdf:type per catalog class), or
 *   rdfs : only the node's own statement as an RDF class, the direct generalizations
 *          (typing, specialization, subsetting, redefinition, reference subsetting, implicit
 *          library supertype) as rdfs:subClassOf, and A(t) rdfs:subClassOf t; pySHACL computes
 *          the closure with inference='rdfs' (owlrl), so the closure is not taken from TypeScript.
 * Attribute values (including inherited ones) are passed as S1 computed them.
 * Results are written into a new directory only.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { aerospaceCatalog, allCatalogs } from './catalog/domains';
import { deriveRules, maxLocalRadius } from './catalog/rules';
import { applyChanges, changeSupportNodes, cloneGraph, graphToModel, normalizeToTypedGraph } from './model/graph';
import { Catalog, Change, SysMLLikeModel, TypedGraph, Violation } from './model/types';
import { catalogData, OracleViolation, ORACLE_DIR, ORACLE_PY } from './oracle/bridge';
import { diff, engineKeys, oracleKeys } from './oracle/compare';
import { loadLibrary, loadUnits, semanticModelFor, Unit } from './sysml/corpus';
import { sysmlWellFormednessCatalog } from './sysml/experiments';
import { CATALOG_ANCHORS, LevelMode, normalizeSysML, S1Result } from './sysml/normalize';
import { SStatement } from './sysml/parser';
import { SemanticModel } from './sysml/semantics';
import { ClassMap, revalidateScoped, validateSpec } from './sysml/specEngine';
import { Rng } from './util/rng';
import { validate } from './validator/engine';

const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus', 'SysML-v2-Release');
const SRC = path.join(CORPUS, 'sysml', 'src');
const LIB = path.join(CORPUS, 'sysml.library');
const GROUPS = ['examples', 'training', 'validation'];

interface Hierarchy {
  nodeClass: Record<string, string>;
  subClassOf: [string, string][];
  anchors: Record<string, string>;
}
type MultiModel = SysMLLikeModel & { nodes: (SysMLLikeModel['nodes'][number] & { types: string[] })[]; hierarchy: Hierarchy };

/** Direct-generalization export of the statements reachable from the nodes (no closure computed here). */
function exportHierarchy(sm: SemanticModel, s1: S1Result): Hierarchy {
  const nodeClass: Record<string, string> = {};
  const seen = new Set<number>();
  const queue: SStatement[] = [];
  for (const [id, p] of s1.nodeProv) {
    nodeClass[id] = String(p.uid);
    const s = sm.stmt(p.uid)!;
    if (!seen.has(s.uid)) {
      seen.add(s.uid);
      queue.push(s);
    }
  }
  const subClassOf: [string, string][] = [];
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i];
    for (const g of sm.generals(x)) {
      subClassOf.push([String(x.uid), String(g.uid)]);
      if (!seen.has(g.uid)) {
        seen.add(g.uid);
        queue.push(g);
      }
    }
  }
  const anchors: Record<string, string> = {};
  for (const [t, q] of Object.entries(CATALOG_ANCHORS)) {
    const a = sm.libAnchor(q);
    if (a) anchors[t] = String(a.uid);
  }
  return { nodeClass, subClassOf, anchors };
}

function multiModel(id: string, g: TypedGraph, classes: ClassMap, h: Hierarchy): MultiModel {
  const m = graphToModel(g);
  return {
    id,
    nodes: m.nodes.map((n) => ({ ...n, attrs: { ...n.attrs }, types: [...(classes.get(n.id) ?? new Set([n.type]))].sort() })),
    edges: m.edges,
    hierarchy: h,
  };
}

interface MultiResult {
  violations: Record<string, OracleViolation[]>;
  inferredClasses?: Record<string, Record<string, string[]>>;
  rules: { id: string }[];
  timing: { validateMs: number };
}

let counter = 0;
function runMultiOracle(work: string, catalog: Catalog, cases: { caseId: string; model: MultiModel }[], mode: 'flat' | 'rdfs'): MultiResult {
  fs.mkdirSync(work, { recursive: true });
  const tag = `${process.pid}-${counter++}`;
  const inF = path.join(work, `multi-in-${tag}.json`);
  const outF = path.join(work, `multi-out-${tag}.json`);
  fs.writeFileSync(inF, JSON.stringify({ batches: [{ catalog: catalogData(catalog), models: cases }] }));
  const r = spawnSync(ORACLE_PY, ['-B', path.join(ORACLE_DIR, 'run_oracle_multi.py'), inF, outF, '--types', mode], {
    cwd: ORACLE_DIR,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error(`multi oracle failed (${r.status}): ${r.stderr}`);
  const res = JSON.parse(fs.readFileSync(outF, 'utf8')).batches[0] as MultiResult;
  fs.unlinkSync(inF);
  fs.unlinkSync(outF);
  return res;
}

function sha256(f: string): string {
  return createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

function codeIdentity(): Record<string, string> {
  const files = [
    'src/cli-spec-oracle.ts',
    'src/sysml/specEngine.ts',
    'src/sysml/normalize.ts',
    'src/sysml/semantics.ts',
    'src/validator/engine.ts',
    'src/catalog/rules.ts',
    'oracle-py/run_oracle_multi.py',
    'oracle-py/rdf_export.py',
    'oracle-py/shapes.py',
    'oracle-py/run_oracle.py',
  ];
  return Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(ROOT, f)) ? sha256(path.join(ROOT, f)) : 'missing']));
}

function writeNew(dir: string, name: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  if (fs.existsSync(f)) throw new Error(`refusing to overwrite ${f}`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  console.log(`written: ${f}`);
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function bump(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

function ruleOf(k: string): string {
  return k.split('|')[0];
}

// ------------------------------------------------------------------------------ corpus

function corpus(out: string): void {
  const work = path.join(out, 'work');
  const lib = loadLibrary(LIB);
  const units = loadUnits(SRC, GROUPS);
  const catalogs: Catalog[] = [...allCatalogs(), sysmlWellFormednessCatalog()];
  const rows: unknown[] = [];
  const mismatches: unknown[] = [];
  const classAgreement: Record<string, unknown> = {};
  for (const levels of ['all', 'usage'] as LevelMode[]) {
    const prepared = units.map((u) => {
      const sm = semanticModelFor(u, units, lib);
      const s1 = normalizeSysML(sm, 'specialization', levels);
      const g = normalizeToTypedGraph({ ...s1.model, id: u.id });
      const h = exportHierarchy(sm, s1);
      return { u, s1, g, model: multiModel(u.id, g, s1.classes, h) };
    });
    const multiNodes = prepared.reduce((s, p) => s + [...p.s1.classes.values()].filter((c) => c.size > 1).length, 0);
    const nodes = prepared.reduce((s, p) => s + p.g.nodes.size, 0);
    let classChecked = false;
    for (const c of catalogs) {
      const rules = deriveRules(c);
      const cases = prepared.map((p) => ({ caseId: p.u.id, model: p.model }));
      const flat = runMultiOracle(work, c, cases, 'flat');
      const rdfs = runMultiOracle(work, c, cases, 'rdfs');
      if (!classChecked && rdfs.inferredClasses) {
        // S1 class sets vs RDFS-entailed class sets (catalog-independent; checked once per level mode)
        let agree = 0;
        let differ = 0;
        const examples: unknown[] = [];
        for (const p of prepared) {
          const inf = rdfs.inferredClasses[p.u.id] ?? {};
          for (const [id, cls] of p.s1.classes) {
            const a = [...cls].sort().join(',');
            const b = (inf[id] ?? []).join(',');
            if (a === b) agree++;
            else {
              differ++;
              if (examples.length < 20) examples.push({ unit: p.u.id, node: id, s1: a, rdfs: b });
            }
          }
        }
        classAgreement[levels] = { nodes: agree + differ, agree, differ, examples };
        classChecked = true;
      }
      const st = {
        levels,
        catalog: c.id,
        units: cases.length,
        nodes,
        multiClassNodes: multiNodes,
        engineMulti: 0,
        engineSingleProjection: 0,
        oracleFlat: 0,
        oracleRdfs: 0,
        mismatchingCasesFlat: 0,
        mismatchingCasesRdfs: 0,
        engineOnlyRdfs: {} as Record<string, number>,
        oracleOnlyRdfs: {} as Record<string, number>,
        multiMinusSingle: 0,
        singleMinusMulti: 0,
        multiVsSingleByRule: {} as Record<string, number>,
        ruleCountMismatch: rules.length !== rdfs.rules.length || rules.length !== flat.rules.length,
      };
      for (const p of prepared) {
        const em = engineKeys(validateSpec(p.g, p.s1.classes, rules));
        const es = engineKeys(validate(p.g, c, rules));
        const of = oracleKeys(flat.violations[p.u.id] ?? []);
        const or = oracleKeys(rdfs.violations[p.u.id] ?? []);
        st.engineMulti += em.size;
        st.engineSingleProjection += es.size;
        st.oracleFlat += of.size;
        st.oracleRdfs += or.size;
        const df = diff(em, of);
        const dr = diff(em, or);
        if (df.engineOnly.length + df.oracleOnly.length > 0) st.mismatchingCasesFlat++;
        if (dr.engineOnly.length + dr.oracleOnly.length > 0) {
          st.mismatchingCasesRdfs++;
          for (const k of dr.engineOnly) bump(st.engineOnlyRdfs, ruleOf(k));
          for (const k of dr.oracleOnly) bump(st.oracleOnlyRdfs, ruleOf(k));
          if (mismatches.length < 40) mismatches.push({ levels, catalog: c.id, unit: p.u.id, flat: df, rdfs: dr });
        }
        const ds = diff(em, es);
        st.multiMinusSingle += ds.engineOnly.length;
        st.singleMinusMulti += ds.oracleOnly.length;
        for (const k of [...ds.engineOnly, ...ds.oracleOnly]) bump(st.multiVsSingleByRule, ruleOf(k).split(':')[0]);
      }
      rows.push(st);
      console.log(JSON.stringify(st));
    }
  }
  writeNew(out, 'n1-spec-oracle-corpus.json', {
    experiment: 'N1 specialization-mode differential test against the multi-type SHACL oracle',
    input: 'public SysML v2 models (SysML-v2-Release tag 2026-08; examples, training, validation), S1 specialization mode',
    engine: 'sysml/specEngine.validateSpec (multi-class evaluator, the evaluator behind E7/X2); engineSingleProjection = validator/engine.validate on the one-type-per-node projection',
    oracle: {
      flat: 'oracle-py/run_oracle_multi.py --types flat: one rdf:type per S1 class, pySHACL inference none',
      rdfs: 'oracle-py/run_oracle_multi.py --types rdfs: direct generalizations as rdfs:subClassOf, anchors A(t) rdfs:subClassOf t, pySHACL inference rdfs (owlrl); closure not taken from TypeScript',
      shared: 'name resolution of the direct generals and attribute values (including inherited values) come from S1',
    },
    classAgreement,
    rows,
    mismatches,
    codeIdentity: codeIdentity(),
  });
}

// ------------------------------------------------------------------------------ X3 re-check

function touched(ch: Change[]): string[] {
  const out: string[] = [];
  for (const c of ch) {
    if (c.kind === 'addEdge') out.push(c.edge.src, c.edge.tgt);
    if (c.kind === 'setAttr') out.push(c.id);
  }
  return out;
}

interface EditRec {
  part: 'a' | 'a2' | 'b';
  unit: string;
  caseId: string;
  kind: string;
  model: MultiModel;
  truth: Set<string>;
  inc?: Set<string>;
  naive?: Set<string>;
  witness?: Set<string>;
  note?: string;
  changed?: boolean;
}

/** S1-level attribute edit of statement s: hide own attribute features named attr, add a literal one. */
function withAttributeEdit<T>(sm: SemanticModel, s: SStatement, attr: string, value: unknown, fn: () => T): T {
  const hidden: SStatement[] = [];
  for (const c of s.children) if (c.name === attr && !sm.hidden.has(c.uid)) hidden.push(c);
  for (const c of hidden) sm.hidden.add(c.uid);
  let synthetic: SStatement | undefined;
  if (value !== undefined) {
    const tok = typeof value === 'number' ? { k: 'num', v: String(value), line: s.line } : { k: 'str', v: String(value), line: s.line };
    synthetic = {
      uid: 900000000 + counter++,
      file: s.file,
      line: s.line,
      kind: 'attribute',
      isDef: false,
      prefixes: [],
      metadata: [],
      isRef: false,
      name: attr,
      typedBy: [],
      specializes: [],
      subsets: [],
      redefines: [],
      references: [],
      value: [tok as never],
      owner: s,
      children: [],
      header: [],
      isLibrary: false,
    };
    s.children.push(synthetic);
  }
  sm.invalidate();
  try {
    return fn();
  } finally {
    if (synthetic) s.children.splice(s.children.indexOf(synthetic), 1);
    for (const c of hidden) sm.hidden.delete(c.uid);
    sm.invalidate();
  }
}

function x3(out: string, maxUnits: number): void {
  const work = path.join(out, 'work');
  const lib = loadLibrary(LIB);
  const units = loadUnits(SRC, GROUPS);
  const cat0 = aerospaceCatalog();
  const rules0 = deriveRules(cat0);
  const k = maxLocalRadius(rules0);
  // identical RNG stream and edit generation as sysml/experiments.ts X3
  const rng = new Rng(20261020);
  const perUnitEdits = 30;
  const catalogAttrNames = new Set<string>([...Object.values(cat0.requiredAttr).flat(), ...Object.keys(cat0.domain).map((x) => x.split('.')[1])]);
  const recs: EditRec[] = [];
  const a2Stats = { candidates: 0, skippedName: 0, notExpressible: 0, propagatedToOthers: 0, examples: [] as unknown[] };
  let unitsDone = 0;

  for (const u of units) {
    const sm = semanticModelFor(u, units, lib);
    const s1 = normalizeSysML(sm, 'specialization', 'all');
    const g0 = normalizeToTypedGraph({ ...s1.model, id: u.id });
    if (g0.nodes.size === 0) continue;
    if (unitsDone++ >= maxUnits) break;
    const classes0 = s1.classes;
    const h0 = exportHierarchy(sm, s1);
    const before = validateSpec(g0, classes0, rules0);
    const beforeKeys = engineKeys(before);
    // down-sets of node statements (proper, nodes only)
    const downSet = new Map<string, string[]>();
    for (const [id, p] of s1.nodeProv) {
      const xs: string[] = [];
      for (const [id2, p2] of s1.nodeProv) if (id2 !== id && sm.closure(sm.stmt(p2.uid)!).has(p.uid)) xs.push(id2);
      downSet.set(id, xs);
    }

    // ---- (a) edits of G under a fixed hierarchy (same stream as X3)
    const nodeIds = [...g0.nodes.keys()];
    const edgeIds = [...g0.edges.keys()];
    for (let i = 0; i < perUnitEdits; i++) {
      const g = cloneGraph(g0);
      const ch: Change[] = [];
      const roll = rng.next();
      if (roll < 0.35) {
        const n = rng.pick(nodeIds);
        const attr = rng.pick(['name', 'mass', 'criticality', 'priority', 'direction', 'method']);
        const val = rng.bernoulli(0.5) ? undefined : rng.pick(['A', 'high', 'in', 'test', 12000, 50, 'x']);
        ch.push({ kind: 'setAttr', id: n, attr, value: val });
      } else if (roll < 0.65 && edgeIds.length > 0) {
        ch.push({ kind: 'delEdge', id: rng.pick(edgeIds) });
      } else {
        const t = rng.pick(['contain', 'satisfy', 'connect', 'allocate', 'dependOn', 'verify']);
        ch.push({ kind: 'addEdge', edge: { id: `x3a#${i}`, type: t, src: rng.pick(nodeIds), tgt: rng.pick(nodeIds) } });
      }
      const seeds = changeSupportNodes(g, ch);
      applyChanges(g, ch);
      for (const id of touched(ch)) if (g.nodes.has(id)) seeds.push(id);
      const truth = engineKeys(validateSpec(g, classes0, rules0));
      const inc = engineKeys(revalidateScoped(g, classes0, rules0, before, seeds, k).violations);
      const caseId = `a:${u.id}:${i}`;
      recs.push({ part: 'a', unit: u.id, caseId, kind: ch[0].kind, model: multiModel(caseId, g, classes0, h0), truth, inc, changed: !setEq(truth, beforeKeys) });

      // ---- (a') the same attribute edit read as an edit of H when the element has a non-empty down-set
      const c0 = ch[0];
      if (c0.kind === 'setAttr' && (downSet.get(c0.id) ?? []).length > 0) {
        a2Stats.candidates++;
        if (c0.attr === 'name') {
          a2Stats.skippedName++;
          continue;
        }
        const s = sm.stmt(s1.nodeProv.get(c0.id)!.uid)!;
        const res = withAttributeEdit(sm, s, c0.attr, c0.value, () => {
          const s1b = normalizeSysML(sm, 'specialization', 'all');
          return { s1b, gb: normalizeToTypedGraph({ ...s1b.model, id: u.id }), hb: exportHierarchy(sm, s1b) };
        });
        const nb = res.gb.nodes.get(c0.id);
        if (!nb || nb.attrs[c0.attr] !== c0.value) {
          a2Stats.notExpressible++;
          continue;
        }
        const truthB = engineKeys(validateSpec(res.gb, res.s1b.classes, rules0));
        const changedOthers = [...(downSet.get(c0.id) ?? [])].filter((y) => {
          const a = g0.nodes.get(y)?.attrs[c0.attr];
          const b = res.gb.nodes.get(y)?.attrs[c0.attr];
          return a !== b;
        });
        if (changedOthers.length > 0) a2Stats.propagatedToOthers++;
        const naive = engineKeys(revalidateScoped(res.gb, res.s1b.classes, rules0, before, [c0.id], k, g0).violations);
        const witness = engineKeys(revalidateScoped(res.gb, res.s1b.classes, rules0, before, [c0.id, ...(downSet.get(c0.id) ?? [])], k, g0).violations);
        const id2 = `a2:${u.id}:${i}`;
        if (a2Stats.examples.length < 10 && changedOthers.length > 0) a2Stats.examples.push({ unit: u.id, node: c0.id, attr: c0.attr, value: c0.value, inheritorsChanged: changedOthers });
        recs.push({ part: 'a2', unit: u.id, caseId: id2, kind: `setAttr(${changedOthers.length > 0 ? 'propagates' : 'local'})`, model: multiModel(id2, res.gb, res.s1b.classes, res.hb), truth: truthB, inc: undefined, naive, witness, note: `downSet=${downSet.get(c0.id)!.length}`, changed: !setEq(truthB, beforeKeys) });
      }
    }

    // ---- (b) edits of H (same stream and selection as X3)
    const generalOf = new Map<number, SStatement[]>();
    for (const s of sm.unitStatements) {
      for (const g of sm.explicitGenerals(s)) {
        if (g.isLibrary) continue;
        const l = generalOf.get(g.uid) ?? [];
        l.push(s);
        generalOf.set(g.uid, l);
      }
    }
    const targets = sm.unitStatements.filter((s) => generalOf.has(s.uid));
    const editList: Array<{ kind: string; s: SStatement; attr?: SStatement }> = [];
    for (const s of targets) {
      if (sm.explicitGenerals(s).some((g) => !g.isLibrary)) editList.push({ kind: 'removeGeneralizations', s });
      const attrs = s.children.filter((c) => c.kind === 'attribute' && c.name);
      if (attrs.length > 0) editList.push({ kind: 'deleteAttribute', s, attr: rng.pick(attrs) });
      const relevant = attrs.filter((c) => catalogAttrNames.has(c.name!) && c.name !== 'name');
      if (relevant.length > 0) editList.push({ kind: 'deleteCatalogAttribute', s, attr: rng.pick(relevant) });
    }
    const chosen = [...editList.filter((e) => e.kind === 'deleteCatalogAttribute'), ...rng.shuffle(editList.filter((e) => e.kind !== 'deleteCatalogAttribute')).slice(0, perUnitEdits)];
    let bi = 0;
    for (const ed of chosen) {
      const downSetUids = new Set<number>();
      for (const x of sm.unitStatements) if (sm.closure(x).has(ed.s.uid)) downSetUids.add(x.uid);
      const witnessUids = new Set<number>(downSetUids);
      const addOwned = (x: SStatement): void => {
        for (const c of x.children) {
          if (witnessUids.has(c.uid)) continue;
          witnessUids.add(c.uid);
          addOwned(c);
        }
      };
      for (const uid of downSetUids) addOwned(sm.stmt(uid)!);
      if (ed.kind === 'removeGeneralizations') {
        const keep = sm.generals(ed.s).filter((g) => g.isLibrary && !sm.explicitGenerals(ed.s).includes(g));
        sm.overrideGenerals(ed.s, keep);
      } else sm.hide(ed.attr!);
      const s1b = normalizeSysML(sm, 'specialization', 'all');
      const gb = normalizeToTypedGraph({ ...s1b.model, id: u.id });
      const hb = exportHierarchy(sm, s1b);
      const truth = engineKeys(validateSpec(gb, s1b.classes, rules0));
      sm.clearOverrides();
      const editedNode = (() => {
        let cur: SStatement | undefined = ed.s;
        while (cur) {
          const id = s1.nodeOfStmt.get(cur.uid);
          if (id) return id;
          cur = cur.owner;
        }
        return undefined;
      })();
      const seedsNaive = editedNode ? [editedNode] : [];
      const naive = engineKeys(revalidateScoped(gb, s1b.classes, rules0, before, seedsNaive, k, g0).violations);
      const seedsWitness = [...seedsNaive];
      for (const uid of witnessUids) {
        const id = s1b.nodeOfStmt.get(uid) ?? s1.nodeOfStmt.get(uid);
        if (id) seedsWitness.push(id);
      }
      const witness = engineKeys(revalidateScoped(gb, s1b.classes, rules0, before, seedsWitness, k, g0).violations);
      const caseId = `b:${u.id}:${bi++}`;
      recs.push({ part: 'b', unit: u.id, caseId, kind: ed.kind, model: multiModel(caseId, gb, s1b.classes, hb), truth, naive, witness, changed: !setEq(truth, beforeKeys) });
    }
    console.log(`x3 ${u.id}: ${recs.length} records so far`);
  }

  // ---- oracle on every post-state (rdfs mode: closure computed by the oracle)
  const oracle = new Map<string, Set<string>>();
  const chunk = 200;
  for (let i = 0; i < recs.length; i += chunk) {
    const part = recs.slice(i, i + chunk);
    const res = runMultiOracle(work, cat0, part.map((r) => ({ caseId: r.caseId, model: r.model })), 'rdfs');
    for (const r of part) oracle.set(r.caseId, oracleKeys(res.violations[r.caseId] ?? []));
    console.log(`oracle ${Math.min(i + chunk, recs.length)}/${recs.length}`);
  }
  const summary: Record<string, Record<string, number>> = {};
  const mism: unknown[] = [];
  for (const r of recs) {
    const key = `${r.part}:${r.kind}`;
    const s = (summary[key] = summary[key] ?? { edits: 0, batchChanged: 0, truthEqualsOracle: 0, incEqualsTruth: 0, incEqualsOracle: 0, naiveEqualsTruth: 0, naiveEqualsOracle: 0, witnessEqualsTruth: 0, witnessEqualsOracle: 0, naiveWrongWhenChanged: 0, witnessWrongWhenChanged: 0 });
    const o = oracle.get(r.caseId)!;
    s.edits++;
    const tEq = setEq(r.truth, o);
    if (tEq) s.truthEqualsOracle++;
    if (r.changed) s.batchChanged++;
    if (r.inc && setEq(r.inc, r.truth)) s.incEqualsTruth++;
    if (r.naive && setEq(r.naive, r.truth)) s.naiveEqualsTruth++;
    if (r.witness && setEq(r.witness, r.truth)) s.witnessEqualsTruth++;
    if (r.changed && r.naive && !setEq(r.naive, o)) s.naiveWrongWhenChanged++;
    if (r.changed && r.witness && !setEq(r.witness, o)) s.witnessWrongWhenChanged++;
    if (r.inc && setEq(r.inc, o)) s.incEqualsOracle++;
    if (r.naive && setEq(r.naive, o)) s.naiveEqualsOracle++;
    if (r.witness && setEq(r.witness, o)) s.witnessEqualsOracle++;
    if (!tEq && mism.length < 40) {
      const d = diff(r.truth, o);
      mism.push({ caseId: r.caseId, kind: r.kind, engineOnly: d.engineOnly, oracleOnly: d.oracleOnly });
    }
  }
  // batchChanged relative to the unit's pre-state (needs the before set per unit): recomputed from records
  const roll = (p: string) => {
    const acc: Record<string, number> = { edits: 0, batchChanged: 0, truthEqualsOracle: 0, incEqualsTruth: 0, incEqualsOracle: 0, naiveEqualsTruth: 0, naiveEqualsOracle: 0, witnessEqualsTruth: 0, witnessEqualsOracle: 0, naiveWrongWhenChanged: 0, witnessWrongWhenChanged: 0 };
    for (const [k2, v] of Object.entries(summary)) if (k2.startsWith(p + ':')) for (const f of Object.keys(acc)) acc[f] += v[f] ?? 0;
    return acc;
  };
  writeNew(out, 'n1-x3-oracle.json', {
    experiment: 'N1: X3 incremental-scope experiment re-judged by the multi-type SHACL oracle (rdfs mode)',
    catalog: cat0.id,
    k,
    unitsProcessed: unitsDone,
    definitions: {
      a: 'X3 (a) edits of G (same RNG stream 20261020 as sysml/experiments.ts); classes and attributes of other nodes fixed; incremental = scoped re-validation on N_k(delta)',
      a2: "(a') the (a) attribute edits whose target element has a non-empty proper down-set, re-read as an edit of H: the attribute feature of the statement is replaced (S1 re-run, inheritance propagates); naive = scope seeded with the edited node, witness = seeded with the edited node and its down-set; 'name' is excluded (identity, not inherited)",
      b: 'X3 (b) edits of H (same selection); naive / witness scopes as in X3',
    },
    a2Selection: a2Stats,
    totals: { a: roll('a'), a2: roll('a2'), b: roll('b') },
    byPartAndKind: summary,
    truthOracleMismatches: mism,
    codeIdentity: codeIdentity(),
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const oi = args.indexOf('--out');
  if (oi < 0) throw new Error('--out <new dir> required');
  const out = path.resolve(args[oi + 1]);
  const mi = args.indexOf('--max-units');
  const maxUnits = mi >= 0 ? Number(args[mi + 1]) : Number.POSITIVE_INFINITY;
  const t0 = Date.now();
  if (cmd === 'corpus') corpus(out);
  else if (cmd === 'x3') x3(out, maxUnits);
  else throw new Error('usage: cli-spec-oracle.js corpus|x3 --out <new dir> [--max-units N]');
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main();
