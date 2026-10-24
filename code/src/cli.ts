/**
 * Experiment driver. Every experiment is a pure function of its fixed seeds, so
 *   node dist/cli.js all --output <new-dir>
 * reproduces every number reported in the paper except wall-clock timings.
 *
 * Result files are created exclusively. All target files of a command are checked
 * before any experiment runs, so the stored raw results in results/ are never
 * overwritten. An explicit --output that already holds a target file is refused and
 * nothing is written; without --output, a run whose results/ targets already exist
 * goes to a fresh runs/<timestamp>-<suffix>/ directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runE1, runE2, runInjectionProtocol, summarizeE3, summarizeE4 } from './experiments/e1e4';
import { runE5, runE6, runE7 } from './experiments/e5e7';
import { formatWorkedExample, runWorkedExample } from './experiments/workedExample';
import { SysMLLikeModel } from './model/types';

const DEFAULT_RESULTS_DIR = path.join(__dirname, '..', 'results');
const RUNS_DIR = path.join(__dirname, '..', 'runs');
const PUBLIC_DIR = path.join(__dirname, '..', 'examples', 'public-models');

const RESULT_NAMES: Record<string, string[]> = {
  e1: ['e1-proof-mechanization'],
  e2: ['e2-generator-integrity'],
  e3e4: ['e3-detection-accuracy', 'e4-expressiveness-separation', 'e3-raw-records'],
  e5: ['e5-incremental'],
  e6: ['e6-complexity'],
  e7: ['e7-external-validity'],
  example: ['worked-example'],
};
RESULT_NAMES.e3 = RESULT_NAMES.e3e4;
RESULT_NAMES.e4 = RESULT_NAMES.e3e4;
RESULT_NAMES.all = ['e1', 'e2', 'e3e4', 'e5', 'e6', 'e7', 'example'].flatMap((c) => RESULT_NAMES[c]);

let resultsDir = DEFAULT_RESULTS_DIR;

function resultFile(name: string): string {
  return path.join(resultsDir, `${name}.json`);
}

function writeResult(name: string, data: unknown): void {
  const file = resultFile(name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`written: ${path.relative(process.cwd(), file)}`);
}

function loadPublicModels(): SysMLLikeModel[] {
  const files = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')) as SysMLLikeModel);
}

function e1(): void {
  console.log('E1: proof mechanization (bounded exhaustive + property based)');
  const result = runE1() as {
    boundedExhaustive: { counterexamples: number };
    propertyBased: { counterexamples: number };
  };
  writeResult('e1-proof-mechanization', result);
  const counterexamples = result.boundedExhaustive.counterexamples + result.propertyBased.counterexamples;
  if (counterexamples > 0) {
    console.error(`E1 found ${counterexamples} counterexample(s)`);
    process.exitCode = 1;
  }
}

function e2(): void {
  console.log('E2: generator and clean model integrity');
  writeResult('e2-generator-integrity', runE2());
}

function e3e4(): void {
  console.log('E3/E4: defect injection under the exact oracle, and baseline separation');
  const protocol = runInjectionProtocol();
  writeResult('e3-detection-accuracy', summarizeE3(protocol));
  writeResult('e4-expressiveness-separation', summarizeE4(protocol));
  writeResult('e3-raw-records', { records: protocol.records });
}

function e5(): void {
  console.log('E5: incremental correctness, counterexample families, speedup');
  writeResult('e5-incremental', runE5());
}

function e6(): void {
  console.log('E6: complexity prediction test');
  writeResult('e6-complexity', runE6());
}

function e7(): void {
  console.log('E7: public model calibration and external validity');
  writeResult('e7-external-validity', runE7(loadPublicModels()));
}

function example(): void {
  console.log('Worked example: the five procedure stages on one small model');
  const result = runWorkedExample();
  console.log(formatWorkedExample(result));
  writeResult('worked-example', result);
}

function usage(message: string): never {
  console.error(message);
  console.error('usage: node dist/cli.js <e1|e2|e3|e4|e3e4|e5|e6|e7|example|all> [--output <dir> | --temp-output]');
  process.exit(2);
}

function parseArgs(argv: string[]): { cmd: string; output?: string; tempOutput: boolean } {
  let cmd: string | undefined;
  let output: string | undefined;
  let tempOutput = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') {
      output = argv[++i];
      if (!output) usage('--output requires a directory');
    } else if (arg === '--temp-output') {
      tempOutput = true;
    } else if (arg.startsWith('-') || cmd !== undefined) {
      usage(`unexpected argument: ${arg}`);
    } else {
      cmd = arg;
    }
  }
  if (output !== undefined && tempOutput) usage('--output and --temp-output are mutually exclusive');
  return { cmd: cmd ?? 'all', output, tempOutput };
}

function main(): void {
  const { cmd, output, tempOutput } = parseArgs(process.argv.slice(2));
  const names = RESULT_NAMES[cmd];
  if (!names) usage(`unknown command: ${cmd}`);
  if (tempOutput) {
    resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamodel-validator-'));
  } else {
    resultsDir = output !== undefined ? path.resolve(output) : DEFAULT_RESULTS_DIR;
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const existing = names.map(resultFile).filter((f) => fs.existsSync(f));
  if (existing.length > 0) {
    if (output !== undefined) {
      console.error(`refusing to overwrite existing results: ${existing.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
      console.error('pass a new --output directory or --temp-output to rerun');
      process.exit(1);
    }
    // The stored raw results stay in results/; the rerun goes to a fresh run directory.
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    resultsDir = fs.mkdtempSync(path.join(RUNS_DIR, `${stamp}-`));
    console.log(`existing results in ${path.relative(process.cwd(), DEFAULT_RESULTS_DIR)} kept; writing to ${path.relative(process.cwd(), resultsDir)}`);
  }
  const started = Date.now();
  switch (cmd) {
    case 'e1':
      e1();
      break;
    case 'e2':
      e2();
      break;
    case 'e3':
    case 'e4':
    case 'e3e4':
      e3e4();
      break;
    case 'e5':
      e5();
      break;
    case 'e6':
      e6();
      break;
    case 'e7':
      e7();
      break;
    case 'example':
      example();
      break;
    case 'all':
      e1();
      e2();
      e3e4();
      e5();
      e6();
      e7();
      example();
      break;
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main();
