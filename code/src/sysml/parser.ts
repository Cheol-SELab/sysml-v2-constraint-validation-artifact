/**
 * Structural-subset parser for the SysML v2 textual notation (stage S1, part 1).
 *
 * The parser is deliberately total: every statement of the input becomes one SStatement,
 * whether or not S1 maps it. Unrecognized statements are kept with kind 'unknown' (or
 * a recognized-but-unmapped kind) so that the normalization loss can be counted rather
 * than silently dropped. Expressions are not evaluated; they are kept as token lists.
 */

import { lex, LexError, Token } from './lexer';

export interface QRef {
  /** path segments, e.g. ['vehicle_b', 'engine', 'fuelInPort'] */
  segs: string[];
  /** separators between segments: '::' (namespace) or '.' (feature chain) */
  seps: Array<'::' | '.'>;
  /** '~' conjugated port typing */
  conj: boolean;
  /** import / expose wildcard */
  wildcard?: '*' | '**';
  line: number;
  text: string;
}

export interface RelSpec {
  kind:
    | 'connect'
    | 'flow'
    | 'message'
    | 'bind'
    | 'succession'
    | 'satisfy'
    | 'verify'
    | 'allocate'
    | 'dependency'
    | 'expose'
    | 'import'
    | 'alias'
    | 'perform'
    | 'exhibit'
    | 'include'
    | 'require'
    | 'frame';
  /** source ends (satisfy: satisfier; verify: (empty, owner); allocate: from; dependency: clients) */
  src: QRef[];
  /** target ends (satisfy: requirement; verify: requirement; allocate: to; dependency: suppliers) */
  tgt: QRef[];
  negated?: boolean;
  /** import: '*'/'**' and visibility */
  importAll?: boolean;
  importRecursive?: boolean;
  aliasName?: string;
}

export interface SStatement {
  uid: number;
  file: string;
  line: number;
  /** canonical kind, e.g. 'part def', 'part', 'connect', 'feature', 'expression', 'unknown' */
  kind: string;
  isDef: boolean;
  prefixes: string[];
  metadata: string[];
  direction?: 'in' | 'out' | 'inout';
  isRef: boolean;
  name?: string;
  shortName?: string;
  typedBy: QRef[];
  specializes: QRef[];
  subsets: QRef[];
  redefines: QRef[];
  references: QRef[];
  /** value expression tokens (after '=', ':=' or 'default') */
  value?: Token[];
  rel?: RelSpec;
  owner?: SStatement;
  children: SStatement[];
  /** tokens of the header (for diagnostics and loss reports) */
  header: Token[];
  isLibrary: boolean;
  /** parser-level note on a partially understood statement */
  note?: string;
}

export interface ParsedFile {
  file: string;
  ok: boolean;
  error?: string;
  roots: SStatement[];
  statements: number;
  lines: number;
}

// ---------------------------------------------------------------------------
// Statement splitting
// ---------------------------------------------------------------------------

interface RawStmt {
  tokens: Token[];
  body?: RawStmt[];
  line: number;
}

class Splitter {
  i = 0;
  constructor(private readonly t: Token[]) {}

  block(untilBrace: boolean): RawStmt[] {
    const out: RawStmt[] = [];
    while (this.i < this.t.length) {
      const tok = this.t[this.i];
      if (tok.k === 'sym' && tok.v === '}') {
        if (untilBrace) return out;
        throw new LexError('unbalanced }', tok.line);
      }
      if (tok.k === 'sym' && tok.v === ';') {
        this.i++;
        continue;
      }
      out.push(this.stmt());
    }
    if (untilBrace) throw new LexError('missing }', this.t[this.t.length - 1]?.line ?? 0);
    return out;
  }

  private balanced(open: string, close: string, into: Token[]): void {
    let depth = 0;
    while (this.i < this.t.length) {
      const tok = this.t[this.i++];
      into.push(tok);
      if (tok.k === 'sym' && tok.v === open) depth++;
      else if (tok.k === 'sym' && tok.v === close) {
        depth--;
        if (depth === 0) return;
      }
    }
    throw new LexError(`missing ${close}`, into[0]?.line ?? 0);
  }

