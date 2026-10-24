/**
 * Pre-registered adjudication of violations reported on public SysML v2 examples.
 *
 * Each violation receives exactly one category, decided by the first matching rule:
 *
 *   N  false violation caused by normalization loss (S1 dropped, approximated or
 *      conflated information that would have discharged the violation)
 *      N1 relationType / multiplicity on an edge whose end was reached through a
 *         reference-feature chain that conflates feature contexts (self-loop or via ref)
 *      N2 requiredAttr / attrDomain on an attribute whose value is a non-literal
 *         expression that S1 does not evaluate
 *      N3 multiplicity (lower bound) or isolation of a node whose name occurs as an end
 *         of a relationship statement that S1 could not map (unresolved end / end not in G)
 *      N4 multiplicity 'contain|in' or isolation of a node whose owner is a reference
 *         feature or another element that S1 does not map into G
 *   T  true violation: the violated rule is implied by SysML v2 well-formedness, i.e.
 *      satisfy / verify target not a requirement, verify source not a verification case,
 *      expose source not a view. Candidates are listed with the source line for manual
 *      confirmation.
 *   P  catalog policy differs from the example's intent: the model is well-formed SysML v2
 *      and the rule encodes an organizational policy the example does not adopt
 *      P1 required attribute never declared in the model (own or inherited)
 *      P2 required attribute declared without a value (left open by the example)
 *      P3 attribute value legal in SysML v2 but outside the catalog domain
 *      P4 relation between element kinds that SysML v2 permits but the catalog forbids
 *      P5 multiplicity policy (coverage / allocation / subject) not adopted by the example
 *      P6 isolation, view or trace policy not adopted by the example
 *      P7 the anchor is a definition (a type), while the catalog policy is usage-level
 */

import { Violation } from '../model/types';
import { TypedGraph } from '../model/types';
import { S1Result } from './normalize';

export type Verdict = 'N' | 'T' | 'P';

export interface Adjudication {
  ruleId: string;
  witness: string[];
  verdict: Verdict;
  code: string;
  reason: string;
  evidence: Array<{ file: string; line: number; text: string }>;
}

