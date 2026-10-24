/**
 * Witness store for the Acyclic global rule (Theorem 6, invariant (i)).
 *
 * Maintained invariants:
 *   (a) every node has a position `pos`, and the members of one SCC occupy a
 *       contiguous position range;
 *   (b) for every edge (u, v) of the governed type with comp(u) != comp(v):
 *       pos(u) < pos(v).
 *
 * Insertion of (u, v) with pos(u) > pos(v) is handled by recomputing SCCs and the
 * topological order inside the position interval [pos(v), pos(u)] only. Any cycle
 * created by the new edge lies wholly inside that interval, because invariant (b)
 * held before the insertion. Deletion never creates a cycle and never breaks (b);
 * it can only split one component, which is recomputed inside that component's
 * contiguous range.
 */

import { Rule, TypedGraph, Violation } from '../model/types';
import { makeViolation } from '../catalog/rules';
import { hasSelfLoop, stronglyConnectedComponents } from './tarjan';

export class AcyclicWitness {
  /** position sequence; removed nodes leave tombstones so that positions stay stable */
  private order: (string | null)[] = [];
  private pos = new Map<string, number>();
  private compId = new Map<string, number>();
  /** incrementally maintained set of violating components: comp id -> sorted members */
  private nonTrivial = new Map<number, string[]>();
  private nextComp = 0;
  /** work counter: number of nodes touched by recomputation, for cost reporting */
  public work = 0;

  constructor(private readonly g: TypedGraph, private readonly rule: Extract<Rule, { kind: 'acyclic' }>) {
    this.rebuild();
  }

  /** Full construction: Tarjan + condensation topological order (BatchGlobal). */
  rebuild(): void {
    const { components, compOf } = stronglyConnectedComponents(this.g, this.rule.edgeType);
    // Tarjan emits components in reverse topological order of the condensation.
    const ordered = [...components].reverse();
    this.order = [];
    this.pos = new Map();
    this.compId = new Map();
    this.nonTrivial = new Map();
    this.nextComp = 0;
    for (const comp of ordered) {
      const cid = this.nextComp++;
      for (const v of comp) {
        this.compId.set(v, cid);
        this.pos.set(v, this.order.length);
        this.order.push(v);
      }
      this.classify(cid, comp);
    }
    void compOf;
    this.work += this.g.nodes.size;
  }

  /**
   * Expands a position interval outward so that it contains only whole components.
   * Components are contiguous, so only the two boundaries can be partial.
   */
  private expandToComponentBoundaries(lo: number, hi: number): [number, number] {
    const cidOf = (i: number): number | undefined => {
      const v = this.order[i];
      return v === null || v === undefined ? undefined : this.compId.get(v);
    };
    const loCid = cidOf(lo);
    const hiCid = cidOf(hi);
    let a = lo;
    let b = hi;
    while (a > 0) {
      const c = cidOf(a - 1);
      if (c === undefined || c === loCid) a--;
      else break;
    }
    while (b < this.order.length - 1) {
      const c = cidOf(b + 1);
      if (c === undefined || c === hiCid) b++;
      else break;
    }
    return [a, b];
  }

  /** Live nodes in a position interval. */
  private slice(lo: number, hi: number): string[] {
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const v = this.order[i];
      if (v !== null && v !== undefined && this.g.nodes.has(v)) out.push(v);
    }
    return out;
  }

  /** Records or clears a component in the violating-component set. */
  private classify(cid: number, comp: string[]): void {
    if (comp.length > 1 || hasSelfLoop(this.g, comp[0], this.rule.edgeType)) {
      this.nonTrivial.set(cid, [...comp].sort());
    } else {
      this.nonTrivial.delete(cid);
    }
  }

  private reindex(range: string[], startPos: number, endPos: number): void {
    const region = new Set(range);
    for (let i = startPos; i <= endPos; i++) this.order[i] = null;
    for (const v of region) {
      const old = this.compId.get(v);
      if (old !== undefined) this.nonTrivial.delete(old);
    }
    const { components } = stronglyConnectedComponents(this.g, this.rule.edgeType, region);
    const ordered = [...components].reverse();
    let p = startPos;
    for (const comp of ordered) {
      const cid = this.nextComp++;
      for (const v of comp) {
        this.compId.set(v, cid);
        this.pos.set(v, p);
        this.order[p] = v;
        p++;
      }
      this.classify(cid, comp);
    }
    this.work += Math.max(1, range.length);
  }

  /** Position range of the component containing `v` (components are contiguous). */
  private componentRange(v: string): [number, number] {
    const p = this.pos.get(v)!;
    return this.expandToComponentBoundaries(p, p);
  }

  onAddNode(v: string): void {
    if (this.pos.has(v)) return;
    this.compId.set(v, this.nextComp++);
    this.pos.set(v, this.order.length);
    this.order.push(v);
    this.work += 1;
  }

  onDelNode(v: string): void {
    if (!this.pos.has(v)) return;
    const p = this.pos.get(v)!;
    this.order[p] = null;
    this.pos.delete(v);
    const old = this.compId.get(v);
    if (old !== undefined) this.nonTrivial.delete(old);
    this.compId.delete(v);
    this.work += 1;
  }

  /** Edge insertion. `u`, `v` are the endpoints of the inserted edge of the governed type. */
  onAddEdge(u: string, v: string): void {
    if (!this.pos.has(u)) this.onAddNode(u);
    if (!this.pos.has(v)) this.onAddNode(v);
    if (u === v) {
      const [lo, hi] = this.componentRange(u);
      this.reindex(this.slice(lo, hi), lo, hi);
      return; // self loop turns a singleton component into a violating one
    }
    if (this.compId.get(u) === this.compId.get(v)) {
      this.work += 1;
      return;
    }
    const pu = this.pos.get(u)!;
    const pv = this.pos.get(v)!;
    if (pu < pv) {
      this.work += 1;
      return; // invariant already holds
    }
    const [lo, hi] = this.expandToComponentBoundaries(pv, pu);
    this.reindex(this.slice(lo, hi), lo, hi);
  }

  /** Edge deletion. Only a same-component deletion can change the answer. */
  onDelEdge(u: string, v: string): void {
    if (!this.pos.has(u) || !this.pos.has(v)) {
      this.work += 1;
      return;
    }
    if (u === v) {
      const [lo, hi] = this.componentRange(u);
      this.reindex(this.slice(lo, hi), lo, hi);
      return;
    }
    if (this.compId.get(u) !== this.compId.get(v)) {
      this.work += 1;
      return;
    }
    const [lo, hi] = this.componentRange(u);
    this.reindex(this.slice(lo, hi), lo, hi);
  }

  /** Reports from the incrementally maintained violating-component set. */
  report(): Violation[] {
    const out: Violation[] = [];
    for (const comp of this.nonTrivial.values()) {
      out.push(makeViolation(this.rule.id, this.rule.kind, comp, `cyclic ${this.rule.edgeType} dependency over {${comp.join(', ')}}`, comp[0]));
    }
    out.sort((a, b) => (a.witness.join(',') < b.witness.join(',') ? -1 : 1));
    return out;
  }
}
