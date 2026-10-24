import json, time, collections, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sql_validator import run_all

base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
d = json.load(open(os.path.join(base, "inputs", "batch-blind.json"), encoding="utf8"))
t = time.time()
res = run_all(d["batches"])
el = time.time() - t
os.makedirs(os.path.join(base, "out"), exist_ok=True)
json.dump(res, open(os.path.join(base, "out", "violations-blind.json"), "w", encoding="utf8"), ensure_ascii=False)
c = collections.Counter(v["cls"] for vs in res.values() for v in vs)
json.dump({"models": len(res), "batches": len(d["batches"]), "violationsTotal": sum(c.values()),
           "perClass": dict(c), "seconds": round(el, 2), "python": sys.version.split()[0],
           "engine": "sqlite3 in-memory + WITH RECURSIVE"},
          open(os.path.join(base, "out", "run-info.json"), "w"), indent=1)
print(len(res), dict(c), el)
