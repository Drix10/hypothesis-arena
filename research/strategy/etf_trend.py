"""ETF Trend signal (plan/strategies.md, research/prereg/etf_trend.json): the
sign of the 12-month return minus the cash leg, inverse-volatility weights
scaled to a portfolio volatility target. Target for portfolio.run(margin=...).
exposure_scale turns the same trend state into the gross multiplier of the
long-short book (plan/math.md, Exposure scaler)."""
import math

LOOKBACK = 252
MIN_CLOSES = LOOKBACK + 1
TRADING_DAYS = 252
SCALE_FLOOR = 0.0  # math.md: G_t = G * clip(s_t, 0, 1)
SCALE_CEILING = 1.0
# Proposed values (strategies.md Open items: form and rate cap are registered
# with the pre-registration).
TREND_BAND = 0.05  # excess return over which the trend state moves 0 -> 1
RATE_CAP = 0.25  # largest |s_t - s_{t-1}| between rebalances


class EtfTrendError(ValueError):
    pass


def _returns(closes):
    return [b / a - 1.0 for a, b in zip(closes, closes[1:])]


def _stdev(xs):
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


class EtfTrend:
    """Callable target_fn(date, closes) -> {sym: signed weight} on month-end
    sessions, None otherwise; use one instance per run. `closes[sym]` lists
    closes up to `date`. A symbol with fewer than MIN_CLOSES closes, or a flat
    volatility window, is left out and counted in `excluded`; if the cash leg
    is short the target is empty. Weights are scaled so the realised volatility
    of the book over the window equals `target_vol` (annual), then so gross is
    at most `gross_max`. `long_only` sends negative signals to cash."""

    def __init__(self, sessions, universe, cash="BIL", vol_window=63,
                 target_vol=0.10, gross_max=1.5, long_only=False):
        if cash not in universe:
            raise EtfTrendError("cash-not-in-universe")
        if not (isinstance(vol_window, int) and vol_window >= 2):
            raise EtfTrendError("bad-vol-window")
        if not (math.isfinite(target_vol) and target_vol > 0):
            raise EtfTrendError("bad-target-vol")
        if not (math.isfinite(gross_max) and gross_max > 0):
            raise EtfTrendError("bad-gross-max")
        self.symbols = [s for s in universe if s != cash]
        self.cash = cash
        self.vol_window = vol_window
        self.target_vol = target_vol
        self.gross_max = gross_max
        self.long_only = long_only
        self.month_ends = {a for a, b in zip(sessions, sessions[1:])
                           if a[:7] != b[:7]}
        self.excluded = 0

    def __call__(self, date, closes):
        if date not in self.month_ends:
            return None
        bil = closes.get(self.cash, [])
        if len(bil) < MIN_CLOSES:
            self.excluded += len(self.symbols)
            return {}
        cash_ret = bil[-1] / bil[-MIN_CLOSES] - 1.0
        raw, rets = {}, {}
        for s in self.symbols:
            c = closes.get(s, [])
            if len(c) < MIN_CLOSES:
                self.excluded += 1
                continue
            r = _returns(c[-self.vol_window - 1:])
            vol = _stdev(r) * math.sqrt(TRADING_DAYS)
            if not vol > 0:
                self.excluded += 1
                continue
            excess = c[-1] / c[-MIN_CLOSES] - 1.0 - cash_ret
            sign = (excess > 0) - (excess < 0)
            if sign < 0 and self.long_only:
                sign = 0
            if sign:
                raw[s] = sign / vol
                rets[s] = r
        if not raw:
            return {}
        book = [sum(raw[s] * rets[s][i] for s in raw)
                for i in range(self.vol_window)]
        book_vol = _stdev(book) * math.sqrt(TRADING_DAYS)
        if not book_vol > 0:
            return {}
        scale = self.target_vol / book_vol
        gross = scale * sum(abs(x) for x in raw.values())
        if gross > self.gross_max:
            scale *= self.gross_max / gross
        return {s: x * scale for s, x in raw.items()}


def exposure_scale(prices, date, prev, market, cash="BIL", vol_window=63,
                   target_vol=0.10):
    """Gross multiplier in [SCALE_FLOOR, SCALE_CEILING] at rebalance `date`.

    `prices[sym][d] = (open, close)`; only bars dated up to `date` are read.
    The trend state is the market's 12-month excess return over the cash leg,
    mapped linearly through 0.5 at zero excess to 0 and 1 at +-TREND_BAND; it
    is multiplied by min(1, target_vol / trailing realised volatility). The
    result moves at most RATE_CAP from `prev` (None on the first rebalance).
    A missing or stale bar, a short history or a bad price returns
    SCALE_FLOOR immediately: fail closed is not rate limited."""
    try:
        m = _closes(prices[market], date)
        c = _closes(prices[cash], date)
    except (KeyError, TypeError, ValueError, IndexError):
        return SCALE_FLOOR
    if m is None or c is None:
        return SCALE_FLOOR
    excess = m[-1] / m[-MIN_CLOSES] - 1.0 - (c[-1] / c[-MIN_CLOSES] - 1.0)
    trend = min(1.0, max(0.0, 0.5 + excess / (2.0 * TREND_BAND)))
    vol = _stdev(_returns(m[-vol_window - 1:])) * math.sqrt(TRADING_DAYS)
    if not vol > 0:
        return SCALE_FLOOR
    s = trend * min(1.0, target_vol / vol)
    if prev is not None:
        s = min(prev + RATE_CAP, max(prev - RATE_CAP, s))
    return min(SCALE_CEILING, max(SCALE_FLOOR, s))


def _closes(bars, date):
    """Closes up to `date`, or None when `date` has no bar or history is short."""
    days = sorted(d for d in bars if d <= date)
    if len(days) < MIN_CLOSES or days[-1] != date:
        return None
    closes = [float(bars[d][1]) for d in days[-MIN_CLOSES:]]
    if not all(math.isfinite(x) and x > 0 for x in closes):
        return None
    return closes
