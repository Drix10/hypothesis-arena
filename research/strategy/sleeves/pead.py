"""E2-det post-earnings-drift sleeve, built on the E1 mechanics.

An earnings filing accepted on session d is decided at d's close and enters at
the next open; a position exits at the open of the session after `hold`
sessions or after a close below entry - 3 x ATR20. Events carry `sue` and
`pct` (rolling percentile among recent filings). A signal is sue >= min_sue
and pct >= min_pct; larger SUE takes a free slot first. InsiderSleeve already
orders by `value`, filters on `min_value` / `n_insiders`, and applies the
liquidity, stop and slot rules, so events are mapped onto those fields."""
from research.strategy.sleeves.insider import InsiderSleeve


class PeadSleeve(InsiderSleeve):
    def __init__(self, events, raw, adj, sessions, *, min_price,
                 min_dollar_volume, min_sue=1.0, min_pct=0.9, hold=20,
                 slots=5, atr_mult=3.0, never_eligible=()):
        mapped = [dict(e, value=e["sue"],
                       n_insiders=int(e["pct"] >= min_pct)) for e in events]
        super().__init__(mapped, raw, adj, sessions, min_price=min_price,
                         min_dollar_volume=min_dollar_volume,
                         min_value=min_sue, min_insiders=1, hold=hold,
                         slots=slots, atr_mult=atr_mult,
                         never_eligible=never_eligible)