  private stmt(): RawStmt {
    const header: Token[] = [];
    const line = this.t[this.i].line;
    let depth = 0;
    while (this.i < this.t.length) {
      const tok = this.t[this.i];
      if (tok.k === 'sym' && (tok.v === '(' || tok.v === '[')) {
        depth++;
        header.push(tok);
        this.i++;
        continue;
      }
      if (tok.k === 'sym' && (tok.v === ')' || tok.v === ']')) {
        depth--;
        header.push(tok);
        this.i++;
        continue;
      }
      if (tok.k === 'sym' && tok.v === '{') {
        const prev = header[header.length - 1];
        const prev2 = header[header.length - 2];
        const exprBrace =
          depth > 0 ||
          (prev && prev.k === 'sym' && prev.v === '->') ||
          (prev2 && prev2.k === 'sym' && prev2.v === '->' && prev && prev.k === 'word');
        if (exprBrace) {
          this.balanced('{', '}', header);
          continue;
        }
        this.i++;
        const body = this.block(true);
        this.i++; // consume '}'
        return { tokens: header, body, line };
      }
      if (tok.k === 'sym' && tok.v === ';' && depth <= 0) {
        this.i++;
        return { tokens: header, line };
      }
      if (tok.k === 'sym' && tok.v === '}' && depth <= 0) {
        // last statement of a body without ';' (typical for expression bodies)
        return { tokens: header, line };
      }
      header.push(tok);
      this.i++;
      if (tok.k === 'comment' && depth <= 0) {
        // doc / comment / language / rep bodies end the statement
        return { tokens: header, line };
      }
    }
    return { tokens: header, line };
  }
}

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

const PREFIX_WORDS = new Set([
  'private', 'public', 'protected', 'abstract', 'variation', 'variant', 'readonly', 'derived', 'constant', 'ref', 'in',
  'out', 'inout', 'end', 'individual', 'snapshot', 'timeslice', 'composite', 'portion', 'nonunique', 'ordered',
  'standard', 'library', 'parallel', 'then', 'assert', 'not', 'var',
]);

/** kind words that may be followed by 'def' */
const KIND_WORDS = [
  'part', 'port', 'attribute', 'item', 'connection', 'interface', 'action', 'requirement', 'constraint', 'calc', 'case',
  'analysis', 'verification', 'view', 'viewpoint', 'rendering', 'allocation', 'flow', 'message', 'occurrence', 'state',
  'enum', 'metadata', 'concern', 'binding', 'succession',
];

const KERML_DECL_WORDS = new Set(['feature', 'class', 'struct', 'datatype', 'assoc', 'behavior', 'function', 'predicate', 'interaction', 'step', 'expr', 'bool', 'classifier', 'type', 'connector', 'metaclass']);

/** words that terminate a declaration and start a relationship part */
const DECL_STOP = new Set(['connect', 'to', 'from', 'by', 'of', 'about', 'for', 'bind', 'allocate', 'first', 'then', 'if', 'do', 'accept', 'via', 'at', 'after', 'when']);

let uidCounter = 0;

export function resetUids(): void {
  uidCounter = 0;
}

class Cursor {
  i = 0;
  constructor(public readonly t: Token[]) {}
  peek(o = 0): Token | undefined {
    return this.t[this.i + o];
  }
  isWord(v: string, o = 0): boolean {
    const p = this.peek(o);
    return !!p && p.k === 'word' && p.v === v;
  }
  isSym(v: string, o = 0): boolean {
    const p = this.peek(o);
    return !!p && p.k === 'sym' && p.v === v;
  }
  eof(): boolean {
    return this.i >= this.t.length;
  }
}

function isNameTok(t: Token | undefined): boolean {
  return !!t && (t.k === 'word' || t.k === 'name');
}

