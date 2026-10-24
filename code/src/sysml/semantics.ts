/**
 * Name resolution and specialization closure over parsed SysML v2 statements.
 *
 * Resolution follows the textual-notation scoping rules in simplified form:
 *   - a simple name is looked up in the lexical scope chain; at every namespace the owned
 *     members, aliases, imported members (X::*, X::**, X::Y) and inherited members (members
 *     of the general types: typing, specialization, subsetting, redefinition, reference
 *     subsetting) are visible;
 *   - '::' segments navigate namespace membership, '.' segments navigate feature chains
 *     (members of the feature, including inherited ones);
 *   - top-level packages of the unit and of the standard library form the global scope.
 * Visibility (private/public) is not enforced. Unresolved references are counted.
 */

import { QRef, SStatement, walk } from './parser';

export const DEF_KINDS_IMPLICIT: Record<string, string> = {
  part: 'Parts::Part',
  port: 'Ports::Port',
  action: 'Actions::Action',
  requirement: 'Requirements::RequirementCheck',
  concern: 'Requirements::ConcernCheck',
  viewpoint: 'Views::ViewpointCheck',
  verification: 'VerificationCases::VerificationCase',
  view: 'Views::View',
  rendering: 'Views::Rendering',
  interface: 'Interfaces::Interface',
  connection: 'Connections::Connection',
  allocation: 'Allocations::Allocation',
  item: 'Items::Item',
  state: 'States::StateAction',
  calc: 'Calculations::Calculation',
  case: 'Cases::Case',
  analysis: 'AnalysisCases::AnalysisCase',
  'use case': 'UseCases::UseCase',
  constraint: 'Constraints::ConstraintCheck',
  flow: 'Flows::Flow',
  message: 'Flows::Message',
  metadata: 'Metadata::MetadataItem',
};

/** base kind word of a statement kind ('part def' -> 'part') */
export function baseKind(kind: string): string {
  return kind.endsWith(' def') ? kind.slice(0, -4) : kind;
}

export class SemanticModel {
  readonly unitStatements: SStatement[] = [];
  readonly all: SStatement[] = [];
  private readonly global = new Map<string, SStatement[]>();
  private readonly byUid = new Map<number, SStatement>();
  private readonly memberCache = new Map<string, SStatement | null>();
  private readonly generalsCache = new Map<number, SStatement[]>();
  private readonly closureCache = new Map<number, Set<number>>();
  private readonly libAnchorCache = new Map<string, SStatement | undefined>();
  /** resolution statistics for unit references */
  refStats = { resolved: 0, unresolved: 0, unresolvedRefs: [] as Array<{ file: string; line: number; ref: string }> };
  /** statements whose generals were edited (used by the hierarchy-change experiment) */
  private readonly generalOverride = new Map<number, SStatement[]>();
  /** child statements hidden by an edit (attribute deletion experiment) */
  readonly hidden = new Set<number>();
  private readonly activeImports = new Set<number>();

  /**
   * @param unitRoots   statements of the model unit (the only ones mapped into G)
   * @param libraryRoots standard library statements
   * @param contextRoots other units of the same corpus group, visible to imports only
   */
  constructor(unitRoots: SStatement[], libraryRoots: SStatement[], contextRoots: SStatement[] = []) {
    for (const roots of [unitRoots, contextRoots, libraryRoots]) {
      for (const r of roots) {
        const key = r.name;
        if (key) {
          const l = this.global.get(key) ?? [];
          l.push(r);
          this.global.set(key, l);
        }
        // anonymous top-level statements contribute their members (rare)
      }
    }
    walk(unitRoots, (s) => {
      this.unitStatements.push(s);
      this.all.push(s);
      this.byUid.set(s.uid, s);
    });
    walk(contextRoots, (s) => {
      this.all.push(s);
      this.byUid.set(s.uid, s);
    });
    walk(libraryRoots, (s) => {
      this.all.push(s);
      this.byUid.set(s.uid, s);
    });
  }

  stmt(uid: number): SStatement | undefined {
    return this.byUid.get(uid);
  }

  invalidate(): void {
    this.memberCache.clear();
    this.importCache.clear();
    this.lookupCache.clear();
    this.generalsCache.clear();
    this.closureCache.clear();
  }

  /** Library anchor by qualified name, e.g. 'Parts::Part'. */
  libAnchor(qname: string): SStatement | undefined {
    if (this.libAnchorCache.has(qname)) return this.libAnchorCache.get(qname);
    const segs = qname.split('::');
    let cur: SStatement | undefined = (this.global.get(segs[0]) ?? []).find((s) => s.isLibrary);
    for (let i = 1; cur && i < segs.length; i++) cur = cur.children.find((c) => c.name === segs[i] && !this.hidden.has(c.uid));
    this.libAnchorCache.set(qname, cur);
    return cur;
  }

