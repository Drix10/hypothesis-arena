"""XBRL cover-page shares outstanding and public float from companyfacts JSON.

Reads dei:EntityCommonStockSharesOutstanding and dei:EntityPublicFloat as
dated observations; no network. shares()/public_float() use only facts with
filed <= as_of and prefer the latest filing. Entries sharing one accession
and cover date are share classes and are summed. A later filing that
reports a different total for an earlier filing's cover date is flagged
restated. A malformed fact fails closed.
"""
import datetime
import math
import re

SHARES_CONCEPT = "EntityCommonStockSharesOutstanding"
FLOAT_CONCEPT = "EntityPublicFloat"
SHARES_UNIT = "shares"
FLOAT_UNIT = "USD"

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SharesError(ValueError):
    pass


def _date(text, what):
    if not isinstance(text, str) or not _DATE_RE.match(text):
        raise SharesError("bad %s %r" % (what, text))
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        raise SharesError("bad %s %r" % (what, text))
    return text


def observations(cik_facts, concept, unit):
    """Return the concept's facts as dicts (value, end, filed, accn, form),
    sorted by (filed, end, accn, value)."""
    try:
        rows = cik_facts["facts"]["dei"][concept]["units"][unit]
    except (KeyError, TypeError):
        raise SharesError("no dei:%s in %s" % (concept, unit))
    if not isinstance(rows, list):
        raise SharesError("dei:%s units not a list" % concept)
    out = []
    for r in rows:
        if not isinstance(r, dict):
            raise SharesError("malformed fact %r" % (r,))
        val = r.get("val")
        if (isinstance(val, bool) or not isinstance(val, (int, float))
                or not math.isfinite(val) or val < 0):
            raise SharesError("bad value %r" % (val,))
        accn = r.get("accn")
        form = r.get("form")
        if not isinstance(accn, str) or not accn:
            raise SharesError("bad accession %r" % (accn,))
        if not isinstance(form, str) or not form:
            raise SharesError("bad form %r" % (form,))
        out.append({"value": val, "end": _date(r.get("end"), "end"),
                    "filed": _date(r.get("filed"), "filed"),
                    "accn": accn, "form": form})
    out.sort(key=lambda o: (o["filed"], o["end"], o["accn"], o["value"]))
    return out


def _totals(obs):
    """Sum share classes per (filed, accn, end) filing cover date."""
    by_key = {}
    for o in obs:
        k = (o["filed"], o["accn"], o["end"], o["form"])
        by_key.setdefault(k, []).append(o["value"])
    return [{"filed": k[0], "accession": k[1], "end": k[2], "form": k[3],
             "value": sum(v), "classes": len(v)}
            for k, v in sorted(by_key.items())]


def _latest(cik_facts, concept, unit, as_of):
    as_of = _date(as_of, "as_of")
    eligible = _totals([o for o in observations(cik_facts, concept, unit)
                        if o["filed"] <= as_of])
    if not eligible:
        raise SharesError("no dei:%s filed on or before %s"
                          % (concept, as_of))
    best = eligible[-1]
    best["restated"] = any(e["end"] == best["end"]
                           and e["accession"] != best["accession"]
                           and e["value"] != best["value"]
                           for e in eligible)
    return best


def shares(cik_facts, as_of):
    """Latest cover-page shares outstanding known at as_of (ISO date).
    Returns {value, end, filed, accession, form, classes, restated}."""
    return _latest(cik_facts, SHARES_CONCEPT, SHARES_UNIT, as_of)


def public_float(cik_facts, as_of):
    """Latest cover-page public float in USD known at as_of; same shape."""
    return _latest(cik_facts, FLOAT_CONCEPT, FLOAT_UNIT, as_of)
