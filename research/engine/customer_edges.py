"""Customer and supplier edges for the link graph (plan/engine.md, supply_chain
source): a per-year coverage check and a deterministic regex extractor over
10-K text. A name that is unresolved or ambiguous yields no edge. Stdlib only,
no I/O, no clock reads."""
import calendar
import datetime
import re

from research.sources import ticker_map

AGE_OUT_MONTHS = 18

_WORD = r"[A-Z][A-Za-z0-9&'\-]*\.?"
_NAME = r"%s(?:[ \t]+%s)*" % (_WORD, _WORD)
_LIST = r"%s(?:(?:,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+)%s)*" % (_NAME, _NAME)
_PCT = r"(\d+(?:\.\d+)?)[ \t]*%"
_BASIS = r"(?:(?:our|the|its|Company's|total|net|consolidated)[ \t]+)*"
_SPLIT = re.compile(r",[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+")
_SUFFIXES = frozenset(("inc", "incorporated", "corp", "corporation", "co",
                       "company", "ltd", "limited", "llc", "plc", "lp",
                       "holdings", "group", "the"))

# (relation, pattern, group of the name text, group of the share or None)
_PATTERNS = (
    ("customer", re.compile(
        r"(%s),?[ \t]+(?:which[ \t]+)?(?:each[ \t]+)?accounted[ \t]+for"
        r"[ \t]+(?:approximately[ \t]+|about[ \t]+)?%s[ \t]+of[ \t]+%s"
        r"(?:revenues?|sales)" % (_NAME, _PCT, _BASIS)), 1, 2),
    ("customer", re.compile(
        r"\b(?:sold|sells?|sales)[ \t]+(?:[a-z]+[ \t]+){0,3}to[ \t]+(%s)"
        % _LIST), 1, None),
    ("customer", re.compile(
        r"\bcustomers[ \t]+(?:include|including|are|were)[ \t]+(%s)"
        % _LIST), 1, None),
    ("supplier", re.compile(
        r"\b(?:purchases?|purchased|buys?|sources?|sourced|obtains?|"
        r"obtained|procures?|procured)\b[^.;]{0,80}?\bfrom[ \t]+(%s)"
        % _LIST), 1, None),
    ("supplier", re.compile(r"\bsupplied[ \t]+by[ \t]+(%s)" % _LIST),
     1, None),
    ("supplier", re.compile(
        r"(%s)[ \t]+(?:is|are)[ \t]+(?:our|a|the)[ \t]+(?:sole|single|"
        r"primary|principal|key|major)[ \t]+(?:source[ \t]+)?suppliers?"
        % _NAME), 1, None),
    ("supplier", re.compile(
        r"(%s)[ \t]+supplies[ \t]+(?:us|the[ \t]+Company)" % _NAME),
     1, None),
)
# A disclosed percentage with no name still counts as customer coverage
# ("Customer A accounted for 12% of revenue").
_ANON_PCT = re.compile(
    r"accounted[ \t]+for[^.]{0,60}?%s[ \t]+of[ \t]+%s(?:revenues?|sales)"
    % (_PCT, _BASIS))


def normalise_name(text):
    """Lowercase alphanumeric words with legal suffixes dropped."""
    words = re.findall(r"[a-z0-9]+", text.lower().replace("&", " and "))
    while words and words[-1] in _SUFFIXES:
        words.pop()
    while words and words[0] in _SUFFIXES:
        words.pop(0)
    return " ".join(words)


def mentions(text):
    """Counterparty mentions as dicts {name, relation, share, start, end},
    share a fraction or None, ordered by position."""
    found = []
    for relation, pat, name_group, share_group in _PATTERNS:
        for m in pat.finditer(text):
            share = float(m.group(share_group)) / 100 if share_group else None
            base = m.start(name_group)
            offset = 0
            for part in _SPLIT.split(m.group(name_group)):
                start = base + m.group(name_group).index(part, offset)
                offset = start - base + len(part)
                found.append({"name": part.rstrip("."), "relation": relation,
                              "share": share, "start": start,
                              "end": start + len(part.rstrip("."))})
    return sorted(found, key=lambda f: (f["start"], f["relation"]))


def _cik(value):
    return "%010d" % int(value)


