"""Filing Change signal (plan/strategies.md, plan/math.md Text change): per
filing, Delta = 1 - cosine of term-frequency vectors of Item 1A and MD&A
(Item 7) against the same filer's prior-year filing of the same form, with
litigation and CEO/CFO sub-scores. Consumes filing_sections.Result."""
import math
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

SECTIONS = ("1A", "7")
PRIOR_DAYS = (330, 400)  # period-end gap that counts as the prior year

_WORD = re.compile(r"[a-z]+")
_SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")
_LITIGATION = re.compile(
    r"\b(litigation|lawsuits?|legal proceedings?|class action|plaintiffs?|"
    r"subpoenas?|settlements?|indemnif\w*|injunctions?)\b", re.IGNORECASE)
_OFFICER = re.compile(
    r"\b(ceo|cfo|chief executive|chief financial|principal executive|"
    r"principal financial)\b", re.IGNORECASE)


class TextChangeError(ValueError):
    pass


@dataclass
class Filing:
    cik: str
    form: str
    period: str      # period of report, YYYY-MM-DD
    accepted: str    # SEC acceptance datetime, ISO 8601 with offset
    result: object   # filing_sections.Result


def _when(s):
    try:
        t = datetime.fromisoformat(s)
    except ValueError:
        raise TextChangeError("bad-datetime") from None
    if t.tzinfo is None:
        raise TextChangeError("naive-datetime")
    return t


def _vector(text):
    return Counter(_WORD.findall(text.lower()))


def _cosine(a, b):
    if not a or not b:
        return None
    dot = sum(n * b[w] for w, n in a.items() if w in b)
    return dot / (math.sqrt(sum(n * n for n in a.values()))
                  * math.sqrt(sum(n * n for n in b.values())))


def _delta(a, b):
    c = _cosine(a, b)
    return None if c is None else max(0.0, 1.0 - c)


def _focus(text, pattern):
    return _vector(" ".join(s for s in _SENTENCE.split(text) if pattern.search(s)))


def _texts(filing):
    r = filing.result
    if r.reason or any(i not in r.sections for i in SECTIONS):
        return None
    return {i: r.section_text(i) for i in SECTIONS}


def _prior(filing, history, accepted):
    gap_lo, gap_hi = PRIOR_DAYS
    period = datetime.fromisoformat(filing.period)
    best = None
    for h in history:
        if h.cik != filing.cik or h.form != filing.form:
            continue
        if _when(h.accepted) >= accepted:
            continue
        gap = (period - datetime.fromisoformat(h.period)).days
        if gap_lo <= gap <= gap_hi and (
                best is None or _when(h.accepted) > _when(best.accepted)):
            best = h
    return best


def score(filing, history):
    """Return {known_at, delta, sections, litigation, officer} or None.
    `delta` is the mean of the Item 1A and Item 7 deltas; `litigation` and
    `officer` are the same delta over sentences matching the language and are
    None where either year has none. A filing with a missing or unparsed
    section, no prior-year counterpart accepted before it, or an empty section
    gives None. `known_at` is the filing's acceptance time; only history
    accepted strictly earlier is used."""
    accepted = _when(filing.accepted)
    cur = _texts(filing)
    if cur is None:
        return None
    prior = _prior(filing, history, accepted)
    prev = _texts(prior) if prior else None
    if prev is None:
        return None
    sections = {i: _delta(_vector(cur[i]), _vector(prev[i])) for i in SECTIONS}
    if any(d is None for d in sections.values()):
        return None

    def sub(pattern):
        ds = [_delta(_focus(cur[i], pattern), _focus(prev[i], pattern))
              for i in SECTIONS]
        ds = [d for d in ds if d is not None]
        return sum(ds) / len(ds) if ds else None

    return {"known_at": filing.accepted,
            "delta": sum(sections.values()) / len(SECTIONS),
            "sections": sections,
            "litigation": sub(_LITIGATION),
            "officer": sub(_OFFICER)}
