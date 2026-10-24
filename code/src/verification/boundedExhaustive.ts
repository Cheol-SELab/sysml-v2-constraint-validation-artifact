/**
 * Bounded exhaustive checking (section 4.8, first mechanization).
 *
 * All typed attributed graphs within the stated bound are enumerated, and for each one the
 * engine output is compared with the independently written reference semantics, the rule
 * traversal order is permuted, and one-step incremental validation is compared with batch
 * validation. Within the bound the check is exhaustive, so the absence of a counterexample
 * is evidence about the implementation rather than about a sample.
 */

import { deriveRules, serializeViolations, setDiff, violationSet } from '../catalog/rules';
import { IncrementalSession } from '../incremental/session';
import { normalizeToTypedGraph } from '../model/graph';
import { applyChangesToModel, graphModelDiff } from './modelChanges';
import { AttrValue, Catalog, Change, ModelEdge, ModelNode, Rule, SysMLLikeModel } from '../model/types';
import { referenceValidate } from '../reference/referenceSemantics';
import { validate, validatePermuted } from '../validator/engine';

/** Small catalog whose derived rule set covers all eight rule kinds. */
export function tinyCatalog(): Catalog {
  return {
    id: 'tiny',
    nodeTypes: ['A', 'B', 'C', 'D'],
    edgeTypes: ['r', 's', 't'],
    allowed: {
      r: { src: ['A'], tgt: ['B'] },
      s: { src: ['B'], tgt: ['C'] },
      t: { src: ['C'], tgt: ['C'] },
    },
    requiredAttr: { A: ['p'] },
    domain: { 'A.p': { kind: 'enum', values: [1, 2] } },
    multiplicity: { 'B|s|out': [1, 1], 'A|r|out': [0, 2] },
    acyclic: ['t'],
    tracePolicy: [{ id: 'TP', sourceType: 'A', edgeTypes: ['r', 's'], targetType: 'C' }],
    nonIsolated: ['A', 'B'],
    viewPolicy: { viewType: 'D', subjectEdgeType: 'r', exposeEdgeType: 's', containEdgeType: 't' },
  };
}

export interface BoundSpec {
  nodes: number;
  maxEdges: number;
  /** attribute variants applied to the first node: absent, in-domain, out-of-domain */
  attributeVariants: number;
}

export interface ExhaustiveReport {
  bounds: BoundSpec[];
  graphsEnumerated: number;
  semanticsChecks: number;
  orderChecks: number;
  incrementalChecks: number;
  /** incremental checks in which a global rule took the invalid-witness fallback */
  fallbackChecks: number;
  mismatches: Array<{ check: string; model: SysMLLikeModel; detail: string }>;
  elapsedMs: number;
}

interface Slot {
  src: number;
  tgt: number;
  type: string;
}

function slotsFor(n: number, edgeTypes: string[]): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (const t of edgeTypes) out.push({ src: i, tgt: j, type: t });
    }
  }
  return out;
}

function* combinations(total: number, choose: number): Generator<number[]> {
  const idx: number[] = [];
  for (let i = 0; i < choose; i++) idx.push(i);
  if (choose === 0) {
    yield [];
    return;
  }
  if (choose > total) return;
  for (;;) {
    yield [...idx];
    let i = choose - 1;
    while (i >= 0 && idx[i] === total - choose + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < choose; j++) idx[j] = idx[j - 1] + 1;
  }
}

function attributeFor(variant: number): Record<string, AttrValue> {
  if (variant === 0) return {};
  if (variant === 1) return { p: 1 };
  return { p: 3 };
}

/**
 * Candidate one-step changes used for the incremental comparison.
 *   base templates (T1-T3): first-edge deletion, t-edge insertion, attribute update
 *   extended templates (T4-T11): r/s insertion (trace-policy edges), t self loop, node
 *   deletion, node insertion with an incident s edge (new trace target), node retype
 *   (exercises the invalid-witness fallback), and a two-change set.
 */
export function candidateChanges(model: SysMLLikeModel, extended = true): Change[][] {
  const out: Change[][] = [];
  const first = model.nodes[0]?.id;
  const last = model.nodes[model.nodes.length - 1]?.id;
  if (model.edges.length > 0) out.push([{ kind: 'delEdge', id: model.edges[0].id }]);
  if (model.nodes.length >= 2) {
    const e: ModelEdge = { id: 'x0', type: 't', src: last, tgt: first };
    out.push([{ kind: 'addEdge', edge: e }]);
  }
  if (model.nodes.length > 0) out.push([{ kind: 'setAttr', id: first, attr: 'p', value: 3 }]);
  if (!extended || model.nodes.length === 0) return out;
  if (model.nodes.length >= 2) {
    out.push([{ kind: 'addEdge', edge: { id: 'x1', type: 'r', src: last, tgt: first } }]);
    out.push([{ kind: 'addEdge', edge: { id: 'x2', type: 's', src: last, tgt: first } }]);
  }
  out.push([{ kind: 'addEdge', edge: { id: 'x3', type: 't', src: first, tgt: first } }]);
  out.push([{ kind: 'delNode', id: first }]);
  out.push([
    { kind: 'addNode', node: { id: 'nx', type: 'C', attrs: {} } },
    { kind: 'addEdge', edge: { id: 'x4', type: 's', src: last, tgt: 'nx' } },
  ]);
  const firstType = model.nodes[0].type;
  out.push([{ kind: 'addNode', node: { id: first, type: firstType === 'C' ? 'A' : 'C', attrs: { p: 1 } } }]);
  if (model.edges.length > 0) {
    out.push([
      { kind: 'delEdge', id: model.edges[model.edges.length - 1].id },
      { kind: 'setAttr', id: first, attr: 'p', value: undefined },
    ]);
  }
  return out;
}

