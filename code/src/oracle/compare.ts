/**
 * Differential comparison of engine output and independent-oracle output.
 *
 * Both sides are mapped to a common key "RULE|grounding" (grounding ids sorted):
 *  - rule-name convention: the engine names required-attribute rules ATTR:..., the oracle
 *    REQ:... (no printed name in the manuscript); ATTR is mapped to REQ.
 *  - acyclic granularity: the engine reports one violation per non-trivial SCC (node set);
 *    the oracle reports every edge on a cycle (manuscript: "비자명 SCC에 속한 엣지 집합").
 *    The oracle's cyclic edges are projected to node sets by weak components of the
 *    cyclic-edge subgraph, which are exactly the non-trivial SCCs. A second, edge-level
 *    comparison of acyclic results is not possible from the engine output.
 */

import { Violation } from '../model/types';
import { OracleViolation } from './bridge';

export function engineKey(v: Violation): string {
  const rule = v.ruleId.startsWith('ATTR:') ? 'REQ:' + v.ruleId.slice(5) : v.ruleId;
  return `${rule}|${[...v.witness].sort().join(',')}`;
}

export function engineKeys(vs: Violation[]): Set<string> {
  return new Set(vs.map(engineKey));
}

/** Oracle violations -> comparison keys (acyclic projected to SCC node sets). */
export function oracleKeys(vs: OracleViolation[]): Set<string> {
  const out = new Set<string>();
  const cyclic = new Map<string, [string, string][]>(); // rule -> (src, tgt) of cyclic edges
  for (const v of vs) {
    if (v.cls === 'acyclic') {
      const [, s, t] = v.grounding;
      if (!cyclic.has(v.rule)) cyclic.set(v.rule, []);
      cyclic.get(v.rule)!.push([s, t]);
      continue;
    }
    const g = v.cls === 'relationType' ? [v.grounding[0]] : [...v.grounding];
    out.add(`${v.rule}|${g.sort().join(',')}`);
  }
  for (const [rule, edges] of cyclic) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        const p = parent.get(parent.get(x)!)!;
        parent.set(x, p);
        x = p;
      }
      return x;
    };
    for (const [s, t] of edges) {
      if (!parent.has(s)) parent.set(s, s);
      if (!parent.has(t)) parent.set(t, t);
      const a = find(s);
      const b = find(t);
      if (a !== b) parent.set(a, b);
    }
    const comps = new Map<string, string[]>();
    for (const x of parent.keys()) {
      const r = find(x);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r)!.push(x);
    }
    for (const c of comps.values()) out.add(`${rule}|${c.sort().join(',')}`);
  }
  return out;
}

export interface Diff {
  engineOnly: string[];
  oracleOnly: string[];
}

export function diff(engine: Set<string>, oracle: Set<string>): Diff {
  return {
    engineOnly: [...engine].filter((k) => !oracle.has(k)).sort(),
    oracleOnly: [...oracle].filter((k) => !engine.has(k)).sort(),
  };
}

export function ruleClassOfKey(k: string): string {
  return k.split(':', 1)[0];
}
