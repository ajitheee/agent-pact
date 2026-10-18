# The output the poster received: the delivered query, run on this quarter's data. Reads the payload on stdin.
import json
import os
import random
import sys

here = os.path.dirname(os.path.abspath(__file__))
check = {}
with open(os.path.join(here, "verify.py"), encoding="utf-8") as f:
    exec(f.read(), check)  # reuse the check's data generator and its read-only, time-boxed runner

sql = json.loads(sys.stdin.read())["sql"]
data = check["make_data"](random.Random(2026), orders=900)  # this quarter's snapshot
rows = check["run_query"](check["load"](data), sql)
print("Q3 2026 net revenue by region (paid orders, refunds subtracted):")
for region, cents in rows:
    print(f"  {region:<6} {check['dollars'](cents):>14}")
print(f"  {'total':<6} {check['dollars'](sum(c for _, c in rows)):>14}   from {len(data['orders'])} orders, {len(data['refunds'])} refunds")
print("The query, ready for the dashboard:")
for line in sql.splitlines()[:6]:
    print("  " + line)
if len(sql.splitlines()) > 6:
    print(f"  ... {len(sql.splitlines()) - 6} more lines")
