#!/usr/bin/env bash
# R8 (round-2 review, item 8): every manuscript experiment re-run from ONE code snapshot.
#
# usage (from the project root, Git Bash):
#   bash tools/run-r8-final.sh correctness   # non-timing jobs, at most 4 heavy jobs at a time
#   bash tools/run-r8-final.sh timing        # timing jobs, strictly one at a time, nothing else running
#
# Prerequisite: npx tsc -p tsconfig.r8.json (dist-r8), results-v4/snapshot/ written by
# tools/snapshot-r8.js. Every job writes into a new directory under results-v4/ and logs to
# results-v4/logs/<job>.log; the exit code is appended to the log and to results-v4/logs/exit-codes.txt.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd -W)"
cd "$ROOT"
OUT="$ROOT/results-v4"
LOG="$OUT/logs"
mkdir -p "$LOG"
PY="$ROOT/oracle-py/.venv/Scripts/python.exe"
TSC="$ROOT/node_modules/typescript/lib/tsc.js"
BLIND="$ROOT/../oracle-blind"
TAGS="$ROOT/corpus-history/tags"
export ORACLE_DIR="$ROOT/oracle-py"

job() { # name cmd...
  local name="$1"; shift
  echo "[$(date '+%F %T')] start $name: $*" >> "$LOG/$name.log"
  local t0=$(date +%s)
  "$@" >> "$LOG/$name.log" 2>&1
  local rc=$?
  local t1=$(date +%s)
  echo "[$(date '+%F %T')] end $name rc=$rc elapsed=$((t1 - t0))s" >> "$LOG/$name.log"
  echo "$name rc=$rc elapsed=$((t1 - t0))s" >> "$LOG/exit-codes.txt"
}

slots() { # wait until fewer than $1 background jobs run
  while [ "$(jobs -rp | wc -l)" -ge "$1" ]; do sleep 5; done
}

correctness() {
  echo "cpu load / processes at start:" > "$LOG/correctness-host.txt"
  (tasklist 2>/dev/null | sort -k5 -n -r | head -15) >> "$LOG/correctness-host.txt" 2>&1
  # longest first
  slots 4; job oracle-e3 node --max-old-space-size=16000 dist-r8/cli-oracle.js e3 --out "$OUT/oracle" --work "$OUT/work/oracle-e3" &
  slots 4; job oracle-e2 node --max-old-space-size=16000 dist-r8/cli-oracle.js e2 --out "$OUT/oracle-e2" --work "$OUT/work/oracle-e2" &
  slots 4; job e3 node --max-old-space-size=16000 dist-r8/cli-v2.js e3 --output "$OUT/e3" &
  slots 4; job mutation env MUT_ROOT="$OUT/snapshot/tree" MUT_TS_ROOT="$ROOT" node --max-old-space-size=16000 dist-r8/cli-v2.js mutation --output "$OUT/mutation" &
  slots 4; job oracle-random node --max-old-space-size=16000 dist-r8/cli-oracle.js random --out "$OUT/oracle-random" --work "$OUT/work/oracle-random" &
  slots 4; job spec-x3 node --max-old-space-size=16000 dist-r8/cli-spec-oracle.js x3 --out "$OUT/n1-spec-oracle-x3" &
  slots 4; job e1 node --max-old-space-size=24000 dist-r8/cli-v2.js e1 --output "$OUT/e1" &
  slots 4; job e3sched node --max-old-space-size=16000 dist-r8/cli-v2.js e3sched --output "$OUT/e3sched" &
  slots 4; job shared-mutants "$PY" -B oracle-py/shared_code_mutants.py "$OUT/snapshot/tree" "$OUT/work/mutants" "$OUT/oracle-shared-code-mutants" "$TSC" &
  slots 4; job oracle-variants node dist-r8/cli-oracle.js variants --out "$OUT/oracle-variants" --work "$OUT/work/oracle-variants" &
  slots 4; job spec-corpus node --max-old-space-size=16000 dist-r8/cli-spec-oracle.js corpus --out "$OUT/n1-spec-oracle-corpus" &
  slots 4; job blind node dist-r8/cli-blind.js --blind "$BLIND" --out "$OUT/n20-blind" --work "$OUT/work/blind" &
  slots 4; job oracle-sysml node dist-r8/cli-oracle.js sysml --out "$OUT/oracle-sysml" --work "$OUT/work/oracle-sysml" &
  slots 4; job oracle-small bash -c "node dist-r8/cli-oracle.js independence --out '$OUT/oracle-small' --work '$OUT/work/oracle-small' && node dist-r8/cli-oracle.js shapes --out '$OUT/oracle-small' --work '$OUT/work/oracle-small' && node dist-r8/cli-oracle.js e7 --out '$OUT/oracle-small' --work '$OUT/work/oracle-small'" &
  slots 4; job r5 bash -c "node dist-r8/cli.js e2 --output '$OUT/r5-e2' && node dist-r8/cli.js e3e4 --output '$OUT/r5-e3e4' && node dist-r8/cli.js example --output '$OUT/r5-example'" &
  slots 4; job r8-light bash -c "node dist-r8/cli-r8.js tests --out '$OUT/r8' && node dist-r8/cli-r8.js wex --out '$OUT/r8' && node dist-r8/cli-r8.js csr-eq --out '$OUT/r8' && node dist-r8/cli-r8.js wf2 --out '$OUT/r8' && node dist-r8/cli-blind.js probes --blind '$BLIND' --out '$OUT/n20-blind-probes' --work '$OUT/work/probes' && cd oracle-py && '$PY' -B -m unittest test_oracle.py" &
  slots 4; job shared-mutants-e2 "$PY" -B oracle-py/shared_code_mutants.py "$OUT/snapshot/tree" "$OUT/work/mutants-e2" "$OUT/oracle-shared-code-mutants-e2" "$TSC" --e2-only &
  slots 4; job sysml-legacy-expose env S1_EXPOSE_LEGACY=1 node --max-old-space-size=16000 dist-r8/cli-sysml.js run --output "$OUT/sysml-legacy-expose" &
  wait
  echo "correctness done $(date '+%F %T')" >> "$LOG/exit-codes.txt"
}

