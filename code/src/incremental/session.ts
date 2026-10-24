/**
 * Incremental validation session (Fig. 2 with a change set Delta), with the three
 * strategies compared in experiment E5.
 *
 *   strategy 1 ("naive k-hop"): all rules, local and global alike, are re-evaluated on the
 *              induced subgraph of N_k(delta). Theorem 5 predicts missed violations.
 *   strategy 2 ("hybrid"): local rules scope-restricted, global rules recomputed in batch
 *              over the whole graph at every step. Correct but pays Theta(n + m) per step.
 *   strategy 3 ("witness maintenance"): local rules scope-restricted, global rules updated
 *              through the witness stores (Theorem 6); a store that is not valid for the
 *              current step falls back to BatchGlobal and is rebuilt.
 *
 * Mapping to the pseudocode of Fig. 2 (manuscript lines 8-17):
 *   8      S_pre = N_k^G(supp(Delta))            kHopNodes on the pre-state
 *   9-11   Expand(Delta), apply, UpdateWitness    expand()/applyPrimitive(): every change is
 *                                                 expanded into primitive events against the
 *                                                 current state, applied to G in place, and each
 *                                                 event is passed to the witness stores
 *   12     S = S_pre u N_k^G'(supp(Delta))        kHopNodes on the post-state
 *   13     keep local violations anchored outside S
 *   14-15  EvalLocal_r(G', S), anchors in S
 *   16     Report(W_r)
 * Addition not shown in Fig. 2: a store is declared invalid when a primitive event lies
 * outside its update rules (a node replaced with a different type, for the trace store) or
 * when the optional size threshold is exceeded; an invalid store is answered by BatchGlobal
 * and rebuilt in the same step.
 */

import { globalRules, localRules, maxLocalRadius, violationKey } from '../catalog/rules';
import { addEdge, addNode, changeSupportNodes, delEdge, delNode, kHopNodes, setAttr } from '../model/graph';
import { AttrValue, Catalog, Change, ModelEdge, ModelNode, Rule, TypedGraph, Violation } from '../model/types';
import { evaluateGlobalRuleBatch, evaluateLocalRule, inducedSubgraph, opCounter } from '../validator/engine';
import { AcyclicWitness } from '../witness/acyclicWitness';
import { TraceWitness } from '../witness/traceWitness';

export type StrategyId = 1 | 2 | 3;

export interface StepResult {
  violations: Violation[];
  /** number of nodes in the recomputation scope N_k(delta) */
  scopeSize: number;
  /** nodes touched by witness maintenance during this step */
  witnessWork: number;
  /** Holds evaluations of local rules during this step */
  groundingsEvaluated: number;
  /** adjacency entries scanned inside Holds during this step */
  localScans: number;
  /** global work units: witness work (incremental) plus BatchGlobal scans (batch / fallback) */
  globalWork: number;
  /** global rules served by IncrementalGlobal / by BatchGlobal in this step */
  incrementalGlobalRules: number;
  batchGlobalRules: number;
  /** previous local violations removed because their anchor lies in the scope */
  removedLocal: number;
}

export interface SessionOptions {
  /** radius override, used to instantiate Theorem 5 for a given k (strategy 1) */
  radiusOverride?: number;
  /**
   * Witness validity policy: when the number of primitive events of one step exceeds
   * rebuildThreshold * (n + m), the stores are declared invalid for that step and the
   * global rules fall back to BatchGlobal (then the stores are rebuilt). Default: never.
   */
  rebuildThreshold?: number;
  /**
   * Review n14 (real edit history): 'false' (default) removes the local violations anchored in
   * the scope through an anchor index and materialises the full violation list only when
   * StepResult.violations is read; 'true' restores the earlier behaviour (scan of every stored
   * local violation and an eager violation list each step), kept to measure that per-step
   * O(|Omega|) term on models that carry many violations.
   */
  eagerOutput?: boolean;
}

type Primitive =
  | { kind: 'addNode'; id: string; node: ModelNode }
  | { kind: 'delNode'; id: string }
  | { kind: 'addEdge'; edge: ModelEdge }
  | { kind: 'delEdge'; edge: ModelEdge }
  | { kind: 'setAttr'; id: string; attr: string; value: AttrValue | undefined };

interface GlobalStore {
  rule: Rule;
  acyclic?: AcyclicWitness;
  trace?: TraceWitness;
  /** W has valid witnesses for r (Fig. 2, valid-witness branch) */
  valid: boolean;
}

export class IncrementalSession {
  private readonly k: number;
  private readonly rLoc: Rule[];
  private readonly rGlob: Rule[];
  private stores: GlobalStore[] = [];
  /** current local violations, keyed by canonical violation key */
  private local = new Map<string, Violation>();
  /** anchor node -> keys of the stored local violations whose (last) grounding is anchored there */
  private localByAnchor = new Map<string, Set<string>>();
  private global: Violation[] = [];
  private readonly eagerOutput: boolean;
  /** incremented by every step; a lazily materialised StepResult.violations must be read before the next step */
  private version = 0;
  private readonly rebuildThreshold: number;
  /** cumulative counters over the session */
  public fallbacks = 0;

