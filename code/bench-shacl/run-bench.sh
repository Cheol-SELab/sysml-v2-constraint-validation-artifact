#!/usr/bin/env bash
# Round-2 review item N2: runs every SHACL engine on the same Turtle data and shapes, sequentially
# (one process at a time, no concurrent heavy work), then compares detections with the engine.
#
# usage: [REFMAX=1000] bash bench-shacl/run-bench.sh <new output dir> [sizes]   (from the project root)
#   REFMAX: largest n for the reference implementation (full grounding, no indices; super-linear)
#   prerequisites: npx tsc -p tsconfig.review2.json; (cd bench-shacl && npm ci); (cd bench-shacl/jena && mvn -q package)
set -u
OUT="$1"
SIZES="${2:-1000,10000,100000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/oracle-py/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$ROOT/oracle-py/.venv/bin/python"
JAR="$ROOT/bench-shacl/jena/target/bench-jena-shacl.jar"
TO=5400   # per-run limit (s); a run that exceeds it is recorded as a timeout
log() { echo "[$(date +%H:%M:%S)] $*"; }

node "$ROOT/dist-review2/cli-bench-shacl.js" gen --out "$OUT" --sizes "$SIZES" --reference-max "${REFMAX:-1000}" || exit 1
first=1
for d in "$OUT"/n*-s*; do
  for m in model post0 post1 post2; do
    f=data; [ "$m" != model ] && f="data-$m"
    if [ $first = 1 ]; then
      (cd "$ROOT/oracle-py" && "$PY" -B export_ttl.py "$OUT/catalog.json" "$d/$m.json" "$d/$f.ttl" --shapes "$OUT/shapes.ttl" --rules "$OUT/rules.json" --shapes-core "$OUT/shapes-core.ttl") || exit 1
      first=0
    else
      (cd "$ROOT/oracle-py" && "$PY" -B export_ttl.py "$OUT/catalog.json" "$d/$m.json" "$d/$f.ttl") || exit 1
    fi
  done
done

run() { # name outfile cmd...
  local name="$1" of="$2"; shift 2
  log "$name"
  timeout $TO "$@"
  local rc=$?
  if [ $rc -ne 0 ] && [ ! -s "$of" ]; then echo "{\"engine\":\"$name\",\"file\":\"$(basename "$of")\",\"error\":\"exit $rc (timeout ${TO}s if 124)\"}" > "$of.failed"; fi
}

for d in "$OUT"/n*-s*; do
  n=$(basename "$d" | sed -E 's/^n([0-9]+)-.*/\1/')
  if [ "$n" -ge 100000 ]; then R=3; FILES="data data-post0"; else R=5; FILES="data data-post0 data-post1 data-post2"; fi
  for f in $FILES; do
    if [ "$f" = data ]; then r=$R; elif [ "$n" -ge 100000 ]; then r=1; else r=3; fi
    run jena "$d/shacl-jena-$f.json" java -Xmx12g -jar "$JAR" "$OUT/shapes.ttl" "$d/$f.ttl" "$d/shacl-jena-$f.json" $r 2
    run shacl-engine-core "$d/shacl-shacl-engine-core-$f.json" node --max-old-space-size=12288 "$ROOT/bench-shacl/run-js.mjs" shacl-engine-core "$OUT/shapes-core.ttl" "$d/$f.ttl" "$d/shacl-shacl-engine-core-$f.json" --reps $r --warmup 1
    run rdf-validate-shacl "$d/shacl-rdf-validate-shacl-$f.json" node --max-old-space-size=12288 "$ROOT/bench-shacl/run-js.mjs" rdf-validate-shacl "$OUT/shapes-core.ttl" "$d/$f.ttl" "$d/shacl-rdf-validate-shacl-$f.json" --reps $r --warmup 1
    # full SHACL-SPARQL in Node.js (Comunica per focus node) and pySHACL are orders of magnitude slower:
    # fewer repetitions, and only up to 10^4 nodes (10^3 for the post-edit re-validations)
    if [ "$n" -le 1000 ] || { [ "$n" -le 10000 ] && [ "$f" = data ]; }; then
      if [ "$n" -le 1000 ]; then rr=3; ww=1; else rr=1; ww=0; fi
      run shacl-engine "$d/shacl-shacl-engine-$f.json" node --max-old-space-size=12288 "$ROOT/bench-shacl/run-js.mjs" shacl-engine "$OUT/shapes.ttl" "$d/$f.ttl" "$d/shacl-shacl-engine-$f.json" --reps $rr --warmup $ww
      run pyshacl "$d/shacl-pyshacl-$f.json" bash -c "cd '$ROOT/oracle-py' && '$PY' -B time_pyshacl.py '$OUT/shapes.ttl' '$d/$f.ttl' '$d/shacl-pyshacl-$f.json' --reps $rr --warmup $ww"
    fi
  done
done
node "$ROOT/dist-review2/cli-bench-shacl.js" compare --out "$OUT"
log done
