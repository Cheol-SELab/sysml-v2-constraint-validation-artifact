/**
 * Review n14: E5 on real edit history. Consecutive tags of the public SysML-v2-Release
 * repository (examples, training, validation; each tag with its own standard library) are
 * normalised by S1 (specialization classes, all levels). Node identity across tags is the
 * qualified name and kind of the element within its unit (occurrence index for repeated
 * names); edge identity is (type, source key, target key, occurrence). The S1 output of two
 * consecutive tags is diffed into a change set of primitive events (edge deletions, node
 * deletions, node additions, type replacements, attribute settings, edge additions), which
 * reproduces the next tag's graph exactly (checked). This change sequence replaces the
 * synthetic random / clustered edits of E5:
 *
 *   corpus level  all units of a tag merged into one model (unit-prefixed keys);
 *                 every non-empty transition replayed on its pre-state, per path;
 *                 the whole chronological sequence replayed as in E5 (per-step time).
 *   unit level    every unit changed by a transition, on its own graph.
 *
 * Paths and timing protocol as in E5 v2: batch = apply + full validation; S1 naive k-hop,
 * S2 hybrid, S3 witness stores, S3t threshold 0.02; graph copy and session construction are
 * excluded, change application included; one warm-up, median of reps. Correctness of every
 * path is compared with batch validation of the post-state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { aerospaceCatalog } from '../catalog/domains';
import { deriveRules, setDiff, violationSet } from '../catalog/rules';
import { bootstrapMedianCI, median, round } from '../evaluation/stats';
import { IncrementalSession, StrategyId } from '../incremental/session';
import { applyChanges, changeSupportNodes, normalizeToTypedGraph } from '../model/graph';
import { Catalog, Change, ModelEdge, ModelNode, Rule, SysMLLikeModel, TypedGraph } from '../model/types';
import { loadLibrary, loadUnits, semanticModelFor } from '../sysml/corpus';
import { normalizeSysML } from '../sysml/normalize';
import { opCounter, validate } from '../validator/engine';

const GROUPS = ['examples', 'training', 'validation'];
type PathId = 'batch' | 'S1' | 'S2' | 'S3' | 'S3t' | 'S3e';
/** S3e = S3 with eagerOutput (scan of all stored local violations and eager output list each step) */
const PATHS: PathId[] = ['batch', 'S1', 'S2', 'S3', 'S3t', 'S3e'];
const THRESHOLD = 0.02;

interface TagModels {
  tag: string;
  units: Map<string, SysMLLikeModel>;
  corpus: SysMLLikeModel;
}

/** S1 output of one unit with stable keys as ids. */
function keyed(unitId: string, m: SysMLLikeModel, qn: (id: string) => string): SysMLLikeModel {
  const map = new Map<string, string>();
  const seen = new Map<string, number>();
  const nodes: ModelNode[] = [];
  for (const n of m.nodes) {
    const base = `${unitId}/${qn(n.id)}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    const key = k === 0 ? base : `${base}#${k}`;
    map.set(n.id, key);
    nodes.push({ id: key, type: n.type, attrs: { ...n.attrs } });
  }
  const eseen = new Map<string, number>();
  const edges: ModelEdge[] = [];
  for (const e of m.edges) {
    const s = map.get(e.src)!;
    const t = map.get(e.tgt)!;
    const base = `${e.type}|${s}|${t}`;
    const k = eseen.get(base) ?? 0;
    eseen.set(base, k + 1);
    edges.push({ id: `${base}|${k}`, type: e.type, src: s, tgt: t });
  }
  return { id: unitId, nodes, edges };
}

