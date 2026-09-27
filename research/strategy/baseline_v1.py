"""baseline_v1 reference engine (doc 12, exact — never "improved").

Features (exact): RSI(14, Wilder), z-score(20, 2σ on close), ATR(14, Wilder
TR), SMA 20/50 trend filter, session flag (caller-supplied; entries need a
tradeable session), realized 1h-vol bucket (BASE3: stdev of 1h log returns,
trailing 24 vs median of trailing 480; low < 0.5x / high > 2x; 480-bar
warmup; missing bars skipped). Regime: ADX(14, Wilder) > 25 → trend, else
range unless vol bucket high → volatile.

Entries: range + |z| > 2 → mean reversion toward mean; trend + 20>50 +
RSI confirmation (BASE2: long RSI>50 / short RSI<50) → momentum with trend;
volatile → no entry.

Exits (exit_profile_v1): stop 1.5×ATR floored at 0.1% of entry, TP 2R,
mandatory time exit (caller-supplied horizon per asset class).

All functions take bars[..i] slices (index i inclusive) — data after i is
unobservable by construction. Missing bars: the caller passes only real
observations; functions never invent filler.
"""
import math

WARMUP = 480  # BASE3 vol-bucket warmup in bars


def _closes(bars):
    return [b.c for b in bars]


def rsi14(bars, i):
    """Wilder RSI(14) over closes ending at i. None if <15 observations."""
    if i < 14:
        return None
    c0 = _closes(bars[:i + 1])
    g = l = 0.0
    for k in range(1, 15):
        d = c0[k] - c0[k - 1]
        if d > 0:
            g += d
        else:
            l -= d
    ag, al = g / 14.0, l / 14.0
    for k in range(15, len(c0)):
        d = c0[k] - c0[k - 1]
        ag = (ag * 13.0 + (d if d > 0 else 0.0)) / 14.0
        al = (al * 13.0 + (-d if d < 0 else 0.0)) / 14.0
    if al == 0.0:
        return 100.0 if ag > 0.0 else 50.0
    rs = ag / al
    return 100.0 - 100.0 / (1.0 + rs)


def zscore20(bars, i):
    if i < 19:
        return None
    c = _closes(bars[:i + 1])[-20:]
    m = sum(c) / 20.0
    var = sum((x - m) ** 2 for x in c) / 20.0
    if var <= 0.0:
        return 0.0
    return (c[-1] - m) / math.sqrt(var)


def atr14(bars, i):
    if i < 14:
        return None
    trs = []
    for k in range(1, i + 1):
        h, l, pc = bars[k].h, bars[k].l, bars[k - 1].c
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    a = sum(trs[:14]) / 14.0
    for k in range(14, len(trs)):
        a = (a * 13.0 + trs[k]) / 14.0
    return a


def sma(bars, i, n):
    if i < n - 1:
        return None
    return sum(b.c for b in bars[i - n + 1:i + 1]) / n


def adx14(bars, i):
    if i < 27:  # 14 seed + 14 smoothing needs 28 observations minimum
        return None
    pdm, mdm, tr = [], [], []
    for k in range(1, i + 1):
        up = bars[k].h - bars[k - 1].h
        dn = bars[k - 1].l - bars[k].l
        pdm.append(up if up > dn and up > 0 else 0.0)
        mdm.append(dn if dn > up and dn > 0 else 0.0)
        h, l, pc = bars[k].h, bars[k].l, bars[k - 1].c
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    sp, sm, st = sum(pdm[:14]), sum(mdm[:14]), sum(tr[:14])
    dxs = []
    if st > 0:
        dxs.append(100.0 * abs(sp / st - sm / st) / ((sp / st + sm / st) or 1.0))
    for k in range(14, len(tr)):
        sp = (sp * 13.0 + pdm[k]) / 14.0
        sm = (sm * 13.0 + mdm[k]) / 14.0
        st = (st * 13.0 + tr[k]) / 14.0
        if st > 0:
            pd = sp / st
            md = sm / st
            dxs.append(100.0 * abs(pd - md) / ((pd + md) or 1.0))
        else:
            dxs.append(0.0)
    if len(dxs) < 14:
        return None
    return sum(dxs[-14:]) / 14.0


def _log_returns(bars, i):
    out = []
    for k in range(1, i + 1):
        if bars[k - 1].c > 0 and bars[k].c > 0:
            out.append(math.log(bars[k].c / bars[k - 1].c))
    return out


def vol_bucket(bars, i):
    """BASE3 bucket. None during 480-bar warmup. ('low'|'mid'|'high')."""
    if i < WARMUP:
        return None
    rets = _log_returns(bars, i)
    if len(rets) < 24:
        return None
    cur = rets[-24:]
    m = sum(cur) / len(cur)
    cur_sd = math.sqrt(sum((x - m) ** 2 for x in cur) / len(cur))
    base = rets[-WARMUP:]
    med_window = []
    for k in range(len(base) - 23):
        w = base[k:k + 24]
        wm = sum(w) / 24.0
        med_window.append(math.sqrt(sum((x - wm) ** 2 for x in w) / 24.0))
    med = sorted(med_window)[len(med_window) // 2]
    if med <= 0:
        return "mid"
    if cur_sd < 0.5 * med:
        return "low"
    if cur_sd > 2.0 * med:
        return "high"
    return "mid"


def regime(bars, i):
    adx = adx14(bars, i)
    vb = vol_bucket(bars, i)
    if adx is None or vb is None:
        return None
    if vb == "high":
        return "volatile"
    if adx > 25.0:
        return "trend"
    return "range"


def signal(bars, i, session_open: bool):
    """-> (side, family) | None. Pure doc-12 §12.3 entries."""
    if not session_open:
        return None
    rg = regime(bars, i)
    if rg is None or rg == "volatile":
        return None
    z = zscore20(bars, i)
    rsi = rsi14(bars, i)
    s20 = sma(bars, i, 20)
    s50 = sma(bars, i, 50)
    if z is None or rsi is None or s20 is None or s50 is None:
        return None
    if rg == "range" and abs(z) > 2.0:
        return ("SELL" if z > 0 else "BUY", "mean_reversion")
    if rg == "trend":
        if s20 > s50 and rsi > 50.0:
            return ("BUY", "momentum")
        if s20 < s50 and rsi < 50.0:
            return ("SELL", "momentum")
    return None


def exits(entry_px: float, side: str, atr: float):
    """exit_profile_v1: 1.5×ATR stop floored 0.1%, TP 2R. -> (stop, tp, risk)."""
    risk = max(1.5 * atr, 0.001 * entry_px)
    if side == "BUY":
        return (entry_px - risk, entry_px + 2.0 * risk, risk)
    return (entry_px + risk, entry_px - 2.0 * risk, risk)
