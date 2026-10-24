/**
 * Real-SysML-v2 experiments (review items M1, M8).
 *
 *   X1 corpus and S1 normalization statistics (parse success, size, loss, mode differences)
 *   X2 validation of the corpus under the evaluation catalogs, vacuity per rule class,
 *      violations with pre-registered adjudication (adjudicate.ts)
 *   X3 specialization semantics: (a) changes to G with a fixed hierarchy H,
 *      (b) changes to H (generalization removal, attribute deletion)
 *   X4 E7 recalibration on the extended corpus with a calibration / holdout split and a
 *      permutation Kolmogorov-Smirnov test
 *   X5 batch and incremental validation time on the real models
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { aerospaceCatalog, automotiveCatalog } from '../catalog/domains';
import { deriveRules, maxLocalRadius, violationKey } from '../catalog/rules';
import { structureStats, StructureStats } from '../experiments/e5e7';
import { generateCleanModel } from '../generator/syntheticModelGenerator';
import { applyChanges, changeSupportNodes, cloneGraph, normalizeToTypedGraph } from '../model/graph';
import { Catalog, Change, Rule, SysMLLikeModel, TypedGraph } from '../model/types';
import { median, quantile, round } from '../evaluation/stats';
import { Rng } from '../util/rng';
import { timeMedian } from '../util/timing';
import { adjudicate, Adjudication } from './adjudicate';
import { loadLibrary, loadUnits, semanticModelFor, Unit } from './corpus';
import { runSelfTest } from './selftest';
import { ClassMode, CATALOG_ANCHORS, KEYWORD_CLASS, LevelMode, lossSummary, normalizeSysML, S1Result } from './normalize';
import { SStatement } from './parser';
import { SemanticModel } from './semantics';
import { ClassMap, crossCheckAgainstEngine, revalidateScoped, validateSpec } from './specEngine';

interface Options {
  corpusDir: string;
  srcDir: string;
  libDir: string;
  groups: string[];
  outputDir: string;
  quick: boolean;
}

const RULE_CLASSES = ['TYPE', 'ATTR', 'DOM', 'MULT', 'ISO', 'VIEW', 'ACYC', 'TRACE'];

function ruleClass(r: { id: string }): string {
  return r.id.split(':')[0];
}

function dist(xs: number[]): { n: number; min: number; q1: number; median: number; q3: number; max: number; sum: number } {
  if (xs.length === 0) return { n: 0, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, sum: 0 };
  return {
    n: xs.length,
    min: Math.min(...xs),
    q1: round(quantile(xs, 0.25), 3),
    median: round(median(xs), 3),
    q3: round(quantile(xs, 0.75), 3),
    max: Math.max(...xs),
    sum: xs.reduce((s, x) => s + x, 0),
  };
}

function toGraph(r: S1Result, id: string): TypedGraph {
  return normalizeToTypedGraph({ ...r.model, id });
}

/** Whether rule r has at least one grounding of its antecedent in g (non-vacuous). */
function nonVacuous(r: Rule, g: TypedGraph, classes: ClassMap): boolean {
  const hasClass = (t: string): boolean => {
    for (const id of g.nodes.keys()) if (classes.get(id)?.has(t)) return true;
    return false;
  };
  const hasEdge = (t: string): boolean => {
    for (const e of g.edges.values()) if (e.type === t) return true;
    return false;
  };
  switch (r.kind) {
    case 'relationType':
      return hasEdge(r.edgeType);
    case 'requiredAttr':
    case 'attrDomain':
    case 'multiplicity':
    case 'isolated':
      return hasClass(r.nodeType);
    case 'viewConsistency':
      return hasClass(r.policy.viewType);
    case 'acyclic':
      return hasEdge(r.edgeType);
    case 'tracePolicy':
      return hasClass(r.policy.sourceType);
  }
}

// ---------------------------------------------------------------------------
// permutation KS
// ---------------------------------------------------------------------------

function ksD(a: number[], b: number[]): number {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return d;
}

function permutationKs(a: number[], b: number[], iterations: number, seed: number): { d: number; p: number; n1: number; n2: number; asymptoticCritical005: number } {
  const d = ksD(a, b);
  const pooled = [...a, ...b];
  const rng = new Rng(seed);
  let ge = 0;
  for (let it = 0; it < iterations; it++) {
    const s = rng.shuffle(pooled);
    if (ksD(s.slice(0, a.length), s.slice(a.length)) >= d - 1e-12) ge++;
  }
  return {
    d: round(d, 4),
    p: round((ge + 1) / (iterations + 1), 4),
    n1: a.length,
    n2: b.length,
    asymptoticCritical005: round(1.36 * Math.sqrt((a.length + b.length) / (a.length * b.length)), 4),
  };
}

