/**
 * Bridge to the independent SHACL oracle (oracle-py/). The TypeScript side only serialises
 * catalog *data* and model JSON and reads back the oracle's violation tuples; no rule
 * derivation, domain check or violation construction is shipped to the oracle.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Catalog, SysMLLikeModel } from '../model/types';

export const ORACLE_DIR = process.env.ORACLE_DIR ?? path.join(__dirname, '..', '..', 'oracle-py');
export const ORACLE_PY = path.join(ORACLE_DIR, '.venv', 'Scripts', 'python.exe');

export interface OracleViolation {
  rule: string;
  cls: string;
  grounding: string[];
}

export interface OracleBatchResult {
  catalog: string;
  rules: { id: string; cls: string; layer: string }[];
  violations: Record<string, OracleViolation[]>;
  timing: Record<string, unknown> & {
    shapesMs: number;
    rdfMs?: number;
    validateMs?: number;
    reportMs?: number;
    perModel?: {
      caseId: string;
      nodes: number;
      edges: number;
      triples: number;
      rdfMs: number;
      validateMs: number;
      validateSamplesMs: number[];
      reportMs: number;
      violations: number;
    }[];
  };
}

export interface OracleCase {
  caseId: string;
  model: SysMLLikeModel;
}

/** Catalog as plain data (the object built by catalog/domains.ts, nothing derived). */
export function catalogData(c: Catalog): unknown {
  return JSON.parse(JSON.stringify(c));
}

let counter = 0;

export function runOracle(
  batches: { catalog: Catalog; cases: OracleCase[] }[],
  workDir: string,
  opts: { perModel?: boolean; reps?: number; shapesOut?: string } = {},
): OracleBatchResult[] {
  fs.mkdirSync(workDir, { recursive: true });
  const tag = `${process.pid}-${Date.now()}-${counter++}`;
  const inFile = path.join(workDir, `oracle-in-${tag}.json`);
  const outFile = path.join(workDir, `oracle-out-${tag}.json`);
  const doc = { batches: batches.map((b) => ({ catalog: catalogData(b.catalog), models: b.cases })) };
  fs.writeFileSync(inFile, JSON.stringify(doc));
  const args = ['-B', path.join(ORACLE_DIR, 'run_oracle.py'), inFile, outFile];
  if (opts.perModel) args.push('--per-model');
  if (opts.reps) args.push('--reps', String(opts.reps));
  const r = spawnSync(ORACLE_PY, args, { cwd: ORACLE_DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    throw new Error(`oracle failed (status ${r.status}): ${r.stderr}`);
  }
  const res = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { batches: OracleBatchResult[] };
  fs.unlinkSync(inFile);
  fs.unlinkSync(outFile);
  return res.batches;
}

/** Writes the SHACL shapes the oracle derives from a catalog (for inspection and LOC counts). */
export function writeShapes(c: Catalog, file: string, workDir: string): void {
  fs.mkdirSync(workDir, { recursive: true });
  const inFile = path.join(workDir, `shapes-in-${process.pid}-${counter++}.json`);
  const outFile = inFile.replace('shapes-in-', 'shapes-out-');
  fs.writeFileSync(inFile, JSON.stringify({ catalog: catalogData(c), models: [] }));
  const r = spawnSync(ORACLE_PY, ['-B', path.join(ORACLE_DIR, 'run_oracle.py'), inFile, outFile, '--shapes-out', file], {
    cwd: ORACLE_DIR,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`oracle shapes failed: ${r.stderr}`);
  fs.unlinkSync(inFile);
  fs.unlinkSync(outFile);
}
