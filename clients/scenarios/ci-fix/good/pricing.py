"""Checkout pricing for the storefront API."""
from decimal import ROUND_HALF_UP, Decimal

TAX_RATES = {
    "US-CA": Decimal("0.0725"),
    "US-NY": Decimal("0.08875"),
    "US-TX": Decimal("0.0625"),
    "DE": Decimal("0.19"),
    "FR": Decimal("0.20"),
    "GB": Decimal("0.20"),
}
DISCOUNTS = {"SAVE10": ("percent", 10), "SAVE25": ("percent", 25), "FLAT5": ("flat", 500), "FLAT20": ("flat", 2000)}


class Quote:
    def __init__(self, subtotal_cents, discount_cents, tax_cents, total_cents):
        self.subtotal_cents = subtotal_cents
        self.discount_cents = discount_cents
        self.tax_cents = tax_cents
        self.total_cents = total_cents


def _to_cents(amount):
    """Round half up to a whole cent (money never uses banker's rounding)."""
    return int(Decimal(amount).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def quote(cart, discount_code=None, region="US-CA"):
    """cart: list of {"sku", "qty", "unit_cents"}. Returns a Quote with every amount in integer cents."""
    if region not in TAX_RATES:
        raise ValueError(f"unknown region {region!r}")
    if discount_code and discount_code not in DISCOUNTS:
        raise ValueError(f"unknown discount code {discount_code!r}")
    subtotal = sum(line["qty"] * line["unit_cents"] for line in cart)
    discount = 0
    if discount_code:
        kind, value = DISCOUNTS[discount_code]
        # Percent discounts round half up; a flat discount never exceeds the order.
        discount = _to_cents(Decimal(subtotal) * value / 100) if kind == "percent" else min(value, subtotal)
    # Tax is charged on what the customer actually pays: the discounted subtotal.
    tax = _to_cents((subtotal - discount) * TAX_RATES[region])
    return Quote(subtotal, discount, tax, subtotal - discount + tax)
