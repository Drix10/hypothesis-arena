"""Cash-account settlement simulation (doc 11 §11.0d, doc 06 §6.0b, R18).

T+1 on the supplied session calendar. A BUY may only be funded from
SETTLED cash (fail closed: no margin, no unsettled-proceeds purchases, so
good-faith and free-riding violations cannot occur by construction). SELL
proceeds settle on the next session. Long only: selling more than held is
an error. Stdlib only.
"""


class SettlementError(ValueError):
    pass


class CashLedger:
    def __init__(self, sessions, cash):
        s = list(sessions)
        if len(s) < 2 or s != sorted(set(s)):
            raise SettlementError("sessions-must-be-sorted-unique")
        if cash < 0:
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
        return 0 < notional <= self.settled + 1e-9

    def buy(self, sym, qty, notional):
        if qty <= 0 or notional <= 0:
            raise SettlementError("bad-buy")
        if notional > self.settled + 1e-9:
            raise SettlementError("r18-insufficient-settled-cash")
        self.settled -= notional
        self.shares[sym] = self.shares.get(sym, 0) + qty

    def sell(self, sym, qty, proceeds):
        held = self.shares.get(sym, 0)
        if qty <= 0 or proceeds < 0:
            raise SettlementError("bad-sell")
        if qty > held:
            raise SettlementError("short-sale-refused")
        if self.today + 1 >= len(self.sessions):
            raise SettlementError("no-settlement-session")
        self.shares[sym] = held - qty
        if self.shares[sym] == 0:
            del self.shares[sym]
        self.pending.append((self.today + 1, proceeds))

    def credit(self, amount):
        """Dividends: cash on receipt (already settled by the issuer)."""
        if amount < 0:
            raise SettlementError("bad-credit")
        self.settled += amount
