# Isolation record for the blind re-translation oracle

- Implementer: a separate LLM agent (Anthropic Claude Sonnet family), launched as an isolated sub-agent; not a human.
- Launched: 2026-10-22, after the spec excerpt and inputs below were frozen.
- Access rule given in the launch prompt (verbatim excerpt): "you may read files ONLY inside `oracle-blind/`. Do NOT read, list, grep or open anything else in the repository (in particular not the validator engine sources, the SHACL oracle, results, reviews, or the full manuscript). Do not search the web for this paper. If you are unsure about a definition, decide from the spec text and record the decision."
- Inputs available to the implementer:
  - `spec/definitions-sec2-sec4_2.tex`: manuscript excerpt (problem definition and Sections 4.1-4.2) as of 2026-10-22. This excerpt predates the generalisation of node typing to type sets; it defines a single type per node.
  - `spec/input-schema.ts`: data-only interface declarations for models and catalogs.
  - `inputs/batch-blind.json`: 23 batches, 2,900 models (3 domain catalogs x 300 models, 20 random catalogs x 100 models).
- Paradigm required: Python standard library only, relational encoding in sqlite3 with SQL / WITH RECURSIVE.
- Outputs: `sql_oracle/`, `out/violations-blind.json`, `out/run-info.json`, `INTERPRETATION.md` (21 recorded ambiguities).
- Limitation: tool-level access was governed by the launch instruction; there is no OS-level sandbox log proving no other file was read.
