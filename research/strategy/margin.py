"""Margin-account ledger for the US constraint set: signed whole-share
positions, Reg T initial margin, maintenance margin, borrow, margin interest and
short dividends (plan/math.md, plan/risk.md). Short proceeds stay in cash and earn
no rebate."""
import math
from dataclasses import dataclass

from research.strategy import costs as C


class MarginError(ValueError):
    pass


@dataclass(frozen=True)
class MarginTerms:
    margin_rate: float  # broker's published annual rate on a debit balance
    borrow_rate: float = C.ETB_BORROW_RATE
    initial: float = 0.5  # Reg T: 50% deposit on longs, 150% on shorts
    maint_long: float = 0.30
    maint_short_pct: float = 0.30
    maint_short_floor: float = 5.0  # USD per share
    gross_max: float = 1.5

    def __post_init__(self):
        for v in (self.margin_rate, self.borrow_rate, self.initial,
                  self.maint_long, self.maint_short_pct,
                  self.maint_short_floor, self.gross_max):
            if not (isinstance(v, (int, float)) and math.isfinite(v)
                    and v >= 0):
                raise MarginError("bad-terms")


class MarginLedger:
    def __init__(self, cash, terms):
        if not math.isfinite(cash) or cash <= 0:
            raise MarginError("bad-cash")
        self.cash = float(cash)  # includes short proceeds
        self.shares = {}  # signed
        self.terms = terms

    def value(self, px):
        return sum(q * px[s] for s, q in self.shares.items())

    def equity(self, px):
        return self.cash + self.value(px)

    def gross(self, px):
        return sum(abs(q) * px[s] for s, q in self.shares.items())

    def short_value(self, px):
        return sum(-q * px[s] for s, q in self.shares.items() if q < 0)

    def initial_requirement(self, px):
        return self.terms.initial * self.gross(px)

    def maintenance_requirement(self, px):
        t = self.terms
        req = 0.0
        for s, q in self.shares.items():
            if q > 0:
                req += t.maint_long * q * px[s]
            else:
                req += -q * max(t.maint_short_floor,
                                t.maint_short_pct * px[s])
        return req

    def trade(self, sym, signed_qty, cash_delta):
        """Apply a fill: `signed_qty` > 0 buys, < 0 sells; `cash_delta` is the
        net cash change after fees."""
        if not isinstance(signed_qty, int) or signed_qty == 0 \
                or not math.isfinite(cash_delta):
            raise MarginError("bad-trade")
        q = self.shares.get(sym, 0) + signed_qty
        self.cash += cash_delta
        if q == 0:
            self.shares.pop(sym, None)
        else:
            self.shares[sym] = q

    def accrue_carry(self, px, days):
        """Borrow on the short value and interest on the debit balance for
        `days` calendar days; returns the USD charged."""
        fee = (C.borrow_fee_usd(self.short_value(px), days,
                                self.terms.borrow_rate)
               + C.margin_interest_usd(-self.cash, days,
                                       self.terms.margin_rate))
        self.cash -= fee
        return fee

    def dividend(self, sym, per_share):
        """Credit a long, charge a short; returns the signed cash change."""
        q = self.shares.get(sym, 0)
        if q == 0 or per_share == 0:
            return 0.0
        amt = C.dividend_credit(q, per_share) if q > 0 \
            else -C.short_dividend_usd(-q, per_share)
        self.cash += amt
        return amt
