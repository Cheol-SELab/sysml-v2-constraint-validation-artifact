# selab-metamodel-validator

Prototype for the paper *SysML v2 모델의 메타모델 기반 의미 검증 기법*
(`2026/papers/SysML-Metamodel-Semantic-Validation`).

The prototype is a research artifact, not a product. Its purpose is to (a) mechanize the
theorems of section 4.7 and (b) run the deterministic simulation experiments E1-E7 of
section 6 without human subjects.

## Design

```
src/model/            typed attributed graph, normalization, k-hop neighbourhoods
src/catalog/          catalog -> rule set derivation (L_C), canonical violation identity
src/reference/        Omega*: unoptimized, independent implementation of the semantics
src/validator/        Algorithm 1: index-guided local rules, BatchGlobal for global rules
src/witness/          Tarjan SCC, acyclic witness store, traceability witness forest
src/incremental/      three incremental strategies compared in E5
src/generator/        clean-model generator (Lemma 1 invariants), Theorem 5 families
src/injector/         defect construction, scope analysis, non-interference scheduler
src/evaluation/       catalog-independent baselines, metrics, non-parametric statistics
src/verification/     bounded exhaustive checker, property-based tests
src/experiments/      E1-E7
```

Two independent evaluators exist on purpose:

- `src/reference/referenceSemantics.ts` computes `Omega*` straight from the definition
  (full grounding enumeration, reachability by repeated edge scans, no indices);
- `src/validator/engine.ts` is the implementation whose claims are under test.

Theorem 1 is checked by comparing them; without the first module the check would be
circular.

## Build and run

```powershell
npm ci
npm run build
npm test              # E1 into a fresh temporary directory; exits 1 on any counterexample

node dist/cli.js e1   # proof mechanization: bounded exhaustive + property based
node dist/cli.js e2   # generator and clean model integrity (Lemma 1)
node dist/cli.js e3e4 # defect injection under the exact oracle, baseline separation
node dist/cli.js e5   # incremental correctness, Theorem 5 families, speedup
node dist/cli.js e6   # complexity prediction test (Theorem 3)
node dist/cli.js e7   # public model calibration
node dist/cli.js example # worked example: the five procedure stages on one model
node dist/cli.js all  # everything
```

Result files are created exclusively, so the stored raw results in `results/` are never
overwritten. Without `--output`, a run whose result files already exist in `results/` is
written to a fresh `runs/<timestamp>-<suffix>/` directory (git-ignored) and the path is
printed. `--output <dir>` writes to that directory and refuses, before running any
experiment, when it already holds a target file. `--temp-output` writes to a fresh
temporary directory; `npm test` uses it.

All experiments are pure functions of fixed seeds, so every reported number except
wall-clock timings is reproduced exactly. Timings use one warm-up run followed by the
median of five repetitions. E1 takes about five minutes; `all` about fourteen.

## Results

`results/*.json` holds the raw output consumed by the paper:

| file | content |
|---|---|
| `e1-proof-mechanization.json` | enumerated graph count, check counts, counterexamples |
| `e2-generator-integrity.json` | per catalog and size: clean-model count, reference cross-check |
| `e3-detection-accuracy.json` | per defect type: instances, TP/FP/FN, precision/recall/F1 |
| `e3-raw-records.json` | one record per injected defect (expected keys, baseline detection) |
| `e4-expressiveness-separation.json` | baseline comparison, additional detection rate, catalog swap |
| `e5-incremental.json` | step-wise correctness, counterexample families, speedup |
| `e6-complexity.json` | runtime per size and the fitted exponent with bootstrap CI |
| `e7-external-validity.json` | public model statistics, calibration, KS distances |
| `worked-example.json` | per-stage artifacts of the worked example in section 4.5 of the paper |

## Scope and limitations

- The model exchange format is a SysML v2-like typed graph (JSON), not the OMG API. The
  normalization step is the only place that would change when connecting a real parser.
- Baselines A and B are reimplementations of the *catalog-independent* diagnostic class.
  They are not the OMG pilot implementation. Theorem 7 is what makes the comparison
  meaningful: no catalog-independent validator can detect the separated defect family,
  regardless of engineering quality.
- The SMT cross-check described in section 4.8 is not executed here because no solver is
  available in this environment; the bounded exhaustive check against the independent
  reference implementation is the executed substitute.
- Public models are manual transcriptions of the structural subset of public OMG examples,
  so the calibration sample is small and its statistics have low power.
