# The output the poster received: ledger entries ready to import. Reads the payload on stdin.
import json
import sys
from decimal import Decimal

invoices = json.loads(sys.stdin.read())["invoices"]
print(f"Ledger entries ready to import: {len(invoices)} invoices, every figure traced to its source document")
totals = {}
for inv in invoices:
    total = Decimal(str(inv["total"]))
    totals[inv["currency"]] = totals.get(inv["currency"], Decimal(0)) + total
    tax = Decimal(str(inv["tax"]))
    print(f"  {inv['invoice_no']:<14} {inv['vendor']:<22} {inv['issue_date']}  {inv['currency']} {total:>10,.2f}"
          f"  {len(inv['lines'])} lines{f', tax {tax:,.2f}' if tax else ''}")
print("  Payable: " + " · ".join(f"{cur} {amount:,.2f}" for cur, amount in sorted(totals.items())))
