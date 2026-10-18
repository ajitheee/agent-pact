"""Checkout pricing for the storefront API."""

TAX_RATES = {"US-CA": 0.0725, "US-NY": 0.08875, "US-TX": 0.0625, "DE": 0.19, "FR": 0.20, "GB": 0.20}
DISCOUNTS = {"SAVE10": ("percent", 10), "SAVE25": ("percent", 25), "FLAT5": ("flat", 500), "FLAT20": ("flat", 2000)}


class Quote:
    def __init__(self, subtotal_cents, discount_cents, tax_cents, total_cents):
        self.subtotal_cents = subtotal_cents
        self.discount_cents = discount_cents
        self.tax_cents = tax_cents
        self.total_cents = total_cents


def quote(cart, discount_code=None, region="US-CA"):
    """cart: list of {"sku", "qty", "unit_cents"}. Returns a Quote with every amount in integer cents."""
    subtotal = sum(line["qty"] * line["unit_cents"] for line in cart)
    discount = 0
    if discount_code:
        kind, value = DISCOUNTS[discount_code]
        discount = subtotal * value / 100 if kind == "percent" else value
    tax = round(subtotal * TAX_RATES[region])
    total = subtotal - discount + tax
    return Quote(subtotal, int(discount), int(tax), int(total))