function checkOne(
  model: SysMLLikeModel,
  c: Catalog,
  rules: Rule[],
  report: ExhaustiveReport,
  withIncremental: boolean,
  extendedTemplates: boolean,
): void {
  const g = normalizeToTypedGraph(model);
  const omega = validate(g, c, rules);
  const omegaStar = referenceValidate(g, c, rules);
  report.semanticsChecks++;
  const a = violationSet(omega);
  const b = violationSet(omegaStar);
  if (a.size !== b.size || setDiff(a, b).length > 0 || setDiff(b, a).length > 0) {
    report.mismatches.push({
      check: 'theorem1',
      model,
      detail: `engine-only=[${setDiff(a, b).join(' ')}] reference-only=[${setDiff(b, a).join(' ')}]`,
    });
  }

  const perm = rules.map((_, i) => rules.length - 1 - i);
  const permuted = validatePermuted(g, c, rules, perm);
  report.orderChecks++;
  if (serializeViolations(permuted) !== serializeViolations(omega)) {
    report.mismatches.push({ check: 'theorem2', model, detail: 'serialization differs under rule permutation' });
  }

  if (!withIncremental) return;
  for (const changes of candidateChanges(model, extendedTemplates)) {
    const gi = normalizeToTypedGraph(model);
    const session = new IncrementalSession(gi, c, rules, 3);
    const step = session.step(changes);
    // oracle: the post-change model built independently of model/graph.ts and evaluated by
    // the reference semantics; the session's graph must equal that model as well
    const post = applyChangesToModel(model, changes);
    const full = referenceValidate(normalizeToTypedGraph(post), c, rules);
    report.incrementalChecks++;
    const gdiff = graphModelDiff(gi, post);
    if (gdiff !== '') report.mismatches.push({ check: 'changeApplication', model, detail: `changes=${JSON.stringify(changes)} ${gdiff}` });
    if (step.batchGlobalRules > 0) report.fallbackChecks++;
    const inc = violationSet(step.violations);
    const bat = violationSet(full);
    if (setDiff(inc, bat).length > 0 || setDiff(bat, inc).length > 0) {
      report.mismatches.push({
        check: 'theorem4and6',
        model,
        detail: `changes=${JSON.stringify(changes)} incremental-only=[${setDiff(inc, bat).join(' ')}] batch-only=[${setDiff(bat, inc).join(' ')}]`,
      });
    }
  }
}

export function runBoundedExhaustive(bounds: BoundSpec[], withIncremental = true, extendedTemplates = false, stopAfter = 21): ExhaustiveReport {
  const c = tinyCatalog();
  const rules = deriveRules(c);
  const report: ExhaustiveReport = {
    bounds,
    graphsEnumerated: 0,
    semanticsChecks: 0,
    orderChecks: 0,
    incrementalChecks: 0,
    fallbackChecks: 0,
    mismatches: [],
    elapsedMs: 0,
  };
  const started = Date.now();

  for (const bound of bounds) {
    const n = bound.nodes;
    const slots = slotsFor(n, c.edgeTypes);
    const typeCount = c.nodeTypes.length;
    const typeAssignments = Math.pow(typeCount, n);
    for (let ta = 0; ta < typeAssignments; ta++) {
      const types: string[] = [];
      let rest = ta;
      for (let i = 0; i < n; i++) {
        types.push(c.nodeTypes[rest % typeCount]);
        rest = Math.floor(rest / typeCount);
      }
      for (let variant = 0; variant < bound.attributeVariants; variant++) {
        const nodes: ModelNode[] = [];
        for (let i = 0; i < n; i++) {
          nodes.push({ id: `n${i}`, type: types[i], attrs: i === 0 ? attributeFor(variant) : types[i] === 'A' ? { p: 1 } : {} });
        }
        for (let m = 0; m <= bound.maxEdges; m++) {
          for (const combo of combinations(slots.length, m)) {
            const edges: ModelEdge[] = combo.map((si, idx) => ({
              id: `e${idx}`,
              type: slots[si].type,
              src: `n${slots[si].src}`,
              tgt: `n${slots[si].tgt}`,
            }));
            const model: SysMLLikeModel = { id: `ex-n${n}-m${m}-t${ta}-v${variant}`, nodes, edges };
            report.graphsEnumerated++;
            checkOne(model, c, rules, report, withIncremental, extendedTemplates);
            if (report.mismatches.length >= stopAfter) {
              report.elapsedMs = Date.now() - started;
              return report;
            }
          }
        }
      }
    }
  }
  report.elapsedMs = Date.now() - started;
  return report;
}