  constructor(
    private readonly g: TypedGraph,
    private readonly c: Catalog,
    rules: Rule[],
    private readonly strategy: StrategyId,
    radiusOverride?: number,
    options: SessionOptions = {},
  ) {
    this.rLoc = localRules(rules);
    this.rGlob = globalRules(rules);
    this.k = radiusOverride ?? options.radiusOverride ?? maxLocalRadius(rules);
    this.rebuildThreshold = options.rebuildThreshold ?? Number.POSITIVE_INFINITY;
    this.eagerOutput = options.eagerOutput ?? false;
    // initial full validation (Fig. 2 with Delta absent)
    for (const r of this.rLoc) for (const v of evaluateLocalRule(g, c, r, undefined)) this.putLocal(v);
    if (strategy === 3) {
      for (const r of this.rGlob) {
        if (r.kind === 'acyclic') this.stores.push({ rule: r, acyclic: new AcyclicWitness(g, r), valid: true });
        else if (r.kind === 'tracePolicy') this.stores.push({ rule: r, trace: new TraceWitness(g, r), valid: true });
      }
      this.global = this.reportStores();
    } else {
      for (const r of this.rGlob) this.global.push(...evaluateGlobalRuleBatch(g, r));
    }
  }

  private putLocal(v: Violation): void {
    const key = violationKey(v);
    const prev = this.local.get(key);
    if (prev && prev.anchor !== v.anchor) this.localByAnchor.get(prev.anchor)?.delete(key);
    this.local.set(key, v);
    let ks = this.localByAnchor.get(v.anchor);
    if (!ks) {
      ks = new Set<string>();
      this.localByAnchor.set(v.anchor, ks);
    }
    ks.add(key);
  }

  violations(): Violation[] {
    const merged = new Map<string, Violation>(this.local);
    for (const v of this.global) merged.set(violationKey(v), v);
    return [...merged.values()];
  }

  private witnessWork(): number {
    let w = 0;
    for (const s of this.stores) w += s.acyclic ? s.acyclic.work : s.trace!.work;
    return w;
  }

  private reportStores(): Violation[] {
    const out: Violation[] = [];
    for (const s of this.stores) out.push(...(s.acyclic ? s.acyclic.report() : s.trace!.report()));
    return out;
  }

  /** Expands one change into primitive events against the current graph state. */
  private expand(ch: Change): Primitive[] {
    switch (ch.kind) {
      case 'addNode':
        return [{ kind: 'addNode', id: ch.node.id, node: { id: ch.node.id, type: ch.node.type, attrs: { ...ch.node.attrs } } }];
      case 'addEdge':
        return [{ kind: 'addEdge', edge: { ...ch.edge } }];
      case 'setAttr':
        return [{ kind: 'setAttr', id: ch.id, attr: ch.attr, value: ch.value }];
      case 'delEdge': {
        const e = this.g.edges.get(ch.id);
        return e ? [{ kind: 'delEdge', edge: { ...e } }] : [];
      }
      case 'delNode': {
        if (!this.g.nodes.has(ch.id)) return [];
        const out: Primitive[] = [];
        const incident = new Set<string>([...(this.g.out.get(ch.id) ?? []), ...(this.g.in.get(ch.id) ?? [])]);
        for (const eid of incident) {
          const e = this.g.edges.get(eid);
          if (e) out.push({ kind: 'delEdge', edge: { ...e } });
        }
        out.push({ kind: 'delNode', id: ch.id });
        return out;
      }
    }
  }

  /**
   * Witness validity check for one primitive event. A node replacement that changes the
   * node type is outside the update rules of the trace store (source/target membership
   * would change underneath existing evidence), so the trace stores become invalid.
   */
  private invalidateFor(p: Primitive): void {
    if (p.kind !== 'addNode') return;
    const old = this.g.nodes.get(p.id);
    if (!old || old.type === p.node.type) return;
    for (const s of this.stores) if (s.trace) s.valid = false;
  }

  /** Applies one primitive event to G and notifies the valid witness stores. */
  private applyPrimitive(p: Primitive): void {
    switch (p.kind) {
      case 'addNode': {
        addNode(this.g, p.node);
        for (const s of this.stores) {
          if (!s.valid) continue;
          if (s.acyclic) s.acyclic.onAddNode(p.id);
          else s.trace!.onAddNode(p.id);
        }
        break;
      }
      case 'addEdge': {
        if (!addEdge(this.g, p.edge)) break;
        for (const s of this.stores) {
          if (!s.valid) continue;
          if (s.acyclic) {
            if ((s.rule as Extract<Rule, { kind: 'acyclic' }>).edgeType === p.edge.type) s.acyclic.onAddEdge(p.edge.src, p.edge.tgt);
          } else s.trace!.onAddEdge(p.edge.src, p.edge.tgt, p.edge.id);
        }
        break;
      }
      case 'delEdge': {
        if (!this.g.edges.has(p.edge.id)) break;
        delEdge(this.g, p.edge.id);
        for (const s of this.stores) {
          if (!s.valid) continue;
          if (s.acyclic) {
            if ((s.rule as Extract<Rule, { kind: 'acyclic' }>).edgeType === p.edge.type) s.acyclic.onDelEdge(p.edge.src, p.edge.tgt);
          } else s.trace!.onDelEdge(p.edge.src, p.edge.tgt, p.edge.id, p.edge.type);
        }
        break;
      }
      case 'delNode': {
        if (!this.g.nodes.has(p.id)) break;
        delNode(this.g, p.id);
        for (const s of this.stores) {
          if (!s.valid) continue;
          if (s.acyclic) s.acyclic.onDelNode(p.id);
          else s.trace!.onDelNode(p.id);
        }
        break;
      }
      case 'setAttr':
        setAttr(this.g, p.id, p.attr, p.value);
        break;
    }
  }

