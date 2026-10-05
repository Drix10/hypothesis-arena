"""GDELT GKG 2.1 co-mention reader (plan/data.md, plan/engine.md 'news' edges).

Pure functions over passed-in text. A record's DATE is the batch time and
becomes known_at. Organisation names resolve to CIKs by normalized exact
match only; ambiguous names resolve to nothing.
"""
import collections
import datetime
import itertools

from sources import ticker_observations

# Tab-separated GKG 2.1 column positions.
_RECORD_ID, _DATE, _SOURCE, _DOC_ID, _THEMES, _ORGS = 0, 1, 3, 4, 8, 14
_MIN_FIELDS = _ORGS + 1
# Documents naming more distinct resolved firms than this are list pages,
# not relationships.
MAX_RESOLVED_ORGS = 20

Row = collections.namedtuple(
    "Row", "record_id known_at source url organizations themes")
Aggregate = collections.namedtuple(
    "Aggregate", "pairs_by_day documents bulk_documents malformed "
                 "mentions resolved ambiguous unknown")


def _organizations(field):
    names = []
    for entry in field.split(";") if field else ():
        name, sep, offset = entry.rpartition(",")
        if not sep or not name.strip() or not offset.strip().isdigit():
            raise ValueError("bad organization entry %r" % (entry,))
        names.append(name.strip())
    return names


def _row(line):
    f = line.split("\t")
    if len(f) < _MIN_FIELDS or not f[_RECORD_ID] or not f[_DOC_ID]:
        raise ValueError("bad field count or identity")
    known_at = datetime.datetime.strptime(f[_DATE], "%Y%m%d%H%M%S")
    themes = [t.split(",")[0] for t in f[_THEMES].split(";") if t]
    return Row(f[_RECORD_ID], known_at, f[_SOURCE], f[_DOC_ID],
               _organizations(f[_ORGS]), themes)


def parse(text):
    """Returns (rows, malformed); a malformed line is skipped and counted."""
    rows, malformed = [], 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            rows.append(_row(line))
        except ValueError:
            malformed += 1
    return rows, malformed


def name_index(entries):
    """Normalized name -> CIK, or None when several CIKs share the name.
    entries: (cik, name) pairs covering legal and former names."""
    index = {}
    for cik, name in entries:
        key = ticker_observations.normalize_name(name)
        if not key:
            continue
        if index.setdefault(key, int(cik)) != int(cik):
            index[key] = None
    return index


def aggregate(rows, index, malformed=0):
    """Daily co-mention counts: one per unordered CIK pair per document.
    pairs_by_day maps a date to a Counter of (low_cik, high_cik)."""
    pairs_by_day = collections.defaultdict(collections.Counter)
    bulk = mentions = resolved = ambiguous = unknown = 0
    for row in rows:
        ciks = set()
        for name in row.organizations:
            mentions += 1
            key = ticker_observations.normalize_name(name)
            if key not in index:
                unknown += 1
            elif index[key] is None:
                ambiguous += 1
            else:
                resolved += 1
                ciks.add(index[key])
        if len(ciks) > MAX_RESOLVED_ORGS:
            bulk += 1
        elif len(ciks) >= 2:
            pairs_by_day[row.known_at.date()].update(
                itertools.combinations(sorted(ciks), 2))
    return Aggregate(dict(pairs_by_day), len(rows), bulk, malformed,
                     mentions, resolved, ambiguous, unknown)


def resolution_rate(agg):
    """Resolved organisation mentions over all; None when there are none."""
    return agg.resolved / agg.mentions if agg.mentions else None
