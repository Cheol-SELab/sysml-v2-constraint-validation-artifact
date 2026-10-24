/**
 * Reference semantics Omega* (section 4.5), written directly from the definition.
 *
 * This module is deliberately unoptimized and independent of the production engine:
 * groundings are enumerated over all elements, every quantifier is evaluated by a full
 * scan, and reachability is recomputed from scratch by repeated edge scans. It exists so
 * that Theorem 1 (Omega = Omega*) can be checked against something that is not the
 * algorithm being tested.
 */

import { inDomain, makeViolation } from '../catalog/rules';
import { Catalog, Rule, TypedGraph, Violation } from '../model/types';

/** reach_T(x, y) with path length >= 1, computed by naive iterated edge scanning. */
function naiveReach(g: TypedGraph, from: string, edgeTypes: string[], stopAtType?: string, catalogless?: boolean): Set<string> {
  const allowed = new Set(edgeTypes);
  const reached = new Set<string>();
  let changed = true;
  const frontier = new Set<string>([from]);
  while (changed) {
    changed = false;
    for (const e of g.edges.values()) {
      if (!allowed.has(e.type)) continue;
      if ((frontier.has(e.src) || reached.has(e.src)) && !reached.has(e.tgt)) {
        reached.add(e.tgt);
        changed = true;
      }
    }
  }
  void stopAtType;
  void catalogless;
  return reached;
}

function nonTrivialSccs(g: TypedGraph, edgeType: string): string[][] {
  const ids = [...g.nodes.keys()].sort();
  const reach = new Map<string, Set<string>>();
  for (const v of ids) reach.set(v, naiveReach(g, v, [edgeType]));
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const v of ids) {
    if (seen.has(v)) continue;
    const comp = [v];
    for (const w of ids) {
      if (w === v) continue;
      if (reach.get(v)!.has(w) && reach.get(w)!.has(v)) comp.push(w);
    }
    const isSelfLoop = reach.get(v)!.has(v);
    if (comp.length > 1 || isSelfLoop) {
      for (const w of comp) seen.add(w);
      out.push(comp.sort());
    }
  }
  return out;
}

function evalRule(g: TypedGraph, c: Catalog, r: Rule): Violation[] {
  const vs: Violation[] = [];
  const nodes = [...g.nodes.values()];
  const edges = [...g.edges.values()];

  switch (r.kind) {
    case 'relationType': {
      for (const e of edges) {
        if (e.type !== r.edgeType) continue;
        const s = g.nodes.get(e.src)!;
        const t = g.nodes.get(e.tgt)!;
        if (!r.srcTypes.includes(s.type) || !r.tgtTypes.includes(t.type)) {
          vs.push(makeViolation(r.id, r.kind, [e.id], `relation ${e.id}:${e.type} connects ${s.type} -> ${t.type}`, e.src));
        }
      }
      break;
    }
    case 'requiredAttr': {
      for (const n of nodes) {
        if (n.type !== r.nodeType) continue;
        if (n.attrs[r.attr] === undefined) {
          vs.push(makeViolation(r.id, r.kind, [n.id], `missing required attribute ${r.attr}`));
        }
      }
      break;
    }
    case 'attrDomain': {
      for (const n of nodes) {
        if (n.type !== r.nodeType) continue;
        const v = n.attrs[r.attr];
        if (v === undefined) continue;
        if (!inDomain(v, r.domain)) {
          vs.push(makeViolation(r.id, r.kind, [n.id], `attribute ${r.attr}=${String(v)} outside domain`));
        }
      }
      break;
    }
    case 'multiplicity': {
      for (const n of nodes) {
        if (n.type !== r.nodeType) continue;
        let count = 0;
        for (const e of edges) {
          if (e.type !== r.edgeType) continue;
          if (r.dir === 'out' ? e.src === n.id : e.tgt === n.id) count++;
        }
        const upperOk = r.max < 0 || count <= r.max;
        if (count < r.min || !upperOk) {
          vs.push(makeViolation(r.id, r.kind, [n.id], `${r.dir} degree of ${r.edgeType} is ${count}, expected [${r.min}, ${r.max < 0 ? 'inf' : r.max}]`));
        }
      }
      break;
    }
    case 'isolated': {
      for (const n of nodes) {
        if (n.type !== r.nodeType) continue;
        let incident = false;
        for (const e of edges) {
          if (e.src === n.id || e.tgt === n.id) {
            incident = true;
            break;
          }
        }
        if (!incident) vs.push(makeViolation(r.id, r.kind, [n.id], `isolated ${n.type}`));
      }
      break;
    }
    case 'viewConsistency': {
      const p = r.policy;
      for (const v of nodes) {
        if (v.type !== p.viewType) continue;
        for (const x of nodes) {
          let exposed = false;
          for (const e of edges) {
            if (e.type === p.exposeEdgeType && e.src === v.id && e.tgt === x.id) {
              exposed = true;
              break;
            }
          }
          if (!exposed) continue;
          let ok = false;
          for (const es of edges) {
            if (es.type !== p.subjectEdgeType || es.src !== v.id) continue;
            const s = es.tgt;
            if (s === x.id) {
              ok = true;
              break;
            }
            for (const ec of edges) {
              if (ec.type === p.containEdgeType && ec.src === s && ec.tgt === x.id) {
                ok = true;
                break;
              }
            }
            if (ok) break;
          }
          if (!ok) vs.push(makeViolation(r.id, r.kind, [v.id, x.id], `view ${v.id} exposes ${x.id} outside its subject scope`, v.id));
        }
      }
      break;
    }
    case 'acyclic': {
      for (const comp of nonTrivialSccs(g, r.edgeType)) {
        vs.push(makeViolation(r.id, r.kind, comp, `cyclic ${r.edgeType} dependency over {${comp.join(', ')}}`, comp[0]));
      }
      break;
    }
    case 'tracePolicy': {
      const p = r.policy;
      for (const n of nodes) {
        if (n.type !== p.sourceType) continue;
        const reached = naiveReach(g, n.id, p.edgeTypes);
        let ok = false;
        for (const w of reached) {
          if (g.nodes.get(w)!.type === p.targetType) {
            ok = true;
            break;
          }
        }
        if (!ok) vs.push(makeViolation(r.id, r.kind, [n.id], `no ${p.edgeTypes.join('|')} path from ${n.id} to any ${p.targetType}`));
      }
      break;
    }
  }
  void c;
  return vs;
}

/** Omega*(G, C, R): the declarative semantics, evaluated rule by rule. */
export function referenceValidate(g: TypedGraph, c: Catalog, rules: Rule[]): Violation[] {
  const out: Violation[] = [];
  for (const r of rules) out.push(...evalRule(g, c, r));
  return out;
}

export { naiveReach as referenceReach };
