/**
 * Stage S1: normalization of parsed SysML v2 text into the typed attributed graph
 * G = (V, E, src, tgt, tau_V, tau_E, A) consumed by the validator, plus the type
 * hierarchy H used for specialization-aware conformance.
 *
 * Two classification modes are provided so that the effect of KerML specialization
 * semantics can be measured in isolation (name resolution is identical in both):
 *
 *   keyword         tau_V(x) is fixed by the textual kind keyword (part -> Component, ...);
 *                   attributes are only the element's own; reference features are not
 *                   followed. This is the "flat string type" reading criticized in M1.
 *   specialization  x is classified into every catalog class t whose library anchor
 *                   A(t) satisfies tau(x) <= A(t) in the reflexive-transitive closure
 *                   of typing, specialization, subsetting, redefinition and the implicit
 *                   library supertype of each kind; attribute values are inherited along
 *                   the same closure (the most specific value wins); a reference feature
 *                   used as a relationship end is resolved through its subsetting /
 *                   redefinition / reference-subsetting chain to the element it denotes.
 *
 * Every unit statement receives exactly one category (node, edge, attribute, context,
 * annotation, folded, lost:<reason>) so that the normalization loss can be reported.
 */

import { AttrValue, ModelEdge, ModelNode, SysMLLikeModel } from '../model/types';
import { Token } from './lexer';
import { QRef, SStatement } from './parser';
import { baseKind, SemanticModel } from './semantics';

export type ClassMode = 'keyword' | 'specialization';

/**
 * exposeMode 'namespace' (default): SysML v2 exposure semantics with subject edges (review n17).
 * 'legacy': the earlier mapping (expose(view, X) for every expose statement, wildcard dropped,
 * no subject edges), kept only to measure the effect of the change on E7.
 */
export const s1Config: { exposeMode: 'namespace' | 'legacy' } = { exposeMode: process.env.S1_EXPOSE_LEGACY === '1' ? 'legacy' : 'namespace' };
export type LevelMode = 'all' | 'usage';

/** Catalog node types and their SysML v2 standard library anchors A(t). */
export const CATALOG_ANCHORS: Record<string, string> = {
  Component: 'Parts::Part',
  Port: 'Ports::Port',
  Requirement: 'Requirements::RequirementCheck',
  Function: 'Actions::Action',
  VerificationCase: 'VerificationCases::VerificationCase',
  Interface: 'Interfaces::Interface',
  View: 'Views::View',
};

/** Keyword-mode mapping (kind keyword -> catalog node type). */
export const KEYWORD_CLASS: Record<string, string> = {
  'part def': 'Component',
  part: 'Component',
  'port def': 'Port',
  port: 'Port',
  'requirement def': 'Requirement',
  requirement: 'Requirement',
  'action def': 'Function',
  action: 'Function',
  'verification def': 'VerificationCase',
  verification: 'VerificationCase',
  'interface def': 'Interface',
  'view def': 'View',
  view: 'View',
};

/** Priority used to pick the primary type string of a multi-class node. */
const CLASS_PRIORITY = ['Requirement', 'VerificationCase', 'View', 'Interface', 'Port', 'Function', 'Component'];

/** Usages that S1 reifies as edges (connectors), never as nodes. */
const CONNECTOR_USAGE_KINDS = new Set(['connection', 'interface', 'allocation', 'flow', 'message', 'binding', 'succession']);

const DECLARATION_KINDS = new Set([
  'part', 'port', 'attribute', 'item', 'connection', 'interface', 'action', 'requirement', 'constraint', 'calc', 'case',
  'analysis', 'verification', 'view', 'viewpoint', 'rendering', 'allocation', 'flow', 'message', 'occurrence', 'state',
  'enum', 'metadata', 'concern', 'binding', 'succession', 'use case', 'feature',
]);

const CONTEXT_KINDS = new Set(['package', 'import', 'alias', 'attribute def', 'enum def', 'enum literal', 'enum', 'metadata def']);
const ANNOTATION_KINDS = new Set(['doc', 'comment', 'metadata usage', 'metadata', 'empty']);

