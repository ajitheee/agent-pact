# scenario: bugfix
import random

# The deliverable is {"code": "<Python source that defines parse_duration(text)>"}.
# run_submission (provided by the escrow sandbox) runs that code in its own sandboxed process.

EXAMPLES = [("1h30m", 5400), ("45s", 45), ("2h5s", 7205), ("90m", 5400), ("1h2m3s", 3723), ("10h", 36000)]
UNITS = (("h", 3600), ("m", 60), ("s", 1))


def fresh(rng):
    """A duration nobody has seen before this check, with its answer."""
    while True:
        parts = [(unit, rng.randint(1, 99), size) for unit, size in UNITS if rng.random() < 0.6]
        if parts:
            return "".join(f"{n}{unit}" for unit, n, _ in parts), sum(n * size for _, n, size in parts)


def verify(payload):
    assert isinstance(payload, dict) and isinstance(payload.get("code"), str), 'deliver {"code": "<Python source defining parse_duration(text)>"}'
    rng = random.Random()
    cases = EXAMPLES + [fresh(rng) for _ in range(25)]
    got = run_submission(payload["code"], "parse_duration", [text for text, _ in cases])
    for i, ((text, want), value) in enumerate(zip(cases, got)):
        # Examples are checked first, so a "hidden test" failure means every public example passed.
        where = "hidden test: " if i >= len(EXAMPLES) else ""
        assert type(value) is int and value == want, f"{where}parse_duration({text!r}) returned {value!r}, expected {want}"
    return True
