import re

UNITS = {"h": 3600, "m": 60, "s": 1}


def parse_duration(text):
    return sum(int(amount) * UNITS[unit] for amount, unit in re.findall(r"(\d+)([hms])", text))
