/**
 * Experiment driver for the revised experiments (round-1 review response, R1).
 *
 *   node dist/cli-v2.js <command> [--output <dir>] [--quick]
 *
 * Commands:
 *   e1        proof mechanization with extended templates, P1f and invariance checks
 *   e3        defect injection v2: operator families, position strata, non-interference
 *             ablation, mixture sensitivity, measured FP
 *   e5        incremental evaluation v2: symmetric timing, operation counters, three
 *             strategies reported separately, random and clustered edits
 *   e6        complexity v2: up to 10^6 elements, operation counters, hub generator
 *   mutation  mutation analysis of the verification harness (forks child processes)
 *
 * Results are written to results-v2/ (or --output) with exclusive creation; an existing
 * file is never overwritten. Every file carries a meta block (command, Node version,
 * platform, CPU, memory, start time, elapsed time).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_DIR = path.join(__dirname, '..', 'results-v2');

interface Command {
  file: string;
  run: (quick: boolean) => unknown;
}

const COMMANDS: Record<string, Command> = {
  e1: {
    file: 'e1-proof-mechanization-v2',
    run: () => require('./experiments/e1v2').runE1v2(),
  },
  e3: {
    file: 'e3-defect-injection-v2',
    run: (quick) => require('./experiments/e3v2').runE3v2(quick),
  },
  e3sched: {
    file: 'e3-scheduler-scope-comparison',
    run: (quick) => require('./experiments/e3sched').runE3Sched(quick),
  },
  e5: {
    file: 'e5-incremental-v2',
    run: (quick) => require('./experiments/e5v2').runE5v2(quick),
  },
  e6: {
    file: 'e6-complexity-v2',
    run: (quick) => require('./experiments/e6v2').runE6v2(quick),
  },
  e6order: {
    file: 'e6-view-order-comparison',
    run: (quick) => require('./experiments/e6v2').runE6Order(quick),
  },
  mutation: {
    file: 'm4-mutation-analysis',
    run: (quick) => require('./verification/mutationAnalysis').runMutationAnalysis(quick),
  },
};

function meta(cmd: string, started: Date, elapsedMs: number): unknown {
  return {
    command: `node dist/cli-v2.js ${process.argv.slice(2).join(' ')}`.trim(),
    subcommand: cmd,
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    maxOldSpaceMiB: Math.round(require('v8').getHeapStatistics().heap_size_limit / 2 ** 20),
    startedAt: started.toISOString(),
    elapsedSec: Math.round(elapsedMs / 100) / 10,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let cmd: string | undefined;
  let out = DEFAULT_DIR;
  let quick = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') out = path.resolve(args[++i]);
    else if (args[i] === '--quick') quick = true;
    else cmd = args[i];
  }
  if (!cmd || !COMMANDS[cmd]) {
    console.error(`usage: node dist/cli-v2.js <${Object.keys(COMMANDS).join('|')}> [--output <dir>] [--quick]`);
    process.exit(2);
  }
  const c = COMMANDS[cmd];
  fs.mkdirSync(out, { recursive: true });
  const tag = process.env.R1_TAG ? `-${process.env.R1_TAG}` : '';
  const file = path.join(out, `${c.file}${tag}${quick ? '-quick' : ''}.json`);
  if (fs.existsSync(file)) {
    console.error(`refusing to overwrite ${file}`);
    process.exit(1);
  }
  const started = new Date();
  const t0 = Date.now();
  const result = (await Promise.resolve(c.run(quick))) as Record<string, unknown>;
  const data = { meta: meta(cmd, started, Date.now() - t0), ...result };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`written: ${file} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const ce = result as { boundedExhaustive?: { counterexamples: number }; propertyBased?: { counterexamples: number }; invariance?: { counterexamples: number } };
  const total = (ce.boundedExhaustive?.counterexamples ?? 0) + (ce.propertyBased?.counterexamples ?? 0) + (ce.invariance?.counterexamples ?? 0);
  if (total > 0) {
    console.error(`${total} counterexample(s)`);
    process.exitCode = 1;
  }
}

void main();