  // -------------------------------------------------------------------------
  // membership
  // -------------------------------------------------------------------------

  /** Owned, aliased, imported and inherited member named `name` of namespace `ns`. */
  member(ns: SStatement, name: string, visited: Set<number> = new Set(), exclude?: SStatement, ownedOnly = false): SStatement | undefined {
    const key = `${ns.uid}|${name}|${exclude?.uid ?? ''}|${ownedOnly ? 1 : 0}`;
    const top = visited.size === 0;
    if (top && this.memberCache.has(key)) return this.memberCache.get(key) ?? undefined;
    if (visited.has(ns.uid)) return undefined;
    visited.add(ns.uid);
    const r = this.memberUncached(ns, name, visited, exclude, ownedOnly);
    if (top) this.memberCache.set(key, r ?? null);
    return r;
  }

  private memberUncached(ns: SStatement, name: string, visited: Set<number>, exclude: SStatement | undefined, ownedOnly: boolean): SStatement | undefined {
    // owned (a member that is itself anonymous but redefines `name` carries that name)
    for (const c of ns.children) {
      if (c === exclude || this.hidden.has(c.uid)) continue;
      if ((c.name === name || c.shortName === name) && c.kind !== 'alias' && c.kind !== 'import') return c;
    }
    // aliases
    for (const c of ns.children) {
      if (c.kind === 'alias' && c.rel?.aliasName === name && c.rel.tgt[0]) {
        const t = this.resolve(ns, c.rel.tgt[0], undefined, false);
        if (t) return t;
      }
    }
    // imports
    for (const c of ns.children) {
      if (c.kind !== 'import' || !c.rel || !c.rel.tgt[0]) continue;
      const q = c.rel.tgt[0];
      if (this.activeImports.has(c.uid)) continue;
      this.activeImports.add(c.uid);
      try {
      if (q.wildcard) {
        const target = this.importTarget(ns, c, q);
        if (!target) continue;
        const found = q.wildcard === '**' ? this.memberRecursive(target, name, new Set()) : this.member(target, name, new Set(), undefined, true);
        if (found) return found;
      } else if (q.segs[q.segs.length - 1] === name) {
        const target = this.importTarget(ns, c, q);
        if (target) return target;
      }
      } finally {
        this.activeImports.delete(c.uid);
      }
    }
    if (ownedOnly) return undefined;
    // inherited
    for (const g of this.generals(ns)) {
      const found = this.member(g, name, visited);
      if (found) return found;
    }
    return undefined;
  }

  private readonly importCache = new Map<number, SStatement | null>();

  /** Resolved target namespace of an import statement (cached; cycle-safe). */
  private importTarget(ns: SStatement, imp: SStatement, q: QRef): SStatement | undefined {
    if (this.importCache.has(imp.uid)) return this.importCache.get(imp.uid) ?? undefined;
    this.importCache.set(imp.uid, null);
    // resolve from the namespace that contains the import, skipping its own imports via the guard
    const t = this.resolve(ns, { ...q, wildcard: undefined }, undefined, false, new Set([imp.uid]));
    this.importCache.set(imp.uid, t ?? null);
    return t;
  }

  private memberRecursive(ns: SStatement, name: string, seen: Set<number>): SStatement | undefined {
    if (seen.has(ns.uid)) return undefined;
    seen.add(ns.uid);
    const direct = this.member(ns, name, new Set(), undefined, true);
    if (direct) return direct;
    for (const c of ns.children) {
      if (c.name && c.children.length > 0) {
        const f = this.memberRecursive(c, name, seen);
        if (f) return f;
      }
    }
    return undefined;
  }

  /** Lexical lookup of a simple name starting at `scope`. */
  private readonly lookupCache = new Map<string, SStatement | null>();

  lookup(scope: SStatement | undefined, name: string, exclude?: SStatement, importGuard?: Set<number>): SStatement | undefined {
    const key = `${scope?.uid ?? 0}|${name}|${exclude?.uid ?? ''}`;
    if (!importGuard && this.lookupCache.has(key)) return this.lookupCache.get(key) ?? undefined;
    const r = this.lookupUncached(scope, name, exclude, importGuard);
    if (!importGuard) this.lookupCache.set(key, r ?? null);
    return r;
  }

