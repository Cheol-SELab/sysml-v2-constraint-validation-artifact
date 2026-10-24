/**
 * Three domain catalogs used in the evaluation (section 6.3). They share the type
 * vocabulary but differ in policy, which is what makes Theorem 7's catalog-swap
 * construction expressible.
 */

import { Catalog } from '../model/types';

const NODE_TYPES = ['Requirement', 'Function', 'Component', 'Interface', 'Port', 'VerificationCase', 'View'];
const EDGE_TYPES = ['satisfy', 'verify', 'allocate', 'connect', 'contain', 'dependOn', 'expose', 'subject'];

function baseCatalog(id: string): Catalog {
  return {
    id,
    nodeTypes: [...NODE_TYPES],
    edgeTypes: [...EDGE_TYPES],
    allowed: {
      satisfy: { src: ['Component'], tgt: ['Requirement'] },
      verify: { src: ['VerificationCase'], tgt: ['Requirement'] },
      allocate: { src: ['Function'], tgt: ['Component'] },
      connect: { src: ['Port'], tgt: ['Port'] },
      contain: { src: ['Component'], tgt: ['Component', 'Port'] },
      dependOn: { src: ['Component'], tgt: ['Component'] },
      expose: { src: ['View'], tgt: ['Component', 'Port'] },
      subject: { src: ['View'], tgt: ['Component'] },
    },
    requiredAttr: {
      Requirement: ['name', 'priority'],
      Function: ['name'],
      Component: ['name', 'criticality', 'mass'],
      Interface: ['name'],
      Port: ['name', 'direction'],
      VerificationCase: ['name', 'method'],
      View: ['name'],
    },
    domain: {
      'Component.criticality': { kind: 'enum', values: ['A', 'B', 'C', 'D'] },
      'Component.mass': { kind: 'range', min: 0, max: 10000 },
      'Requirement.priority': { kind: 'enum', values: ['high', 'medium', 'low'] },
      'Port.direction': { kind: 'enum', values: ['in', 'out'] },
      'VerificationCase.method': { kind: 'enum', values: ['test', 'analysis', 'inspection', 'demonstration'] },
      'Component.name': { kind: 'nonEmptyString' },
      'Requirement.name': { kind: 'nonEmptyString' },
    },
    multiplicity: {
      'Requirement|satisfy|in': [1, -1],
      'Requirement|verify|in': [1, -1],
      'Function|allocate|out': [1, 1],
      'Port|contain|in': [1, 1],
      'View|subject|out': [1, 1],
    },
    acyclic: ['dependOn'],
    tracePolicy: [{ id: 'FUN2REQ', sourceType: 'Function', edgeTypes: ['allocate', 'satisfy'], targetType: 'Requirement' }],
    nonIsolated: ['Requirement', 'Function', 'Component', 'Interface', 'Port', 'VerificationCase'],
    viewPolicy: { viewType: 'View', subjectEdgeType: 'subject', exposeEdgeType: 'expose', containEdgeType: 'contain' },
  };
}

/** Aerospace-like policy: strict verification and criticality governance. */
export function aerospaceCatalog(): Catalog {
  const c = baseCatalog('aerospace');
  c.multiplicity['Requirement|verify|in'] = [1, -1];
  c.domain['Component.criticality'] = { kind: 'enum', values: ['A', 'B', 'C', 'D'] };
  return c;
}

/** Automotive-like policy: mass budget is tighter, verification method restricted. */
export function automotiveCatalog(): Catalog {
  const c = baseCatalog('automotive');
  c.domain['Component.mass'] = { kind: 'range', min: 0, max: 3000 };
  c.domain['VerificationCase.method'] = { kind: 'enum', values: ['test', 'analysis'] };
  return c;
}

/** Robotics-like policy: no cyclic dependency allowed on connect either. */
export function roboticsCatalog(): Catalog {
  const c = baseCatalog('robotics');
  c.domain['Component.criticality'] = { kind: 'enum', values: ['high', 'medium', 'low'] };
  c.requiredAttr.Component = ['name', 'criticality', 'mass', 'power'];
  c.domain['Component.power'] = { kind: 'range', min: 0, max: 5000 };
  return c;
}

export function allCatalogs(): Catalog[] {
  return [aerospaceCatalog(), automotiveCatalog(), roboticsCatalog()];
}

/**
 * Theorem 7 witness pair: two catalogs over the same type vocabulary that disagree on
 * a single policy entry. Any catalog-independent validator returns the same answer for
 * both, while Omega* differs.
 */
export function catalogSwapPair(): { c1: Catalog; c2: Catalog; changedEntry: string } {
  const c1 = baseCatalog('swap-permissive');
  const c2 = baseCatalog('swap-restrictive');
  c2.allowed.allocate = { src: ['Function'], tgt: ['Interface'] };
  return { c1, c2, changedEntry: 'allowed(allocate).tgt: [Component] vs [Interface]' };
}
