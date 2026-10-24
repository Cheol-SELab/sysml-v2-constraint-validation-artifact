/**
 * Lexer for the SysML v2 textual notation (structural subset used by S1).
 *
 * Token kinds:
 *   word    identifier or keyword (keywords are resolved contextually by the parser)
 *   name    unrestricted name in single quotes ('provide power'); never a keyword
 *   num     numeric literal
 *   str     double-quoted string literal
 *   comment block comment body (/* ... *\/), used by doc / comment elements
 *   sym     punctuation / operator
 * Notes (// ... and //* ... *\/) are discarded, as in the SysML v2 grammar.
 */

export type TokKind = 'word' | 'name' | 'num' | 'str' | 'comment' | 'sym';

export interface Token {
  k: TokKind;
  v: string;
  line: number;
}

export class LexError extends Error {
  constructor(
    msg: string,
    public readonly line: number,
  ) {
    super(`${msg} (line ${line})`);
  }
}

const SYMBOLS = [
  ':::>', '::>', ':>>', '===', '!==', '::', ':>', ':=', '==', '!=', '<=', '>=', '->', '..', '**', '??', '@@', '.?',
  '{', '}', '(', ')', '[', ']', ';', ',', ':', '.', '~', '=', '<', '>', '+', '-', '*', '/', '%', '^', '&', '|', '!',
  '?', '@', '#', '$',
];

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '﻿') {
      i++;
      continue;
    }
    // notes
    if (src.startsWith('//*', i)) {
      const end = src.indexOf('*/', i + 3);
      if (end < 0) throw new LexError('unterminated note', line);
      for (let j = i; j < end; j++) if (src[j] === '\n') line++;
      i = end + 2;
      continue;
    }
    if (src.startsWith('//', i)) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new LexError('unterminated comment', line);
      const startLine = line;
      const body = src.slice(i + 2, end);
      for (const ch of body) if (ch === '\n') line++;
      out.push({ k: 'comment', v: body, line: startLine });
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) {
          v += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') line++;
        v += src[j];
        j++;
      }
      if (j >= n) throw new LexError('unterminated quoted name', line);
      out.push({ k: 'name', v, line });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          v += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') line++;
        v += src[j];
        j++;
      }
      if (j >= n) throw new LexError('unterminated string', line);
      out.push({ k: 'str', v, line });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 64))!;
      out.push({ k: 'num', v: m[0], line });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'word', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    let matched = false;
    for (const s of SYMBOLS) {
      if (src.startsWith(s, i)) {
        out.push({ k: 'sym', v: s, line });
        i += s.length;
        matched = true;
        break;
      }
    }
    if (!matched) throw new LexError(`unexpected character ${JSON.stringify(c)}`, line);
  }
  return out;
}
