# scenario: sql-report
# Runs the delivered query on 3 databases generated now (random customers, orders, lines and refunds, with
# orders on both sides of every quarter boundary) and compares each result with the right answer. A query
# that runs fine but returns the wrong number fails, and the reason names the mistake when it is a known one.
import random
import sqlite3
import time

REGIONS = ("NA", "EMEA", "APAC")
Q3_START, Q3_END = "2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"
DDL = (
    "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT)",
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, placed_at TEXT)",
    "CREATE TABLE order_lines (order_id INTEGER, sku TEXT, qty INTEGER, unit_cents INTEGER)",
    "CREATE TABLE refunds (id INTEGER PRIMARY KEY, order_id INTEGER, amount_cents INTEGER, issued_at TEXT)",
)
# Edge timestamps: the last second of Q2, the first and last seconds of Q3, the first second of Q4.
EDGES = ("2026-06-30T23:59:59Z", "2026-07-01T00:00:00Z", "2026-09-30T23:59:59Z", "2026-10-01T00:00:00Z")


def make_data(rng, orders=220):
    customers = [(i, f"Customer {i}", rng.choice(REGIONS)) for i in range(1, 41)]
    rows, lines, refunds = [], [], []
    for oid in range(1, orders + 1):
        if oid <= len(EDGES) * 3:
            placed = EDGES[oid % len(EDGES)]
        else:
            month = rng.choice((5, 6, 7, 7, 8, 8, 9, 9, 10, 11))
            placed = f"2026-{month:02d}-{rng.randint(1, 30 if month in (6, 9, 11) else 31):02d}T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:00Z"
        status = rng.choices(("paid", "pending", "cancelled"), (7, 2, 1))[0]
        rows.append((oid, rng.randint(1, len(customers)), status, placed))
        for _ in range(rng.randint(1, 4)):
            lines.append((oid, f"SKU-{rng.randint(100, 999)}", rng.randint(1, 6), rng.randint(500, 40000)))
        if rng.random() < 0.3:  # some orders get one or two refunds
            for _ in range(rng.randint(1, 2)):
                refunds.append((len(refunds) + 1, oid, rng.randint(300, 9000), placed))
    return {"customers": customers, "orders": rows, "order_lines": lines, "refunds": refunds}


def load(data):
    db = sqlite3.connect(":memory:")
    for statement in DDL:
        db.execute(statement)
    for table, values in data.items():
        db.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' * len(values[0]))})", values)
    return db


def net_revenue(data, statuses=("paid",), end=Q3_END, refunds=True, fanout=False):
    """The right answer, or a known wrong one: refunds ignored, the quarter cut short, every status, or a JOIN fan-out."""
    region = {c[0]: c[2] for c in data["customers"]}
    by_order = {}
    for oid, _sku, qty, unit in data["order_lines"]:
        total, n = by_order.get(oid, (0, 0))
        by_order[oid] = (total + qty * unit, n + 1)
    refunded = {}
    for _id, oid, amount, _at in data["refunds"]:
        total, n = refunded.get(oid, (0, 0))
        refunded[oid] = (total + amount, n + 1)
    result = {}
    for oid, cid, status, placed in data["orders"]:
        if status not in statuses or not (Q3_START <= placed < end):
            continue
        gross, n_lines = by_order[oid]
        back, n_refunds = refunded.get(oid, (0, 0)) if refunds else (0, 0)
        if fanout:  # lines joined to refunds: each line repeats per refund, each refund per line
            gross, back = gross * max(1, n_refunds), back * n_lines
        result[region[cid]] = result.get(region[cid], 0) + gross - back
    return result


MISTAKES = {
    "refunds and line items multiplied together by joining both to orders (JOIN fan-out)": {"fanout": True},
    "refunds not subtracted": {"refunds": False},
    "orders placed on September 30 left out (the quarter was cut short)": {"end": "2026-09-30T00:00:00Z"},
    "pending and cancelled orders counted as revenue": {"statuses": ("paid", "pending", "cancelled")},
}


def run_query(db, sql):
    """Read-only, time-boxed: no writes, no ATTACH, no PRAGMA."""
    allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, getattr(sqlite3, "SQLITE_RECURSIVE", 33)}
    db.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
    stop = time.monotonic() + 1.5
    db.set_progress_handler(lambda: 1 if time.monotonic() > stop else 0, 20000)
    try:
        return db.execute(sql).fetchall()
    except sqlite3.Error as exc:
        raise AssertionError(f"the query fails: {exc}") from None


def dollars(cents):
    return f"${cents / 100:,.2f}"


def verify(payload):
    sql = payload.get("sql") if isinstance(payload, dict) else None
    assert isinstance(sql, str) and sql.strip(), 'deliver {"sql": "<one SQLite query>"}'
    rng = random.Random()
    for n in range(1, 4):
        data = make_data(rng)
        want = net_revenue(data)
        rows = run_query(load(data), sql)
        assert all(len(row) == 2 for row in rows), "return exactly two columns: region, net_revenue_cents"
        got = {row[0]: row[1] for row in rows}
        if got != want:
            region = next((r for r in sorted(set(want) | set(got)) if got.get(r) != want.get(r)), "?")
            hint = next((name for name, kw in MISTAKES.items() if net_revenue(data, **kw) == got), None)
            g, w = got.get(region), want.get(region)
            line = f"test database {n}: {region} net revenue {dollars(g) if isinstance(g, int) else repr(g)}, expected {dollars(w) if isinstance(w, int) else repr(w)}"
            raise AssertionError(line + (f"; the numbers match a known mistake: {hint}" if hint else ""))
        values = [row[1] for row in rows]
        assert values == sorted(values, reverse=True), "order the rows by net_revenue_cents, highest first"
    return True