export function adjudicate(
  v: Violation,
  g: TypedGraph,
  s1: S1Result,
  sourceLine: (file: string, line: number) => string,
): Adjudication {
  const ev = (file: string, line: number) => ({ file, line, text: sourceLine(file, line).trim().slice(0, 200) });
  const base = { ruleId: v.ruleId, witness: v.witness };
  const anchorNode = g.nodes.get(v.anchor);
  const prov = anchorNode ? s1.nodeProv.get(anchorNode.id) : undefined;
  const nodeEvidence = prov ? [ev(prov.file, prov.line)] : [];
  const nodeName = anchorNode ? String(anchorNode.attrs.name ?? '') : '';

  if (v.kind === 'relationType') {
    const e = g.edges.get(v.witness[0]);
    const ep = e ? s1.edgeProv.get(e.id) : undefined;
    const evid = ep ? [ev(ep.file, ep.line)] : [];
    if (e && ep && (ep.viaReference || e.src === e.tgt)) {
      return { ...base, verdict: 'N', code: 'N1', reason: 'edge end reached through a reference-feature chain; feature contexts are conflated by S1', evidence: evid };
    }
    const tgt = e ? s1.classes.get(e.tgt) : undefined;
    const src = e ? s1.classes.get(e.src) : undefined;
    if (e && (e.type === 'satisfy' || e.type === 'verify') && tgt && !tgt.has('Requirement')) {
      return { ...base, verdict: 'T', code: 'T', reason: `${e.type} target is not a requirement (SysML v2 well-formedness)`, evidence: evid };
    }
    if (e && e.type === 'verify' && src && !src.has('VerificationCase')) {
      return { ...base, verdict: 'T', code: 'T', reason: 'verify source is not a verification case (SysML v2 well-formedness)', evidence: evid };
    }
    if (e && e.type === 'expose' && src && !src.has('View')) {
      return { ...base, verdict: 'T', code: 'T', reason: 'expose source is not a view (SysML v2 well-formedness)', evidence: evid };
    }
    const sk = e ? s1.nodeProv.get(e.src)?.kind : '?';
    const tk = e ? s1.nodeProv.get(e.tgt)?.kind : '?';
    return { ...base, verdict: 'P', code: 'P4', reason: `${e?.type} from ${sk} to ${tk} is legal SysML v2 but outside the catalog's allowed type pairs`, evidence: evid };
  }

  if (v.kind === 'requiredAttr' || v.kind === 'attrDomain') {
    const attr = v.ruleId.split('.').slice(1).join('.');
    if (prov && prov.nonLiteral.includes(attr)) {
      return { ...base, verdict: 'N', code: 'N2', reason: `attribute ${attr} is defined by an expression that S1 does not evaluate`, evidence: nodeEvidence };
    }
    if (v.kind === 'attrDomain') {
      return { ...base, verdict: 'P', code: 'P3', reason: `value of ${attr} is legal SysML v2 but outside the catalog domain`, evidence: nodeEvidence };
    }
    if (prov && prov.level === 'definition' && attr !== 'name') {
      // fall through to P1/P2 but flag the definition level
    }
    if (prov && prov.declaredWithoutValue.includes(attr)) {
      return { ...base, verdict: 'P', code: 'P2', reason: `attribute ${attr} is declared but left without a value`, evidence: nodeEvidence };
    }
    return { ...base, verdict: 'P', code: 'P1', reason: `attribute ${attr} is never declared for this element (catalog policy)`, evidence: nodeEvidence };
  }

  if (v.kind === 'multiplicity' || v.kind === 'isolated') {
    // N3: the node is named as an end of a relationship statement that S1 could not map
    if (anchorNode && prov) {
      // the dropped end denotes a feature owned by this node, or (unresolved) names it in the same file
      const edgeType = v.kind === 'multiplicity' ? v.ruleId.split('|')[1] : undefined;
      const hit = s1.lostEdgeEnds.find((x) => {
        if (edgeType && x.edgeType !== edgeType) return false;
        if (x.ownerNode !== undefined) return x.ownerNode === anchorNode.id;
        const last = x.end.replace(/^~/, '').split(/::|\./).pop();
        return x.reason === 'unresolved reference' && x.file === prov.file && last === nodeName;
      });
      if (hit) {
        return { ...base, verdict: 'N', code: 'N3', reason: `node is an end of an unmapped ${hit.rel} (${hit.reason})`, evidence: [...nodeEvidence, ev(hit.file, hit.line)] };
      }
    }
    const containIn = v.kind === 'multiplicity' && v.ruleId.includes('|contain|in');
    if ((containIn || v.kind === 'isolated') && prov && prov.level === 'usage') {
      // N4: the owner exists in the text but is not a node of G
      const ownerCat = prov.ownerCategory;
      if (ownerCat === 'ref' || ownerCat === 'unmapped') {
        return { ...base, verdict: 'N', code: 'N4', reason: `owner (${prov.ownerKind}) is not mapped into G by S1`, evidence: nodeEvidence };
      }
    }
    if (prov && prov.level === 'definition') {
      return { ...base, verdict: 'P', code: 'P7', reason: 'anchor is a definition (type); the catalog policy is written for usages', evidence: nodeEvidence };
    }
    if (v.kind === 'multiplicity') {
      return { ...base, verdict: 'P', code: 'P5', reason: `${v.ruleId} is a coverage/allocation policy the example does not adopt`, evidence: nodeEvidence };
    }
    return { ...base, verdict: 'P', code: 'P6', reason: 'isolation policy not adopted by the example', evidence: nodeEvidence };
  }

  // viewConsistency, tracePolicy, acyclic
  if (prov && prov.level === 'definition') {
    return { ...base, verdict: 'P', code: 'P7', reason: 'anchor is a definition (type); the catalog policy is written for usages', evidence: nodeEvidence };
  }
  return { ...base, verdict: 'P', code: 'P6', reason: `${v.kind} policy not adopted by the example`, evidence: nodeEvidence };
}
