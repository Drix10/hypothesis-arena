"""Observation builders for the point-in-time ticker map (plan/data.md).

Pure functions over already-fetched inputs; no network. Each returns
(observations, skipped), where skipped counts records with a missing or
malformed field. A date is never inferred.
"""
import datetime
import re

from sources import ticker_map

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:T.*)?$")
_SYMBOL = re.compile(r"^[A-Za-z0-9]{1,6}(?:[.-][A-Za-z0-9]{1,2})?$")
_NAME_NOISE = re.compile(
    r"\b(?:INC|CORP|CORPORATION|CO|COMPANY|LTD|LLC|PLC|COMMON STOCK)\b")
# A name change is reported on an 8-K (Item 5.03); the submissions
# formerNames entry carries no accession.
_NAME_CHANGE_FORMS = ("8-K", "8-K/A")


def _date(value):
    """A date from 'YYYY-MM-DD' or an ISO timestamp, else None."""
    if not isinstance(value, str) or not _ISO_DATE.match(value):
        return None
    try:
        return datetime.date.fromisoformat(value[:10])
    except ValueError:
        return None


def _cik(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    text = str(value).strip()
    return int(text) if text.isdigit() else None


def _symbol(value):
    return value if isinstance(value, str) and _SYMBOL.match(value) else None


def _build(cik, symbol, source, observed, known):
    """An Observation, or None when any field is missing or malformed."""
    if None in (cik, symbol, observed, known):
        return None
    return ticker_map.observation(cik, symbol, source, observed, known)


def dei_observations(companyfacts):
    """dei:TradingSymbol facts: period end is observed_date, filed is known_at."""
    cik = _cik(companyfacts.get("cik"))
    facts = ((companyfacts.get("facts") or {}).get("dei") or {}).get(
        "TradingSymbol") or {}
    out, skipped = [], 0
    for units in (facts.get("units") or {}).values():
        for fact in units:
            ob = _build(cik, _symbol(fact.get("val")), "dei",
                        _date(fact.get("end")), _date(fact.get("filed")))
            if ob is None:
                skipped += 1
            else:
                out.append(ob)
    return out, skipped


def form4_observations(rows):
    """Issuer symbol from research/strategy/form4.read_quarter rows. The row
    carries the filing date only, so it is both observed_date and known_at."""
    out, skipped = [], 0
    for row in rows:
        filed = row.get("filing_date")
        filed = filed if isinstance(filed, datetime.date) else None
        ob = _build(_cik(row.get("cik")), _symbol(row.get("symbol")),
                    "form4", filed, filed)
        if ob is None:
            skipped += 1
        else:
            out.append(ob)
    return out, skipped


def corp_action_observations(records, cik_by_symbol):
    """Alpaca symbol-change records (old_symbol, new_symbol, effective_date,
    process_date). The new symbol is observed at the effective date and known
    at the process date; the old symbol needs no observation, because the
    earlier record that introduced it already carries it. A record whose
    symbols are not in cik_by_symbol has no issuer and is skipped."""
    out, skipped = [], 0
    for rec in records:
        new, old = _symbol(rec.get("new_symbol")), _symbol(rec.get("old_symbol"))
        cik = None
        if new and old:
            cik = _cik(cik_by_symbol.get(new.upper(),
                                         cik_by_symbol.get(old.upper())))
        ob = _build(cik, new, "corp_action", _date(rec.get("effective_date")),
                    _date(rec.get("process_date")))
        if ob is None:
            skipped += 1
        else:
            out.append(ob)
    return out, skipped


def normalize_name(name):
    text = re.sub(r"[^A-Z0-9 ]", " ", name.upper().replace("&", " AND "))
    return " ".join(_NAME_NOISE.sub(" ", text).split())


def former_name_observations(submissions, assets):
    """Symbols of broker assets whose normalized name equals a former name.

    observed_date is the end of the former name; known_at is the first 8-K
    filed on or after it. An entry with no such filing, or whose name matches
    several symbols, is skipped; an entry matching no asset yields nothing.
    assets: dicts with name and symbol."""
    cik = _cik(submissions.get("cik"))
    recent = (submissions.get("filings") or {}).get("recent") or {}
    filed = sorted(d for form, d in zip(recent.get("form") or (),
                                        map(_date, recent.get("filingDate") or ()))
                   if form in _NAME_CHANGE_FORMS and d)
    symbols = {}
    for asset in assets:
        if isinstance(asset.get("name"), str):
            symbols.setdefault(normalize_name(asset["name"]), set()).add(
                asset.get("symbol"))
    out, skipped = [], 0
    for entry in submissions.get("formerNames") or ():
        name = entry.get("name")
        changed = _date(entry.get("to"))
        if not isinstance(name, str) or changed is None:
            skipped += 1
            continue
        matched = symbols.get(normalize_name(name), set())
        if not matched:
            continue
        known = next((d for d in filed if d >= changed), None)
        ob = None
        if len(matched) == 1:
            ob = _build(cik, _symbol(next(iter(matched))), "former_name",
                        changed, known)
        if ob is None:
            skipped += 1
        else:
            out.append(ob)
    return out, skipped
