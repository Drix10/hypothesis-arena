"""passive_core: a passive 60/40 core (VTI, IEF) used to exercise the paper
loop end to end. It is the passive benchmark itself, not a promotion
candidate."""
from research.strategy import candidate_wire as W

STRATEGY = "passive_core"
SYMBOLS = ("VTI", "IEF")
TP_MULT = 1.5
MIN_BARS = 21  # ATR(20) needs 20 true ranges


def build(bars, held, month, emitted, now_ns):
    """One BUY candidate per unheld symbol not yet emitted for `month`.

    bars[sym] = list of (high, low, close), oldest first. Returns
    (lines, newly_emitted_keys)."""
    lines, keys = [], []
    for sym in SYMBOLS:
        key = f"{STRATEGY}:{sym}:{month}"
        if (sym in held or key in emitted
                or len(bars.get(sym, ())) < MIN_BARS):
            continue
        hi, lo, cl = zip(*bars[sym])
        entry = cl[-1]
        stop = W.atr_stop(hi, lo, cl)
        lines.append(W.wire_line(STRATEGY, sym, now_ns, entry, stop,
                                 entry * TP_MULT, family="core"))
        keys.append(key)
    return lines, keys
