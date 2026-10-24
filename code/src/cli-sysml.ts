/**
 * Entry point for the real-SysML-v2 experiments (review items M1, M8).
 *
 *   node dist/cli-sysml.js summary                 per-unit S1 statistics (both modes)
 *   node dist/cli-sysml.js inspect <unit> [mode]   dump nodes / edges / losses of one unit
 *   node dist/cli-sysml.js selftest                S1 self-test on a hand-written model
 *   node dist/cli-sysml.js run --output <dir>      full experiment, writes JSON into a new directory
 */

import * as path from 'path';
import { loadLibrary, loadUnits, semanticModelFor } from './sysml/corpus';
import { lossSummary, normalizeSysML, ClassMode } from './sysml/normalize';
import { SemanticModel } from './sysml/semantics';
import { runSysmlExperiments } from './sysml/experiments';
import { runSelfTest } from './sysml/selftest';

const ROOT = process.env.VALIDATOR_ROOT ? path.resolve(process.env.VALIDATOR_ROOT) : path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'corpus', 'SysML-v2-Release');
const SRC = path.join(CORPUS, 'sysml', 'src');
const LIB = path.join(CORPUS, 'sysml.library');
const GROUPS = ['examples', 'training', 'validation'];

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'summary') {
    const lib = loadLibrary(LIB);
    const units = loadUnits(SRC, GROUPS);
    for (const u of units) {
      const row: string[] = [u.id, String(u.lines)];
      for (const mode of ['keyword', 'specialization'] as ClassMode[]) {
        const sm = semanticModelFor(u, units, lib);
        const r = normalizeSysML(sm, mode);
        const l = lossSummary(r);
        row.push(`${mode[0]}:V=${r.model.nodes.length},E=${r.model.edges.length},loss=${l.lossRate.toFixed(2)},unres=${sm.refStats.unresolved}/${sm.refStats.resolved + sm.refStats.unresolved}`);
      }
      console.log(row.join(' | '));
    }
    return;
  }
  if (cmd === 'inspect') {
    const lib = loadLibrary(LIB);
    const allUnits = loadUnits(SRC, GROUPS);
    const units = allUnits.filter((u) => u.id.includes(args[0]));
    const mode = (args[1] ?? 'specialization') as ClassMode;
    for (const u of units) {
      const sm = semanticModelFor(u, allUnits, lib);
      const r = normalizeSysML(sm, mode);
      console.log(`=== ${u.id} (${mode})`);
      for (const n of r.model.nodes) console.log(`N ${n.id} [${[...r.classes.get(n.id)!].join(',')}] ${JSON.stringify(n.attrs)} ${r.nodeProv.get(n.id)!.file}:${r.nodeProv.get(n.id)!.line}`);
      for (const e of r.model.edges) console.log(`E ${e.type} ${e.src} -> ${e.tgt}  (${r.edgeProv.get(e.id)!.line}${r.edgeProv.get(e.id)!.viaReference ? ', via ref' : ''})`);
      for (const c of r.categories) if (c.category === 'lost') console.log(`L ${c.file}:${c.line} ${c.kind}: ${c.reason}`);
      console.log(JSON.stringify(lossSummary(r).byCategory));
      for (const x of sm.refStats.unresolvedRefs) console.log(`U ${x.file}:${x.line} ${x.ref}`);
    }
    return;
  }
  if (cmd === 'selftest') {
    const r = runSelfTest(loadLibrary(LIB));
    for (const f of r.failures) console.log(`FAIL ${f}`);
    console.log(r.ok ? 'selftest: all checks passed' : `selftest: ${r.failures.length} failure(s)`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'run') {
    const oi = args.indexOf('--output');
    if (oi < 0 || !args[oi + 1]) throw new Error('--output <new directory> is required');
    runSysmlExperiments({ corpusDir: CORPUS, srcDir: SRC, libDir: LIB, groups: GROUPS, outputDir: path.resolve(args[oi + 1]), quick: args.includes('--quick') });
    return;
  }
  console.log('usage: cli-sysml.js summary | inspect <unit> [keyword|specialization] | run --output <new dir>');
}

main();