export interface NodeProv {
  uid: number;
  qname: string;
  file: string;
  line: number;
  kind: string;
  level: 'definition' | 'usage';
  classes: string[];
  /** attribute names declared (own or, in specialization mode, inherited) without a literal value */
  declaredWithoutValue: string[];
  /** attribute names whose value is a non-literal expression (not evaluated by S1) */
  nonLiteral: string[];
  /** attribute values obtained by inheritance (specialization mode) */
  inherited: string[];
  /** kind of the owning statement and whether S1 maps it ('node'), treats it as namespace context, or drops it */
  ownerKind: string;
  ownerCategory: 'node' | 'context' | 'ref' | 'unmapped' | 'top';
}

export interface EdgeProv {
  uid: number;
  file: string;
  line: number;
  kind: string;
  text: string;
  /** endpoint reached through a reference-feature chain (specialization mode) */
  viaReference: boolean;
}

export interface StatementCategory {
  uid: number;
  file: string;
  line: number;
  kind: string;
  category: 'node' | 'edge' | 'attribute' | 'context' | 'annotation' | 'folded' | 'lost';
  reason?: string;
}

export interface S1Result {
  model: SysMLLikeModel;
  classes: Map<string, Set<string>>;
  nodeProv: Map<string, NodeProv>;
  edgeProv: Map<string, EdgeProv>;
  categories: StatementCategory[];
  /** uid -> node id */
  nodeOfStmt: Map<number, string>;
  lostEdgeEnds: Array<{ uid: number; file: string; line: number; rel: string; edgeType: string; end: string; reason: string; ownerNode?: string }>;
}

export function nodeIdOf(s: SStatement): string {
  return `${s.name ?? s.shortName ?? baseKind(s.kind).replace(/ /g, '_')}#${s.uid}`;
}

function isLiteral(tokens: Token[]): { ok: boolean; value?: AttrValue } {
  if (tokens.length === 0) return { ok: false };
  let i = 0;
  let neg = false;
  if (tokens[0].k === 'sym' && tokens[0].v === '-') {
    neg = true;
    i = 1;
  }
  const t = tokens[i];
  if (!t) return { ok: false };
  const restIsUnit = (from: number): boolean => {
    if (from >= tokens.length) return true;
    if (tokens[from].k === 'sym' && tokens[from].v === '[' && tokens[tokens.length - 1].k === 'sym' && tokens[tokens.length - 1].v === ']') {
      return tokens.slice(from + 1, -1).every((x) => x.k === 'word' || x.k === 'name' || (x.k === 'sym' && ['/', '*', '^', '.', '::'].includes(x.v)) || x.k === 'num');
    }
    return false;
  };
  if (t.k === 'num') {
    if (!restIsUnit(i + 1)) return { ok: false };
    const v = Number(t.v);
    return { ok: true, value: neg ? -v : v };
  }
  if (neg) return { ok: false };
  if (t.k === 'str' && tokens.length === 1) return { ok: true, value: t.v };
  if (t.k === 'word' && (t.v === 'true' || t.v === 'false') && tokens.length === 1) return { ok: true, value: t.v === 'true' };
  // enumeration literal reference: Name (:: Name)*
  let k = 0;
  let last = '';
  while (k < tokens.length) {
    const x = tokens[k];
    if (!(x.k === 'word' || x.k === 'name')) return { ok: false };
    last = x.v;
    k++;
    if (k < tokens.length) {
      if (!(tokens[k].k === 'sym' && tokens[k].v === '::')) return { ok: false };
      k++;
    }
  }
  return { ok: true, value: last };
}

