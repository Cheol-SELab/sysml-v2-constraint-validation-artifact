/**
 * Witness store for the path-based TracePolicy global rule (Theorem 6, invariant (ii)).
 *
 * For every node that can reach a target-type node over the policy edge types we store a
 * witness successor edge. The witness successors form a forest rooted at the target-type
 * nodes; following them yields an explicit evidence path.
 *
 *   insertion: reachability grows monotonically, so only currently unreachable nodes can
 *              change. Backward propagation from the inserted edge suffices.
 *   deletion : only nodes whose evidence path used the deleted edge can change. Those are
 *              exactly the witness-forest subtree below the edge's source, so only that
 *              subtree is re-searched.
 */

import { makeViolation } from '../catalog/rules';
import { Rule, TypedGraph, Violation } from '../model/types';

export class TraceWitness {
  /** node -> witness successor edge id (evidence toward a target) */
  private succ = new Map<string, string>();
  /** node -> nodes that use an edge into this node as their witness successor */
  private children = new Map<string, Set<string>>();
  private reaches = new Set<string>();
  /** nodes of the policy source type */
  private sources = new Set<string>();
  /** incrementally maintained violating source nodes: sources without evidence */
  private violating = new Set<string>();
  private allowed: Set<string>;
  public work = 0;

  constructor(private readonly g: TypedGraph, private readonly rule: Extract<Rule, { kind: 'tracePolicy' }>) {
    this.allowed = new Set(rule.policy.edgeTypes);
    this.rebuild();
  }

  private isTarget(v: string): boolean {
    const n = this.g.nodes.get(v);
    return !!n && n.type === this.rule.policy.targetType;
  }

  private markReaches(v: string): void {
    this.reaches.add(v);
    if (this.sources.has(v)) this.violating.delete(v);
  }

  private clearReaches(v: string): void {
    this.reaches.delete(v);
    if (this.sources.has(v)) this.violating.add(v);
  }

  private addChild(parent: string, child: string): void {
    let s = this.children.get(parent);
    if (!s) {
      s = new Set();
      this.children.set(parent, s);
    }
    s.add(child);
  }

  private removeChild(parent: string, child: string): void {
    this.children.get(parent)?.delete(child);
  }

  /** BatchGlobal: one reverse BFS from all target-type nodes builds the whole witness forest. */
  rebuild(): void {
    this.succ = new Map();
    this.children = new Map();
    this.reaches = new Set();
    this.sources = new Set();
    this.violating = new Set();
    for (const [id, n] of this.g.nodes) {
      if (n.type === this.rule.policy.sourceType) {
        this.sources.add(id);
        this.violating.add(id);
      }
    }
    const queue: string[] = [];
    for (const v of this.g.nodes.keys()) if (this.isTarget(v)) queue.push(v);
    queue.sort();
    let head = 0;
    while (head < queue.length) {
      const w = queue[head++];
      for (const eid of this.g.in.get(w) ?? []) {
        const e = this.g.edges.get(eid)!;
        if (!this.allowed.has(e.type)) continue;
        const u = e.src;
        if (this.reaches.has(u)) continue;
        this.markReaches(u);
        this.succ.set(u, eid);
        this.addChild(w, u);
        queue.push(u);
      }
      this.work++;
    }
  }

  onAddNode(v: string): void {
    const n = this.g.nodes.get(v);
    if (n && n.type === this.rule.policy.sourceType) {
      this.sources.add(v);
      if (!this.reaches.has(v)) this.violating.add(v);
    }
    // a new node reaches nothing yet; if it is a target, its predecessors may change
    if (this.isTarget(v)) this.propagateFrom(v);
    this.work += 1;
  }

  onDelNode(v: string): void {
    const subtree = this.collectSubtree(v);
    for (const x of subtree) this.invalidate(x);
    this.reaches.delete(v);
    this.sources.delete(v);
    this.violating.delete(v);
    this.succ.delete(v);
    this.children.delete(v);
    this.reresolve(subtree);
    this.work += subtree.size + 1;
  }

