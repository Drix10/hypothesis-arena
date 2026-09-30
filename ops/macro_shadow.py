"""Log-only "macro-lite" shadow ledger `macro_lite_v1` (doc 11, Macro data).

Preregistered signal, fixed here before any forward row exists; no tuning:

  base    60/40 VTI/IEF (the core_passive_v1 weights).
  tilt    equity/bond split moves by TILT = 10 percentage points:
            +10 (VTI 70 / IEF 30) when the 1-year change in the 2-year
                 Treasury yield (FRED DGS2) is negative (easing) AND the
                 1-year VTI return is positive;
            -10 (VTI 50 / IEF 50) when the 1-year DGS2 change is positive AND
                 the 1-year VTI return is negative;
             0  otherwise (a change or return of exactly 0 is "otherwise").
  when    decided at each month-end close (the last session of a calendar
          month); the target is held until the next month-end, and the
          portfolio rebalances to it at the next open through
          research/strategy/portfolio.run with the default cost_v2 model,
          exactly as ops/sleeve_shadow.py does. Before the first month-end
          with a full year of history the base 60/40 is held (warm-up only).

Point-in-time rules. VTI return: close on the decision date D over the last
close at or before D minus one calendar year. DGS2: FRED publishes each day's
yield the next business day and never revises it, so no vintage query is
needed; conservatively the decision uses only the latest observation dated on
or before the business day BEFORE D (weekday arithmetic; holidays only make it
older), and the year-ago leg is the latest observation on or before that
observation's date minus one year. An anchor observation more than 7 days old,
or a year-ago leg more than 10 days before its target, is a data gap: inside the
forward window the sleeve is skipped (never a partial row); in warm-up history
the tilt is simply 0.

Event-risk flags (FOMC/CPI/NFP days): NOT produced. The repo carries only the
release-key -> symbol map (collector/entity_map.json) and event feeds, no dated
FOMC/CPI/NFP calendar, and dates are not invented here.

FRED_API_KEY is read through collector.config (env or repo .env). A missing key
or a failed pull skips the sleeve with one stderr JSON line; nothing is
written. No orders, no broker calls.

    python3 ops/macro_shadow.py <dir>            # append missing sessions
    python3 ops/macro_shadow.py <dir> --verify   # replay must equal the log
"""
import bisect
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ops import sleeve_shadow as S

SLEEVE_ID = "macro_lite_v1"
SERIES = "DGS2"
BASE = {"VTI": 0.6, "IEF": 0.4}
TILT = 0.10
MAX_ANCHOR_AGE_DAYS = 7
MAX_PRIOR_GAP_DAYS = 10
FRED_START = "2014-12-01"
SPEC = ("macro_lite: 60/40 VTI/IEF +/-10pp on 1y dDGS2 & 1y VTI, month-end; "
        "event_flags=unavailable(no dated calendar)")


class Skip(Exception):
    """Inputs incomplete or unavailable; the sleeve is skipped this run."""


def _log(msg):
    print(json.dumps({"macro_sleeve": msg}, sort_keys=True), file=sys.stderr)


def _d(s):
    return datetime.date.fromisoformat(s)


def _year_ago(d):
    try:
        return d.replace(year=d.year - 1)
    except ValueError:  # Feb 29
        return d.replace(year=d.year - 1, day=28)


def prev_business_day(d):
    d -= datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d -= datetime.timedelta(days=1)
    return d


def tilt(dgs2_change, vti_return):
    if dgs2_change < 0 and vti_return > 0:
        return TILT
    if dgs2_change > 0 and vti_return < 0:
        return -TILT
    return 0.0


def weights(t):
    return {"VTI": round(BASE["VTI"] + t, 10), "IEF": round(BASE["IEF"] - t, 10)}


class Series:
    """Sorted (date, value) observations with as-of lookup."""

    def __init__(self, pairs):
        self.d = [p[0] for p in pairs]
        self.v = [p[1] for p in pairs]

    def asof(self, day):
        i = bisect.bisect_right(self.d, day.isoformat())
        return (_d(self.d[i - 1]), self.v[i - 1]) if i else None


def clean_obs(raw):
    """[(date, value)] from fred_get output; '.'/None/non-finite dropped."""
    out = {}
    for d, v in raw:
        try:
            x = float(v)
            _d(d)
        except (TypeError, ValueError):
            continue
        if x == x and abs(x) != float("inf"):
            out[d] = x
    if not out:
        raise Skip("no usable DGS2 observations")
    return Series(sorted(out.items()))


