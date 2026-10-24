/**
 * Worked example used in the paper (section 4.5): a small model is carried through every
 * stage of the procedure so that each stage has a concrete, reproducible artifact.
 *
 * Stage 1  normalization            SysML v2-like JSON -> typed attributed graph
 * Stage 2  rule derivation          catalog C -> rule set R_C, split into local and global
 * Stage 3  full validation          Omega(G, C, R) on the clean model
 * Stage 4  defect exposure          three defects, one per rule class, with evidence
 * Stage 5  incremental revalidation N_k(delta) scope, witness update, batch equality
 *
 * Nothing here is hand-written output: the paper tables are generated from this run.
 */

import { aerospaceCatalog } from '../catalog/domains';
import { deriveRules, globalRules, localRules, maxLocalRadius, violationKey } from '../catalog/rules';
import { cloneGraph, kHopNodes, normalizeToTypedGraph } from '../model/graph';
import { Catalog, Change, Rule, SysMLLikeModel, TypedGraph, Violation } from '../model/types';
import { referenceValidate } from '../reference/referenceSemantics';
import { validate } from '../validator/engine';
import { IncrementalSession } from '../incremental/session';

/** A small UAV flight-control excerpt that is clean under the aerospace catalog. */
export function exampleModel(): SysMLLikeModel {
  return {
    id: 'uav-excerpt',
    nodes: [
      { id: 'R1', type: 'Requirement', attrs: { name: 'AttitudeHold', priority: 'high' } },
      { id: 'F1', type: 'Function', attrs: { name: 'StabilizeAttitude' } },
      { id: 'C1', type: 'Component', attrs: { name: 'FlightController', criticality: 'A', mass: 2.5 } },
      { id: 'C2', type: 'Component', attrs: { name: 'PowerUnit', criticality: 'B', mass: 4.0 } },
      { id: 'P1', type: 'Port', attrs: { name: 'cmdOut', direction: 'out' } },
      { id: 'P2', type: 'Port', attrs: { name: 'cmdIn', direction: 'in' } },
      { id: 'V1', type: 'VerificationCase', attrs: { name: 'HilAttitudeTest', method: 'test' } },
      { id: 'W1', type: 'View', attrs: { name: 'PowerView' } },
    ],
    edges: [
      { id: 'e1', type: 'contain', src: 'C1', tgt: 'P1' },
      { id: 'e2', type: 'contain', src: 'C2', tgt: 'P2' },
      { id: 'e3', type: 'connect', src: 'P1', tgt: 'P2' },
      { id: 'e4', type: 'allocate', src: 'F1', tgt: 'C1' },
      { id: 'e5', type: 'satisfy', src: 'C1', tgt: 'R1' },
      { id: 'e6', type: 'verify', src: 'V1', tgt: 'R1' },
      { id: 'e7', type: 'subject', src: 'W1', tgt: 'C2' },
      { id: 'e8', type: 'expose', src: 'W1', tgt: 'P2' },
      { id: 'e9', type: 'dependOn', src: 'C1', tgt: 'C2' },
    ],
  };
}

export interface StageRecord {
  stage: number;
  name: string;
  input: string;
  output: string;
  detail: Record<string, unknown>;
}

function ruleCensus(rules: Rule[]): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const r of rules) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return byKind;
}

function violationRows(vs: Violation[]): Array<{ ruleId: string; kind: string; witness: string; message: string }> {
  return [...vs]
    .sort((a, b) => violationKey(a).localeCompare(violationKey(b)))
    .map((v) => ({ ruleId: v.ruleId, kind: v.kind, witness: v.witness.join(','), message: v.message }));
}

function sameViolationSet(a: Violation[], b: Violation[]): boolean {
  const ka = new Set(a.map(violationKey));
  const kb = new Set(b.map(violationKey));
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}

export interface WorkedExampleResult {
  catalog: string;
  stages: StageRecord[];
  cleanViolations: number;
  defectViolations: Array<{ defect: string; edit: string; rows: ReturnType<typeof violationRows> }>;
  incremental: {
    change: string;
    scopeSize: number;
    graphSize: number;
    radius: number;
    violationsAfter: ReturnType<typeof violationRows>;
    matchesBatch: boolean;
  };
}

