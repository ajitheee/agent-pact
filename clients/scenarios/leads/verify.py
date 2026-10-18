# scenario: leads
# The same directory as the task (fictional companies on reserved .example domains). The check knows exactly
# which companies qualify, so invented, unqualified or missing leads all fail.

EUROPE = {
    "Austria", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Ireland", "Netherlands",
    "Norway", "Poland", "Portugal", "Spain", "Sweden", "Switzerland", "United Kingdom",
}
DIRECTORY = """company | domain | sector | hq | employees | contact
Tracewind | tracewind.example | dev tools | Berlin, Germany | 120 | sales@tracewind.example
Quillstack | quillstack.example | dev tools | Austin, USA | 85 | hello@quillstack.example
Loomforge | loomforge.example | dev tools | Amsterdam, Netherlands | 50 | sales@loomforge.example
Driftbase | driftbase.example | data tools | Paris, France | 200 | contact@driftbase.example
Ferrolabs | ferrolabs.example | dev tools | Stockholm, Sweden | 49 | sales@ferrolabs.example
Parcelcore | parcelcore.example | logistics | Madrid, Spain | 300 | info@parcelcore.example
Kiteshell | kiteshell.example | dev tools | Dublin, Ireland | 75 | sales@kiteshell.example
Emberlane | emberlane.example | dev tools | Toronto, Canada | 140 | hi@emberlane.example
Nimbusworks | nimbusworks.example | dev tools | Munich, Germany | 310 | vertrieb@nimbusworks.example
Glyphwise | glyphwise.example | AI tools | London, United Kingdom | 60 | sales@glyphwise.example
Harborci | harborci.example | dev tools | Lisbon, Portugal | 95 | sales@harborci.example
Tallyhq | tallyhq.example | fintech | Warsaw, Poland | 55 | hello@tallyhq.example
Oakpipe | oakpipe.example | dev tools | Tallinn, Estonia | 30 | team@oakpipe.example
Vectorly | vectorly.example | dev tools | San Francisco, USA | 500 | sales@vectorly.example
Mintgrid | mintgrid.example | dev tools | Helsinki, Finland | 64 | myynti@mintgrid.example
Relaydock | relaydock.example | dev tools | Copenhagen, Denmark | 12 | hej@relaydock.example
Patchwell | patchwell.example | security | Vienna, Austria | 80 | sales@patchwell.example
Saltbox | saltbox.example | dev tools | Zurich, Switzerland | 110 | sales@saltbox.example
Cinderly | cinderly.example | dev tools | Bangalore, India | 90 | sales@cinderly.example
Brightfork | brightfork.example | dev tools | Manchester, United Kingdom | 52 | sales@brightfork.example
Quarry Labs | quarrylabs.example | data tools | Berlin, Germany | 70 | hello@quarrylabs.example
Lanternbay | lanternbay.example | dev tools | Lyon, France | 47 | contact@lanternbay.example
Northpine | northpine.example | dev tools | Oslo, Norway | 58 | sales@northpine.example
Sablecode | sablecode.example | dev tools | Prague, Czechia | 150 | obchod@sablecode.example"""


def companies():
    rows = [line.split(" | ") for line in DIRECTORY.splitlines()[1:]]
    return {r[0]: {"domain": r[1], "sector": r[2], "country": r[3].split(", ")[-1], "employees": int(r[4]), "contact": r[5]} for r in rows}


def qualifies(c):
    return c["sector"] == "dev tools" and c["country"] in EUROPE and c["employees"] >= 50


def verify(payload):
    assert isinstance(payload, dict) and isinstance(payload.get("leads"), list), 'deliver {"leads": [{"company", "domain", "contact"}]}'
    directory = companies()
    seen = set()
    for i, lead in enumerate(payload["leads"]):
        assert isinstance(lead, dict), f"leads[{i}] must be an object"
        name = str(lead.get("company", "")).strip()
        c = directory.get(name)
        assert c, f"{name or f'leads[{i}]'} is not in the directory: invented lead"
        assert qualifies(c), f"{name} doesn't qualify ({c['sector']}, {c['country']}, {c['employees']} employees)"
        assert lead.get("domain") == c["domain"], f"{name}: domain should be {c['domain']}"
        assert lead.get("contact") == c["contact"], f"{name}: contact should be {c['contact']}, as listed"
        assert name not in seen, f"{name} is listed twice"
        seen.add(name)
    missing = sorted(n for n, c in directory.items() if qualifies(c) and n not in seen)
    assert not missing, f"missing qualified leads: {', '.join(missing)}"
    return True