  step(changes: Change[]): StepResult {
    const groundingsBefore = opCounter.groundings;
    const scansBefore = opCounter.scans;
    const globalWorkBefore = opCounter.globalWork;
    const workBefore = this.witnessWork();

    // line 8: S_pre = N_k^G(supp) on the pre-state
    const supportPre = changeSupportNodes(this.g, changes);
    const scopePre = kHopNodes(this.g, supportPre, this.k);

    // validity policy on the size of the change
    if (this.strategy === 3 && changes.length > this.rebuildThreshold * (this.g.nodes.size + this.g.edges.size)) {
      for (const s of this.stores) s.valid = false;
    }

    // lines 9-11: Expand(Delta), apply in place, event-driven UpdateWitness
    const supportPost: string[] = [];
    for (const ch of changes) {
      for (const p of this.expand(ch)) {
        if (this.strategy === 3) this.invalidateFor(p);
        this.applyPrimitive(p);
        if (p.kind === 'addNode' || p.kind === 'delNode' || p.kind === 'setAttr') supportPost.push(p.id);
        else supportPost.push(p.edge.src, p.edge.tgt);
      }
    }

    // line 12: S = S_pre u N_k^G'(supp) on the post-state
    const scope = new Set<string>(scopePre);
    for (const v of kHopNodes(this.g, supportPost, this.k)) scope.add(v);

    // line 13: keep the local violations anchored outside S
    let removedLocal = 0;
    if (this.eagerOutput) {
      for (const [key, v] of this.local) {
        if (scope.has(v.anchor)) {
          this.local.delete(key);
          this.localByAnchor.get(v.anchor)?.delete(key);
          removedLocal++;
        }
      }
    } else {
      for (const a of scope) {
        const ks = this.localByAnchor.get(a);
        if (!ks) continue;
        for (const key of ks) if (this.local.delete(key)) removedLocal++;
        this.localByAnchor.delete(a);
      }
    }
    // lines 14-15: EvalLocal_r(G', S) enumerates exactly the groundings anchored in S
    for (const r of this.rLoc) for (const v of evaluateLocalRule(this.g, this.c, r, scope)) this.putLocal(v);

    // global rules
    let incrementalGlobalRules = 0;
    let batchGlobalRules = 0;
    if (this.strategy === 1) {
      const sub = inducedSubgraph(this.g, scope);
      const recomputed: Violation[] = [];
      for (const r of this.rGlob) {
        for (const v of evaluateGlobalRuleBatch(sub, r)) if (scope.has(v.anchor)) recomputed.push(v);
      }
      const kept = this.global.filter((v) => !scope.has(v.anchor) && (this.g.nodes.has(v.anchor) || this.g.edges.has(v.anchor)));
      this.global = [...kept, ...recomputed];
      batchGlobalRules += this.rGlob.length;
    } else if (this.strategy === 2) {
      this.global = [];
      for (const r of this.rGlob) this.global.push(...evaluateGlobalRuleBatch(this.g, r));
      batchGlobalRules += this.rGlob.length;
    } else {
      const out: Violation[] = [];
      for (const s of this.stores) {
        if (s.valid) {
          // IncrementalGlobal: the store was updated event by event above
          out.push(...(s.acyclic ? s.acyclic.report() : s.trace!.report()));
          incrementalGlobalRules++;
        } else {
          // BatchGlobal, then UpdateWitness by rebuilding the store
          out.push(...evaluateGlobalRuleBatch(this.g, s.rule));
          if (s.acyclic) s.acyclic.rebuild();
          else s.trace!.rebuild();
          s.valid = true;
          batchGlobalRules++;
          this.fallbacks++;
        }
      }
      this.global = out;
    }

    const witnessWork = this.witnessWork() - workBefore;
    const version = ++this.version;
    let materialized: Violation[] | undefined = this.eagerOutput ? this.violations() : undefined;
    const self = this;
    return {
      get violations(): Violation[] {
        if (!materialized) {
          if (self.version !== version) throw new Error('StepResult.violations read after a later step');
          materialized = self.violations();
        }
        return materialized;
      },
      scopeSize: scope.size,
      witnessWork,
      groundingsEvaluated: opCounter.groundings - groundingsBefore,
      localScans: opCounter.scans - scansBefore,
      globalWork: opCounter.globalWork - globalWorkBefore + witnessWork,
      incrementalGlobalRules,
      batchGlobalRules,
      removedLocal,
    };
  }
}
