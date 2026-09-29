"""Market-data plumbing for the deterministic strategy stack (stdlib only).

Bars are 1h observations. Missing bars are MISSING (gaps) — never
interpolated, never zero-filled (doc 05 K3 / doc 12 BASE3). Every indicator
at index i uses only bars[..i] (leakage-hostile by construction: the slice
is the enforcement).
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Bar:
    ts_ns: int
    o: float
    h: float
    l: float
    c: float
    dollar_volume: float = 0.0   # equities liquidity filter; 0 = unknown
    spread_bps: float = 0.0      # entry spread filter; 0 = unknown