  /** Backward propagation of reachability from a node that is already satisfied or a target. */
  private propagateFrom(seed: string): void {
    const queue = [seed];
    let head = 0;
    while (head < queue.length) {
      const w = queue[head++];
      for (const eid of this.g.in.get(w) ?? []) {
        const e = this.g.edges.get(eid)!;
        if (!this.allowed.has(e.type)) continue;
        const u = e.src;
        if (this.reaches.has(u)) continue;
        this.markReaches(u);
        this.succ.set(u, eid);
        this.addChild(w, u);
        queue.push(u);
      }
      this.work++;
    }
  }

  onAddEdge(u: string, v: string, edgeId: string): void {
    const e = this.g.edges.get(edgeId);
    if (!e || !this.allowed.has(e.type)) {
      this.work += 1;
      return;
    }
    if (this.reaches.has(u)) {
      this.work += 1;
      return; // already satisfied, evidence unchanged
    }
    if (this.isTarget(v) || this.reaches.has(v)) {
      this.markReaches(u);
      this.succ.set(u, edgeId);
      this.addChild(v, u);
      this.propagateFrom(u);
    } else {
      this.work += 1;
    }
  }

  private collectSubtree(root: string): Set<string> {
    const out = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (out.has(v)) continue;
      out.add(v);
      for (const c of this.children.get(v) ?? []) stack.push(c);
    }
    out.delete(root);
    return out;
  }

  private invalidate(v: string): void {
    const eid = this.succ.get(v);
    if (eid !== undefined) {
      const e = this.g.edges.get(eid);
      if (e) this.removeChild(e.tgt, v);
    }
    this.succ.delete(v);
    this.clearReaches(v);
  }

  /**
   * Re-searches evidence for an invalidated node set. A node is satisfiable again iff it
   * has an outgoing policy edge into a target or into a node that still has evidence.
   */
  private reresolve(invalidated: Set<string>): void {
    const queue: string[] = [];
    for (const u of [...invalidated].sort()) {
      if (this.reaches.has(u)) continue;
      for (const eid of this.g.out.get(u) ?? []) {
        const e = this.g.edges.get(eid)!;
        if (!this.allowed.has(e.type)) continue;
        if (this.isTarget(e.tgt) || this.reaches.has(e.tgt)) {
          this.markReaches(u);
          this.succ.set(u, eid);
          this.addChild(e.tgt, u);
          queue.push(u);
          break;
        }
      }
      this.work++;
    }
    for (const seed of queue) this.propagateFrom(seed);
  }

  onDelEdge(u: string, v: string, edgeId: string, edgeType: string): void {
    if (!this.allowed.has(edgeType)) {
      this.work += 1;
      return;
    }
    if (this.succ.get(u) !== edgeId) {
      this.work += 1;
      return; // evidence of u did not use this edge; nothing can change
    }
    const affected = this.collectSubtree(u);
    affected.add(u);
    for (const x of affected) this.invalidate(x);
    this.removeChild(v, u);
    this.reresolve(affected);
    this.work += affected.size;
  }

  /** Reports from the incrementally maintained violating-source set. */
  report(): Violation[] {
    const p = this.rule.policy;
    const out: Violation[] = [];
    for (const id of this.violating) {
      if (!this.g.nodes.has(id)) continue;
      out.push(makeViolation(this.rule.id, this.rule.kind, [id], `no ${p.edgeTypes.join('|')} path from ${id} to any ${p.targetType}`, id));
    }
    out.sort((a, b) => (a.witness[0] < b.witness[0] ? -1 : 1));
    return out;
  }

  /** Explicit evidence path for a satisfied node (used in violation evidence reporting). */
  evidencePath(from: string): string[] {
    const path: string[] = [];
    let cur = from;
    const guard = new Set<string>();
    while (this.succ.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      const eid = this.succ.get(cur)!;
      path.push(eid);
      cur = this.g.edges.get(eid)!.tgt;
      if (this.isTarget(cur)) break;
    }
    return path;
  }
}