function pooled(stats: StructureStats[]): StructureStats {
  return {
    nodes: stats.reduce((s, x) => s + x.nodes, 0),
    edges: stats.reduce((s, x) => s + x.edges, 0),
    degrees: stats.flatMap((x) => x.degrees),
    containmentDepths: stats.flatMap((x) => x.containmentDepths),
    distanceToRequirement: stats.flatMap((x) => x.distanceToRequirement),
  };
}

function sumD(a: StructureStats, b: StructureStats): number {
  return ksD(a.degrees, b.degrees) + ksD(a.containmentDepths, b.containmentDepths) + ksD(a.distanceToRequirement, b.distanceToRequirement);
}

// ---------------------------------------------------------------------------

export function runSysmlExperiments(o: Options): void {
  if (fs.existsSync(o.outputDir)) throw new Error(`output directory already exists: ${o.outputDir} (results are never overwritten)`);
  const t0 = Date.now();
  const lib = loadLibrary(o.libDir);
  const units = loadUnits(o.srcDir, o.groups);
  const selftest = runSelfTest(lib);
  if (!selftest.ok) throw new Error(`S1 self-test failed: ${selftest.failures.join('; ')}`);
  const fileText = new Map<string, string[]>();
  const sourceLine = (file: string, line: number): string => {
    let lines = fileText.get(file);
    if (!lines) {
      lines = fs.readFileSync(path.join(o.srcDir, file), 'utf8').split('\n');
      fileText.set(file, lines);
    }
    return lines[line - 1] ?? '';
  };

  const corpusRev = (() => {
    try {
      const head = fs.readFileSync(path.join(o.corpusDir, '.git', 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(head)) return head;
      const ref = head.replace(/^ref: /, '');
      return fs.readFileSync(path.join(o.corpusDir, '.git', ref), 'utf8').trim();
    } catch {
      return 'unknown';
    }
  })();
  const engineHash = (() => {
    const p = path.resolve(o.corpusDir, '..', '..', 'src', 'validator', 'engine.ts');
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    } catch {
      return 'unavailable';
    }
  })();

  const provenance = {
    source: 'https://github.com/Systems-Modeling/SysML-v2-Release',
    tag: '2026-08',
    commit: corpusRev,
    license: 'EPL-2.0 (models and libraries, per repository README "Licensing")',
    paths: o.groups.map((g) => `sysml/src/${g}`),
    library: 'sysml.library (*.sysml; *.kerml kernel files are not parsed)',
    engineSha256: engineHash,
    note: 'downloaded files are treated as data only; no script inside the corpus was executed',
  };

  // ---------------------------------------------------------------------------
  // X1: corpus and normalization statistics
  // ---------------------------------------------------------------------------
  const files = units.flatMap((u) => u.files);
  const modes: ClassMode[] = ['keyword', 'specialization'];
  const levelsList: LevelMode[] = ['all', 'usage'];

  interface UnitRun {
    unit: Unit;
    mode: ClassMode;
    levels: LevelMode;
    sm: SemanticModel;
    s1: S1Result;
    g: TypedGraph;
    normalizeMs: number;
  }
  const runs: UnitRun[] = [];
  for (const u of units) {
    for (const mode of modes) {
      for (const levels of levelsList) {
        const sm = semanticModelFor(u, units, lib);
        const t1 = process.hrtime.bigint();
        const s1 = normalizeSysML(sm, mode, levels);
        const ms = Number(process.hrtime.bigint() - t1) / 1e6;
        runs.push({ unit: u, mode, levels, sm, s1, g: toGraph(s1, u.id), normalizeMs: ms });
      }
    }
  }
  const pick = (mode: ClassMode, levels: LevelMode) => runs.filter((r) => r.mode === mode && r.levels === levels);

  const x1PerMode = modes.flatMap((mode) =>
    levelsList.map((levels) => {
      const rs = pick(mode, levels);
      const cat: Record<string, number> = {};
      const lost = new Map<string, number>();
      let resolved = 0;
      let unresolved = 0;
      const classCount: Record<string, number> = {};
      const multiClass: Record<string, number> = {};
      const edgeCount: Record<string, number> = {};
      let viaRef = 0;
      let inheritedAttrs = 0;
      for (const r of rs) {
        const l = lossSummary(r.s1);
        for (const [k, v] of Object.entries(l.byCategory)) cat[k] = (cat[k] ?? 0) + v;
        for (const x of l.lostByReason) {
          const key = x.reason.replace(/\s*\(.*\)$/, '');
          lost.set(key, (lost.get(key) ?? 0) + x.count);
        }
        resolved += r.sm.refStats.resolved;
        unresolved += r.sm.refStats.unresolved;
        for (const [, cls] of r.s1.classes) {
          for (const c of cls) classCount[c] = (classCount[c] ?? 0) + 1;
          if (cls.size > 1) {
            const key = [...cls].join('+');
            multiClass[key] = (multiClass[key] ?? 0) + 1;
          }
        }
        for (const e of r.s1.model.edges) edgeCount[e.type] = (edgeCount[e.type] ?? 0) + 1;
        for (const p of r.s1.edgeProv.values()) if (p.viaReference) viaRef++;
        for (const p of r.s1.nodeProv.values()) inheritedAttrs += p.inherited.length;
      }
      const total = Object.values(cat).reduce((s, x) => s + x, 0);
      return {
        mode,
        levels,
        nodes: dist(rs.map((r) => r.g.nodes.size)),
        edges: dist(rs.map((r) => r.g.edges.size)),
        unitsWithEmptyGraph: rs.filter((r) => r.g.nodes.size === 0).length,
        statementCategories: cat,
        statements: total,
        lossRate: round((cat.lost ?? 0) / total, 4),
        lossRateExclAnnotation: round((cat.lost ?? 0) / (total - (cat.annotation ?? 0)), 4),
        perUnitLossRate: dist(rs.map((r) => round(lossSummary(r.s1).lossRate, 4))),
        lostByReason: [...lost.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
        relationshipEndResolution: { resolved, unresolved, rate: round(resolved / Math.max(1, resolved + unresolved), 4) },
        nodeClassCounts: classCount,
        multiClassNodes: multiClass,
        edgeTypeCounts: edgeCount,
        edgesViaReferenceChain: viaRef,
        inheritedAttributeValues: inheritedAttrs,
      };
    }),
  );

  // differences between the two modes on identical name resolution (levels = all)
  const modeDiff = units.map((u) => {
    const k = runs.find((r) => r.unit === u && r.mode === 'keyword' && r.levels === 'all')!;
    const s = runs.find((r) => r.unit === u && r.mode === 'specialization' && r.levels === 'all')!;
    const kIds = new Set(k.g.nodes.keys());
    const sIds = new Set(s.g.nodes.keys());
    let onlySpec = 0;
    let classChanged = 0;
    for (const id of sIds) {
      if (!kIds.has(id)) onlySpec++;
      else {
        const a = [...k.s1.classes.get(id)!].sort().join();
        const b = [...s.s1.classes.get(id)!].sort().join();
        if (a !== b) classChanged++;
      }
    }
    let onlyKeyword = 0;
    for (const id of kIds) if (!sIds.has(id)) onlyKeyword++;
    return { unit: u.id, keywordNodes: kIds.size, specializationNodes: sIds.size, onlySpec, onlyKeyword, classChanged, keywordEdges: k.g.edges.size, specializationEdges: s.g.edges.size };
  });

  const x1 = {
    experiment: 'X1 corpus and S1 normalization',
    provenance,
    corpus: {
      units: units.length,
      unitsByGroup: Object.fromEntries(o.groups.map((g) => [g, units.filter((u) => u.group === g).length])),
      files: files.length,
      filesParsed: files.filter((f) => f.ok).length,
      parseFailures: files.filter((f) => !f.ok).map((f) => ({ file: f.file, error: f.error })),
      lines: files.reduce((s, f) => s + f.lines, 0),
      statements: files.reduce((s, f) => s + f.statements, 0),
      library: { files: lib.files.length, parsed: lib.files.filter((f) => f.ok).length, failures: lib.failed },
      unitList: units.map((u) => ({ id: u.id, files: u.files.length, lines: u.lines, statements: u.statements, sha256: u.sha256 })),
    },
    anchors: CATALOG_ANCHORS,
    keywordMapping: KEYWORD_CLASS,
    perMode: x1PerMode,
    modeDifferencesPerUnit: modeDiff,
    modeDifferencesTotal: {
      nodesOnlyInSpecialization: modeDiff.reduce((s, x) => s + x.onlySpec, 0),
      nodesOnlyInKeyword: modeDiff.reduce((s, x) => s + x.onlyKeyword, 0),
      nodesWithChangedClassSet: modeDiff.reduce((s, x) => s + x.classChanged, 0),
      unitsAffected: modeDiff.filter((x) => x.onlySpec + x.onlyKeyword + x.classChanged > 0).length,
    },
    unresolvedReferences: runs.filter((r) => r.mode === 'specialization' && r.levels === 'all').flatMap((r) => r.sm.refStats.unresolvedRefs),
  };

  // ---------------------------------------------------------------------------
  // X2: validation, vacuity, adjudication
  // ---------------------------------------------------------------------------
  const catalogs: Catalog[] = [aerospaceCatalog(), automotiveCatalog(), sysmlWellFormednessCatalog()];
  const x2Configs: unknown[] = [];
  let primaryAdjudications: Array<Adjudication & { unit: string }> = [];
  const engineEquivalence: Array<{ unit: string; catalog: string; levels: LevelMode; equal: boolean }> = [];
  for (const cat of catalogs) {
    const rules = deriveRules(cat);
    for (const mode of modes) {
      for (const levels of levelsList) {
        const rs = pick(mode, levels);
        const vacuity: Record<string, { pairs: number; vacuous: number }> = {};
        const unitsNonVacuous: Record<string, number> = {};
        const byClass: Record<string, number> = {};
        const verdicts: Record<string, number> = {};
        const codes: Record<string, number> = {};
        const byRule: Record<string, number> = {};
        const adjs: Array<Adjudication & { unit: string }> = [];
        let total = 0;
        const unitsWithNodes = rs.filter((r) => r.g.nodes.size > 0);
        for (const r of unitsWithNodes) {
          const seenClass = new Set<string>();
          for (const rule of rules) {
            const rc = ruleClass(rule);
            vacuity[rc] = vacuity[rc] ?? { pairs: 0, vacuous: 0 };
            vacuity[rc].pairs++;
            if (!nonVacuous(rule, r.g, r.s1.classes)) vacuity[rc].vacuous++;
            else seenClass.add(rc);
          }
          for (const rc of seenClass) unitsNonVacuous[rc] = (unitsNonVacuous[rc] ?? 0) + 1;
          if (mode === 'keyword') {
            const cc = crossCheckAgainstEngine(r.g, cat, rules);
            engineEquivalence.push({ unit: r.unit.id, catalog: cat.id, levels, equal: cc.equal });
          }
          const vs = validateSpec(r.g, r.s1.classes, rules);
          total += vs.length;
          for (const v of vs) {
            const rc = v.ruleId.split(':')[0];
            byClass[rc] = (byClass[rc] ?? 0) + 1;
            byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1;
            const a = adjudicate(v, r.g, r.s1, sourceLine);
            verdicts[a.verdict] = (verdicts[a.verdict] ?? 0) + 1;
            codes[a.code] = (codes[a.code] ?? 0) + 1;
            adjs.push({ ...a, unit: r.unit.id });
          }
        }
        const vac = Object.fromEntries(
          RULE_CLASSES.filter((rc) => vacuity[rc]).map((rc) => [
            rc,
            { rulePairs: vacuity[rc].pairs, vacuous: vacuity[rc].vacuous, vacuousRate: round(vacuity[rc].vacuous / vacuity[rc].pairs, 4), unitsWhereNonVacuous: unitsNonVacuous[rc] ?? 0 },
          ]),
        );
        x2Configs.push({
          catalog: cat.id,
          mode,
          levels,
          unitsValidated: unitsWithNodes.length,
          violations: total,
          violationsPerUnit: dist(unitsWithNodes.map((r) => validateSpec(r.g, r.s1.classes, rules).length)),
          byRuleClass: byClass,
          byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1])),
          vacuity: vac,
          verdicts,
          verdictCodes: codes,
          trueViolationCandidates: adjs.filter((a) => a.verdict === 'T'),
        });
        if (cat.id === 'aerospace' && mode === 'specialization' && levels === 'all') primaryAdjudications = adjs;
      }
    }
  }
  const x2 = {
    experiment: 'X2 validation of public SysML v2 models',
    adjudicationRules: {
      order: 'first matching rule wins: N1-N4, T, P1-P7',
      N: 'false violation caused by normalization loss (N1 reference-chain context conflation; N2 non-literal attribute expression; N3 node named as an end of an unmapped relationship; N4 owner not mapped into G)',
      T: 'true violation of a rule implied by SysML v2 well-formedness (satisfy/verify target not a requirement, verify source not a verification case, expose source not a view)',
      P: 'catalog policy differs from the intent of the well-formed example (P1 attribute never declared; P2 declared without value; P3 legal value outside catalog domain; P4 legal relation outside allowed type pairs; P5 coverage/allocation/subject multiplicity; P6 isolation/view/trace; P7 definition-level anchor)',
    },
    engineEquivalence: {
      checked: engineEquivalence.length,
      allEqual: engineEquivalence.every((e) => e.equal),
      mismatches: engineEquivalence.filter((e) => !e.equal),
    },
    configurations: x2Configs,
  };
  const x2Primary = {
    configuration: { catalog: 'aerospace', mode: 'specialization', levels: 'all' },
    adjudications: primaryAdjudications,
  };

  // ---------------------------------------------------------------------------
  // X3: specialization semantics and incremental scope
  // ---------------------------------------------------------------------------
  const cat0 = aerospaceCatalog();
  const rules0 = deriveRules(cat0);
  const k = maxLocalRadius(rules0);
  const rng = new Rng(20261020);
  const perUnitEdits = o.quick ? 5 : 30;
  const x3a = { edits: 0, scopedEqualsBatch: 0, mismatches: [] as unknown[] };
  interface HEdit {
    unit: string;
    kind: 'removeGeneralizations' | 'deleteAttribute' | 'deleteCatalogAttribute';
    target: string;
    downSet: number;
    witnessScopeStatements: number;
    affectedNodes: number;
    batchChanged: boolean;
    keywordBatchChanged: boolean;
    naiveEqualsBatch: boolean;
    witnessEqualsBatch: boolean;
    naiveMissed: number;
    naiveStale: number;
    maxDistanceAffected: number | 'unreachable' | null;
  }
  const x3b: HEdit[] = [];
  const hierarchyDepths: number[] = [];
  const catalogAttrNames = new Set<string>([...Object.values(cat0.requiredAttr).flat(), ...Object.keys(cat0.domain).map((k) => k.split('.')[1])]);
  const timing: unknown[] = [];

  for (const u of units) {
    const run = runs.find((r) => r.unit === u && r.mode === 'specialization' && r.levels === 'all')!;
    if (run.g.nodes.size === 0) continue;
    const g0 = run.g;
    const classes0 = run.s1.classes;
    const before = validateSpec(g0, classes0, rules0);

    // ---- (a) edits of G under a fixed hierarchy ---------------------------------
    const nodeIds = [...g0.nodes.keys()];
    const edgeIds = [...g0.edges.keys()];
    const incTimes: number[] = [];
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
      for (const id of applyChangesTouchedNodes(ch)) if (g.nodes.has(id)) seeds.push(id);
      const truth = new Set(validateSpec(g, classes0, rules0).map(violationKey));
      const t1 = process.hrtime.bigint();
      const inc = revalidateScoped(g, classes0, rules0, before, seeds, k);
      incTimes.push(Number(process.hrtime.bigint() - t1) / 1e6);
      const got = new Set(inc.violations.map(violationKey));
      x3a.edits++;
      if (setEq(truth, got)) x3a.scopedEqualsBatch++;
      else if (x3a.mismatches.length < 20) x3a.mismatches.push({ unit: u.id, change: ch, missing: [...truth].filter((x) => !got.has(x)), extra: [...got].filter((x) => !truth.has(x)) });
    }

    // ---- (b) edits of the hierarchy H -------------------------------------------------
    const sm = run.sm;
    const kwRun = runs.find((r) => r.unit === u && r.mode === 'keyword' && r.levels === 'all')!;
    const kwBefore = new Set(validateSpec(kwRun.g, kwRun.s1.classes, rules0).map(violationKey));
    // candidate targets: unit statements that some other unit statement generalizes to
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
    const editList: Array<{ kind: HEdit['kind']; s: SStatement; attr?: SStatement }> = [];
    for (const s of targets) {
      if (sm.explicitGenerals(s).some((g) => !g.isLibrary)) editList.push({ kind: 'removeGeneralizations', s });
      const attrs = s.children.filter((c) => c.kind === 'attribute' && c.name);
      if (attrs.length > 0) editList.push({ kind: 'deleteAttribute', s, attr: rng.pick(attrs) });
      // attributes the catalog constrains (required attribute or value domain of some node type)
      const relevant = attrs.filter((c) => catalogAttrNames.has(c.name!) && c.name !== 'name');
      if (relevant.length > 0) editList.push({ kind: 'deleteCatalogAttribute', s, attr: rng.pick(relevant) });
    }
    // depth of user-defined generalization chains (longest chain of non-library generals)
    const depthMemo = new Map<number, number>();
    const userDepth = (x: SStatement, guard: Set<number>): number => {
      if (depthMemo.has(x.uid)) return depthMemo.get(x.uid)!;
      if (guard.has(x.uid)) return 0;
      guard.add(x.uid);
      let d = 0;
      for (const g of sm.explicitGenerals(x)) if (!g.isLibrary) d = Math.max(d, 1 + userDepth(g, guard));
      guard.delete(x.uid);
      depthMemo.set(x.uid, d);
      return d;
    };
    for (const x of sm.unitStatements) {
      const d = userDepth(x, new Set());
      if (d > 0) hierarchyDepths.push(d);
    }
    // all catalog-relevant attribute deletions are kept; the other edits are sampled
    const chosen = [...editList.filter((e) => e.kind === 'deleteCatalogAttribute'), ...rng.shuffle(editList.filter((e) => e.kind !== 'deleteCatalogAttribute')).slice(0, perUnitEdits)];
    const beforeKeys = new Set(before.map(violationKey));
    for (const ed of chosen) {
      // down-set of the edited statement before the edit (elements whose closure contains it)
      const downSetUids = new Set<number>();
      for (const x of sm.unitStatements) if (sm.closure(x).has(ed.s.uid)) downSetUids.add(x.uid);
      // witness scope: the down-set and everything owned by it (inherited-member resolution of owned
      // features, e.g. redefinitions, passes through the edited type)
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
      const gb = toGraph(s1b, u.id);
      const truthList = validateSpec(gb, s1b.classes, rules0);
      const truth = new Set(truthList.map(violationKey));
      // keyword-mode reading of the same edit
      const kwAfter = new Set(validateSpec(toGraph(normalizeSysML(sm, 'keyword', 'all'), u.id), normalizeSysML(sm, 'keyword', 'all').classes, rules0).map(violationKey));
      sm.clearOverrides();

      const editedNode = (() => {
        let cur: SStatement | undefined = ed.s;
        while (cur) {
          const id = run.s1.nodeOfStmt.get(cur.uid);
          if (id) return id;
          cur = cur.owner;
        }
        return undefined;
      })();
      const seedsNaive = editedNode ? [editedNode] : [];
      const naive = new Set(revalidateScoped(gb, s1b.classes, rules0, before, seedsNaive, k, g0).violations.map(violationKey));
      const seedsWitness = [...seedsNaive];
      for (const uid of witnessUids) {
        const id = s1b.nodeOfStmt.get(uid) ?? run.s1.nodeOfStmt.get(uid);
        if (id) seedsWitness.push(id);
      }
      const witness = new Set(revalidateScoped(gb, s1b.classes, rules0, before, seedsWitness, k, g0).violations.map(violationKey));
      // affected nodes: anchors of violations that changed
      const changed = new Set<string>();
      for (const v of truthList) if (!beforeKeys.has(violationKey(v))) changed.add(v.anchor);
      for (const v of before) if (!truth.has(violationKey(v))) changed.add(v.anchor);
      let maxD: number | 'unreachable' | null = null;
      if (changed.size > 0 && editedNode) {
        // undirected distance from the edited element in the pre-state or the post-state graph
        const dPre = bfsDistances(g0, editedNode);
        const dPost = gb.nodes.has(editedNode) ? bfsDistances(gb, editedNode) : new Map<string, number>();
        for (const a of changed) {
          const node = gb.edges.get(a)?.src ?? g0.edges.get(a)?.src ?? a;
          const cands = [dPre.get(node), dPost.get(node)].filter((x): x is number => x !== undefined);
          const d = cands.length > 0 ? Math.min(...cands) : undefined;
          if (d === undefined) {
            maxD = 'unreachable';
            break;
          }
          if (maxD === null || (typeof maxD === 'number' && d > maxD)) maxD = d;
        }
      }
      x3b.push({
        unit: u.id,
        kind: ed.kind,
        target: `${sm.qualifiedName(ed.s)} (${ed.s.kind}, ${ed.s.file}:${ed.s.line})`,
        downSet: downSetUids.size,
        witnessScopeStatements: witnessUids.size,
        affectedNodes: changed.size,
        batchChanged: !setEq(truth, beforeKeys),
        keywordBatchChanged: !setEq(kwAfter, kwBefore),
        naiveEqualsBatch: setEq(naive, truth),
        witnessEqualsBatch: setEq(witness, truth),
        naiveMissed: [...truth].filter((x) => !naive.has(x)).length,
        naiveStale: [...naive].filter((x) => !truth.has(x)).length,
        maxDistanceAffected: maxD,
      });
    }

    // ---- X5 timing ---------------------------------------------------------------------
    const batchMs = timeMedian(() => validateSpec(g0, classes0, rules0), 7);
    const s1Ms = timeMedian(() => normalizeSysML(semanticModelFor(u, units, lib), 'specialization', 'all'), 3);
    timing.push({
      unit: u.id,
      nodes: g0.nodes.size,
      edges: g0.edges.size,
      s1NormalizeMs: round(s1Ms, 3),
      batchValidateMs: round(batchMs, 4),
      incrementalMedianMs: round(median(incTimes), 4),
      incrementalMaxMs: round(Math.max(...incTimes), 4),
    });
  }

  const x3bSummary = (rows: HEdit[]) => ({
    edits: rows.length,
    batchChanged: rows.filter((r) => r.batchChanged).length,
    keywordBatchChanged: rows.filter((r) => r.keywordBatchChanged).length,
    naiveEqualsBatch: rows.filter((r) => r.naiveEqualsBatch).length,
    witnessEqualsBatch: rows.filter((r) => r.witnessEqualsBatch).length,
    naiveWrongWhenBatchChanged: rows.filter((r) => r.batchChanged && !r.naiveEqualsBatch).length,
    downSetSize: dist(rows.map((r) => r.downSet)),
    affectedNodes: dist(rows.filter((r) => r.batchChanged).map((r) => r.affectedNodes)),
    affectedBeyondK: rows.filter((r) => r.maxDistanceAffected === 'unreachable' || (typeof r.maxDistanceAffected === 'number' && r.maxDistanceAffected > k)).length,
    affectedUnreachable: rows.filter((r) => r.maxDistanceAffected === 'unreachable').length,
  });
  const x3 = {
    experiment: 'X3 specialization semantics and the scope of incremental validation',
    catalog: 'aerospace',
    mode: 'specialization',
    k,
    userGeneralizationChainDepth: { ...dist(hierarchyDepths), histogram: histogram(hierarchyDepths) },
    a_fixedHierarchy: {
      description: 'random edits of G (attribute set/unset, edge add/delete); classes and inherited attributes fixed; local rules re-evaluated on N_k(delta), global rules in batch',
      ...x3a,
    },
    b_hierarchyEdits: {
      description: 'edits of H: removal of all explicit generalizations of a user type, or deletion of an attribute owned by a user type; S1 is re-run on the edited hierarchy and the batch result is the ground truth',
      all: x3bSummary(x3b),
      removeGeneralizations: x3bSummary(x3b.filter((r) => r.kind === 'removeGeneralizations')),
      deleteAttribute: x3bSummary(x3b.filter((r) => r.kind === 'deleteAttribute')),
      deleteCatalogAttribute: x3bSummary(x3b.filter((r) => r.kind === 'deleteCatalogAttribute')),
      rows: x3b,
    },
  };

  // ---------------------------------------------------------------------------
  // X4: E7 recalibration with calibration / holdout split
  // ---------------------------------------------------------------------------
  const x4 = runX4(pick('specialization', 'all'), o.quick);

  const x5 = {
    experiment: 'X5 validation time on real SysML v2 models (spec mode, aerospace catalog)',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    perUnit: timing,
    batchValidateMs: dist((timing as Array<{ batchValidateMs: number }>).map((t) => t.batchValidateMs)),
    incrementalMedianMs: dist((timing as Array<{ incrementalMedianMs: number }>).map((t) => t.incrementalMedianMs)),
    s1NormalizeMs: dist((timing as Array<{ s1NormalizeMs: number }>).map((t) => t.s1NormalizeMs)),
  };

  fs.mkdirSync(o.outputDir, { recursive: false });
  const write = (name: string, data: unknown) => {
    const p = path.join(o.outputDir, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 1) + '\n', { flag: 'wx' });
  };
  write('x1-corpus-normalization.json', x1);
  write('x2-validation.json', x2);
  write('x2-adjudications-primary.json', x2Primary);
  write('x3-specialization-incremental.json', x3);
  write('x4-calibration-holdout.json', x4);
  write('x5-timing.json', x5);
  write('run-info.json', { provenance, selftest, quick: o.quick, wallSeconds: round((Date.now() - t0) / 1000, 1), date: new Date().toISOString() });
  console.log(`wrote ${o.outputDir} in ${round((Date.now() - t0) / 1000, 1)} s`);
}

