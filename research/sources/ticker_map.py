"""Point-in-time CIK to ticker map over dated observations (plan/data.md).

Pure functions over passed-in observation lists. An observation is visible
only once known_at <= as_of; sources are tried in SOURCES order, except
that a corporate action dated after the latest cover page wins.
"""
import collections
import datetime

SOURCES = ("dei", "corp_action", "form4", "former_name")
# The 5% rule: more excluded firm-dates than this voids a run.
MAX_UNRESOLVED_SHARE = 0.05

Observation = collections.namedtuple(
    "Observation", "cik symbol source observed_date known_at")


class TickerMapError(ValueError):
    pass


def observation(cik, symbol, source, observed_date, known_at):
    if source not in SOURCES:
        raise TickerMapError("unknown source %r" % (source,))
    if not symbol or not isinstance(symbol, str):
        raise TickerMapError("bad symbol %r" % (symbol,))
    for d in (observed_date, known_at):
        if not isinstance(d, datetime.date):
            raise TickerMapError("bad date %r" % (d,))
    return Observation(int(cik), symbol.upper(), source, observed_date, known_at)


def _pick(source, obs, as_of):
    """The observation a source offers for as_of, or None."""
    if source == "form4":
        # Nearest either side; the earlier date wins a tie.
        return min(obs, key=lambda o: (abs((o.observed_date - as_of).days),
                                       o.observed_date, o.symbol),
                   default=None)
    past = [o for o in obs if o.observed_date <= as_of]
    return max(past, key=lambda o: (o.observed_date, o.known_at, o.symbol),
               default=None)


def ticker(observations, cik, as_of):
    """The symbol for cik at as_of using only observations known by as_of,
    or None when no source resolves it."""
    cik = int(cik)
    visible = [o for o in observations
               if o.cik == cik and o.known_at <= as_of]
    hits = {s: _pick(s, [o for o in visible if o.source == s], as_of)
            for s in SOURCES}
    dei, action = hits["dei"], hits["corp_action"]
    # A symbol change after the latest cover page supersedes it.
    if dei and action and action.observed_date > dei.observed_date:
        return action.symbol
    for source in SOURCES:
        if hits[source] is not None:
            return hits[source].symbol
    return None


def resolve(observations, firm_dates):
    """Map each (cik, as_of) to its symbol. Returns (symbols, unresolved),
    where unresolved counts the firm-dates mapped to None."""
    symbols = {}
    unresolved = 0
    for cik, as_of in firm_dates:
        sym = ticker(observations, cik, as_of)
        symbols[(int(cik), as_of)] = sym
        if sym is None:
            unresolved += 1
    return symbols, unresolved


def exceeds_exclusion_limit(unresolved, total):
    return total > 0 and unresolved / total > MAX_UNRESOLVED_SHARE
