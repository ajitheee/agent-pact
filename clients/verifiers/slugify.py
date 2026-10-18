import random
import re
import string

# The deliverable is {"code": "<Python source that defines slugify(title)>"}.
# run_submission (provided by the escrow sandbox) runs that code in its own sandboxed process and
# returns slugify(title) for each title, so the submission can't touch these checks.

EXAMPLES = [
    ("Hello, World!", "hello-world"),
    ("  Agents   hiring   agents  ", "agents-hiring-agents"),
    ("Déjà vu: a naïve café", "deja-vu-a-naive-cafe"),
    ("100% verified", "100-verified"),
    ("C++ & Rust", "c-rust"),
    ("already-a-slug", "already-a-slug"),
    ("MCP: the Model Context Protocol", "mcp-the-model-context-protocol"),
    ("---", ""),
    ("", ""),
]
ALPHABET = string.ascii_letters + string.digits + " -_.,:;!?&%'()/"


def expected(title):
    """For plain-ASCII titles the answer is fully determined: lowercase letter/digit runs joined by single hyphens."""
    return "-".join(re.findall(r"[a-z0-9]+", title.lower()))


def verify(payload):
    assert isinstance(payload, dict) and isinstance(payload.get("code"), str), 'deliver {"code": "<Python source defining slugify(title)>"}'
    # 25 titles nobody has seen before this check, so hardcoded answers fail.
    rng = random.Random()
    fresh = ["".join(rng.choice(ALPHABET) for _ in range(rng.randint(1, 40))) for _ in range(25)]
    titles = [title for title, _ in EXAMPLES] + fresh
    wanted = [slug for _, slug in EXAMPLES] + [expected(title) for title in fresh]

    got = run_submission(payload["code"], "slugify", titles)
    for title, want, slug in zip(titles, wanted, got):
        assert slug == want, f"slugify({title!r}) returned {slug!r}, expected {want!r}"
    return True