/** Parses a qualified name / feature chain at the cursor; returns undefined if none. */
function parseQRef(c: Cursor): QRef | undefined {
  const start = c.i;
  let conj = false;
  if (c.isSym('~')) {
    conj = true;
    c.i++;
  }
  if (c.isSym('::')) c.i++; // global scope prefix '$::' variants are ignored
  if (!isNameTok(c.peek())) {
    c.i = start;
    return undefined;
  }
  const segs: string[] = [c.peek()!.v];
  const seps: Array<'::' | '.'> = [];
  const line = c.peek()!.line;
  c.i++;
  let wildcard: '*' | '**' | undefined;
  while (!c.eof()) {
    if ((c.isSym('::') || c.isSym('.')) && isNameTok(c.peek(1))) {
      seps.push(c.peek()!.v as '::' | '.');
      segs.push(c.peek(1)!.v);
      c.i += 2;
      continue;
    }
    if (c.isSym('::') && (c.isSym('*', 1) || c.isSym('**', 1))) {
      wildcard = c.peek(1)!.v as '*' | '**';
      c.i += 2;
      if (wildcard === '*' && c.isSym('::') && c.isSym('**', 1)) {
        wildcard = '**';
        c.i += 2;
      }
      continue;
    }
    break;
  }
  const text = (conj ? '~' : '') + segs.map((s, k) => (k === 0 ? s : seps[k - 1] + s)).join('') + (wildcard ? '::' + wildcard : '');
  return { segs, seps, conj, wildcard, line, text };
}

function parseQRefList(c: Cursor): QRef[] {
  const out: QRef[] = [];
  const q = parseQRef(c);
  if (!q) return out;
  out.push(q);
  while (c.isSym(',')) {
    c.i++;
    const r = parseQRef(c);
    if (!r) break;
    out.push(r);
  }
  return out;
}

function skipMultiplicity(c: Cursor): void {
  if (!c.isSym('[')) return;
  let depth = 0;
  while (!c.eof()) {
    const t = c.peek()!;
    c.i++;
    if (t.k === 'sym' && t.v === '[') depth++;
    else if (t.k === 'sym' && t.v === ']') {
      depth--;
      if (depth === 0) return;
    }
  }
}

/**
 * Declaration part: [<short>] [name] (typing | specialization | subsetting | redefinition | multiplicity)* [value].
 * Stops at a relationship keyword (connect, to, from, by, ...).
 */
function parseDeclaration(c: Cursor, s: SStatement, opts: { allowName: boolean }): void {
  if (c.isSym('<') && isNameTok(c.peek(1)) && c.isSym('>', 2)) {
    s.shortName = c.peek(1)!.v;
    c.i += 3;
  }
  if (opts.allowName && isNameTok(c.peek())) {
    const t = c.peek()!;
    const nextIsChain = c.isSym('.', 1) || c.isSym('::', 1);
    if (!(t.k === 'word' && (DECL_STOP.has(t.v) || ['typed', 'defined', 'subsets', 'redefines', 'specializes', 'references', 'default', 'ordered', 'nonunique', 'conjugates', 'crosses'].includes(t.v))) && !nextIsChain) {
      s.name = t.v;
      c.i++;
      if (c.isSym('<') && isNameTok(c.peek(1)) && c.isSym('>', 2)) {
        s.shortName = c.peek(1)!.v;
        c.i += 3;
      }
    }
  }
  for (let guard = 0; guard < 64 && !c.eof(); guard++) {
    const t = c.peek()!;
    if (t.k === 'sym' && t.v === ':' ) {
      c.i++;
      s.typedBy.push(...parseQRefList(c));
      continue;
    }
    if (t.k === 'word' && (t.v === 'typed' || t.v === 'defined') && c.isWord('by', 1)) {
      c.i += 2;
      s.typedBy.push(...parseQRefList(c));
      continue;
    }
    if ((t.k === 'sym' && t.v === ':>') || (t.k === 'word' && (t.v === 'subsets' || t.v === 'specializes'))) {
      c.i++;
      const l = parseQRefList(c);
      if (s.isDef) s.specializes.push(...l);
      else s.subsets.push(...l);
      continue;
    }
    if ((t.k === 'sym' && t.v === ':>>') || (t.k === 'word' && t.v === 'redefines')) {
      c.i++;
      s.redefines.push(...parseQRefList(c));
      continue;
    }
    if ((t.k === 'sym' && t.v === '::>') || (t.k === 'word' && t.v === 'references')) {
      c.i++;
      s.references.push(...parseQRefList(c));
      continue;
    }
    if (t.k === 'sym' && t.v === '~') {
      // conjugated port definition reference without ':' (rare)
      const q = parseQRef(c);
      if (q) s.typedBy.push(q);
      continue;
    }
    if (t.k === 'sym' && t.v === '[') {
      skipMultiplicity(c);
      continue;
    }
    if (t.k === 'word' && (t.v === 'ordered' || t.v === 'nonunique')) {
      c.i++;
      continue;
    }
    if ((t.k === 'sym' && (t.v === '=' || t.v === ':=')) || (t.k === 'word' && t.v === 'default')) {
      c.i++;
      if (c.isSym('=') || c.isSym(':=')) c.i++;
      const val: Token[] = [];
      while (!c.eof()) {
        const v = c.peek()!;
        if (v.k === 'word' && (v.v === 'connect' || v.v === 'to') && val.length > 0) break;
        val.push(v);
        c.i++;
      }
      s.value = val;
      continue;
    }
    if (t.k === 'word' && t.v === 'of') {
      // flow / message payload type: "of T"
      c.i++;
      const q = parseQRef(c);
      if (q) s.typedBy.push(q);
      continue;
    }
    break;
  }
  if (!s.name && s.redefines.length > 0) {
    // an unnamed redefinition takes the name of the redefined feature
    const r = s.redefines[0];
    s.name = r.segs[r.segs.length - 1];
  }
}

