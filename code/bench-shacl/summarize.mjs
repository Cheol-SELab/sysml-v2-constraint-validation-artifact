// Summarizes a run-bench.sh output directory and copies its small result files into a new directory.
// usage: node summarize.mjs <run dir> <new result dir>
// Large regenerable inputs (model JSON, Turtle) are not copied; their sha256 values are listed instead.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [runDir, outDir] = process.argv.slice(2)
if (fs.existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`)
fs.mkdirSync(outDir, { recursive: true })
const rd = (f) => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const cmp = rd('compare.json').rows
const cases = rd('engine-cases.json')
const failed = []
const inputs = {}
for (const c of fs.readdirSync(runDir).filter((d) => /^n\d+-s\d+$/.test(d))) {
  const dir = path.join(runDir, c)
  fs.mkdirSync(path.join(outDir, c))
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (f.endsWith('.failed')) failed.push({ case: c, ...JSON.parse(fs.readFileSync(p, 'utf8')) })
    if (f.endsWith('.ttl') || f.endsWith('.json') && /^(model|post\d)\.json$/.test(f)) inputs[`${c}/${f}`] = { bytes: fs.statSync(p).size, sha256: sha(p) }
    else fs.copyFileSync(p, path.join(outDir, c, f))
  }
}
for (const f of ['catalog.json', 'rules.json', 'shapes.ttl', 'shapes-core.ttl', 'compare.json', 'engine-cases.json']) fs.copyFileSync(path.join(runDir, f), path.join(outDir, f))

// full validation: per size and engine, median over seeds of the per-seed medians
const groups = {}
for (const r of cmp) {
  if (r.error) continue
  const kind = r.file === 'data.ttl' ? 'full' : 'afterOneEdit'
  const k = `${r.n}|${r.engine}|${kind}`
  ;(groups[k] = groups[k] || []).push(r)
}
const rows = Object.entries(groups).map(([k, rs]) => {
  const [n, engine, kind] = k.split('|')
  return {
    n: Number(n),
    engine,
    version: rs[0].version,
    kind,
    comparedRuleClasses: rs[0].comparedRuleClasses,
    runs: rs.length,
    shaclValidateMsMedian: median(rs.map((r) => r.validateMs)),
    proposedMsMedian: median(rs.map((r) => (kind === 'full' ? r.engineValidateMs : r.incrementalStepMs))),
    ratioMedian: median(rs.map((r) => (kind === 'full' ? r.ratio : r.ratioVsIncrementalStep))),
    ratioMin: Math.min(...rs.map((r) => (kind === 'full' ? r.ratio : r.ratioVsIncrementalStep))),
    ratioMax: Math.max(...rs.map((r) => (kind === 'full' ? r.ratio : r.ratioVsIncrementalStep))),
    expectedViolations: rs.reduce((s, r) => s + r.expected, 0),
    shaclViolations: rs.reduce((s, r) => s + r.shacl, 0),
    engineOnly: rs.reduce((s, r) => s + r.engineOnly, 0),
    shaclOnly: rs.reduce((s, r) => s + r.shaclOnly, 0),
    unknownShapes: rs.reduce((s, r) => s + r.unknownShapes, 0),
    parseMsMedian: median(rs.map((r) => r.parseMs)),
  }
}).sort((a, b) => a.kind.localeCompare(b.kind) || a.n - b.n || a.engine.localeCompare(b.engine))

const engineRows = []
for (const n of [...new Set(cases.cases.map((c) => c.n))]) {
  const cs = cases.cases.filter((c) => c.n === n)
  engineRows.push({
    n,
    nodes: median(cs.map((c) => c.nodes)),
    edges: median(cs.map((c) => c.edges)),
    violations: cs.map((c) => c.violations),
    engineFullMsMedian: median(cs.map((c) => c.engine.validateMs)),
    engineCoreSubsetMsMedian: median(cs.map((c) => c.engine.validateCoreMs)),
    referenceMsMedian: cs.every((c) => typeof c.reference === 'object') ? median(cs.map((c) => c.reference.medianMs)) : null,
    referenceEqualsEngine: cs.every((c) => typeof c.reference !== 'object' || c.reference.equal),
    incrementalStepMsMedian: median(cs.map((c) => c.incremental.stepMedianMs)),
    incrementalEqualsBatchAfterEdit: cs.every((c) => c.post.every((p) => p.batchEqual)),
  })
}
const summary = {
  experiment: 'N2 same-runtime and JVM SHACL baselines on the same Turtle data and shapes',
  method: 'aerospace catalog; generated models (seeds 1000-1002) with max(20, 0.02 n) random edits (X3 (a) vocabulary) as defects; ' +
    'one Turtle encoding (oracle-py/rdf_export) and one shapes graph (oracle-py/shapes.translate) for every engine; ' +
    'SHACL Core engines (rdf-validate-shacl, shacl-engine without SPARQL plugin) get the shapes without sh:sparql (VIEW, ACYC, TRACE removed) and are compared with the engine on the same rule subset; ' +
    'times are validation only (parsing and shape compilation excluded), warm-up runs then the median of repeated runs on the same in-memory data; ' +
    'afterOneEdit: SHACL full re-validation of the post-edit graph vs the proposed incremental step (strategy 3) for the same edit; runs were sequential (one process at a time)',
  machine: cases.machine,
  engine: engineRows,
  rows,
  failedRuns: failed,
  inputs,
}
fs.writeFileSync(path.join(outDir, 'n2-summary.json'), JSON.stringify(summary, null, 1))
console.log(JSON.stringify({ engine: engineRows, rows: rows.map((r) => [r.kind, r.n, r.engine, Math.round(r.shaclValidateMsMedian), r.proposedMsMedian, Math.round(r.ratioMedian), r.engineOnly, r.shaclOnly]) }, null, 0))
