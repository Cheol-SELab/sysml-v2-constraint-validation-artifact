"""Runs the UNMODIFIED blind SQL oracle (codes/oracle-blind/sql_oracle/sql_validator.py) on an
arbitrary input file of the same schema as oracle-blind/inputs/batch-blind.json.

usage: python -B run_blind_on.py <oracle-blind dir> <input.json> <output.json>

The blind code is imported read-only (sys.path); nothing in oracle-blind/ is written.
Used for the n20 three-way comparison (cli-blind.ts) to evaluate the blind oracle on a
sanitized variant of the input (dangling edges removed), which isolates the dangling-edge
convention from the other interpretation differences.
"""
import hashlib
import json
import os
import sys
import time

blind_dir, inp, outp = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(blind_dir, 'sql_oracle'))
from sql_validator import run_all  # noqa: E402

with open(inp, encoding='utf8') as f:
    d = json.load(f)
t = time.time()
res = run_all(d['batches'])
src = os.path.join(blind_dir, 'sql_oracle', 'sql_validator.py')
with open(outp, 'w', encoding='utf8') as f:
    json.dump({'violations': res, 'seconds': time.time() - t,
               'sqlValidatorSha256': hashlib.sha256(open(src, 'rb').read()).hexdigest()}, f)
