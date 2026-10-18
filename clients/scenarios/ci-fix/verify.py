# scenario: ci-fix
# CI for the pricing service. The delivered pricing.py runs in its own sandboxed process (run_submission);
# it is checked against the named tests in test_pricing.py and 200 randomized carts generated now, so a
# "fix" that special-cases the test inputs instead of fixing the code fails.
import random
from decimal import ROUND_HALF_UP, Decimal

TAX = {"US-CA": "0.0725", "US-NY": "0.08875", "US-TX": "0.0625", "DE": "0.19", "FR": "0.20", "GB": "0.20"}
DISCOUNTS = {"SAVE10": ("percent", 10), "SAVE25": ("percent", 25), "FLAT5": ("flat", 500), "FLAT20": ("flat", 2000)}

# test_pricing.py: the suite CI runs on every push.
TESTS = [
    ("test_quote_without_discount", {"cart": [{"sku": "MUG-01", "qty": 2, "unit_cents": 1250}], "region": "US-CA"}),
    ("test_percent_discount_is_taxed_after_discount", {"cart": [{"sku": "HOODIE-M", "qty": 3, "unit_cents": 1999}], "code": "SAVE10", "region": "US-NY"}),
    ("test_flat_discount_never_makes_total_negative", {"cart": [{"sku": "PEN-BLK", "qty": 1, "unit_cents": 1200}], "code": "FLAT20", "region": "US-TX"}),
    ("test_tax_rounds_half_up", {"cart": [{"sku": "STICKER", "qty": 2, "unit_cents": 100}], "region": "US-TX"}),
    ("test_vat_on_discounted_order", {"cart": [{"sku": "LAMP-EU", "qty": 1, "unit_cents": 8900}, {"sku": "BULB-E27", "qty": 4, "unit_cents": 399}], "code": "SAVE25", "region": "DE"}),
    ("test_multi_line_cart", {"cart": [{"sku": "DESK", "qty": 1, "unit_cents": 44900}, {"sku": "CHAIR", "qty": 2, "unit_cents": 18950}, {"sku": "MAT", "qty": 1, "unit_cents": 3999}], "code": "FLAT5", "region": "GB"}),
    ("test_unknown_discount_code_is_rejected", {"cart": [{"sku": "MUG-01", "qty": 1, "unit_cents": 1250}], "code": "FREESTUFF", "region": "US-CA"}),
    ("test_unknown_region_is_rejected", {"cart": [{"sku": "MUG-01", "qty": 1, "unit_cents": 1250}], "region": "MARS-1"}),
]

# Internal: appended to the delivered file so the child process can call quote() per test case.
HARNESS = '''

def _ci(case):
    try:
        q = quote(case["cart"], discount_code=case.get("code"), region=case["region"])
        return [q.subtotal_cents, q.discount_cents, q.tax_cents, q.total_cents]
    except ValueError:
        return "ValueError"
'''


def to_cents(amount):
    return int(Decimal(amount).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def expected(case):
    code = case.get("code")
    if case["region"] not in TAX or (code and code not in DISCOUNTS):
        return "ValueError"
    subtotal = sum(line["qty"] * line["unit_cents"] for line in case["cart"])
    discount = 0
    if code:
        kind, value = DISCOUNTS[code]
        discount = to_cents(Decimal(subtotal) * value / 100) if kind == "percent" else min(value, subtotal)
    tax = to_cents((subtotal - discount) * Decimal(TAX[case["region"]]))
    return [subtotal, discount, tax, subtotal - discount + tax]


def random_case(rng):
    cart = [{"sku": f"SKU-{rng.randint(100, 999)}", "qty": rng.randint(1, 5), "unit_cents": rng.randint(99, 25000)} for _ in range(rng.randint(1, 4))]
    return {"cart": cart, "code": rng.choice([None, None, *DISCOUNTS]), "region": rng.choice(list(TAX))}


def show(value):
    if not isinstance(value, list) or len(value) != 4:
        return repr(value)
    return "subtotal {}, discount {}, tax {}, total {}".format(*value)


def verify(payload):
    files = payload.get("files") if isinstance(payload, dict) else None
    assert isinstance(files, dict) and isinstance(files.get("pricing.py"), str), 'deliver {"files": {"pricing.py": "<the full fixed file>"}}'
    rng = random.Random()
    hidden = [random_case(rng) for _ in range(200)]
    cases = [case for _, case in TESTS] + hidden
    got = run_submission(files["pricing.py"] + HARNESS, "_ci", cases)
    for i, (case, value) in enumerate(zip(cases, got)):
        want = expected(case)
        if value == want:
            continue
        if i < len(TESTS):
            raise AssertionError(f"FAILED {TESTS[i][0]}: got {show(value)}; expected {show(want)}")
        # Every named test passed (they run first), so this cart is one the delivery never saw.
        cart = ", ".join(f"{line['qty']}x{line['unit_cents']}" for line in case["cart"])
        raise AssertionError(f"hidden test: random cart #{i - len(TESTS) + 1} ({cart}, {case.get('code') or 'no code'}, {case['region']}): got {show(value)}; expected {show(want)}")
    return True
