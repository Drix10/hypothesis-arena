"""Monthly-tranche book (plan/math.md Tranches). At each month's last session
one tranche is re-ranked and replaces the tranche opened `horizon` months
earlier; the sum of the live tranches is the signed target for portfolio.run."""
import math


class TrancheError(ValueError):
    pass


class Tranches:
    """Callable target_fn for portfolio.run(margin=...); use one instance per
    run. `weight_fn(date, closes)` returns {sym: signed weight} for a fresh
    tranche with at least `min_names` longs and shorts. Each tranche is scaled
    to gross `gross / horizon`, so the sum never exceeds `gross`."""

    def __init__(self, sessions, weight_fn, horizon=3, gross=1.5,
                 min_names=15):
        if not (isinstance(horizon, int) and horizon >= 1):
            raise TrancheError("bad-horizon")
        if not (math.isfinite(gross) and gross > 0):
            raise TrancheError("bad-gross")
        if not (isinstance(min_names, int) and min_names >= 1):
            raise TrancheError("bad-min-names")
        self.weight_fn = weight_fn
        self.horizon = horizon
        self.gross = gross
        self.min_names = min_names
        self.month_ends = {a for a, b in zip(sessions, sessions[1:])
                           if a[:7] != b[:7]}
        self.slots = {}
        self.opened = 0

    def __call__(self, date, closes):
        if date not in self.month_ends:
            return None
        self.slots[self.opened % self.horizon] = self._tranche(date, closes)
        self.opened += 1
        book = {}
        for w in self.slots.values():
            for s, x in w.items():
                book[s] = book.get(s, 0.0) + x
        return book

    def _tranche(self, date, closes):
        raw = {s: x for s, x in self.weight_fn(date, closes).items() if x}
        longs = sum(1 for x in raw.values() if x > 0)
        if longs < self.min_names or len(raw) - longs < self.min_names:
            raise TrancheError("too-few-names")
        scale = self.gross / self.horizon / sum(abs(x) for x in raw.values())
        return {s: x * scale for s, x in raw.items()}