/** Parses "[mult] [name ::>] chain" connector end. */
function parseEnd(c: Cursor): QRef | undefined {
  skipMultiplicity(c);
  const save = c.i;
  if (isNameTok(c.peek()) && (c.isSym('::>', 1) || c.isWord('references', 1))) {
    c.i += 2;
  }
  const q = parseQRef(c);
  if (!q) {
    c.i = save;
    return undefined;
  }
  skipMultiplicity(c);
  return q;
}

function findTop(c: Cursor, word: string, from: number): number {
  let depth = 0;
  for (let k = from; k < c.t.length; k++) {
    const t = c.t[k];
    if (t.k === 'sym' && (t.v === '(' || t.v === '[')) depth++;
    else if (t.k === 'sym' && (t.v === ')' || t.v === ']')) depth--;
    else if (depth === 0 && t.k === 'word' && t.v === word) return k;
  }
  return -1;
}

/** Last feature chain ending right before index `end` (scans back over name ('.'|'::') name ...). */
function chainBefore(t: Token[], end: number): QRef | undefined {
  let k = end - 1;
  if (k < 0 || !isNameTok(t[k])) return undefined;
  while (k - 2 >= 0 && t[k - 1].k === 'sym' && (t[k - 1].v === '.' || t[k - 1].v === '::') && isNameTok(t[k - 2])) k -= 2;
  const c = new Cursor(t.slice(k, end));
  return parseQRef(c);
}

function parseConnectEnds(c: Cursor): { src: QRef[]; tgt: QRef[] } {
  if (c.isSym('(')) {
    c.i++;
    const ends: QRef[] = [];
    while (!c.eof() && !c.isSym(')')) {
      const e = parseEnd(c);
      if (e) ends.push(e);
      else c.i++;
      if (c.isSym(',')) c.i++;
    }
    return { src: ends.slice(0, 1), tgt: ends.slice(1) };
  }
  const a = parseEnd(c);
  if (c.isWord('to')) c.i++;
  const b = parseEnd(c);
  return { src: a ? [a] : [], tgt: b ? [b] : [] };
}

function newStmt(file: string, line: number, header: Token[], isLibrary: boolean): SStatement {
  return {
    uid: ++uidCounter,
    file,
    line,
    kind: 'unknown',
    isDef: false,
    prefixes: [],
    metadata: [],
    isRef: false,
    typedBy: [],
    specializes: [],
    subsets: [],
    redefines: [],
    references: [],
    children: [],
    header,
    isLibrary,
  };
}

