"""Human-run fetch of the Ken French daily factors (Fama-French 5 plus momentum)
to research/data/french_factors.json, the file gates.breadth reads through
run_connected_drift. Needs MIRO_CONTACT. Verifies factor names, decimal units
and coverage of the evaluation window before it writes, and prints a report."""
import argparse
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, ".."))
sys.path.insert(0, ROOT)

from sources import edgar, french_factors
from research.strategy import fetch_universe_bars

DATA = os.path.join(ROOT, "data")
NAMES = french_factors.FF5_COLUMNS + french_factors.MOM_COLUMNS
# A daily factor return beyond 50% means the percent conversion did not happen.
MAX_ABS_DAILY = 0.5


class VerifyError(ValueError):
    pass


def verify(rows, start):
    """Raise unless `rows` carry every factor as a bounded decimal and begin on
    or before `start`; return the report lines."""
    if not rows:
        raise VerifyError("no rows")
    for d, vals in rows:
        if tuple(sorted(vals)) != tuple(sorted(NAMES)):
            raise VerifyError("factor names on %s: %s" % (d, sorted(vals)))
        if any(abs(v) > MAX_ABS_DAILY for v in vals.values()):
            raise VerifyError("value above %s on %s: units" % (
                MAX_ABS_DAILY, d))
    if rows[0][0] > start:
        raise VerifyError("coverage starts %s, after %s" % (rows[0][0], start))
    gap, at = max(
        ((_gap(a, b), b) for (a, _), (b, _) in zip(rows, rows[1:])),
        default=(0, rows[0][0]))
    return ["rows %d" % len(rows), "first %s" % rows[0][0],
            "last %s" % rows[-1][0], "factors %s" % ", ".join(NAMES),
            "largest gap %d days ending %s" % (gap, at)]


def _gap(a, b):
    return (fetch_universe_bars._day(b) - fetch_universe_bars._day(a)).days


def _atomic_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def main(argv=None, env=None, log=print, **fetch_kw):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--start", default=fetch_universe_bars.DEFAULT_START,
                    help="the file must begin on or before this ISO date")
    a = ap.parse_args(argv)
    contact = edgar.contact_from_env(env)
    if not contact:
        log("MIRO_CONTACT must be exported")
        return 2
    try:
        rows, manifest = french_factors.fetch(contact=contact, **fetch_kw)
        report = verify(rows, a.start)
    except (french_factors.FactorError, VerifyError, edgar.ConfigError,
            OSError) as e:
        log("refused: %s" % e)
        return 1
    for line in report:
        log(line)
    _atomic_json(os.path.join(a.data, "french_factors.json"),
                 {"through": rows[-1][0], "data": rows, "sources": manifest})
    return 0


if __name__ == "__main__":
    sys.exit(main(env=os.environ))
