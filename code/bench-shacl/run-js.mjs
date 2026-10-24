// Same-runtime (Node.js / V8) SHACL baselines for round-2 review item N2.
//
// usage: node run-js.mjs <shacl-engine|rdf-validate-shacl> <shapes.ttl> <data.ttl> <out.json> [--reps N] [--warmup W]
//
// Parsing (N3.js) and validator construction are timed separately from validation. Validation is run
// W times untimed (warm-up) and N times timed on the same parsed dataset; the median is reported.
// Raw results (focus node, source shape, value) are written for the comparison step.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import N3 from 'n3'
import rdf from 'rdf-ext'
import zazuko from '@zazuko/env'
import SHACLValidator from 'rdf-validate-shacl'
import { Validator } from 'shacl-engine'
import { validations as sparqlValidations } from 'shacl-engine/sparql.js'

const require = createRequire(import.meta.url)
const [engine, shapesF, dataF, outF, ...rest] = process.argv.slice(2)
const opt = (n, d) => (rest.includes(n) ? Number(rest[rest.indexOf(n) + 1]) : d)
const reps = opt('--reps', 5)
const warmup = opt('--warmup', 1)

function parse (file) {
  const ds = rdf.dataset()
  const quads = new N3.Parser({ format: 'text/turtle' }).parse(fs.readFileSync(file, 'utf8'))
  for (const q of quads) ds.add(q)
  return ds
}

function now () { return Number(process.hrtime.bigint()) / 1e6 }

function median (xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const out = { engine, file: dataF.split(/[\\/]/).pop() }
try {
  let t0 = now()
  const shapes = parse(shapesF)
  const data = parse(dataF)
  out.parseMs = now() - t0
  out.dataQuads = data.size
  let run
  t0 = now()
  if (engine === 'shacl-engine' || engine === 'shacl-engine-core') {
    out.version = require('shacl-engine/package.json').version
    // shacl-engine-core: without the SPARQL plugin, sh:sparql constraints are not evaluated (Core subset)
    out.supportsSparql = engine === 'shacl-engine'
    const v = new Validator(shapes, out.supportsSparql ? { factory: rdf, validations: sparqlValidations } : { factory: rdf })
    run = async () => v.validate({ dataset: data })
  } else if (engine === 'rdf-validate-shacl') {
    out.version = require('rdf-validate-shacl/package.json').version
    out.supportsSparql = false // README: SHACL-SPARQL constraints are not supported
    const v = new SHACLValidator(shapes, { factory: zazuko })
    run = async () => v.validate(data)
  } else throw new Error('unknown engine ' + engine)
  out.prepareMs = now() - t0
  for (let i = 0; i < warmup; i++) await run()
  const samples = []
  let report
  for (let i = 0; i < reps; i++) {
    t0 = now()
    report = await run()
    samples.push(now() - t0)
  }
  out.warmup = warmup
  out.validateSamplesMs = samples
  out.validateMs = median(samples)
  out.conforms = report.conforms
  out.results = report.results.map((r) => ({
    focus: r.focusNode?.value ?? r.focusNode?.term?.value,
    shape: r.sourceShape?.value ?? r.shape?.ptr?.term?.value,
    value: (r.value?.value ?? r.value?.term?.value) ?? null
  }))
} catch (e) {
  out.error = String(e && e.stack ? e.stack : e)
}
fs.writeFileSync(outF, JSON.stringify(out))
console.log(`${engine} ${out.file}: ${out.error ? 'ERROR ' + out.error.split('\n')[0] : `validate ${out.validateMs.toFixed(1)} ms, ${out.results.length} results, parse ${out.parseMs.toFixed(0)} ms`}`)