function looksLikeDeclaration(t: Token[]): boolean {
  // name? followed only by declaration syntax
  const c = new Cursor(t);
  const probe = newStmt('', 0, t, false);
  parseDeclaration(c, probe, { allowName: true });
  return c.eof() && (probe.name !== undefined || probe.redefines.length > 0 || probe.subsets.length > 0 || probe.typedBy.length > 0 || probe.references.length > 0);
}

function classify(raw: RawStmt, file: string, isLibrary: boolean, ownerKind: string | undefined): SStatement {
  const t = raw.tokens;
  const s = newStmt(file, raw.line, t, isLibrary);
  const c = new Cursor(t);
  if (t.length === 0) {
    s.kind = raw.body ? 'anonymous block' : 'empty';
    return s;
  }
  if (t.length === 1 && t[0].k === 'comment') {
    s.kind = 'comment';
    return s;
  }
  // metadata annotation "@X ..." as a statement
  if (c.isSym('@')) {
    s.kind = 'metadata usage';
    c.i++;
    const q = parseQRef(c);
    if (q) s.metadata.push(q.text);
    return s;
  }
  // prefixes: visibility, modifiers, #metadata
  for (let guard = 0; guard < 32 && !c.eof(); guard++) {
    const p = c.peek()!;
    if (p.k === 'word' && PREFIX_WORDS.has(p.v)) {
      // 'end' / 'in' / 'out' followed by '::>' or ':' etc. are still prefixes
      s.prefixes.push(p.v);
      if (p.v === 'in' || p.v === 'out' || p.v === 'inout') s.direction = p.v;
      if (p.v === 'ref' || p.v === 'end') s.isRef = true;
      c.i++;
      continue;
    }
    if (p.k === 'sym' && p.v === '[' && s.prefixes.length > 0) {
      // multiplicity written before the kind keyword, e.g. "end [1] port p"
      skipMultiplicity(c);
      continue;
    }
    if (p.k === 'sym' && p.v === '#' && isNameTok(c.peek(1))) {
      c.i++;
      const q = parseQRef(c);
      if (q) s.metadata.push(q.text);
      continue;
    }
    break;
  }
  if (s.direction) s.isRef = true; // directed features are referential by default
  const w = c.peek();
  const w1 = c.peek(1);
  const word = w && w.k === 'word' ? w.v : undefined;

  // ---- definitions and usages with a kind keyword -------------------------------
  let kindWord: string | undefined;
  if (s.prefixes.includes('individual') && word === 'def') {
    // "individual def X" is an individual occurrence definition
    s.isDef = true;
    s.isRef = false;
    s.kind = 'occurrence def';
    c.i++;
    parseDeclaration(c, s, { allowName: true });
    return s;
  }
  if (word === 'use' && c.isWord('case', 1)) {
    kindWord = 'use case';
    c.i += 2;
  } else if (word === 'event' && c.isWord('occurrence', 1)) {
    kindWord = 'occurrence';
    s.prefixes.push('event');
    s.isRef = true;
    c.i += 2;
  } else if (word && KIND_WORDS.includes(word)) {
    kindWord = word;
    c.i++;
  }
  if (kindWord) {
    // "succession flow" is a flow
    if (kindWord === 'succession' && c.isWord('flow')) {
      kindWord = 'flow';
      c.i++;
    }
    if (c.isWord('def')) {
      s.isDef = true;
      s.isRef = false;
      c.i++;
      s.kind = `${kindWord} def`;
      parseDeclaration(c, s, { allowName: true });
      if (!c.eof()) s.note = 'trailing tokens in definition header';
      return s;
    }
    s.kind = kindWord;
    if (ownerKind === 'enum def' && kindWord === 'enum') s.kind = 'enum literal';
    return parseUsageTail(c, s, kindWord);
  }

  // ---- relationship and behavioral statements ------------------------------------
  switch (word) {
    case 'package': {
      s.kind = 'package';
      c.i++;
      parseDeclaration(c, s, { allowName: true });
      return s;
    }
    case 'import': {
      s.kind = 'import';
      c.i++;
      if (c.isWord('all')) c.i++;
      const q = parseQRef(c);
      s.rel = { kind: 'import', src: [], tgt: q ? [q] : [], importAll: q?.wildcard !== undefined, importRecursive: q?.wildcard === '**' };
      return s;
    }
    case 'alias': {
      s.kind = 'alias';
      c.i++;
      parseDeclaration(c, s, { allowName: true });
      if (c.isWord('for')) c.i++;
      const q = parseQRef(c);
      s.rel = { kind: 'alias', src: [], tgt: q ? [q] : [], aliasName: s.name };
      return s;
    }
    case 'doc':
    case 'comment':
    case 'language':
    case 'rep':
      s.kind = word === 'doc' ? 'doc' : 'comment';
      return s;
    case 'connect': {
      s.kind = 'connect';
      c.i++;
      const e = parseConnectEnds(c);
      s.rel = { kind: 'connect', ...e };
      return s;
    }
    case 'bind': {
      s.kind = 'bind';
      c.i++;
      const a = parseEnd(c);
      if (c.isSym('=')) c.i++;
      const b = parseEnd(c);
      s.rel = { kind: 'bind', src: a ? [a] : [], tgt: b ? [b] : [] };
      return s;
    }
    case 'satisfy': {
      s.kind = 'satisfy';
      c.i++;
      return parseSatisfy(c, s);
    }
    case 'verify': {
      s.kind = 'verify';
      c.i++;
      if (c.isWord('requirement')) c.i++;
      const save = c.i;
      parseDeclaration(c, s, { allowName: true });
      let tgt: QRef | undefined;
      if (s.typedBy.length > 0) tgt = s.typedBy[0];
      else if (s.subsets.length > 0) tgt = s.subsets[0];
      else {
        c.i = save;
        s.name = undefined;
        tgt = parseQRef(c);
      }
      s.rel = { kind: 'verify', src: [], tgt: tgt ? [tgt] : [] };
      return s;
    }
    case 'allocate': {
      s.kind = 'allocate';
      c.i++;
      const e = parseConnectEnds(c);
      s.rel = { kind: 'allocate', ...e };
      return s;
    }
    case 'dependency': {
      s.kind = 'dependency';
      c.i++;
      const fromIdx = findTop(c, 'from', c.i);
      const toIdx = findTop(c, 'to', c.i);
      if (toIdx < 0) return s;
      if (fromIdx >= 0 && fromIdx < toIdx) {
        const pre = new Cursor(t.slice(c.i, fromIdx));
        parseDeclaration(pre, s, { allowName: true });
        c.i = fromIdx + 1;
      }
      const src = new Cursor(t.slice(c.i, toIdx));
      const srcs = parseQRefList(src);
      c.i = toIdx + 1;
      const tgts = parseQRefList(c);
      s.rel = { kind: 'dependency', src: srcs, tgt: tgts };
      return s;
    }
    case 'expose': {
      s.kind = 'expose';
      c.i++;
      const q = parseQRef(c);
      s.rel = { kind: 'expose', src: [], tgt: q ? [q] : [] };
      return s;
    }
    case 'perform':
    case 'exhibit':
    case 'include': {
      // "perform action x : T" declares; "perform x" references an existing behavior
      c.i++;
      s.isRef = true;
      s.prefixes.push(word);
      const kw = word === 'perform' ? 'action' : word === 'exhibit' ? 'state' : 'use case';
      if (word === 'include' && c.isWord('use') && c.isWord('case', 1)) c.i += 2;
      else if (c.isWord(kw)) c.i++;
      s.kind = kw;
      const hasKw = c.i > 0 && c.t[c.i - 1].k === 'word' && (c.t[c.i - 1].v === kw || c.t[c.i - 1].v === 'case');
      const save = c.i;
      const q = parseQRef(c);
      if (q && (q.segs.length > 1 || !hasKw)) {
        // "perform x" / "perform x.y [:>> z]": a reference to an existing behavior; the effective
        // name of the usage is that of the performed feature (or of the redefined one)
        s.references.push(q);
        s.name = q.segs[q.segs.length - 1];
        const probe = newStmt('', 0, [], false);
        parseDeclaration(c, probe, { allowName: false });
        s.redefines.push(...probe.redefines);
        s.subsets.push(...probe.subsets);
        s.typedBy.push(...probe.typedBy);
        if (probe.redefines.length > 0) s.name = probe.redefines[0].segs[probe.redefines[0].segs.length - 1];
      } else {
        c.i = save;
        parseDeclaration(c, s, { allowName: true });
      }
      s.rel = { kind: word as 'perform' | 'exhibit' | 'include', src: [], tgt: [...s.references, ...s.subsets] };
      return s;
    }
    case 'subject':
    case 'actor':
    case 'stakeholder':
    case 'objective':
    case 'return':
    case 'frame':
    case 'require':
    case 'assume': {
      c.i++;
      s.kind = word;
      if (word !== 'objective') s.isRef = true;
      if ((word === 'require' || word === 'assume') && c.isWord('constraint')) {
        c.i++;
        s.kind = 'constraint';
        s.prefixes.push(word);
        parseDeclaration(c, s, { allowName: true });
        return s;
      }
      if (c.isWord('requirement') || c.isWord('concern')) c.i++;
      parseDeclaration(c, s, { allowName: true });
      return s;
    }
    case 'first':
    case 'succession':
      s.kind = 'succession';
      return s;
    case 'transition':
    case 'accept':
    case 'send':
    case 'entry':
    case 'exit':
    case 'do':
    case 'if':
    case 'else':
    case 'while':
    case 'loop':
    case 'for':
    case 'merge':
    case 'decide':
    case 'join':
    case 'fork':
    case 'assign':
    case 'terminate':
    case 'until':
    case 'after':
    case 'at':
    case 'when':
      s.kind = 'behavior control';
      return s;
    case 'filter':
    case 'render':
      s.kind = word;
      return s;
    case 'specialization':
    case 'subclassification':
    case 'subtype':
    case 'subset':
    case 'redefinition':
    case 'conjugation':
    case 'dependency_':
      s.kind = 'explicit relationship';
      return s;
    default:
      break;
  }
  if (word && KERML_DECL_WORDS.has(word)) {
    s.kind = `kerml ${word}`;
    return s;
  }
  // ---- generic feature declaration or enum literal or expression -------------------
  const rest = t.slice(c.i);
  if (ownerKind === 'enum def' && rest.length >= 1 && isNameTok(rest[0])) {
    s.kind = 'enum literal';
    s.name = rest[0].v;
    return s;
  }
  if (rest.length > 0 && looksLikeDeclaration(rest)) {
    s.kind = 'feature';
    parseDeclaration(c, s, { allowName: true });
    if (s.prefixes.includes('then') && s.typedBy.length + s.subsets.length + s.redefines.length + s.references.length === 0 && !s.value) {
      // "then x;" is a succession to an existing action, not a declaration
      s.kind = 'succession';
      s.name = undefined;
    }
    return s;
  }
  s.kind = 'expression';
  return s;
}

