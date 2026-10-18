import re

FREE_MAIL = {"gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"}
RESERVED = re.compile(r"(^|\.)(example|test|invalid|localhost|domain|sample|placeholder|dummy|fake)(\.|$)")
FULL_NAME = re.compile(r"[A-Z][a-zA-Z'-]+( [A-Z][a-zA-Z'-]+)+")


def verify(rows):
    assert isinstance(rows, list), f"expected a JSON array, got {type(rows).__name__}"
    assert len(rows) == 20, f"expected 20 contacts, got {len(rows)}"
    emails, domains = set(), set()
    for i, row in enumerate(rows):
        assert isinstance(row, dict), f"row {i}: expected an object with name and email"
        name = str(row.get("name", "")).strip()
        email = str(row.get("email", "")).strip().lower()
        assert FULL_NAME.fullmatch(name), f"row {i}: name {name!r} is not a real full name"
        local, at, domain = email.partition("@")
        assert at and local and re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}", domain), f"row {i}: {email!r} is not an email"
        assert not RESERVED.search(domain), f"row {i}: {domain} is a placeholder domain"
        assert not re.search(r"\d", domain), f"row {i}: {domain} looks generated (digits in the company domain)"
        assert domain not in FREE_MAIL, f"row {i}: {domain} is free mail, not a work address"
        first = name.split()[0].lower()
        assert first in local, f"row {i}: {email!r} does not belong to {name!r}"
        assert email not in emails, f"row {i}: duplicate email {email}"
        assert domain not in domains, f"row {i}: duplicate company {domain}"
        emails.add(email)
        domains.add(domain)
    return True