export function normalizeSysML(sm: SemanticModel, mode: ClassMode, levels: LevelMode = 'all'): S1Result {
  const anchors = new Map<string, SStatement>();
  for (const [t, a] of Object.entries(CATALOG_ANCHORS)) {
    const s = sm.libAnchor(a);
    if (s) anchors.set(t, s);
  }

  const isAttributeLike = (s: SStatement): boolean => {
    if (sm.hidden.has(s.uid)) return false;
    if (s.kind === 'attribute' || s.kind === 'enum') return true;
    if (mode === 'specialization' && s.kind === 'feature') {
      for (const g of sm.explicitGenerals(s)) {
        if (g.kind === 'attribute' || g.kind === 'attribute def' || g.kind === 'enum def' || g.kind === 'enum') return true;
      }
      // closure check for longer chains
      for (const uid of sm.closure(s)) {
        const g = sm.stmt(uid);
        if (g && (g.kind === 'attribute' || g.kind === 'attribute def' || g.kind === 'enum def')) return true;
      }
    }
    return false;
  };

  const classesOf = (s: SStatement): string[] => {
    if (s.isLibrary || sm.hidden.has(s.uid)) return [];
    if (!s.isDef && !DECLARATION_KINDS.has(s.kind)) return [];
    if (!s.isDef && CONNECTOR_USAGE_KINDS.has(s.kind)) return [];
    if (s.isRef) return [];
    if (s.kind === 'objective') return [];
    if (levels === 'usage' && s.isDef) return [];
    if (mode === 'keyword') {
      const c = KEYWORD_CLASS[s.kind];
      return c ? [c] : [];
    }
    if (isAttributeLike(s)) return [];
    const cl = sm.closure(s);
    const out: string[] = [];
    for (const t of CLASS_PRIORITY) {
      const a = anchors.get(t);
      if (a && cl.has(a.uid)) out.push(t);
    }
    return out;
  };

  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  const classes = new Map<string, Set<string>>();
  const nodeProv = new Map<string, NodeProv>();
  const edgeProv = new Map<string, EdgeProv>();
  const nodeOfStmt = new Map<number, string>();
  const categories = new Map<number, StatementCategory>();
  const lostEdgeEnds: S1Result['lostEdgeEnds'] = [];

  const setCat = (s: SStatement, category: StatementCategory['category'], reason?: string): void => {
    categories.set(s.uid, { uid: s.uid, file: s.file, line: s.line, kind: s.kind, category, reason });
  };

  // ---- nodes -------------------------------------------------------------------------
  for (const s of sm.unitStatements) {
    if (sm.hidden.has(s.uid)) continue;
    const cls = classesOf(s);
    if (cls.length === 0) continue;
    const id = nodeIdOf(s);
    nodeOfStmt.set(s.uid, id);
    classes.set(id, new Set(cls));
    const kw = KEYWORD_CLASS[s.kind];
    const primary = kw && cls.includes(kw) ? kw : cls[0];
    nodes.push({ id, type: primary, attrs: {} });
    nodeProv.set(id, {
      uid: s.uid,
      qname: sm.qualifiedName(s),
      file: s.file,
      line: s.line,
      kind: s.kind,
      level: s.isDef ? 'definition' : 'usage',
      classes: cls,
      declaredWithoutValue: [],
      nonLiteral: [],
      inherited: [],
      ownerKind: s.owner?.kind ?? 'top',
      ownerCategory: 'top',
    });
    setCat(s, 'node');
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const p of nodeProv.values()) {
    const o = sm.stmt(p.uid)!.owner;
    if (!o) p.ownerCategory = 'top';
    else if (nodeOfStmt.has(o.uid)) p.ownerCategory = 'node';
    else if (o.kind === 'package' || CONTEXT_KINDS.has(o.kind)) p.ownerCategory = 'context';
    else if (o.isRef) p.ownerCategory = 'ref';
    else p.ownerCategory = 'unmapped';
  }

  // ---- attributes ----------------------------------------------------------------------
  const attrSources = (s: SStatement): SStatement[] => {
    if (mode === 'keyword') return [s];
    // own first, then generals in BFS order (most specific first); library types excluded
    const order: SStatement[] = [s];
    const seen = new Set<number>([s.uid]);
    for (let i = 0; i < order.length; i++) {
      for (const g of sm.generals(order[i])) {
        if (seen.has(g.uid) || g.isLibrary) continue;
        seen.add(g.uid);
        order.push(g);
      }
    }
    return order;
  };

  const directionOf = (s: SStatement): string | undefined => {
    const dirs = new Set<string>();
    for (const src of attrSources(s)) {
      for (const c of src.children) {
        if (sm.hidden.has(c.uid)) continue;
        if (c.direction) dirs.add(c.direction);
      }
    }
    if (dirs.size === 0) return undefined;
    let d = dirs.size === 1 ? [...dirs][0] : 'inout';
    const conj = mode === 'specialization' && s.typedBy.some((q) => q.conj);
    if (conj && d === 'in') d = 'out';
    else if (conj && d === 'out') d = 'in';
    return d;
  };

  for (const n of nodes) {
    const p = nodeProv.get(n.id)!;
    const s = sm.stmt(p.uid)!;
    if (s.name ?? s.shortName) n.attrs.name = (s.name ?? s.shortName)!;
    const set = new Set<string>(['name']);
    const sources = attrSources(s);
    for (let si = 0; si < sources.length; si++) {
      const src = sources[si];
      for (const c of src.children) {
        if (!isAttributeLike(c) || !c.name || set.has(c.name)) continue;
        set.add(c.name);
        if (c.value && c.value.length > 0) {
          const lit = isLiteral(c.value);
          if (lit.ok && lit.value !== undefined) {
            n.attrs[c.name] = lit.value;
            if (si > 0) p.inherited.push(c.name);
          } else p.nonLiteral.push(c.name);
        } else {
          // a redefinition without value may still inherit a value from the redefined feature
          let inheritedValue: AttrValue | undefined;
          if (mode === 'specialization') {
            for (const uid of sm.closure(c)) {
              const g = sm.stmt(uid);
              if (!g || g === c || !g.value || g.value.length === 0) continue;
              const lit = isLiteral(g.value);
              if (lit.ok && lit.value !== undefined) {
                inheritedValue = lit.value;
                break;
              }
            }
          }
          if (inheritedValue !== undefined) {
            n.attrs[c.name] = inheritedValue;
            p.inherited.push(c.name);
          } else p.declaredWithoutValue.push(c.name);
        }
        if (si === 0) setCat(c, 'attribute');
      }
    }
    if (p.classes.includes('Port')) {
      const d = directionOf(s);
      if (d !== undefined && n.attrs.direction === undefined) n.attrs.direction = d;
    }
  }

  // ---- edges ---------------------------------------------------------------------------
  let edgeSeq = 0;
  const nearestNode = (s: SStatement | undefined, pred?: (id: string) => boolean): string | undefined => {
    let cur = s;
    while (cur) {
      const id = nodeOfStmt.get(cur.uid);
      if (id && (!pred || pred(id))) return id;
      cur = cur.owner;
    }
    return undefined;
  };

  /** Resolves a relationship end to a node id, following reference chains in specialization mode. */
  const endNode = (scope: SStatement | undefined, q: QRef): { id?: string; reason?: string; via: boolean; ownerNode?: string } => {
    const r = sm.resolve(scope, q);
    if (!r) return { reason: 'unresolved reference', via: false };
    const direct = nodeOfStmt.get(r.uid);
    if (direct) return { id: direct, via: false };
    if (mode === 'specialization') {
      // follow subsetting / redefinition / reference subsetting (not typing) to the denoted element
      const queue: Array<{ s: SStatement; d: number }> = [{ s: r, d: 0 }];
      const seen = new Set<number>([r.uid]);
      while (queue.length > 0) {
        const { s, d } = queue.shift()!;
        if (d > 0) {
          const id = nodeOfStmt.get(s.uid);
          if (id) return { id, via: true };
        }
        if (d >= 10) continue;
        const typed = new Set(s.typedBy.map((tq) => sm.resolve(s.owner, tq, s, false)?.uid));
        for (const g of sm.explicitGenerals(s)) {
          if (seen.has(g.uid) || typed.has(g.uid)) continue;
          seen.add(g.uid);
          queue.push({ s: g, d: d + 1 });
        }
      }
    }
    return { reason: `end not in G (${r.isLibrary ? 'library ' : ''}${r.kind})`, via: false, ownerNode: nearestNode(r.owner) };
  };

  const addEdge = (s: SStatement, type: string, src: string, tgt: string, via: boolean): void => {
    const id = `${type}#${s.uid}#${++edgeSeq}`;
    edges.push({ id, type, src, tgt });
    edgeProv.set(id, { uid: s.uid, file: s.file, line: s.line, kind: s.kind, text: s.header.map((t) => t.v).join(' ').slice(0, 160), viaReference: via });
  };

  // contain edges (composite ownership between mapped elements)
  for (const n of nodes) {
    const p = nodeProv.get(n.id)!;
    if (p.level !== 'usage') continue;
    const s = sm.stmt(p.uid)!;
    const ownerId = s.owner ? nodeOfStmt.get(s.owner.uid) : undefined;
    if (ownerId) {
      const id = `contain#${s.uid}#${++edgeSeq}`;
      edges.push({ id, type: 'contain', src: ownerId, tgt: n.id });
      edgeProv.set(id, { uid: s.uid, file: s.file, line: s.line, kind: 'ownership', text: `${nodeById.get(ownerId)?.attrs.name ?? ownerId} owns ${n.attrs.name ?? n.id}`, viaReference: false });
    }
  }

  const subjectEdges: Array<{ s: SStatement; view: string; root: string }> = [];
  for (const s of sm.unitStatements) {
    if (sm.hidden.has(s.uid) || !s.rel) continue;
    const rel = s.rel;
    const scope = s.owner;
    let type: string | undefined;
    let srcIds: Array<{ id?: string; reason?: string; via: boolean; text: string; ownerNode?: string }> = [];
    let tgtIds: Array<{ id?: string; reason?: string; via: boolean; text: string; ownerNode?: string }> = [];
    const ends = (qs: QRef[]) => qs.map((q) => ({ ...endNode(scope, q), text: q.text }));
    switch (rel.kind) {
      case 'connect':
      case 'flow':
        type = 'connect';
        srcIds = ends(rel.src);
        tgtIds = ends(rel.tgt);
        break;
      case 'satisfy': {
        if (rel.negated) break;
        type = 'satisfy';
        srcIds = rel.src.length > 0 ? ends(rel.src) : [{ id: nearestNode(s.owner), reason: 'no enclosing node', via: false, text: '<owner>' }];
        tgtIds = ends(rel.tgt);
        break;
      }
      case 'verify': {
        type = 'verify';
        const vc = nearestNode(s.owner, (id) => classes.get(id)?.has('VerificationCase') ?? false);
        srcIds = [{ id: vc, reason: vc ? undefined : 'no enclosing verification case in G', via: false, text: '<verification case>' }];
        tgtIds = ends(rel.tgt);
        break;
      }
      case 'allocate':
        type = 'allocate';
        srcIds = ends(rel.src);
        tgtIds = ends(rel.tgt);
        break;
      case 'dependency':
        type = 'dependOn';
        srcIds = ends(rel.src);
        tgtIds = ends(rel.tgt);
        break;
      case 'expose': {
        type = 'expose';
        const v = nearestNode(s.owner, (id) => classes.get(id)?.has('View') ?? false);
        srcIds = [{ id: v, reason: v ? undefined : 'no enclosing view in G', via: false, text: '<view>' }];
        if (s1Config.exposeMode === 'legacy') {
          tgtIds = ends(rel.tgt.map((q) => ({ ...q, wildcard: undefined })));
          break;
        }
        // SysML v2 (review n17): a MembershipExpose `expose X` exposes X; a NamespaceExpose
        // `expose X::*` exposes the members of X and `expose X::**` exposes X and its members
        // recursively (ViewUsage::exposedElement). SysML v2 has no view-subject relationship; S1
        // maps the namespace X of a NamespaceExpose to subject(view, X) when X is a node of G.
        // Owned members that are nodes of G are exposed; element filters are not evaluated.
        for (const q of rel.tgt) {
          if (!q.wildcard) {
            tgtIds.push(...ends([q]));
            continue;
          }
          const r = sm.resolve(scope, { ...q, wildcard: undefined });
          if (!r) {
            tgtIds.push({ reason: 'unresolved reference', via: false, text: q.text });
            continue;
          }
          const root = nodeOfStmt.get(r.uid);
          const members: string[] = [];
          const visit = (x: SStatement, depth: number): void => {
            for (const c of x.children) {
              if (sm.hidden.has(c.uid)) continue;
              const id = nodeOfStmt.get(c.uid);
              if (id) members.push(id);
              if (q.wildcard === '**' && depth < 64) visit(c, depth + 1);
            }
          };
          if (q.wildcard === '**' && root) members.push(root);
          visit(r, 0);
          if (root && v) subjectEdges.push({ s, view: v, root });
          if (members.length === 0) tgtIds.push({ reason: `namespace exposes no element of G (${r.kind})`, via: false, text: q.text, ownerNode: root });
          for (const m of [...new Set(members)]) tgtIds.push({ id: m, via: false, text: q.text });
        }
        break;
      }
      default:
        break;
    }
    if (!type) continue;
    let made = 0;
    const reasons: string[] = [];
    for (const a of srcIds) {
      for (const b of tgtIds) {
        if (a.id && b.id) {
          addEdge(s, type, a.id, b.id, a.via || b.via);
          made++;
        }
      }
    }
    for (const e of [...srcIds, ...tgtIds]) {
      if (!e.id) {
        reasons.push(e.reason ?? 'unresolved');
        lostEdgeEnds.push({ uid: s.uid, file: s.file, line: s.line, rel: rel.kind, edgeType: type, end: e.text, reason: e.reason ?? 'unresolved', ownerNode: e.ownerNode });
      }
    }
    if (srcIds.length === 0 || tgtIds.length === 0) reasons.push('relationship end not parsed');
    if (!categories.has(s.uid) || categories.get(s.uid)!.category !== 'node') {
      if (made > 0 && reasons.length === 0) setCat(s, 'edge');
      else if (made > 0) setCat(s, 'edge', `partial: ${reasons.join('; ')}`);
      else setCat(s, 'lost', `${rel.kind} edge: ${reasons.join('; ') || 'no ends'}`);
    }
  }

  // subject edges of NamespaceExpose (one per (view, namespace) pair)
  const subjectSeen = new Set<string>();
  for (const x of subjectEdges) {
    const k = `${x.view}|${x.root}`;
    if (subjectSeen.has(k)) continue;
    subjectSeen.add(k);
    addEdge(x.s, 'subject', x.view, x.root, false);
  }

  // ---- remaining statement categories ----------------------------------------------
  for (const s of sm.unitStatements) {
    if (categories.has(s.uid)) continue;
    if (sm.hidden.has(s.uid)) continue;
    if (ANNOTATION_KINDS.has(s.kind) || (s.kind === 'feature' && s.owner?.kind === 'metadata usage')) {
      setCat(s, 'annotation');
      continue;
    }
    if (s.owner && ANNOTATION_KINDS.has(s.owner.kind)) {
      setCat(s, 'annotation');
      continue;
    }
    if (s.kind === 'objective') {
      setCat(s, 'folded');
      continue;
    }
    if (CONTEXT_KINDS.has(s.kind)) {
      setCat(s, 'context');
      continue;
    }
    if (isAttributeLike(s)) {
      const o = s.owner ? nodeOfStmt.get(s.owner.uid) : undefined;
      if (o) setCat(s, 'attribute');
      else if (s.owner && (CONTEXT_KINDS.has(s.owner.kind) || s.owner.kind === 'attribute')) setCat(s, 'context');
      else setCat(s, 'lost', `attribute of element not in G (${s.owner?.kind ?? 'top'})`);
      continue;
    }
    if (s.rel) {
      setCat(s, 'lost', `${s.rel.kind} relationship not in T_E`);
      continue;
    }
    if (s.isRef) {
      setCat(s, 'lost', `reference feature (${[...s.prefixes.filter((p) => ['ref', 'in', 'out', 'inout', 'end', 'perform', 'exhibit', 'include', 'event'].includes(p)), s.kind].join(' ')})`);
      continue;
    }
    if (mode === 'keyword' && s.kind === 'feature') {
      setCat(s, 'lost', 'feature without kind keyword');
      continue;
    }
    setCat(s, 'lost', `${s.kind} not mapped to T_V/T_E`);
  }

  return {
    model: { id: 'sysml', nodes, edges },
    classes,
    nodeProv,
    edgeProv,
    categories: [...categories.values()],
    nodeOfStmt,
    lostEdgeEnds,
  };
}

/** Loss summary over statement categories. */
export function lossSummary(r: S1Result): {
  statements: number;
  byCategory: Record<string, number>;
  lostByReason: Array<{ reason: string; count: number }>;
  lossRate: number;
  lossRateExclAnnotation: number;
} {
  const byCategory: Record<string, number> = {};
  const lost = new Map<string, number>();
  for (const c of r.categories) {
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
    if (c.category === 'lost') {
      const key = (c.reason ?? '').replace(/\(([^)]*)\)$/, (m) => m);
      lost.set(key, (lost.get(key) ?? 0) + 1);
    }
  }
  const total = r.categories.length;
  const nLost = byCategory.lost ?? 0;
  const nAnn = byCategory.annotation ?? 0;
  return {
    statements: total,
    byCategory,
    lostByReason: [...lost.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    lossRate: total === 0 ? 0 : nLost / total,
    lossRateExclAnnotation: total - nAnn === 0 ? 0 : nLost / (total - nAnn),
  };
}