function loadTag(dir: string, tag: string): TagModels {
  const lib = loadLibrary(path.join(dir, 'sysml.library'));
  const units = loadUnits(path.join(dir, 'sysml', 'src'), GROUPS);
  const out = new Map<string, SysMLLikeModel>();
  for (const u of units) {
    const r = normalizeSysML(semanticModelFor(u, units, lib), 'specialization', 'all');
    out.set(u.id, keyed(u.id, r.model, (id) => {
      const p = r.nodeProv.get(id)!;
      return `${p.qname}/${p.kind}`;
    }));
  }
  const corpus: SysMLLikeModel = { id: `corpus@${tag}`, nodes: [], edges: [] };
  for (const m of out.values()) {
    corpus.nodes.push(...m.nodes);
    corpus.edges.push(...m.edges);
  }
  return { tag, units: out, corpus };
}

/** Change set turning model a into model b (keys are ids). */
export function diffModels(a: SysMLLikeModel, b: SysMLLikeModel): Change[] {
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const ae = new Map(a.edges.map((e) => [e.id, e]));
  const be = new Map(b.edges.map((e) => [e.id, e]));
  const ch: Change[] = [];
  for (const [id] of ae) if (!be.has(id)) ch.push({ kind: 'delEdge', id });
  for (const [id] of an) if (!bn.has(id)) ch.push({ kind: 'delNode', id });
  for (const [id, n] of bn) {
    const o = an.get(id);
    if (!o) {
      ch.push({ kind: 'addNode', node: { id, type: n.type, attrs: { ...n.attrs } } });
      continue;
    }
    if (o.type !== n.type) {
      // type replacement event (Lemma 3 remark): same identifier, new type, incident edges kept
      ch.push({ kind: 'addNode', node: { id, type: n.type, attrs: { ...n.attrs } } });
      continue;
    }
    for (const attr of new Set([...Object.keys(o.attrs), ...Object.keys(n.attrs)])) {
      if (o.attrs[attr] !== n.attrs[attr]) ch.push({ kind: 'setAttr', id, attr, value: n.attrs[attr] });
    }
  }
  for (const [id, e] of be) if (!ae.has(id)) ch.push({ kind: 'addEdge', edge: { ...e } });
  return ch;
}

function sameGraph(g: TypedGraph, m: SysMLLikeModel): boolean {
  if (g.nodes.size !== m.nodes.length || g.edges.size !== m.edges.length) return false;
  for (const n of m.nodes) {
    const x = g.nodes.get(n.id);
    if (!x || x.type !== n.type) return false;
    const ka = Object.keys(x.attrs).sort();
    const kb = Object.keys(n.attrs).sort();
    if (ka.join('\u0000') !== kb.join('\u0000') || ka.some((k) => x.attrs[k] !== n.attrs[k])) return false;
  }
  for (const e of m.edges) {
    const x = g.edges.get(e.id);
    if (!x || x.src !== e.src || x.tgt !== e.tgt || x.type !== e.type) return false;
  }
  return true;
}

interface Runner {
  step(ch: Change[]): void;
}

function makeRunner(p: PathId, model: SysMLLikeModel, c: Catalog, rules: Rule[]): Runner {
  const g = normalizeToTypedGraph(model);
  if (p === 'batch') {
    return {
      step: (ch) => {
        applyChanges(g, ch);
        validate(g, c, rules);
      },
    };
  }
  const strategy: StrategyId = p === 'S1' ? 1 : p === 'S2' ? 2 : 3;
  const s = new IncrementalSession(g, c, rules, strategy, undefined, p === 'S3t' ? { rebuildThreshold: THRESHOLD } : p === 'S3e' ? { eagerOutput: true } : {});
  return { step: (ch) => void s.step(ch) };
}

/** Median time (ms) of replaying `seq` from `model` on path p; construction excluded. */
function timeSeq(p: PathId, model: SysMLLikeModel, c: Catalog, rules: Rule[], seq: Change[][], reps: number): number {
  const once = (): number => {
    const r = makeRunner(p, model, c, rules);
    const t0 = process.hrtime.bigint();
    for (const ch of seq) r.step(ch);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  once();
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) xs.push(once());
  return median(xs);
}

