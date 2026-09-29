"""E1 insider-purchase sleeve: hold the opportunistic-buy names of the last
21 sessions, up to a fixed number of equal slots.

A signal filed on session d is decided at d's close and enters at the next
open; a position exits at the open of its 22nd session or after a close below
entry - 3 x ATR20. `raw` (price and volume as traded) drives the liquidity
filter; `adj` (split adjusted) drives returns and ATR. Symbols in
`never_eligible` have data but never passed the liquidity filter, so their
events count as ineligible rather than as missing data."""
import bisect
import statistics

MIN_HISTORY = 40


class InsiderSleeve:
    def __init__(self, events, raw, adj, sessions, *, min_price,
                 min_dollar_volume, min_value=25000.0, min_insiders=1,
                 hold=21, slots=5, atr_mult=3.0, never_eligible=()):
        self.raw, self.adj = raw, adj
        self.never = frozenset(never_eligible)
        self.sessions = sessions
        self.idx = {d: i for i, d in enumerate(sessions)}
        self.p = dict(min_price=min_price, min_dv=min_dollar_volume,
                      min_value=min_value, min_insiders=min_insiders,
                      hold=hold, slots=slots, atr_mult=atr_mult)
        self.dates = {s: sorted(b) for s, b in raw.items()}
        self.by_session = {}
        for e in events:
            i = bisect.bisect_left(sessions, e["date"])
            if i < len(sessions):
                self.by_session.setdefault(i, []).append(e)
        self.held = {}
        self.stats = dict(events=0, considered=0, no_data=0, ineligible=0,
                          skipped_full=0, entered=0, stopped=0, orphan=0)
        self._last = None

    def _bars(self, sym, d, n):
        ds = self.dates.get(sym)
        if not ds:
            return None
        j = bisect.bisect_right(ds, d)
        return ds[max(0, j - n):j] if j else None

    def _eligible(self, sym, d):
        ds = self._bars(sym, d, 60)
        if not ds or ds[-1] != d or len(ds) < MIN_HISTORY:
            return None
        rows = [self.raw[sym][x] for x in ds]      # (open, close, volume)
        if rows[-1][1] < self.p["min_price"]:
            return False
        dv = statistics.median(c * v for _, c, v in rows)
        return dv >= self.p["min_dv"]

    def _stop(self, sym, d):
        ds = self._bars(sym, d, 21)
        a = self.adj.get(sym, {})
        if not ds or len(ds) < 21 or any(x not in a for x in ds):
            return None
        tr = []
        for k in range(1, len(ds)):
            _, h, lo, c = a[ds[k]]
            pc = a[ds[k - 1]][3]
            tr.append(max(h - lo, abs(h - pc), abs(lo - pc)))
        return a[ds[-1]][3] - self.p["atr_mult"] * sum(tr) / len(tr)

    def target_fn(self, d, _closes):
        i = self.idx[d]
        before = set(self.held)
        for s, h in list(self.held.items()):
            bar = self.adj.get(s, {}).get(d)
            if i >= h["entry"] + self.p["hold"] - 1:
                del self.held[s]
                self.stats["orphan"] += bar is None
            elif bar and bar[3] < h["stop"]:
                del self.held[s]
                self.stats["stopped"] += 1
        cand = sorted(self.by_session.get(i, []), key=lambda e: -e["value"])
        for e in cand:
            self.stats["events"] += 1
            s = e["symbol"]
            if e["value"] < self.p["min_value"] or \
                    e["n_insiders"] < self.p["min_insiders"] or s in self.held:
                self.stats["ineligible"] += 1
                continue
            self.stats["considered"] += 1
            if s in self.never:
                self.stats["ineligible"] += 1
                continue
            ok = self._eligible(s, d)
            stop = self._stop(s, d) if ok else None
            if ok is None or (ok and stop is None):
                self.stats["no_data"] += 1
            elif not ok:
                self.stats["ineligible"] += 1
            elif len(self.held) >= self.p["slots"]:
                self.stats["skipped_full"] += 1
            else:
                self.held[s] = {"entry": i + 1, "stop": stop}
                self.stats["entered"] += 1
        if set(self.held) == before:
            return None
        w = 1.0 / self.p["slots"]
        return {s: w for s in self.held}
