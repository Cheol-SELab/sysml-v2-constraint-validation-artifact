/**
 * Tarjan strongly connected components, restricted to one edge type and an optional
 * node subset. Used by BatchGlobal (Algorithm 1, line 19) and by the bounded
 * recomputation inside the acyclic witness store.
 */

import { TypedGraph } from '../model/types';

export interface SccResult {
  /** components in reverse topological order of the condensation */
  components: string[][];
  compOf: Map<string, number>;
}

export function stronglyConnectedComponents(g: TypedGraph, edgeType: string, region?: Set<string>): SccResult {
  const nodes = region ? [...region].filter((v) => g.nodes.has(v)) : [...g.nodes.keys()];
  nodes.sort();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const compOf = new Map<string, number>();
  const components: string[][] = [];
  let counter = 0;

  const succ = (v: string): string[] => {
    const out: string[] = [];
    for (const eid of g.out.get(v) ?? []) {
      const e = g.edges.get(eid)!;
      if (e.type !== edgeType) continue;
      if (region && !region.has(e.tgt)) continue;
      out.push(e.tgt);
    }
    return out;
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    // iterative Tarjan
    const work: Array<{ v: string; succs: string[]; i: number }> = [];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    work.push({ v: root, succs: succ(root), i: 0 });

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.i < frame.succs.length) {
        const w = frame.succs[frame.i++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, succs: succ(w), i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1];
          low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
        }
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === frame.v) break;
          }
          comp.sort();
          const cid = components.length;
          for (const w of comp) compOf.set(w, cid);
          components.push(comp);
        }
      }
    }
  }

  return { components, compOf };
}

export function hasSelfLoop(g: TypedGraph, node: string, edgeType: string): boolean {
  for (const eid of g.out.get(node) ?? []) {
    const e = g.edges.get(eid)!;
    if (e.type === edgeType && e.tgt === node) return true;
  }
  return false;
}

/** Non-trivial SCCs: size > 1, or a single node carrying a self loop. */
export function nonTrivialComponents(g: TypedGraph, edgeType: string, region?: Set<string>): string[][] {
  const { components } = stronglyConnectedComponents(g, edgeType, region);
  const out: string[][] = [];
  for (const c of components) {
    if (c.length > 1 || hasSelfLoop(g, c[0], edgeType)) out.push([...c].sort());
  }
  return out;
}
