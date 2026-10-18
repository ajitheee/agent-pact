# scenario: invoices
# Accounts payable: 6 vendor invoices (text as OCR'd from PDFs, fictional vendors) to ledger JSON. No answer key:
# every extracted figure must appear in its own source document (nothing invented), every date must be that
# document's date read in its country's format, and the arithmetic must reconcile (qty x price = amount,
# lines = subtotal, subtotal + tax = total).
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

DOCUMENTS = [
    ("US", """NORTHBEAM CLOUD INC.
1200 Harbor Way, Seattle, WA 98101, USA
INVOICE # NB-10482
Invoice Date: 09/03/2026          Terms: Net 30
Bill To: Acme Robotics, Inc.

Description                       Qty     Unit Price      Amount
Compute (vCPU-hours)            1,200         $0.042      $50.40
Object storage (TB-month)           3         $23.00      $69.00
Business support plan               1        $149.00     $149.00

Subtotal                                                 $268.40
Sales Tax (0%)                                             $0.00
TOTAL DUE                                                $268.40"""),
    ("DE", """Kranich Druck GmbH · Hafenstraße 12 · 20457 Hamburg · Deutschland
RECHNUNG
Rechnung Nr.: KD-2026-0917
Rechnungsdatum: 03.09.2026
Kunde: Acme Robotics Inc.

Pos.  Bezeichnung                   Menge   Einzelpreis       Betrag
1     Messestand-Banner 3x2 m           2      310,00 €     620,00 €
2     Flyer A5, 4/4-farbig          5.000        0,11 €     550,00 €
3     Express-Zuschlag                  1       79,90 €      79,90 €

Nettobetrag                                              1.249,90 €
zzgl. 19 % MwSt.                                           237,48 €
Gesamtbetrag                                             1.487,38 €"""),
    ("GB", """FERNHILL LEGAL LLP
14 Gray's Inn Square, London WC1R 5JA, United Kingdom
VAT Reg. No. GB 284 7712 09

Invoice No: FL/7731
Date: 12 September 2026
Client: Acme Robotics Ltd

Professional services                        Hours      Rate      Amount
Contract review, supplier agreement            6.5   £280.00   £1,820.00
Data processing addendum drafting              2.0   £280.00     £560.00
Disbursements: courier                           1    £42.50      £42.50

Net                                                            £2,422.50
VAT @ 20%                                                        £484.50
Total                                                          £2,907.00"""),
    ("US", """Atlas Freight Co.
Invoice ATF-55821                          Date: Sep 15, 2026
Ship from: Long Beach, CA     Ship to: Reno, NV

Item                                  Qty       Rate       Amount
Full truckload, Long Beach to Reno      1   1,850.00     1,850.00
Liftgate service                        1      95.00        95.00
Fuel surcharge (18%)                    1     333.00       333.00

Subtotal                                                 2,278.00
Tax                                                          0.00
Amount due (USD)                                         2,278.00"""),
    ("FR", """Lumière Studio SARL, 8 rue des Arts, 69002 Lyon, France
FACTURE N° LS-0442
Date : 18/09/2026
Client : Acme Robotics

Désignation                              Qté   Prix unitaire     Montant HT
Tournage vidéo produit (journée)           2      1 200,00 €     2 400,00 €
Montage et étalonnage                      1        950,00 €       950,00 €
Licence musique (usage web)                1        180,00 €       180,00 €

Total HT                                                        3 530,00 €
TVA 20 %                                                          706,00 €
Total TTC                                                       4 236,00 €"""),
    ("US", """QUIET DESK SUPPLY
Invoice: QDS-9003
Invoice date: 2026-09-21
Sold to: Acme Robotics, Inc., 55 Water St, New York, NY 10041

SKU        Description                     Qty     Unit      Total
QD-CH-02   Ergonomic task chair              4   389.00   1,556.00
QD-DK-11   Sit-stand desk frame              4   445.00   1,780.00
QD-MT-07   Anti-fatigue mat                  4    39.50     158.00

Subtotal                                              3,494.00
NY sales tax 8.875%                                     310.09
Invoice total                                         3,804.09"""),
]
NUMBER = {
    "US": (r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?", lambda s: s.replace(",", "")),
    "GB": (r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?", lambda s: s.replace(",", "")),
    "DE": (r"\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?", lambda s: s.replace(".", "").replace(",", ".")),
    "FR": (r"\d{1,3}(?: \d{3})+(?:,\d+)?|\d+(?:,\d+)?", lambda s: s.replace(" ", "").replace(",", ".")),
}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def numbers_in(locale, text):
    pattern, clean = NUMBER[locale]
    return {Decimal(clean(m)) for m in re.findall(pattern, text)}


def date_forms(locale, iso):
    y, m, d = (int(x) for x in iso.split("-"))
    month = MONTHS[m - 1]
    forms = {iso}
    if locale == "US":
        forms |= {f"{m:02d}/{d:02d}/{y}", f"{month[:3]} {d}, {y}", f"{month} {d}, {y}"}
    elif locale == "GB":
        forms |= {f"{d} {month} {y}", f"{d:02d}/{m:02d}/{y}"}
    elif locale == "DE":
        forms |= {f"{d:02d}.{m:02d}.{y}"}
    elif locale == "FR":
        forms |= {f"{d:02d}/{m:02d}/{y}"}
    return forms


def amount(inv, field, value):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise AssertionError(f"{inv}: {field} {value!r} is not a number") from None


def verify(payload):
    invoices = payload.get("invoices") if isinstance(payload, dict) else None
    assert isinstance(invoices, list), 'deliver {"invoices": [...]}'
    assert len(invoices) == len(DOCUMENTS), f"expected {len(DOCUMENTS)} invoices, got {len(invoices)}"
    seen = set()
    for i, inv in enumerate(invoices):
        assert isinstance(inv, dict), f"invoices[{i}] must be an object"
        no = str(inv.get("invoice_no", "")).strip()
        matches = [k for k, (_, text) in enumerate(DOCUMENTS) if no and no in text]
        assert len(matches) == 1, f"invoices[{i}]: invoice_no {no!r} is not in any document: invented value"
        k = matches[0]
        assert k not in seen, f"{no} is extracted twice"
        seen.add(k)
        locale, text = DOCUMENTS[k]
        flat = " ".join(text.split()).lower()
        vendor = " ".join(str(inv.get("vendor", "")).split()).lower()
        assert vendor and vendor in flat, f"{no}: vendor {inv.get('vendor')!r} doesn't appear in the document: invented value"
        currency = "EUR" if "€" in text else "GBP" if "£" in text else "USD"
        assert inv.get("currency") == currency, f"{no}: currency should be {currency}, got {inv.get('currency')!r}"
        iso = str(inv.get("issue_date", ""))
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", iso), f"{no}: issue_date must be YYYY-MM-DD, got {iso!r}"
        assert any(form in text for form in date_forms(locale, iso)), f"{no}: issue_date {iso} doesn't match the document's date ({locale} format)"
        found = numbers_in(locale, text)
        lines = inv.get("lines")
        assert isinstance(lines, list) and lines, f"{no}: lines must be a non-empty list"
        line_total = Decimal(0)
        for j, line in enumerate(lines):
            assert isinstance(line, dict), f"{no}: lines[{j}] must be an object"
            qty, price, amt = (amount(no, f"lines[{j}].{f}", line.get(f)) for f in ("qty", "unit_price", "amount"))
            for field, value in (("qty", qty), ("unit_price", price), ("amount", amt)):
                assert value in found, f"{no}: lines[{j}].{field} {value} doesn't appear in the document: invented value"
            assert (qty * price).quantize(Decimal("0.01"), ROUND_HALF_UP) == amt, f"{no}: lines[{j}]: {qty} x {price} is not {amt}"
            line_total += amt
        subtotal, tax, total = (amount(no, f, inv.get(f)) for f in ("subtotal", "tax", "total"))
        for field, value in (("subtotal", subtotal), ("tax", tax), ("total", total)):
            assert value in found, f"{no}: {field} {value} doesn't appear in the document: invented value"
        assert line_total == subtotal, f"{no}: the lines add up to {line_total}, not the subtotal {subtotal}: a line is missing or wrong"
        assert subtotal + tax == total, f"{no}: subtotal {subtotal} + tax {tax} is not the total {total}"
    return True