function applyChangesTouchedNodes(ch: Change[]): string[] {
  const out: string[] = [];
  for (const c of ch) {
    if (c.kind === 'addEdge') out.push(c.edge.src, c.edge.tgt);
    if (c.kind === 'setAttr') out.push(c.id);
  }
  return out;
}

function histogram(xs: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) h[String(x)] = (h[String(x)] ?? 0) + 1;
  return h;
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function bfsDistances(g: TypedGraph, src: string): Map<string, number> {
  const d = new Map<string, number>([[src, 0]]);
  let frontier = [src];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const eid of [...(g.out.get(v) ?? []), ...(g.in.get(v) ?? [])]) {
        const e = g.edges.get(eid)!;
        const w = e.src === v ? e.tgt : e.src;
        if (!d.has(w)) {
          d.set(w, d.get(v)! + 1);
          next.push(w);
        }
      }
    }
    frontier = next;
  }
  return d;
}

function runX4(rs: Array<{ unit: Unit; g: TypedGraph; s1: S1Result }>, quick: boolean): unknown {
  const catalog = aerospaceCatalog();
  const eligible = rs.filter((r) => r.g.nodes.size >= 10);
  const rng = new Rng(77001);
  const shuffled = rng.shuffle(eligible);
  const half = Math.ceil(shuffled.length / 2);
  const calib = shuffled.slice(0, half);
  const hold = shuffled.slice(half);
  const statsOf = (r: { s1: S1Result; unit: Unit }): StructureStats => structureStats({ ...(r.s1.model as SysMLLikeModel), id: r.unit.id });
  const calibStats = pooled(calib.map(statsOf));
  const holdStats = pooled(hold.map(statsOf));
  const avgN = Math.round(calibStats.nodes / calib.length);

  const synthesize = (p: { portsPerComponent: number; depth: number; dependDensity: number; redundancy: number }, count: number, seedBase: number): StructureStats => {
    const out: StructureStats[] = [];
    for (let s = 0; s < count; s++) {
      const gen = generateCleanModel(catalog, { n: avgN, seed: seedBase + s, ...p });
      out.push(structureStats(gen.model));
    }
    return pooled(out);
  };
  const defaults = { portsPerComponent: 0.8, depth: 3, dependDensity: 0.5, redundancy: 0.4 };
  const nSynth = quick ? 10 : 40;
  let best = defaults;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const portsPerComponent of [0.4, 0.8, 1.2, 2]) {
    for (const depth of [1, 2, 3, 4]) {
      for (const dependDensity of [0, 0.25, 0.5, 0.75]) {
        for (const redundancy of [0, 0.2, 0.4, 0.6]) {
          const cand = { portsPerComponent, depth, dependDensity, redundancy };
          const score = sumD(calibStats, synthesize(cand, nSynth, 41000));
          if (score < bestScore) {
            bestScore = score;
            best = cand;
          }
        }
      }
    }
  }
  const iters = quick ? 200 : 2000;
  const evalAgainst = (target: StructureStats, p: typeof defaults, seed: number) => {
    const syn = synthesize(p, nSynth, 52000);
    return {
      degree: permutationKs(target.degrees, syn.degrees, iters, seed + 1),
      containmentDepth: permutationKs(target.containmentDepths, syn.containmentDepths, iters, seed + 2),
      distanceToRequirement: permutationKs(target.distanceToRequirement, syn.distanceToRequirement, iters, seed + 3),
    };
  };
  // edge-type composition of the real corpus (for dependDensity / redundancy plausibility)
  const edgeTypes: Record<string, number> = {};
  for (const r of eligible) for (const e of r.s1.model.edges) edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1;
  const nodeTypes: Record<string, number> = {};
  for (const r of eligible) for (const n of r.s1.model.nodes) nodeTypes[n.type] = (nodeTypes[n.type] ?? 0) + 1;
  return {
    experiment: 'X4 E7 recalibration on the SysML-v2-Release corpus with holdout',
    eligibleUnits: eligible.length,
    rule: 'units with >= 10 nodes (specialization mode, levels = all); seeded random split',
    calibrationUnits: calib.map((r) => r.unit.id),
    holdoutUnits: hold.map((r) => r.unit.id),
    sampleSizes: {
      calibration: { nodes: calibStats.nodes, degrees: calibStats.degrees.length, components: calibStats.distanceToRequirement.length },
      holdout: { nodes: holdStats.nodes, degrees: holdStats.degrees.length, components: holdStats.distanceToRequirement.length },
      syntheticModelsPerEvaluation: nSynth,
      syntheticNodesPerModel: avgN,
    },
    test: `two-sample Kolmogorov-Smirnov D with permutation p-value (${iters} permutations; valid for discrete data with ties); asymptotic 5% critical value reported for comparison only`,
    defaultParameters: defaults,
    calibratedParameters: best,
    calibrationSumD: round(bestScore, 4),
    holdoutBeforeCalibration: evalAgainst(holdStats, defaults, 600),
    holdoutAfterCalibration: evalAgainst(holdStats, best, 700),
    calibrationAfterCalibration: evalAgainst(calibStats, best, 800),
    realCorpusComposition: { edgeTypes, nodeTypes },
  };
}