interface Audit {
  scopeShare: number;
  supportNodes: number;
  ops: Record<PathId, number>;
  mismatch: Record<'S1' | 'S2' | 'S3' | 'S3t' | 'S3e', number>;
  s3tFallback: boolean;
  batchViolationsAfter: number;
  changedViolationKeys: number;
}

function audit(model: SysMLLikeModel, c: Catalog, rules: Rule[], ch: Change[]): Audit {
  const gb = normalizeToTypedGraph(model);
  const before = violationSet(validate(gb, c, rules));
  const supp = changeSupportNodes(gb, ch);
  const o0 = opCounter.groundings + opCounter.scans + opCounter.globalWork;
  applyChanges(gb, ch);
  const truth = violationSet(validate(gb, c, rules));
  const ops = { batch: opCounter.groundings + opCounter.scans + opCounter.globalWork - o0 } as Record<PathId, number>;
  const mismatch = { S1: 0, S2: 0, S3: 0, S3t: 0, S3e: 0 };
  let scopeShare = 0;
  let s3tFallback = false;
  for (const k of ['S1', 'S2', 'S3', 'S3t', 'S3e'] as const) {
    const s = new IncrementalSession(normalizeToTypedGraph(model), c, rules, k === 'S1' ? 1 : k === 'S2' ? 2 : 3, undefined, k === 'S3t' ? { rebuildThreshold: THRESHOLD } : k === 'S3e' ? { eagerOutput: true } : {});
    const r = s.step(ch);
    ops[k] = r.groundingsEvaluated + r.localScans + r.globalWork;
    const got = violationSet(r.violations);
    mismatch[k] = setDiff(truth, got).length + setDiff(got, truth).length;
    if (k === 'S3') scopeShare = r.scopeSize / Math.max(1, gb.nodes.size);
    if (k === 'S3t') s3tFallback = r.batchGlobalRules > 0;
  }
  return {
    scopeShare,
    supportNodes: supp.length,
    ops,
    mismatch,
    s3tFallback,
    batchViolationsAfter: truth.size,
    changedViolationKeys: setDiff(truth, before).length + setDiff(before, truth).length,
  };
}

function ci(xs: number[]): { median: number; ci95: [number, number]; n: number } {
  if (xs.length === 0) return { median: NaN, ci95: [NaN, NaN], n: 0 };
  const r = bootstrapMedianCI(xs);
  return { median: round(r.point, 3), ci95: [round(r.lo, 3), round(r.hi, 3)], n: xs.length };
}

