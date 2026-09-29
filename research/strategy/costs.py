"""Paper fill model paper_fill_v1 (doc 06 Locked + doc 12 BASE4).

BUY at mid + one full spread adverse, SELL at mid - one full spread
adverse, min 1bp, full size, flagged simulated. Cost stress multiplies
the spread leg (1x / 1.5x / 2x / 3x); a challenger must win at 2x too.
"""
MIN_COST_BPS = 1.0


def fill_px(side: str, mid: float, spread_bps: float, mult: float = 1.0) -> float:
    bps = max(spread_bps * mult, MIN_COST_BPS)
    if side == "BUY":
        return mid * (1.0 + bps / 10000.0)
    if side == "SELL":
        return mid * (1.0 - bps / 10000.0)
    raise ValueError("side must be BUY/SELL")