def decide(day, dgs2, vti, forward):
    """Tilt for a month-end decision on `day`, using only data available then.
    Returns (tilt, reason)."""
    def gap(why):
        if forward:
            raise Skip(f"{day}: {why}")
        return 0.0, why
    anchor = dgs2.asof(prev_business_day(day))
    if anchor is None or (prev_business_day(day) - anchor[0]).days > MAX_ANCHOR_AGE_DAYS:
        return gap("DGS2 anchor missing/stale")
    target = _year_ago(anchor[0])
    prior = dgs2.asof(target)
    if prior is None or (target - prior[0]).days > MAX_PRIOR_GAP_DAYS:
        return gap("DGS2 year-ago leg missing")
    px_now = vti.asof(day)
    px_then = vti.asof(_year_ago(day))
    if px_now is None or px_then is None or px_now[0] != day or \
            (_year_ago(day) - px_then[0]).days > MAX_PRIOR_GAP_DAYS:
        return 0.0, "VTI history short"
    return tilt(anchor[1] - prior[1], px_now[1] / px_then[1] - 1.0), "ok"


def make_factory(dgs2, vti, now):
    """factory(sessions) -> target_fn for sleeve_shadow.replay."""
    def factory(sessions):
        month_end = {}
        for i, s in enumerate(sessions):
            nxt = sessions[i + 1] if i + 1 < len(sessions) else None
            if nxt is not None:
                month_end[s] = nxt[:7] != s[:7]
            else:  # last known session: month-end only once the month is over
                month_end[s] = s[:7] < now.strftime("%Y-%m")
        started = []

        def fn(date, closes):
            if any(not closes.get(s) for s in BASE):
                return None
            if not month_end[date]:
                if started:
                    return None
                started.append(date)
                return dict(BASE)
            started.append(date)
            t, _ = decide(_d(date), dgs2, vti, date >= S.FORWARD_START)
            return weights(t)
        return fn
    return factory


# ------------------------------------------------------------------ FRED I/O

def default_fred_get(series_id, start, end):
    """[(date, value)] via the repo FRED adapter; key from collector.config."""
    from collector import config
    from research.sources import fred
    key = config.load()["values"].get("FRED_API_KEY", "")
    if not key:
        raise Skip("FRED_API_KEY absent")
    obs, err = fred.build(api_key=key).fetch_observations(
        series_id, observation_start=start, observation_end=end)
    if err:
        raise Skip(f"FRED pull failed: {err}")
    return [(o.get("date"), o.get("value")) for o in obs
            if isinstance(o, dict)]


def produce(d, now, prices, fred_get=default_fred_get, log=_log):
    """{sleeve_id: (rows, spec)}; {} (one stderr JSON line) when skipped.
    `prices[sym][date] = (open, close)` must hold VTI and IEF."""
    try:
        if any(not prices.get(s) for s in BASE):
            raise Skip("VTI/IEF prices unavailable")
        obs = fred_get(SERIES, FRED_START, now.date().isoformat())
        dgs2 = clean_obs(obs)
        vti = Series(sorted((k, v[1]) for k, v in prices["VTI"].items()))
        rows = S.replay(SLEEVE_ID, prices, make_factory(dgs2, vti, now),
                        list(BASE))
        if not rows:
            raise Skip("no forward sessions yet")
        return {SLEEVE_ID: (rows, SPEC)}
    except Skip as e:
        log(f"skipped: {e}")
    except Exception as e:  # noqa: BLE001 - degrade, never crash the loop
        log(f"skipped: {type(e).__name__}: {str(e)[:200]}")
    return {}


def run(d, now, verify=False, http_get=S.sip_fetch.default_http_get,
        fred_get=default_fred_get):
    prices = S.fetch_prices(sorted(BASE), now, http_get)
    os.makedirs(os.path.join(d, "sleeves"), exist_ok=True)
    bad, summary = [], {}
    for sid, (fresh, spec) in produce(d, now, prices, fred_get).items():
        S._settle(d, sid, fresh, spec, verify, bad, summary)
    return bad, summary


def main(argv, now=None):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit("usage: macro_shadow.py <dir> [--verify]")
    from research.strategy import a_run
    a_run._load_env()
    n = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        bad, summary = run(args[0], n, verify="--verify" in argv)
    except (ValueError, OSError, S.sip_fetch.SipError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 2
    print(json.dumps({"sleeves": summary, "mismatch": bad}))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
