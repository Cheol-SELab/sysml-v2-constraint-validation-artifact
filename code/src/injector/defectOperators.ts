/**
 * Defect operator families (E3 v2, review item M5).
 *
 * Every defect type D1-D8 has several mutation operators. Operators no longer select only
 * side-effect-free positions: an operator may fire rules other than its target kind, and
 * the oracle records whatever the reference semantics reports for the single-defect model.
 * The "v1" operator of each type reproduces the original fixed operator.
 *
 * Each operator enumerates candidate positions (a central node) so that the experiment can
 * stratify positions by degree tier (periphery / core / hub).
 */

import { GeneratedModel } from '../generator/syntheticModelGenerator';
import { AttrValue, Catalog, Change, ModelNode, TypedGraph } from '../model/types';
import { Rng } from '../util/rng';
import { Defect, DefectType } from './defectInjector';

export interface OperatorContext {
  g: TypedGraph;
  c: Catalog;
  gen: GeneratedModel;
  rng: Rng;
  byType: Map<string, string[]>;
}

export interface DefectOperator {
  type: DefectType;
  name: string;
  description: string;
  /** candidate central nodes */
  positions(ctx: OperatorContext): string[];
  /** builds the defect at a position, or undefined when the position does not apply */
  build(ctx: OperatorContext, pos: string, id: string): Defect | undefined;
}

export function typeIndex(g: TypedGraph): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [id, n] of g.nodes) {
    let l = m.get(n.type);
    if (!l) {
      l = [];
      m.set(n.type, l);
    }
    l.push(id);
  }
  return m;
}

function outOfType(g: TypedGraph, v: string, t: string): string[] {
  const r: string[] = [];
  for (const eid of g.out.get(v) ?? []) if (g.edges.get(eid)!.type === t) r.push(eid);
  return r;
}

function inOfType(g: TypedGraph, v: string, t: string): string[] {
  const r: string[] = [];
  for (const eid of g.in.get(v) ?? []) if (g.edges.get(eid)!.type === t) r.push(eid);
  return r;
}

function nodesOf(ctx: OperatorContext, t: string): string[] {
  return ctx.byType.get(t) ?? [];
}

function pickOther(ctx: OperatorContext, t: string, not: Set<string>): string | undefined {
  const l = nodesOf(ctx, t);
  for (let i = 0; i < 16 && l.length > 0; i++) {
    const x = l[ctx.rng.int(l.length)];
    if (!not.has(x)) return x;
  }
  return l.find((x) => !not.has(x));
}

function mk(type: DefectType, operator: string, id: string, pos: string, changes: Change[], support: string[]): Defect {
  return { id, type, operator, position: pos, changes, support: [...new Set(support)] };
}

function nodesWithOut(ctx: OperatorContext, srcType: string, et: string): string[] {
  return nodesOf(ctx, srcType).filter((v) => outOfType(ctx.g, v, et).length > 0);
}

/** required attributes with a domain, by node type */
function domainKeys(c: Catalog): Array<{ type: string; attr: string }> {
  return Object.keys(c.domain).map((k) => {
    const [type, attr] = k.split('.');
    return { type, attr };
  });
}

function outsideValue(c: Catalog, type: string, attr: string, mode: 'outside' | 'upper' | 'lower' | 'typeMismatch'): AttrValue | undefined {
  const d = c.domain[`${type}.${attr}`];
  if (!d) return undefined;
  switch (d.kind) {
    case 'enum':
      if (mode === 'outside') return 'ZZ_OUT';
      if (mode === 'typeMismatch') return typeof d.values[0] === 'number' ? 'one' : 1;
      return undefined;
    case 'range':
      if (mode === 'upper') return Math.round((d.max + 0.01) * 100) / 100;
      if (mode === 'lower') return Math.round((d.min - 0.01) * 100) / 100;
      if (mode === 'typeMismatch') return String(d.min + 1);
      if (mode === 'outside') return -1;
      return undefined;
    case 'nonEmptyString':
      if (mode === 'typeMismatch') return 42;
      if (mode === 'outside') return '';
      return undefined;
  }
}