export function runWorkedExample(): WorkedExampleResult {
  const c: Catalog = aerospaceCatalog();
  const model = exampleModel();
  const stages: StageRecord[] = [];

  // ---- stage 1: normalization -------------------------------------------------
  const g: TypedGraph = normalizeToTypedGraph(model);
  let degreeSum = 0;
  for (const id of g.nodes.keys()) degreeSum += (g.out.get(id) ?? []).length + (g.in.get(id) ?? []).length;
  stages.push({
    stage: 1,
    name: 'NormalizeToTypedGraph',
    input: `SysML v2-like JSON (${model.nodes.length} elements, ${model.edges.length} relations)`,
    output: `typed attributed graph G with |V|=${g.nodes.size}, |E|=${g.edges.size}`,
    detail: {
      nodeTypes: [...new Set([...g.nodes.values()].map((n) => n.type))].sort(),
      edgeTypes: [...new Set([...g.edges.values()].map((e) => e.type))].sort(),
      averageDegree: Number((degreeSum / g.nodes.size).toFixed(2)),
    },
  });

  // ---- stage 2: rule derivation -----------------------------------------------
  const rules = deriveRules(c);
  const rLoc = localRules(rules);
  const rGlob = globalRules(rules);
  stages.push({
    stage: 2,
    name: 'DeriveRules',
    input: `catalog ${c.id}`,
    output: `rule set R_C with |R|=${rules.length} (local ${rLoc.length}, global ${rGlob.length})`,
    detail: {
      byKind: ruleCensus(rules),
      maxLocalRadius: maxLocalRadius(rules),
      globalRuleIds: rGlob.map((r) => r.id),
      sampleLocalRuleIds: rLoc.slice(0, 4).map((r) => r.id),
    },
  });

  // ---- stage 3: full validation of the clean model ----------------------------
  const clean = validate(g, c, rules);
  const cleanRef = referenceValidate(g, c, rules);
  stages.push({
    stage: 3,
    name: 'Validate (full mode)',
    input: 'G, C, R',
    output: `Omega = ${clean.length} violations; reference agreement = ${sameViolationSet(clean, cleanRef)}`,
    detail: { violations: violationRows(clean), referenceViolations: cleanRef.length },
  });

  // ---- stage 4: one defect per rule class -------------------------------------
  const defects: WorkedExampleResult['defectViolations'] = [];

  // (a) relation type: allocate must target a Component
  const gA = cloneGraph(g);
  gA.edges.get('e4')!.tgt = 'R1';
  gA.out.set('F1', ['e4']);
  gA.in.set('C1', (gA.in.get('C1') ?? []).filter((e) => e !== 'e4'));
  gA.in.set('R1', [...(gA.in.get('R1') ?? []), 'e4']);
  defects.push({
    defect: 'wrong relation type (local, radius 1)',
    edit: 'retarget e4: allocate F1 -> C1 becomes F1 -> R1',
    rows: violationRows(validate(gA, c, rules)),
  });

  // (b) attribute domain: criticality outside the catalog enumeration
  const gB = cloneGraph(g);
  gB.nodes.get('C2')!.attrs.criticality = 'X';
  defects.push({
    defect: 'attribute domain (local, radius 0)',
    edit: 'set C2.criticality = "X"',
    rows: violationRows(validate(gB, c, rules)),
  });

  // (c) dependency cycle: global rule, not decidable in any fixed radius
  const gC = cloneGraph(g);
  gC.edges.set('e10', { id: 'e10', type: 'dependOn', src: 'C2', tgt: 'C1' });
  gC.out.get('C2')!.push('e10');
  gC.in.get('C1')!.push('e10');
  defects.push({
    defect: 'dependency cycle (global)',
    edit: 'add e10: dependOn C2 -> C1',
    rows: violationRows(validate(gC, c, rules)),
  });

  stages.push({
    stage: 4,
    name: 'Defect exposure',
    input: 'three single-element edits on the clean model',
    output: defects.map((d) => `${d.rows.length} violation(s)`).join(', '),
    detail: { defects: defects.map((d) => ({ defect: d.defect, edit: d.edit, reported: d.rows.map((r) => r.ruleId) })) },
  });

  // ---- stage 5: incremental revalidation --------------------------------------
  const gInc = cloneGraph(g);
  const session = new IncrementalSession(gInc, c, rules, 3);
  const change: Change[] = [{ kind: 'delEdge', id: 'e5' }];
  const supportBefore = ['C1', 'R1'];
  const scopePreview = kHopNodes(gInc, supportBefore, maxLocalRadius(rules));
  const step = session.step(change);
  const batch = validate(gInc, c, rules);
  stages.push({
    stage: 5,
    name: 'Incremental revalidation',
    input: 'delta = delete e5 (satisfy C1 -> R1)',
    output: `scope |N_k(delta)|=${step.scopeSize} of ${gInc.nodes.size} nodes; `
      + `${step.violations.length} violation(s); batch agreement = ${sameViolationSet(step.violations, batch)}`,
    detail: {
      k: maxLocalRadius(rules),
      scopePreviewSize: scopePreview.size,
      witnessWork: step.witnessWork,
      violations: violationRows(step.violations),
    },
  });

  return {
    catalog: c.id,
    stages,
    cleanViolations: clean.length,
    defectViolations: defects,
    incremental: {
      change: 'delete e5 (satisfy C1 -> R1)',
      scopeSize: step.scopeSize,
      graphSize: gInc.nodes.size,
      radius: maxLocalRadius(rules),
      violationsAfter: violationRows(step.violations),
      matchesBatch: sameViolationSet(step.violations, batch),
    },
  };
}

/** Human-readable transcript used while writing the paper. */
export function formatWorkedExample(r: WorkedExampleResult): string {
  const lines: string[] = [];
  lines.push(`catalog: ${r.catalog}`);
  for (const s of r.stages) {
    lines.push('');
    lines.push(`[stage ${s.stage}] ${s.name}`);
    lines.push(`  in : ${s.input}`);
    lines.push(`  out: ${s.output}`);
    lines.push(`  detail: ${JSON.stringify(s.detail)}`);
  }
  lines.push('');
  for (const d of r.defectViolations) {
    lines.push(`[defect] ${d.defect} — ${d.edit}`);
    for (const row of d.rows) lines.push(`    ${row.ruleId} | witness=${row.witness} | ${row.message}`);
  }
  return lines.join('\n');
}
