#!/usr/bin/env node
/**
 * R8 single code snapshot: sha256 of every source file that can influence a manuscript number,
 * a frozen copy of the source tree (results-v4/snapshot/tree: src, examples, tsconfig, package
 * files, and dist = the compiled dist-r8) used by the mutation analyses, and identities of the
 * input data. Run after `npx tsc -p tsconfig.r8.json`, before tools/run-r8-final.sh.
 *
 *   node tools/snapshot-r8.js [--verify]
 *
 * --verify recomputes the hashes and reports any file that changed after the snapshot.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'results-v4', 'snapshot');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.venv', '__pycache__', 'target', 'work'].includes(e.name)) continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

function sourceFiles() {
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  const files = [
    ...walk(path.join(ROOT, 'src'), (p) => p.endsWith('.ts')),
    ...walk(path.join(ROOT, 'oracle-py'), (p) => /\.(py|txt)$/.test(p) && !p.includes(`${path.sep}.venv${path.sep}`)),
    ...walk(path.join(ROOT, 'blind-compare'), (p) => p.endsWith('.py')),
    ...walk(path.join(ROOT, 'tools'), (p) => /\.(sh|js)$/.test(p)),
    ...walk(path.join(ROOT, 'bench-shacl'), (p) => /\.(mjs|sh|json|xml|java)$/.test(p) && !p.includes('node_modules')),
    ...walk(path.join(ROOT, 'examples'), (p) => /\.(sysml|json)$/.test(p)),
    ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.r8.json'].map((f) => path.join(ROOT, f)),
  ].filter((f) => fs.existsSync(f));
  return Object.fromEntries(files.map((f) => [rel(f), sha(f)]).sort((a, b) => a[0].localeCompare(b[0])));
}

function treeDigest(dir, pred) {
  const files = walk(dir, pred).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(dir, f).replace(/\\/g, '/'));
    h.update(sha(f));
  }
  return { files: files.length, sha256: h.digest('hex') };
}

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

if (process.argv.includes('--verify')) {
  const stored = JSON.parse(fs.readFileSync(path.join(OUT, 'snapshot-sha256.json'), 'utf8'));
  const now = sourceFiles();
  const changed = Object.keys({ ...stored.sources, ...now }).filter((k) => stored.sources[k] !== now[k]);
  console.log(changed.length === 0 ? 'snapshot unchanged' : `changed since snapshot: ${changed.join(', ')}`);
  process.exit(changed.length === 0 ? 0 : 1);
}

if (fs.existsSync(OUT)) throw new Error(`refusing to overwrite ${OUT}`);
fs.mkdirSync(OUT, { recursive: true });
const sources = sourceFiles();
const tree = path.join(OUT, 'tree');
copyDir(path.join(ROOT, 'src'), path.join(tree, 'src'));
copyDir(path.join(ROOT, 'examples'), path.join(tree, 'examples'));
copyDir(path.join(ROOT, 'dist-r8'), path.join(tree, 'dist'));
for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tree, f));
let tags = [];
try {
  tags = execSync('git -C corpus-history/repo show-ref --tags', { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).map((l) => l.split(' ').reverse().join(' '));
} catch (e) {
  tags = [`unavailable: ${e.message}`];
}
const blind = path.resolve(ROOT, '..', 'oracle-blind');
const doc = {
  createdAt: new Date().toISOString(),
  node: process.version,
  typescript: require(path.join(ROOT, 'node_modules', 'typescript', 'package.json')).version,
  build: 'npx tsc -p tsconfig.r8.json (outDir dist-r8); results-v4/snapshot/tree/dist is a copy of dist-r8',
  sources,
  sourceCount: Object.keys(sources).length,
  sourcesDigest: crypto.createHash('sha256').update(Object.entries(sources).map(([k, v]) => `${k} ${v}`).join('\n')).digest('hex'),
  distR8Digest: treeDigest(path.join(ROOT, 'dist-r8'), (p) => p.endsWith('.js')),
  data: {
    corpus: { dir: 'corpus/SysML-v2-Release', ...treeDigest(path.join(ROOT, 'corpus', 'SysML-v2-Release'), (p) => p.endsWith('.sysml')) },
    corpusHistory: { dir: 'corpus-history/tags', ...treeDigest(path.join(ROOT, 'corpus-history', 'tags'), (p) => p.endsWith('.sysml')), tagRefs: tags.filter((t) => /refs\/tags\/20(2[2-6])/.test(t)) },
    publicModels: { dir: 'examples/public-models', ...treeDigest(path.join(ROOT, 'examples', 'public-models'), (p) => p.endsWith('.json')) },
    oracleBlind: fs.existsSync(blind) ? Object.fromEntries(walk(blind, () => true).map((f) => [path.relative(blind, f).replace(/\\/g, '/'), sha(f)])) : 'missing',
    pythonPackages: fs.readFileSync(path.join(ROOT, 'oracle-py', 'requirements-lock.txt'), 'utf8').trim().split(/\r?\n/),
  },
};
fs.writeFileSync(path.join(OUT, 'snapshot-sha256.json'), JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
console.log(`snapshot: ${doc.sourceCount} source files, digest ${doc.sourcesDigest}`);