function parseUsageTail(c: Cursor, s: SStatement, kindWord: string): SStatement {
  const t = c.t;
  switch (kindWord) {
    case 'connection':
    case 'interface':
    case 'binding':
    case 'allocation': {
      parseDeclaration(c, s, { allowName: true });
      if (c.isWord('connect')) {
        c.i++;
        s.rel = { kind: 'connect', ...parseConnectEnds(c) };
      } else if (c.isWord('allocate')) {
        c.i++;
        s.rel = { kind: 'allocate', ...parseConnectEnds(c) };
      } else if (c.isWord('bind')) {
        c.i++;
        const a = parseEnd(c);
        if (c.isSym('=')) c.i++;
        const b = parseEnd(c);
        s.rel = { kind: 'bind', src: a ? [a] : [], tgt: b ? [b] : [] };
      } else if (kindWord === 'connection' || kindWord === 'interface') {
        // "connection a.b to c.d" shorthand is not valid; connection without ends is a usage only
      }
      return s;
    }
    case 'flow':
    case 'message': {
      const toIdx = findTop(c, 'to', c.i);
      if (toIdx < 0) {
        parseDeclaration(c, s, { allowName: true });
        return s;
      }
      const fromIdx = findTop(c, 'from', c.i);
      let srcRef: QRef | undefined;
      if (fromIdx >= 0 && fromIdx < toIdx) {
        const pre = new Cursor(t.slice(c.i, fromIdx));
        parseDeclaration(pre, s, { allowName: true });
        const sc = new Cursor(t.slice(fromIdx + 1, toIdx));
        srcRef = parseEnd(sc);
      } else {
        srcRef = chainBefore(t, toIdx);
        // anything before the source chain is the declaration (name / of T)
        const chainLen = srcRef ? srcRef.segs.length * 2 - 1 : 0;
        const pre = new Cursor(t.slice(c.i, toIdx - chainLen));
        parseDeclaration(pre, s, { allowName: true });
      }
      const tc = new Cursor(t.slice(toIdx + 1));
      const tgtRef = parseEnd(tc);
      s.rel = { kind: kindWord === 'flow' ? 'flow' : 'message', src: srcRef ? [srcRef] : [], tgt: tgtRef ? [tgtRef] : [] };
      c.i = t.length;
      return s;
    }
    case 'succession': {
      parseDeclaration(c, s, { allowName: true });
      s.rel = { kind: 'succession', src: [], tgt: [] };
      return s;
    }
    case 'requirement':
    case 'concern':
    case 'constraint':
      parseDeclaration(c, s, { allowName: true });
      return s;
    default:
      parseDeclaration(c, s, { allowName: true });
      if (!c.eof()) s.note = 'trailing tokens in usage header';
      return s;
  }
}