export function runE5History(tagsDir: string, quick = false): Record<string, unknown> {
  const c = aerospaceCatalog();
  const rules = deriveRules(c);
  let tags = fs
    .readdirSync(tagsDir)
    .filter((t) => /^\d{4}-\d{2}(\.\d+)?$/.test(t))
    .sort();
  if (quick) tags = tags.slice(-4);
  const loaded: TagModels[] = [];
  for (const t of tags) {
    loaded.push(loadTag(path.join(tagsDir, t), t));
    console.log(`E5hist loaded ${t}: V=${loaded[loaded.length - 1].corpus.nodes.length} E=${loaded[loaded.length - 1].corpus.edges.length}`);
  }
  const repsCorpus = quick ? 5 : 15;
  const repsUnit = quick ? 11 : 51;

  // ---- corpus level, one transition at a time
  const transitions: Record<string, unknown>[] = [];
  const seq: Change[][] = [];
  let reproduced = 0;
  let empty = 0;
  for (let i = 0; i + 1 < loaded.length; i++) {
    const A = loaded[i];
    const B = loaded[i + 1];
    const ch = diffModels(A.corpus, B.corpus);
    const g = normalizeToTypedGraph(A.corpus);
    applyChanges(g, ch);
    const exact = sameGraph(g, B.corpus);
    if (exact) reproduced++;
    if (ch.length === 0) {
      empty++;
      transitions.push({ from: A.tag, to: B.tag, events: 0, reproducesNextTag: exact });
      continue;
    }
    seq.push(ch);
    const byKind: Record<string, number> = {};
    for (const x of ch) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
    const changedUnits = [...B.units.keys()].filter((u) => {
      const a = A.units.get(u);
      return !a || diffModels(a, B.units.get(u)!).length > 0;
    }).length + [...A.units.keys()].filter((u) => !B.units.has(u)).length;
    const au = audit(A.corpus, c, rules, ch);
    const t: Record<string, number> = {};
    for (const p of PATHS) t[p] = timeSeq(p, A.corpus, c, rules, [ch], repsCorpus);
    const n = A.corpus.nodes.length;
    const m = A.corpus.edges.length;
    transitions.push({
      from: A.tag,
      to: B.tag,
      nodes: n,
      edges: m,
      events: ch.length,
      eventsByKind: byKind,
      changeRatio: round(ch.length / (n + m), 5),
      changedUnits,
      supportNodes: au.supportNodes,
      scopeShareS3: round(au.scopeShare, 4),
      reproducesNextTag: exact,
      changedViolationKeys: au.changedViolationKeys,
      batchViolationsAfter: au.batchViolationsAfter,
      stepMs: Object.fromEntries(PATHS.map((p) => [p, round(t[p], 4)])),
      speedupTime: Object.fromEntries((['S1', 'S2', 'S3', 'S3t', 'S3e'] as const).map((p) => [p, round(t.batch / Math.max(1e-6, t[p]), 3)])),
      ops: au.ops,
      speedupOps: Object.fromEntries((['S1', 'S2', 'S3', 'S3t', 'S3e'] as const).map((p) => [p, round(au.ops.batch / Math.max(1, au.ops[p]), 3)])),
      mismatchVsBatch: au.mismatch,
      s3tFallback: au.s3tFallback,
    });
    console.log(`E5hist ${A.tag}->${B.tag}: events ${ch.length}, scope ${au.scopeShare.toFixed(3)}, S3 x${(t.batch / t.S3).toFixed(2)}, exact ${exact}`);
  }

  // ---- corpus level, whole chronological sequence (E5 replay protocol)
  const first = loaded[0].corpus;
  const seqTimes: Record<string, number> = {};
  for (const p of PATHS) seqTimes[p] = seq.length > 0 ? timeSeq(p, first, c, rules, seq, repsCorpus) / seq.length : NaN;

  // ---- unit level
  const unitRows: Record<string, unknown>[] = [];
  for (let i = 0; i + 1 < loaded.length; i++) {
    const A = loaded[i];
    const B = loaded[i + 1];
    for (const [u, bm] of B.units) {
      const am = A.units.get(u);
      if (!am) continue; // a new unit is an initial validation, not an edit
      const ch = diffModels(am, bm);
      if (ch.length === 0 || am.nodes.length === 0) continue;
      const au = audit(am, c, rules, ch);
      const tb = timeSeq('batch', am, c, rules, [ch], repsUnit);
      const t3 = timeSeq('S3', am, c, rules, [ch], repsUnit);
      const t2 = timeSeq('S2', am, c, rules, [ch], repsUnit);
      const t3e = timeSeq('S3e', am, c, rules, [ch], repsUnit);
      unitRows.push({
        from: A.tag,
        to: B.tag,
        unit: u,
        nodes: am.nodes.length,
        edges: am.edges.length,
        events: ch.length,
        changeRatio: round(ch.length / (am.nodes.length + am.edges.length), 4),
        scopeShareS3: round(au.scopeShare, 4),
        batchViolationsAfter: au.batchViolationsAfter,
        stepMs: { batch: round(tb, 5), S2: round(t2, 5), S3: round(t3, 5), S3e: round(t3e, 5) },
        speedupTime: { S2: round(tb / Math.max(1e-6, t2), 3), S3: round(tb / Math.max(1e-6, t3), 3), S3e: round(tb / Math.max(1e-6, t3e), 3) },
        speedupOps: { S2: round(au.ops.batch / Math.max(1, au.ops.S2), 3), S3: round(au.ops.batch / Math.max(1, au.ops.S3), 3) },
        mismatchVsBatch: au.mismatch,
      });
    }
  }

  type T = { scopeShareS3: number; changeRatio: number; speedupTime: Record<string, number>; speedupOps: Record<string, number>; mismatchVsBatch: Record<string, number>; events: number };
  const nonEmpty = transitions.filter((x) => (x as { events: number }).events > 0) as unknown as T[];
  const U = unitRows as unknown as (T & { nodes: number })[];
  const sumMismatch = (rows: T[], k: string) => rows.reduce((a, r) => a + (r.mismatchVsBatch[k] ?? 0), 0);
  return {
    experiment: 'n14-e5-history',
    catalog: c.id,
    source: 'Systems-Modeling/SysML-v2-Release git tags (data only); per tag: sysml/src/{examples,training,validation} with the tag\'s own sysml.library; S1 specialization classes, levels = all',
    tags,
    identity: 'node key = unit id / qualified name / kind (#k for the k-th repeated key); edge key = type | source key | target key | occurrence',
    summary: {
      transitions: loaded.length - 1,
      emptyTransitions: empty,
      nonEmptyTransitions: nonEmpty.length,
      diffReproducesNextTag: `${reproduced}/${loaded.length - 1}`,
      corpus: {
        medianEvents: median(nonEmpty.map((r) => r.events)),
        maxEvents: Math.max(0, ...nonEmpty.map((r) => r.events)),
        medianChangeRatio: round(median(nonEmpty.map((r) => r.changeRatio)), 5),
        scopeShareS3: ci(nonEmpty.map((r) => r.scopeShareS3)),
        speedupTime: Object.fromEntries(['S1', 'S2', 'S3', 'S3t', 'S3e'].map((k) => [k, ci(nonEmpty.map((r) => r.speedupTime[k]))])),
        speedupOps: Object.fromEntries(['S1', 'S2', 'S3', 'S3t', 'S3e'].map((k) => [k, ci(nonEmpty.map((r) => r.speedupOps[k]))])),
        mismatchingViolationsVsBatch: Object.fromEntries(['S1', 'S2', 'S3', 'S3t', 'S3e'].map((k) => [k, sumMismatch(nonEmpty, k)])),
        sequenceReplay: {
          steps: seq.length,
          perStepMs: Object.fromEntries(PATHS.map((p) => [p, round(seqTimes[p], 4)])),
          speedupTime: Object.fromEntries((['S1', 'S2', 'S3', 'S3t', 'S3e'] as const).map((p) => [p, round(seqTimes.batch / Math.max(1e-6, seqTimes[p]), 3)])),
        },
      },
      unit: {
        unitEdits: U.length,
        medianNodes: median(U.map((r) => r.nodes)),
        medianEvents: median(U.map((r) => r.events)),
        medianChangeRatio: round(median(U.map((r) => r.changeRatio)), 4),
        scopeShareS3: ci(U.map((r) => r.scopeShareS3)),
        speedupTime: { S2: ci(U.map((r) => r.speedupTime.S2)), S3: ci(U.map((r) => r.speedupTime.S3)), S3e: ci(U.map((r) => r.speedupTime.S3e)) },
        speedupOps: { S2: ci(U.map((r) => r.speedupOps.S2)), S3: ci(U.map((r) => r.speedupOps.S3)) },
        mismatchingViolationsVsBatch: Object.fromEntries(['S1', 'S2', 'S3', 'S3t', 'S3e'].map((k) => [k, sumMismatch(U, k)])),
      },
    },
    transitions,
    unitEdits: unitRows,
  };
}