  private lookupUncached(scope: SStatement | undefined, name: string, exclude?: SStatement, importGuard?: Set<number>): SStatement | undefined {
    let cur = scope;
    while (cur) {
      const f = this.member(cur, name, new Set(), exclude);
      if (f && !(importGuard && importGuard.has(f.uid))) return f;
      cur = cur.owner;
    }
    const g = this.global.get(name);
    if (!g || g.length === 0) return undefined;
    return g[0];
  }

  /**
   * Resolves a qualified name or feature chain in the scope of `scope`.
   * `exclude` prevents a redefining feature from resolving to itself.
   */
  resolve(scope: SStatement | undefined, q: QRef, exclude?: SStatement, count = true, importGuard?: Set<number>): SStatement | undefined {
    let cur = this.lookup(scope, q.segs[0], exclude, importGuard);
    for (let i = 1; cur && i < q.segs.length; i++) {
      cur = this.member(cur, q.segs[i], new Set());
    }
    if (count && scope && !scope.isLibrary) {
      if (cur) this.refStats.resolved++;
      else {
        this.refStats.unresolved++;
        if (this.refStats.unresolvedRefs.length < 5000) this.refStats.unresolvedRefs.push({ file: scope.file, line: q.line, ref: q.text });
      }
    }
    return cur;
  }

  // -------------------------------------------------------------------------
  // generalization (typing, specialization, subsetting, redefinition)
  // -------------------------------------------------------------------------

  /** Explicit generals of `s`, resolved in its owning namespace. */
  explicitGenerals(s: SStatement): SStatement[] {
    const out: SStatement[] = [];
    const scope = s.owner;
    for (const q of s.typedBy) {
      const r = this.resolve(scope, q, s, false);
      if (r) out.push(r);
    }
    for (const q of s.specializes) {
      const r = this.resolve(scope, q, s, false);
      if (r) out.push(r);
    }
    for (const q of s.subsets) {
      const r = this.resolve(scope, q, s, false);
      if (r) out.push(r);
    }
    for (const q of s.references) {
      const r = this.resolve(scope, q, s, false);
      if (r) out.push(r);
    }
    for (const q of s.redefines) {
      // the redefined feature is an inherited member of the owner, never s itself
      let r: SStatement | undefined;
      if (q.segs.length === 1 && scope) {
        for (const g of this.generals(scope)) {
          r = this.member(g, q.segs[0], new Set());
          if (r) break;
        }
      }
      if (!r) r = this.resolve(scope, q, s, false);
      if (r && r !== s) out.push(r);
    }
    return out;
  }

  /** Explicit generals plus the implicit library supertype of the statement's kind. */
  generals(s: SStatement): SStatement[] {
    const ov = this.generalOverride.get(s.uid);
    if (ov) return ov;
    const cached = this.generalsCache.get(s.uid);
    if (cached) return cached;
    this.generalsCache.set(s.uid, []); // cycle guard
    const out = this.explicitGenerals(s);
    const implicit = DEF_KINDS_IMPLICIT[baseKind(s.kind)];
    if (implicit) {
      const a = this.libAnchor(implicit);
      if (a && a !== s && !out.includes(a)) out.push(a);
    }
    this.generalsCache.set(s.uid, out);
    return out;
  }

  /** Reflexive-transitive specialization closure (uids). */
  closure(s: SStatement): Set<number> {
    const cached = this.closureCache.get(s.uid);
    if (cached) return cached;
    const seen = new Set<number>([s.uid]);
    const queue: SStatement[] = [s];
    while (queue.length > 0) {
      const x = queue.shift()!;
      for (const g of this.generals(x)) {
        if (seen.has(g.uid)) continue;
        seen.add(g.uid);
        queue.push(g);
      }
    }
    this.closureCache.set(s.uid, seen);
    return seen;
  }

  conformsTo(s: SStatement, anchor: SStatement): boolean {
    return this.closure(s).has(anchor.uid);
  }

  /** Edit hooks for the hierarchy-change experiment. */
  overrideGenerals(s: SStatement, generals: SStatement[]): void {
    this.generalOverride.set(s.uid, generals);
    this.invalidate();
  }

  clearOverrides(): void {
    this.generalOverride.clear();
    this.hidden.clear();
    this.invalidate();
  }

  hide(s: SStatement): void {
    this.hidden.add(s.uid);
    this.invalidate();
  }

  qualifiedName(s: SStatement): string {
    const parts: string[] = [];
    let cur: SStatement | undefined = s;
    while (cur) {
      parts.unshift(cur.name ?? cur.shortName ?? `<${cur.kind}@${cur.line}>`);
      cur = cur.owner;
    }
    return parts.join('::');
  }
}
