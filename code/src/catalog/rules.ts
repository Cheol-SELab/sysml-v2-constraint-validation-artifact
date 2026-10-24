/**
 * Derivation of the rule set R from a catalog C, plus canonical violation identity.
 * The rule set is a finite subset of L_C (section 4.5); no rule outside L_C is admitted.
 */

import { AttrValue, Catalog, DomainSpec, Rule, Violation } from '../model/types';

export function deriveRules(c: Catalog): Rule[] {
  const rules: Rule[] = [];

  for (const et of c.edgeTypes) {
    const a = c.allowed[et];
    if (!a) continue;
    rules.push({ id: `TYPE:${et}`, kind: 'relationType', radius: 1, global: false, edgeType: et, srcTypes: a.src, tgtTypes: a.tgt });
  }

  for (const nt of c.nodeTypes) {
    for (const attr of c.requiredAttr[nt] ?? []) {
      rules.push({ id: `ATTR:${nt}.${attr}`, kind: 'requiredAttr', radius: 0, global: false, nodeType: nt, attr });
    }
  }

  for (const key of Object.keys(c.domain)) {
    const [nt, attr] = key.split('.');
    rules.push({ id: `DOM:${key}`, kind: 'attrDomain', radius: 0, global: false, nodeType: nt, attr, domain: c.domain[key] });
  }

  for (const key of Object.keys(c.multiplicity)) {
    const [nt, et, dir] = key.split('|') as [string, string, 'out' | 'in'];
    const [min, max] = c.multiplicity[key];
    rules.push({ id: `MULT:${key}`, kind: 'multiplicity', radius: 1, global: false, nodeType: nt, edgeType: et, dir, min, max });
  }

  for (const nt of c.nonIsolated) {
    rules.push({ id: `ISO:${nt}`, kind: 'isolated', radius: 1, global: false, nodeType: nt });
  }

  if (c.viewPolicy) {
    rules.push({ id: `VIEW:${c.viewPolicy.viewType}`, kind: 'viewConsistency', radius: 2, global: false, policy: c.viewPolicy });
  }

  for (const et of c.acyclic) {
    rules.push({ id: `ACYC:${et}`, kind: 'acyclic', radius: -1, global: true, edgeType: et });
  }

  for (const p of c.tracePolicy) {
    rules.push({ id: `TRACE:${p.id}`, kind: 'tracePolicy', radius: -1, global: true, policy: p });
  }

  return rules;
}

export function localRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => !r.global);
}

export function globalRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => r.global);
}

/** k = max local radius over R_loc (Algorithm 1, line 3). Not a free tuning parameter. */
export function maxLocalRadius(rules: Rule[]): number {
  let k = 0;
  for (const r of rules) if (!r.global && r.radius > k) k = r.radius;
  return k;
}

export function inDomain(v: AttrValue | undefined, d: DomainSpec): boolean {
  if (v === undefined) return false;
  switch (d.kind) {
    case 'enum':
      return d.values.includes(v);
    case 'range':
      return typeof v === 'number' && v >= d.min && v <= d.max;
    case 'nonEmptyString':
      return typeof v === 'string' && v.length > 0;
  }
}

/** Canonical violation key: (rule_id, sorted witness tuple). Basis of Theorem 2. */
export function violationKey(v: Violation): string {
  return `${v.ruleId}|${[...v.witness].sort().join(',')}`;
}

export function makeViolation(ruleId: string, kind: Rule['kind'], witness: string[], message: string, anchor?: string): Violation {
  const w = [...witness].sort();
  return { ruleId, kind, witness: w, message, anchor: anchor ?? w[0] };
}

export function violationSet(vs: Violation[]): Set<string> {
  return new Set(vs.map(violationKey));
}

/** Canonical serialization: byte-identical for equal violation sets (Theorem 2). */
export function serializeViolations(vs: Violation[]): string {
  const keys = vs.map(violationKey);
  keys.sort();
  return keys.join('\n');
}

export function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function setDiff(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out.sort();
}
