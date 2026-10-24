SysML v2 Catalog-Based Constraint Validation -- Research Artifact
================================================================

Code and retained data for:
Catalog-Based Constraint Validation of SysML v2 Structural Models:
Correctness and the Limits of Incremental Revalidation

Authors: Cheol Young Park, Shou Matsumoto, Hong Seok Park, Joongyoon Lee
Contact: cheol@selab.ai
Repository: https://github.com/Cheol-SELab/sysml-v2-constraint-validation-artifact

This is a research prototype and evidence archive. Integrity checks, bounded
simulation checks and implementation agreement do not establish complete SysML
conformance, engineering-defect precision, safety certification or production
assurance. Independent human evaluation remains pending. Historical CLI labels
such as "proof mechanization" denote bounded checks, not machine-checked proofs
of the unbounded theorems; these labels are retained for source identity.

Contents
--------
code/                 Validator, SHACL tools, Python oracle, dependency locks,
                      examples, corpus retrieval and reproduction drivers.
oracle-blind/         Separately instructed SQL implementation, frozen inputs,
                      interpretation and instruction-level isolation record.
data/                 Retained result sessions and logs, byte-identical to the
                      reviewed attachment. Diagnostic/failed runs are included;
                      their presence does not make them manuscript evidence.
ieee-access/          Claim/table evidence indexes and standalone record audits.
SOURCE-IDENTITIES.json Historical snapshot vs supplemental-source identities.
PUBLICATION.json      Selection provenance and source attachment hash.
PUBLIC-MANIFEST.json  SHA-256 inventory of the public artifact.
REPRODUCTION.txt      Dependencies, preparation order and execution limitations.
RIGHTS.txt            Rights and third-party source information.

Start here (Python 3.11+, no experimental execution)
--------------------------------------------------
  python -B verify_public.py
  python -B ieee-access/check_reproduction.py
  python -B ieee-access/audit_example.py
  python -B ieee-access/audit_shacl.py

Run integrity checks before installing dependencies or generating outputs.
The .git directory is ignored; other unexpected files are reported.
The record audits reconstruct stored example JSON and N2 aggregation, not new
measurements. For compilation, use a separate fresh working copy:
  cd code
  npm ci --ignore-scripts
  npm run build
  node node_modules/typescript/bin/tsc -p tsconfig.r8.json

npm test invokes the E1 experimental driver, not a lightweight publication check.
Follow REPRODUCTION.txt before intentionally executing experiments. Never write
new runs into data/. The historical driver writes code/results-v4; use a fresh
working copy for each attempt and inspect every child exit/log.

Evidence boundaries
-------------------
Use ieee-access/claims-evidence.csv and table-evidence-index.csv to select evidence.
The main 85-source snapshot is unchanged. Supplemental sources are identified
separately, not retroactively assigned to historical runs. The N2 timing session
(data/results-v3/n2-shacl-bench) is separate from the main snapshot and later
engine reruns; do not pool them. Original Jena runtime identity is <development>;
exact original binary reconstruction is not established. SQL oracle separation
was instruction-level, not an OS sandbox or independent human interpretation.
Source normalization lacks an independent semantic-preservation oracle. Corpus
diagnostic labels are mechanical classifications, not expert-confirmed defects.

The upstream SysML corpus is fetched separately by code/tools/fetch-corpus.py;
commits, file hashes and license are in code/corpus-manifest.json. Historical
logs retain diagnostic local execution paths. Author photos, manuscript PDFs,
typesetting fonts and editorial review correspondence are not included here.
