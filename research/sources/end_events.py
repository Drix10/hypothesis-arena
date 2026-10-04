"""End-event extraction for delisted firms (plan/data.md Survivorship).

Turns an SEC submissions JSON into the event records research/sources/last_trade
consumes. Pure functions over passed-in JSON and text; no network.
"""
import datetime
import re

from sources import last_trade

END_FORMS = last_trade.DELISTING_FORMS + last_trade.DEREGISTRATION_FORMS
ITEM_FORM = "8-K"

NOT_COMMON = ("note", "bond", "debenture", "preferred", "preference", "warrant",
              "depositary", "right", "unit", "trust", "certificate")
COMMON_CLASS = re.compile(r"\b(common (stock|shares?)|ordinary shares?)\b")
CLASS_LABEL = re.compile(
    r"(?:description of class of securities|title of (?:each )?class"
    r"(?: of securities)?)\s*[:\-]?\s*([^\n]{1,300})", re.I)
TAG = re.compile(r"<[^>]+>")


def parse_form25_class(text):
    """'common' only when the stated class is common stock or ordinary shares
    and names no note, bond, preferred, warrant or depositary share; else None
    (including an unreadable document)."""
    if not isinstance(text, str):
        return None
    for match in CLASS_LABEL.finditer(TAG.sub("\n", text)):
        stated = match.group(1).strip().lower()
        if not stated:
            continue
        if COMMON_CLASS.search(stated) and not any(w in stated for w in NOT_COMMON):
            return last_trade.COMMON
        return None
    return None


def _rows(submissions):
    """Row dicts of a submissions JSON: filings.recent, or the top-level arrays
    of an older-filings file."""
    block = (submissions.get("filings") or {}).get("recent", submissions)
    forms = block.get("form") or []
    columns = {k: block.get(k) or [] for k in
               ("filingDate", "accessionNumber", "items")}
    for i, form in enumerate(forms):
        row = {"form": form}
        for key, col in columns.items():
            row[key] = col[i] if i < len(col) else ""
        yield row


def build_events(submissions, form25_classes=None):
    """Events for forms 25, 25-NSE, 15-12B, 15-12G, 15-15D and 8-K carrying
    item 3.01 or 2.01.

    form25_classes: dict accession -> class text, or a callable doing the same
    lookup; the text is parsed with parse_form25_class. A missing or unparsed
    class leaves security_class unset so last_trade fails closed."""
    lookup = form25_classes
    if lookup is not None and not callable(lookup):
        lookup = lookup.get
    events = []
    for row in _rows(submissions):
        form = row["form"]
        if form not in END_FORMS and form != ITEM_FORM:
            continue
        event = {"form": form,
                 "date": datetime.date.fromisoformat(row["filingDate"]),
                 "accession": row["accessionNumber"]}
        if form == ITEM_FORM:
            items = [i.strip() for i in (row["items"] or "").split(",")]
            items = [i for i in items if i in last_trade.ACQUISITION_ITEMS]
            if not items:
                continue
            event["items"] = items
        elif form in last_trade.DELISTING_FORMS and lookup:
            if parse_form25_class(lookup(row["accessionNumber"])) == last_trade.COMMON:
                event["security_class"] = last_trade.COMMON
        events.append(event)
    return events