function parseSatisfy(c: Cursor, s: SStatement): SStatement {
  const t = c.t;
  if (c.isWord('requirement')) c.i++;
  const byIdx = findTop(c, 'by', c.i);
  const leftEnd = byIdx >= 0 ? byIdx : t.length;
  const left = new Cursor(t.slice(c.i, leftEnd));
  const probe = newStmt('', 0, [], false);
  parseDeclaration(left, probe, { allowName: true });
  let req: QRef | undefined;
  if (probe.typedBy.length > 0) req = probe.typedBy[0];
  else if (probe.subsets.length > 0) req = probe.subsets[0];
  else {
    const lc = new Cursor(t.slice(c.i, leftEnd));
    req = parseQRef(lc);
  }
  let by: QRef | undefined;
  if (byIdx >= 0) {
    const rc = new Cursor(t.slice(byIdx + 1));
    by = parseQRef(rc);
  }
  s.rel = { kind: 'satisfy', src: by ? [by] : [], tgt: req ? [req] : [], negated: s.prefixes.includes('not') };
  return s;
}

function build(raws: RawStmt[], file: string, isLibrary: boolean, owner: SStatement | undefined, count: { n: number }): SStatement[] {
  const out: SStatement[] = [];
  for (const r of raws) {
    const s = classify(r, file, isLibrary, owner?.kind);
    count.n++;
    s.owner = owner;
    if (r.body) s.children = build(r.body, file, isLibrary, s, count);
    out.push(s);
  }
  return out;
}

export function parseSysML(src: string, file: string, isLibrary = false): ParsedFile {
  const lines = src.split('\n').length;
  try {
    const toks = lex(src);
    const sp = new Splitter(toks);
    const raws = sp.block(false);
    const count = { n: 0 };
    const roots = build(raws, file, isLibrary, undefined, count);
    return { file, ok: true, roots, statements: count.n, lines };
  } catch (e) {
    return { file, ok: false, error: (e as Error).message, roots: [], statements: 0, lines };
  }
}

export function walk(stmts: SStatement[], fn: (s: SStatement) => void): void {
  for (const s of stmts) {
    fn(s);
    walk(s.children, fn);
  }
}
