"""Cash-account settlement (R18): T+1 proceeds, buys funded only from settled
cash, whole shares, long only."""
import math

EPS = 1e-9


class SettlementError(ValueError):
    pass


def _whole(q):
    return isinstance(q, int) and not isinstance(q, bool) and q > 0


def _finite_pos(x):
    return isinstance(x, (int, float)) and math.isfinite(x) and x > 0


class CashLedger:
    def __init__(self, sessions, cash):
        s = list(sessions)
        if len(s) < 2 or s != sorted(set(s)):
            raise SettlementError("sessions-must-be-sorted-unique")
        if not math.isfinite(cash) or cash < 0:
            raise SettlementError("negative-cash")
        self.sessions = s
        self._pos = {d: i for i, d in enumerate(s)}
        self.settled = float(cash)
        self.pending = []  # (settle_index, amount)
        self.shares = {}
        self.today = 0

    @property
    def date(self):
        return self.sessions[self.today]

    def unsettled(self):
        return sum(a for _, a in self.pending)

    def total_cash(self):
        return self.settled + self.unsettled()

    def advance(self, date):
        """Move to `date` (must be a later session); settle due proceeds."""
        if date not in self._pos or self._pos[date] <= self.today:
            raise SettlementError("bad-advance")
        self.today = self._pos[date]
        due = [a for i, a in self.pending if i <= self.today]
        self.pending = [(i, a) for i, a in self.pending if i > self.today]
        self.settled += sum(due)

    def can_buy(self, notional):
        return 0 < notional <= self.settled + EPS

    def buy(self, sym, qty, notional):
        if not _whole(qty) or not _finite_pos(notional):
            raise SettlementError("bad-buy")
        if notional > self.settled + EPS:
            raise SettlementError("r18-insufficient-settled-cash")
        self.settled = max(0.0, self.settled - notional)
        self.shares[sym] = self.shares.get(sym, 0) + qty

    def sell(self, sym, qty, proceeds):
        held = self.shares.get(sym, 0)
        if not _whole(qty) or not math.isfinite(proceeds) or proceeds < 0:
            raise SettlementError("bad-sell")
        if qty > held:
            raise SettlementError("short-sale-refused")
        if self.today + 1 >= len(self.sessions):
            raise SettlementError("no-settlement-session")
        self.shares[sym] = held - qty
        if self.shares[sym] == 0:
            del self.shares[sym]
        self.pending.append((self.today + 1, proceeds))

    def close_out(self, sym, proceeds):
        """Delisting: the whole position leaves for `proceeds`, settled at once
        because the issuer, not a trade, pays it."""
        if not math.isfinite(proceeds) or proceeds < 0 or sym not in self.shares:
            raise SettlementError("bad-close-out")
        del self.shares[sym]
        self.settled += proceeds

    def credit(self, amount):
        """Dividends: cash on receipt (already settled by the issuer)."""
        if not math.isfinite(amount) or amount < 0:
            raise SettlementError("bad-credit")
        self.settled += amount

    def accrue(self, amount):
        """Signed yield on idle cash (a total-return series can dip)."""
        if not math.isfinite(amount):
            raise SettlementError("bad-accrual")
        self.settled = max(0.0, self.settled + amount)
