/**
 * Corpus loading: the public SysML v2 textual examples are read as data only (no script
 * inside the downloaded tree is executed). A model unit is one directory of .sysml files
 * (files in the same directory import each other's packages); the standard library
 * (sysml.library, .sysml files only) is parsed once and shared by all units.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ParsedFile, parseSysML, SStatement } from './parser';

export interface Unit {
  id: string;
  group: string;
  dir: string;
  files: ParsedFile[];
  roots: SStatement[];
  lines: number;
  statements: number;
  sha256: string;
}

export interface Library {
  files: ParsedFile[];
  roots: SStatement[];
  failed: string[];
}

function listSysml(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...listSysml(p, true));
    } else if (e.isFile() && e.name.endsWith('.sysml')) out.push(p);
  }
  return out.sort();
}

function listDirs(dir: string): string[] {
  const out: string[] = [dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listDirs(path.join(dir, e.name)));
  }
  return out;
}

export function loadLibrary(libDir: string): Library {
  const files = listSysml(libDir, true).map((f) => parseSysML(fs.readFileSync(f, 'utf8'), path.relative(libDir, f).replace(/\\/g, '/'), true));
  return { files, roots: files.flatMap((f) => f.roots), failed: files.filter((f) => !f.ok).map((f) => `${f.file}: ${f.error}`) };
}

export function loadUnits(srcDir: string, groups: string[]): Unit[] {
  const units: Unit[] = [];
  for (const group of groups) {
    const base = path.join(srcDir, group);
    if (!fs.existsSync(base)) continue;
    for (const d of listDirs(base)) {
      const files = listSysml(d, false);
      if (files.length === 0) continue;
      const hash = crypto.createHash('sha256');
      const parsed: ParsedFile[] = [];
      for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        hash.update(path.basename(f));
        hash.update(text);
        parsed.push(parseSysML(text, path.relative(srcDir, f).replace(/\\/g, '/'), false));
      }
      units.push({
        id: path.relative(srcDir, d).replace(/\\/g, '/'),
        group,
        dir: d,
        files: parsed,
        roots: parsed.flatMap((p) => p.roots),
        lines: parsed.reduce((s, p) => s + p.lines, 0),
        statements: parsed.reduce((s, p) => s + p.statements, 0),
        sha256: hash.digest('hex'),
      });
    }
  }
  return units;
}

import { SemanticModel } from './semantics';

/** Semantic model of one unit: unit + other units of the same group (imports only) + library. */
export function semanticModelFor(u: Unit, units: Unit[], lib: Library): SemanticModel {
  const context = units.filter((v) => v !== u && v.group === u.group).flatMap((v) => v.roots);
  return new SemanticModel(u.roots, lib.roots, context);
}