# timing job: pinned to one P core (logical CPU 2) with AboveNormal priority (as in E5/E6 v2);
# nothing else of this script runs at the same time. usage: tjob name [VAR=value ...] exe args...
tjob() {
  local name="$1"; shift
  local envs=()
  while [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  local exe="$1"; shift
  echo "[$(date '+%F %T')] start $name: ${envs[*]} $exe $*" >> "$LOG/$name.log"
  local t0=$(date +%s)
  env "${envs[@]}" powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/tools/pin.ps1" 4 AboveNormal "$(cygpath -w "$LOG/$name.log")" "$exe" "$*"
  local rc=$?
  local t1=$(date +%s)
  echo "[$(date '+%F %T')] end $name rc=$rc elapsed=$((t1 - t0))s" >> "$LOG/$name.log"
  echo "$name rc=$rc elapsed=$((t1 - t0))s" >> "$LOG/exit-codes.txt"
}

timing() {
  (tasklist 2>/dev/null | sort -k5 -n -r | head -15) > "$LOG/timing-host.txt" 2>&1
  tjob e6 node --expose-gc --max-old-space-size=24000 dist-r8/cli-v2.js e6 --output "$OUT/e6"
  tjob e6order node --expose-gc --max-old-space-size=24000 dist-r8/cli-v2.js e6order --output "$OUT/e6order"
  tjob e6csr node --expose-gc --max-old-space-size=24000 dist-r8/cli-r8.js e6csr --out "$OUT/n13"
  tjob gcdiag node --expose-gc --max-old-space-size=24000 dist-r8/cli-r8.js gcdiag --out "$OUT/n13"
  tjob e5hist node --max-old-space-size=16000 dist-r8/cli-r8.js e5hist --tags "$TAGS" --out "$OUT/n14"
  tjob e5-partA R1_TAG=partA E5_SIZES=500,1000,5000 E5_SKIP_LARGE=1 node --max-old-space-size=16000 dist-r8/cli-v2.js e5 --output "$OUT/e5"
  tjob e5-partB R1_TAG=partB E5_SIZES=20000 E5_SEEDS=5 E5_SKIP_LARGE=1 node --max-old-space-size=16000 dist-r8/cli-v2.js e5 --output "$OUT/e5"
  tjob e5-partC R1_TAG=partC E5_ONLY_LARGE=1 E5_LARGE_SEEDS=5 node --max-old-space-size=24000 dist-r8/cli-v2.js e5 --output "$OUT/e5"
  tjob oracle-scale ORACLE_DIR="$ROOT/oracle-py" node dist-r8/cli-oracle.js scale --out "$OUT/oracle-scale" --work "$OUT/work/oracle-scale"
  tjob sysml node --max-old-space-size=16000 dist-r8/cli-sysml.js run --output "$OUT/sysml"
  tjob n2-engine node --max-old-space-size=24000 dist-r8/cli-bench-shacl.js gen --out "$OUT/n2-engine-rerun" --sizes 1000,10000,100000 --reference-max 1000
  echo "timing done $(date '+%F %T')" >> "$LOG/exit-codes.txt"
}

case "${1:-}" in
  correctness) correctness ;;
  timing) timing ;;
  *) echo "usage: bash tools/run-r8-final.sh correctness|timing"; exit 2 ;;
esac