/**
 * Catalog whose rules are restricted to SysML v2 well-formedness constraints expressible in L_C
 * (fixed before the corpus was validated): the satisfied and the verified element is a requirement,
 * a verification is owned by a verification case, an exposure is owned by a view. All other type
 * pairs are permitted and no attribute, multiplicity, isolation, acyclicity or trace policy is
 * imposed. On well-formed public models every violation of this catalog is either a genuine
 * language-level defect or an artifact of S1.
 */
/**
 * SysML v2 / KerML structural constraints expressible with the eight rule templates (review n15),
 * read from the reflective abstract syntax shipped with the release:
 *   TYPE satisfy   SatisfyRequirementUsage::satisfiedRequirement : RequirementUsage[1..1]
 *   TYPE verify    RequirementVerificationMembership in a verification-case objective,
 *                  verifiedRequirement : RequirementUsage
 *   TYPE expose    an Expose is owned by a ViewUsage (ViewUsage::exposedElement)
 *   TYPE subject   S1 subject edges start at a ViewUsage (NamespaceExpose root)
 *   MULT t|contain|in <= 1 for every node type   KerML Element::owner : Element[0..1]
 *   ACYC contain   ownership is a tree (no element is its own transitive owner)
 * Not expressible with the templates: non-composite nested usages of PortUsages (pair-dependent
 * end guard), PortUsage ends of interfaces (S1 maps interface/connection/flow usages to connect).
 */
export function sysmlWellFormednessCatalog(): Catalog {
  const all = ['Requirement', 'Function', 'Component', 'Interface', 'Port', 'VerificationCase', 'View'];
  const edgeTypes = ['satisfy', 'verify', 'allocate', 'connect', 'contain', 'dependOn', 'expose', 'subject'];
  const allowed: Catalog['allowed'] = {};
  for (const e of edgeTypes) allowed[e] = { src: [...all], tgt: [...all] };
  allowed.satisfy = { src: [...all], tgt: ['Requirement'] };
  allowed.verify = { src: ['VerificationCase'], tgt: ['Requirement'] };
  allowed.expose = { src: ['View'], tgt: [...all] };
  allowed.subject = { src: ['View'], tgt: [...all] };
  const multiplicity: Catalog['multiplicity'] = {};
  for (const t of all) multiplicity[`${t}|contain|in`] = [0, 1];
  return { id: 'sysml-wellformedness', nodeTypes: all, edgeTypes, allowed, requiredAttr: {}, domain: {}, multiplicity, acyclic: ['contain'], tracePolicy: [], nonIsolated: [] };
}
