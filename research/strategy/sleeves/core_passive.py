"""core_passive_v1: a non-alpha 60/40 core (VTI, IEF) that exists to exercise
the paper loop end to end. It is not a promotion candidate: it cannot beat the
passive benchmark it is."""
from research.strategy import candidate_wire as W

SLEEVE = "core_passive_v1"
SYMBOLS = ("VTI", "IEF")
TP_MULT = 1.5


def build(bars, held, month, emitted, now_ns):
    """One BUY candidate per unheld symbol not yet emitted for `month`.

    bars[sym] = list of (high, low, close), oldest first. Returns
    (lines, newly_emitted_keys)."""
    lines, keys = [], []
    for sym in SYMBOLS:
        key = f"{SLEEVE}:{sym}:{month}"
        if sym in held or key in emitted or sym not in bars:
            continue
        hi, lo, cl = zip(*bars[sym])
        entry = cl[-1]
        stop = W.atr_stop(hi, lo, cl)
        lines.append(W.wire_line(SLEEVE, sym, now_ns, entry, stop,
                                 entry * TP_MULT, family="core"))
        keys.append(key)
    return lines, keys