def resolve_name(name, aliases, observations, as_of):
    """CIK string for a name, or None when it is unknown, not in the
    point-in-time ticker map at as_of, or has more than one candidate.

    aliases maps normalise_name output to a list of ciks. The longest word
    span of the name with an alias hit wins, so "Our customer Apple Inc"
    still finds "apple".
    """
    words = normalise_name(name).split()
    for size in range(len(words), 0, -1):
        ciks = set()
        for i in range(len(words) - size + 1):
            for cik in aliases.get(" ".join(words[i:i + size]), ()):
                if ticker_map.ticker(observations, cik, as_of) is not None:
                    ciks.add(_cik(cik))
        if ciks:
            return ciks.pop() if len(ciks) == 1 else None
    return None


def _date(day):
    return datetime.date(day // 10000, day // 100 % 100, day % 100)


def _add_months(day, months):
    y, m, d = day // 10000, day // 100 % 100, day % 100
    m0 = m - 1 + months
    y, m = y + m0 // 12, m0 % 12 + 1
    return y * 10000 + m * 100 + min(d, calendar.monthrange(y, m)[1])


def edges(filings, aliases, observations):
    """Edge dicts for LinkStore.add.

    `filings` is a list of {cik, accession, text, filed}; filed is the
    acceptance date as a YYYYMMDD integer. Each edge runs from the filer to
    the counterparty with type customer or supplier. weight is the largest
    disclosed revenue share (a fraction) in the filing, else 1. known_at and
    valid_from are the acceptance date; valid_to is 18 months later, so an
    edge ages out unless a newer filing repeats it. A name that resolves to
    no single ticker-mapped firm, or to the filer itself, yields no edge.
    """
    out = []
    for f in sorted(filings, key=lambda f: (f["filed"], f["accession"])):
        src, as_of = _cik(f["cik"]), _date(f["filed"])
        grouped = {}
        for m in mentions(f["text"]):
            dst = resolve_name(m["name"], aliases, observations, as_of)
            if dst is None or dst == src:
                continue
            g = grouped.setdefault((dst, m["relation"]), {"shares": [],
                                                          "spans": []})
            if m["share"] is not None:
                g["shares"].append(m["share"])
            g["spans"].append("%s:%d-%d" % (f["accession"], m["start"],
                                            m["end"]))
        for (dst, relation), g in sorted(grouped.items()):
            out.append({
                "edge_id": "supply_chain:%s:%s:%s:%s" % (
                    src, dst, relation, f["accession"]),
                "src_cik": src, "dst_cik": dst,
                "source": "supply_chain", "type": relation,
                "weight": max(g["shares"]) if g["shares"] else 1,
                "valid_from": f["filed"],
                "valid_to": _add_months(f["filed"], AGE_OUT_MONTHS),
                "known_at": f["filed"],
                "evidence_ids": g["spans"],
                "extractor": "deterministic",
                "contamination_class": "deterministic",
            })
    return out


def coverage(filings):
    """{year: {filings, covered, share}} for filings of {year, text}.

    A filing is covered when it names any customer or discloses a
    major-customer percentage, resolved or not, so the share measures what
    the filing offers the extractor.
    """
    counts = {}
    for f in filings:
        row = counts.setdefault(f["year"], [0, 0])
        row[0] += 1
        text = f["text"]
        if any(m["relation"] == "customer" for m in mentions(text)) \
                or _ANON_PCT.search(text):
            row[1] += 1
    return {y: {"filings": n, "covered": c, "share": c / n}
            for y, (n, c) in sorted(counts.items())}


def precision(labeled, aliases, observations):
    """Precision and recall of edges() on labeled fixtures.

    `labeled` is a list of {cik, accession, text, filed, expected} where
    expected is a set of (dst_cik, type) pairs. Precision is None when no
    edge is emitted. This scores fixtures only; the 200-filing audit is a
    separate human-labeled run.
    """
    emitted = tp = want = 0
    for f in labeled:
        got = {(e["dst_cik"], e["type"])
               for e in edges([f], aliases, observations)}
        expected = {(_cik(c), t) for c, t in f["expected"]}
        emitted += len(got)
        tp += len(got & expected)
        want += len(expected)
    return {"emitted": emitted, "true_positive": tp, "expected": want,
            "precision": tp / emitted if emitted else None,
            "recall": tp / want if want else None}