export const OPERATORS: DefectOperator[] = [
  // ---------------- D1 relation type ----------------
  {
    type: 'D1',
    name: 'D1.v1-retarget-connect',
    description: 'connect edge retargeted from a Port to a Component (original operator)',
    positions: (ctx) => nodesWithOut(ctx, 'Port', 'connect'),
    build: (ctx, pos, id) => {
      const eid = outOfType(ctx.g, pos, 'connect')[0];
      const e = ctx.g.edges.get(eid)!;
      const target = pickOther(ctx, 'Component', new Set());
      if (!target) return undefined;
      return mk('D1', 'D1.v1-retarget-connect', id, pos, [
        { kind: 'delEdge', id: eid },
        { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'connect', src: e.src, tgt: target } },
      ], [e.src, e.tgt, target]);
    },
  },
  {
    type: 'D1',
    name: 'D1.retarget-allocate',
    description: 'allocate edge of a Function retargeted to a Port',
    positions: (ctx) => nodesWithOut(ctx, 'Function', 'allocate'),
    build: (ctx, pos, id) => {
      const eid = outOfType(ctx.g, pos, 'allocate')[0];
      const e = ctx.g.edges.get(eid)!;
      const target = pickOther(ctx, 'Port', new Set());
      if (!target) return undefined;
      return mk('D1', 'D1.retarget-allocate', id, pos, [
        { kind: 'delEdge', id: eid },
        { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'allocate', src: pos, tgt: target } },
      ], [pos, e.tgt, target]);
    },
  },
  {
    type: 'D1',
    name: 'D1.reverse-satisfy',
    description: 'satisfy edge reversed (Requirement -> Component)',
    positions: (ctx) => nodesWithOut(ctx, 'Component', 'satisfy'),
    build: (ctx, pos, id) => {
      const eid = outOfType(ctx.g, pos, 'satisfy')[0];
      const e = ctx.g.edges.get(eid)!;
      return mk('D1', 'D1.reverse-satisfy', id, pos, [
        { kind: 'delEdge', id: eid },
        { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'satisfy', src: e.tgt, tgt: e.src } },
      ], [e.src, e.tgt]);
    },
  },
  {
    type: 'D1',
    name: 'D1.add-illegal-pair',
    description: 'new edge of a random type between a type pair the catalog does not allow',
    positions: (ctx) => [...ctx.g.nodes.keys()],
    build: (ctx, pos, id) => {
      const src = ctx.g.nodes.get(pos)!;
      const types = ctx.rng.shuffle(ctx.c.edgeTypes);
      for (const t of types) {
        const a = ctx.c.allowed[t];
        if (!a) continue;
        const nodeTypes = ctx.rng.shuffle(ctx.c.nodeTypes);
        for (const nt of nodeTypes) {
          if (a.src.includes(src.type) && a.tgt.includes(nt)) continue;
          const tgt = pickOther(ctx, nt, new Set([pos]));
          if (!tgt) continue;
          return mk('D1', 'D1.add-illegal-pair', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: t, src: pos, tgt } }], [pos, tgt]);
        }
      }
      return undefined;
    },
  },
  // ---------------- D2 multiplicity ----------------
  {
    type: 'D2',
    name: 'D2.v1-drop-sole-verify',
    description: 'sole verify edge of a Requirement deleted, verification case keeps another edge (original operator)',
    positions: (ctx) => nodesOf(ctx, 'Requirement').filter((r) => inOfType(ctx.g, r, 'verify').length === 1),
    build: (ctx, pos, id) => {
      const e = ctx.g.edges.get(inOfType(ctx.g, pos, 'verify')[0])!;
      if (outOfType(ctx.g, e.src, 'verify').length < 2) return undefined;
      return mk('D2', 'D2.v1-drop-sole-verify', id, pos, [{ kind: 'delEdge', id: e.id }], [e.src, e.tgt]);
    },
  },
  {
    type: 'D2',
    name: 'D2.drop-sole-verify-any',
    description: 'sole verify edge of a Requirement deleted at any position (side effects allowed)',
    positions: (ctx) => nodesOf(ctx, 'Requirement').filter((r) => inOfType(ctx.g, r, 'verify').length === 1),
    build: (ctx, pos, id) => {
      const e = ctx.g.edges.get(inOfType(ctx.g, pos, 'verify')[0])!;
      return mk('D2', 'D2.drop-sole-verify-any', id, pos, [{ kind: 'delEdge', id: e.id }], [e.src, e.tgt]);
    },
  },
  {
    type: 'D2',
    name: 'D2.drop-sole-satisfy',
    description: 'sole satisfy edge of a Requirement deleted',
    positions: (ctx) => nodesOf(ctx, 'Requirement').filter((r) => inOfType(ctx.g, r, 'satisfy').length === 1),
    build: (ctx, pos, id) => {
      const e = ctx.g.edges.get(inOfType(ctx.g, pos, 'satisfy')[0])!;
      return mk('D2', 'D2.drop-sole-satisfy', id, pos, [{ kind: 'delEdge', id: e.id }], [e.src, e.tgt]);
    },
  },
  {
    type: 'D2',
    name: 'D2.extra-allocate',
    description: 'second allocate edge added to a Function (upper bound 1 exceeded)',
    positions: (ctx) => nodesOf(ctx, 'Function'),
    build: (ctx, pos, id) => {
      const cur = new Set(outOfType(ctx.g, pos, 'allocate').map((e) => ctx.g.edges.get(e)!.tgt));
      const t = pickOther(ctx, 'Component', cur);
      if (!t) return undefined;
      return mk('D2', 'D2.extra-allocate', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: 'allocate', src: pos, tgt: t } }], [pos, t]);
    },
  },
  {
    type: 'D2',
    name: 'D2.extra-port-owner',
    description: 'second owning contain edge added to a Port (upper bound 1 exceeded)',
    positions: (ctx) => nodesOf(ctx, 'Port'),
    build: (ctx, pos, id) => {
      const cur = new Set(inOfType(ctx.g, pos, 'contain').map((e) => ctx.g.edges.get(e)!.src));
      const o = pickOther(ctx, 'Component', cur);
      if (!o) return undefined;
      return mk('D2', 'D2.extra-port-owner', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: 'contain', src: o, tgt: pos } }], [o, pos]);
    },
  },
  {
    type: 'D2',
    name: 'D2.extra-subject',
    description: 'second subject edge added to a View (upper bound 1 exceeded)',
    positions: (ctx) => nodesOf(ctx, 'View'),
    build: (ctx, pos, id) => {
      const cur = new Set(outOfType(ctx.g, pos, 'subject').map((e) => ctx.g.edges.get(e)!.tgt));
      const s = pickOther(ctx, 'Component', cur);
      if (!s) return undefined;
      return mk('D2', 'D2.extra-subject', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: 'subject', src: pos, tgt: s } }], [pos, s]);
    },
  },
  // ---------------- D3 required attribute ----------------
  {
    type: 'D3',
    name: 'D3.v1-unset-component-attr',
    description: 'second required attribute of a Component removed (original operator)',
    positions: (ctx) => nodesOf(ctx, 'Component'),
    build: (ctx, pos, id) => {
      const attr = (ctx.c.requiredAttr.Component ?? [])[1] ?? 'criticality';
      return mk('D3', 'D3.v1-unset-component-attr', id, pos, [{ kind: 'setAttr', id: pos, attr, value: undefined }], [pos]);
    },
  },
  {
    type: 'D3',
    name: 'D3.unset-any',
    description: 'a random required attribute of a node of any type removed',
    positions: (ctx) => [...ctx.g.nodes.keys()].filter((v) => (ctx.c.requiredAttr[ctx.g.nodes.get(v)!.type] ?? []).length > 0),
    build: (ctx, pos, id) => {
      const attrs = ctx.c.requiredAttr[ctx.g.nodes.get(pos)!.type] ?? [];
      const present = attrs.filter((a) => ctx.g.nodes.get(pos)!.attrs[a] !== undefined);
      if (present.length === 0) return undefined;
      const attr = ctx.rng.pick(present);
      return mk('D3', 'D3.unset-any', id, pos, [{ kind: 'setAttr', id: pos, attr, value: undefined }], [pos]);
    },
  },
  // ---------------- D4 value domain ----------------
  ...(['v1', 'outside', 'upper', 'lower', 'typeMismatch'] as const).map(
    (mode): DefectOperator => ({
      type: 'D4',
      name: mode === 'v1' ? 'D4.v1-negative-mass' : `D4.${mode}`,
      description:
        mode === 'v1'
          ? 'Component mass set to -1 (original operator)'
          : mode === 'outside'
            ? 'value outside the enumeration / negative / empty string, on a random domain attribute'
            : mode === 'upper'
              ? 'range attribute set to max + 0.01 (boundary)'
              : mode === 'lower'
                ? 'range attribute set to min - 0.01 (boundary)'
                : 'value of the wrong primitive type (string for range, number for enum, number for string)',
      positions: (ctx) => {
        if (mode === 'v1') return nodesOf(ctx, 'Component');
        const types = new Set(
          domainKeys(ctx.c)
            .filter((k) => outsideValue(ctx.c, k.type, k.attr, mode) !== undefined)
            .map((k) => k.type),
        );
        return [...ctx.g.nodes.keys()].filter((v) => types.has(ctx.g.nodes.get(v)!.type));
      },
      build: (ctx, pos, id) => {
        const nt = ctx.g.nodes.get(pos)!.type;
        if (mode === 'v1') return mk('D4', 'D4.v1-negative-mass', id, pos, [{ kind: 'setAttr', id: pos, attr: 'mass', value: -1 }], [pos]);
        const keys = domainKeys(ctx.c).filter((k) => k.type === nt && outsideValue(ctx.c, k.type, k.attr, mode) !== undefined);
        if (keys.length === 0) return undefined;
        const k = ctx.rng.pick(keys);
        return mk('D4', `D4.${mode}`, id, pos, [{ kind: 'setAttr', id: pos, attr: k.attr, value: outsideValue(ctx.c, k.type, k.attr, mode) }], [pos]);
      },
    }),
  ),
  // ---------------- D5 traceability ----------------
  {
    type: 'D5',
    name: 'D5.v1-drop-satisfy',
    description: 'sole satisfy edge of a function-hosting Component deleted, requirement keeps another satisfier (original operator)',
    positions: (ctx) => nodesOf(ctx, 'Component').filter((v) => inOfType(ctx.g, v, 'allocate').length > 0 && outOfType(ctx.g, v, 'satisfy').length === 1),
    build: (ctx, pos, id) => {
      const e = ctx.g.edges.get(outOfType(ctx.g, pos, 'satisfy')[0])!;
      if (inOfType(ctx.g, e.tgt, 'satisfy').length < 2) return undefined;
      return mk('D5', 'D5.v1-drop-satisfy', id, pos, [{ kind: 'delEdge', id: e.id }], [pos, e.tgt]);
    },
  },
  {
    type: 'D5',
    name: 'D5.drop-all-satisfy',
    description: 'all satisfy edges of a function-hosting Component deleted (side effects allowed)',
    positions: (ctx) => nodesOf(ctx, 'Component').filter((v) => inOfType(ctx.g, v, 'allocate').length > 0 && outOfType(ctx.g, v, 'satisfy').length > 0),
    build: (ctx, pos, id) => {
      const es = outOfType(ctx.g, pos, 'satisfy');
      return mk('D5', 'D5.drop-all-satisfy', id, pos, es.map((e): Change => ({ kind: 'delEdge', id: e })), [pos, ...es.map((e) => ctx.g.edges.get(e)!.tgt)]);
    },
  },
  {
    type: 'D5',
    name: 'D5.retarget-allocate-unsatisfying',
    description: 'allocate edge of a Function moved to a Component without any satisfy edge',
    positions: (ctx) => nodesWithOut(ctx, 'Function', 'allocate'),
    build: (ctx, pos, id) => {
      const eid = outOfType(ctx.g, pos, 'allocate')[0];
      const old = ctx.g.edges.get(eid)!.tgt;
      const cands = nodesOf(ctx, 'Component').filter((v) => v !== old && outOfType(ctx.g, v, 'satisfy').length === 0);
      if (cands.length === 0) return undefined;
      const t = cands[ctx.rng.int(cands.length)];
      return mk('D5', 'D5.retarget-allocate-unsatisfying', id, pos, [
        { kind: 'delEdge', id: eid },
        { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'allocate', src: pos, tgt: t } },
      ], [pos, old, t]);
    },
  },
  // ---------------- D6 acyclicity ----------------
  {
    type: 'D6',
    name: 'D6.v1-reverse-edge',
    description: 'reverse dependOn edge added (2-cycle, original operator)',
    positions: (ctx) => nodesWithOut(ctx, 'Component', 'dependOn'),
    build: (ctx, pos, id) => {
      const e = ctx.g.edges.get(outOfType(ctx.g, pos, 'dependOn')[0])!;
      if (e.src === e.tgt) return undefined;
      return mk('D6', 'D6.v1-reverse-edge', id, pos, [{ kind: 'addEdge', edge: { id: `${e.id}_${id}`, type: 'dependOn', src: e.tgt, tgt: e.src } }], [e.src, e.tgt]);
    },
  },
  {
    type: 'D6',
    name: 'D6.close-long-path',
    description: 'dependOn path of length >= 2 closed into a cycle',
    positions: (ctx) => nodesWithOut(ctx, 'Component', 'dependOn'),
    build: (ctx, pos, id) => {
      const path = [pos];
      let cur = pos;
      const seen = new Set([pos]);
      for (let i = 0; i < 6; i++) {
        const outs = outOfType(ctx.g, cur, 'dependOn');
        if (outs.length === 0) break;
        const nxt = ctx.g.edges.get(outs[ctx.rng.int(outs.length)])!.tgt;
        if (seen.has(nxt)) break;
        seen.add(nxt);
        path.push(nxt);
        cur = nxt;
      }
      if (path.length < 3) return undefined;
      return mk('D6', 'D6.close-long-path', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: 'dependOn', src: cur, tgt: pos } }], path);
    },
  },
  {
    type: 'D6',
    name: 'D6.self-loop',
    description: 'dependOn self loop on a Component',
    positions: (ctx) => nodesOf(ctx, 'Component'),
    build: (ctx, pos, id) => mk('D6', 'D6.self-loop', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: 'dependOn', src: pos, tgt: pos } }], [pos]),
  },
  // ---------------- D7 isolation ----------------
  {
    type: 'D7',
    name: 'D7.v1-new-interface',
    description: 'new isolated Interface (original operator)',
    positions: (ctx) => ['(new)'],
    build: (ctx, pos, id) => {
      const node: ModelNode = { id: `I_${id}`, type: 'Interface', attrs: {} };
      for (const a of ctx.c.requiredAttr.Interface ?? []) node.attrs[a] = `interface_${id}_${a}`;
      return mk('D7', 'D7.v1-new-interface', id, node.id, [{ kind: 'addNode', node }], [node.id]);
    },
  },
  {
    type: 'D7',
    name: 'D7.new-other-type',
    description: 'new isolated node of another non-isolated type with valid attributes (side effects allowed)',
    positions: (ctx) => ['(new)'],
    build: (ctx, pos, id) => {
      const types = ctx.c.nonIsolated.filter((t) => t !== 'Interface');
      if (types.length === 0) return undefined;
      const t = ctx.rng.pick(types);
      const node: ModelNode = { id: `N_${id}`, type: t, attrs: {} };
      for (const a of ctx.c.requiredAttr[t] ?? []) {
        const d = ctx.c.domain[`${t}.${a}`];
        node.attrs[a] = !d ? `${t}_${id}_${a}` : d.kind === 'enum' ? d.values[0] : d.kind === 'range' ? d.min : `${t}_${id}`;
      }
      return mk('D7', 'D7.new-other-type', id, node.id, [{ kind: 'addNode', node }], [node.id]);
    },
  },
  {
    type: 'D7',
    name: 'D7.detach-existing',
    description: 'all relationships of an existing node deleted',
    positions: (ctx) => [...ctx.g.nodes.keys()].filter((v) => ctx.c.nonIsolated.includes(ctx.g.nodes.get(v)!.type)),
    build: (ctx, pos, id) => {
      const es = [...new Set([...(ctx.g.out.get(pos) ?? []), ...(ctx.g.in.get(pos) ?? [])])];
      if (es.length === 0 || es.length > 12) return undefined;
      const sup = [pos];
      for (const e of es) {
        const ed = ctx.g.edges.get(e)!;
        sup.push(ed.src, ed.tgt);
      }
      return mk('D7', 'D7.detach-existing', id, pos, es.map((e): Change => ({ kind: 'delEdge', id: e })), sup);
    },
  },
  // ---------------- D8 view consistency ----------------
  {
    type: 'D8',
    name: 'D8.v1-expose-foreign-port',
    description: 'non-subject expose edge of a View moved to a Port of another component (original operator)',
    positions: (ctx) => nodesOf(ctx, 'View'),
    build: (ctx, pos, id) => {
      const subject = ctx.gen.subjectOf.get(pos);
      if (!subject) return undefined;
      const ex = outOfType(ctx.g, pos, 'expose').filter((eid) => ctx.g.edges.get(eid)!.tgt !== subject);
      if (ex.length === 0) return undefined;
      const foreign = ctx.rng
        .shuffle([...ctx.gen.portsOf.entries()].filter(([cmp, ports]) => cmp !== subject && ports.length > 0))
        .map(([, ports]) => ports[0])[0];
      if (!foreign) return undefined;
      const eid = ex[0];
      return mk('D8', 'D8.v1-expose-foreign-port', id, pos, [
        { kind: 'delEdge', id: eid },
        { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'expose', src: pos, tgt: foreign } },
      ], [pos, ctx.g.edges.get(eid)!.tgt, foreign]);
    },
  },
  {
    type: 'D8',
    name: 'D8.add-expose-foreign-component',
    description: 'expose edge added from a View to a Component outside its subject scope',
    positions: (ctx) => nodesOf(ctx, 'View'),
    build: (ctx, pos, id) => {
      const subjects = outOfType(ctx.g, pos, 'subject').map((e) => ctx.g.edges.get(e)!.tgt);
      const inScope = new Set(subjects);
      for (const s of subjects) for (const e of outOfType(ctx.g, s, 'contain')) inScope.add(ctx.g.edges.get(e)!.tgt);
      const t = pickOther(ctx, 'Component', inScope);
      if (!t) return undefined;
      return mk('D8', 'D8.add-expose-foreign-component', id, pos, [{ kind: 'addEdge', edge: { id: `x_${id}`, type: 'expose', src: pos, tgt: t } }], [pos, t]);
    },
  },
  {
    type: 'D8',
    name: 'D8.retarget-subject',
    description: 'subject edge of a View moved to another Component (existing exposures fall out of scope)',
    positions: (ctx) => nodesWithOut(ctx, 'View', 'subject'),
    build: (ctx, pos, id) => {
      const eid = outOfType(ctx.g, pos, 'subject')[0];
      const old = ctx.g.edges.get(eid)!.tgt;
      const t = pickOther(ctx, 'Component', new Set([old]));
      if (!t) return undefined;
      return mk('D8', 'D8.retarget-subject', id, pos, [
        { kind: 'delEdge', id: eid },
        { kind: 'addEdge', edge: { id: `${eid}_${id}`, type: 'subject', src: pos, tgt: t } },
      ], [pos, old, t]);
    },
  },
];

export function operatorsOf(type: DefectType): DefectOperator[] {
  return OPERATORS.filter((o) => o.type === type);
}
