# scenario: orders
import csv
import io
from decimal import Decimal

# The same 10 orders as the task. The check recomputes every total from them, exactly, in whole cents.
ORDERS_CSV = """order_id,customer,item,qty,unit_price_usd
A-1001,Northwind,USB-C cable,3,8.99
A-1002,Contoso,Laptop stand,1,49.50
A-1003,Fabrikam,Mechanical keyboard,2,89.90
A-1004,Northwind,Webcam,4,34.95
A-1005,Litware,Monitor arm,1,64.99
A-1006,Contoso,HDMI adapter,5,12.10
A-1007,Adatum,Desk mat,3,19.99
A-1008,Fabrikam,Wireless mouse,6,24.45
A-1009,Litware,Docking station,1,149.00
A-1010,Adatum,Headset,2,57.35"""


def expected():
    rows = csv.DictReader(io.StringIO(ORDERS_CSV))
    return {r["order_id"]: (r["customer"], int(Decimal(r["unit_price_usd"]) * 100) * int(r["qty"])) for r in rows}


def verify(payload):
    assert isinstance(payload, dict) and isinstance(payload.get("orders"), list), 'deliver {"orders": [...], "revenue_cents": <integer>}'
    want = expected()
    seen = set()
    for i, order in enumerate(payload["orders"]):
        assert isinstance(order, dict), f"orders[{i}] must be an object"
        oid = order.get("order_id")
        assert oid in want, f"orders[{i}]: {oid!r} is not one of the input orders"
        assert oid not in seen, f"{oid} appears twice"
        seen.add(oid)
        customer, cents = want[oid]
        assert order.get("customer") == customer, f"{oid}: customer should be {customer!r}, got {order.get('customer')!r}"
        total = order.get("total_cents")
        assert type(total) is int, f"{oid}: total_cents must be a whole number of cents, got {total!r}"
        assert total == cents, f"{oid}: total_cents is {total}, expected {cents}"
    missing = sorted(set(want) - seen)
    assert not missing, f"missing orders: {', '.join(missing)}"
    revenue = sum(cents for _, cents in want.values())
    got = payload.get("revenue_cents")
    assert type(got) is int and got == revenue, f"revenue_cents is {got!r}, expected {revenue}"
    return True
