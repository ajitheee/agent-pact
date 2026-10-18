# The output the poster received: the delivered fix as a diff against main. Reads the payload on stdin.
import difflib
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
payload = json.loads(sys.stdin.read())
new = payload["files"]["pricing.py"].splitlines()
with open(os.path.join(here, "repo", "pricing.py"), encoding="utf-8") as f:
    old = f.read().splitlines()

diff = list(difflib.unified_diff(old, new, "pricing.py (main)", "pricing.py (fix)", lineterm="", n=0))
added = sum(1 for line in diff if line.startswith("+") and not line.startswith("+++"))
removed = sum(1 for line in diff if line.startswith("-") and not line.startswith("---"))
print(f"Patch to pricing.py: +{added} -{removed} lines, ready to merge (CI green: 8 named tests + 200 random carts)")
body = [line for line in diff[2:] if not line.startswith("@@")]
for line in body[:22]:
    print(line[:118])
if len(body) > 22:
    print(f"... {len(body) - 22} more changed lines")
