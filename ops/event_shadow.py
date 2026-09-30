"""Forward shadow ledgers for the event sleeves that can be built honestly from
public data: E1 (insider purchases, three prereg variants) and I1 (intraday
momentum, two prereg variants). Log-only; no orders, no broker calls.

`produce` returns {sleeve_id: (rows, spec)} in the ledger schema of
ops/sleeve_shadow.py (date, sleeve, equity, ret, target). Any sleeve that
cannot be computed completely this run is skipped and logged to stderr; a
sleeve never yields a partial row, and its rows are cut at the last session for
which every input was complete, so a later run can only extend the log.

E1 uses the frozen research code (insider_data.build_events, InsiderSleeve,
portfolio.run, a_run_e1 tier parameters) unchanged. Its forward inputs are
pulled from EDGAR: the nightly daily index lists every Form 4, and each
filing's full submission carries the SEC acceptance timestamp (Eastern) and
the transactions. A filing accepted at or after 16:00 ET is known only for the
next session's decision, which is stricter than the A-gate (it keys on the SEC
filing date, which stays the same day for 16:00-17:30 acceptances). The
opportunistic/routine test needs three prior years of insider history; it is
built from SEC's quarterly insider-transaction data sets (compact per-quarter
cache) and a session is not emitted until every quarter it needs is cached.
Only the previous EDGAR day's index is final, so E1 rows lag by a day.

I1 uses intraday_mom.simulate unchanged on SIP 30-minute SPY bars; the rule
reads no bar after its decision time, and only sessions that finished before
the last UTC midnight are used."""
import datetime
import gzip
import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as XML
import zipfile
import zoneinfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from research.strategy import (a_run, a_run_e1, fsds_fetch, insider_data,
                               portfolio, sip_fetch)
from research.strategy.sleeves import intraday_mom

NY = zoneinfo.ZoneInfo("America/New_York")
SIP_DELAY_MIN = 16
DAILY_WARMUP_DAYS = 420        # history for the tercile rule and ATR
BAR_WARMUP_DAYS = 150          # calendar days before FORWARD_START
INDEX_URL = "https://www.sec.gov/Archives/edgar/daily-index/{y}/QTR{q}/form.{d}.idx"
ARCHIVE = "https://www.sec.gov/Archives/"
QUARTER_URLS = (
    "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{y}q{q}_form345.zip",
    "https://www.sec.gov/files/dera/data/insider-transactions-data-sets/{y}q{q}_form345.zip",
)
MAX_FILINGS_PER_RUN = 3000
MAX_QUARTER_DOWNLOADS_PER_RUN = 3
MAX_EVENT_SYMBOLS = 800
LATE_MISSING_DAYS = 7          # a listed filing that stays 404 this long is skipped
EMPTY_INDEX_DAYS = 4           # a session-day index that stays 404 this long is empty
IDX_RE = re.compile(r"^(\S+)\s+.*?\s\d+\s+\d{8}\s+"
                    r"(edgar/data/\d+/(\d{10}-\d{2}-\d{6})\.txt)\s*$")
ACCEPT_RE = re.compile(r"<ACCEPTANCE-DATETIME>\s*(\d{14})")
E1_IDS = {"tierA_opp": "insider_tierA_opp_v1",
          "tierB_opp": "insider_tierB_opp_v1",
          "tierA_cluster": "insider_tierA_cluster_v1"}
I1_IDS = {"pos": "intraday_mom_pos_v1",
          "top_tercile": "intraday_mom_top_tercile_v1"}


class EdgarMissing(Exception):
    pass


class EdgarError(Exception):
    pass


class Incomplete(Exception):
    """Inputs are not complete yet; the sleeve stops at the last complete day."""


def _log(msg):
    print(json.dumps({"event_sleeve": msg}, sort_keys=True), file=sys.stderr)


# ---------------------------------------------------------------- EDGAR I/O

def default_edgar_get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def edgar_client(ua, http_get=default_edgar_get, sleep=time.sleep, tries=4,
                 gap=0.15):
    """get(url) -> bytes. Polite: one request at a time with a gap, retries
    with backoff on 429/5xx/network errors; 404 raises EdgarMissing, anything
    else after the last retry raises EdgarError."""
    hdr = {"User-Agent": ua, "Accept-Encoding": "identity"}

    def get(url):
        err = None
        for k in range(tries):
            sleep(gap)
            try:
                return http_get(url, hdr)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise EdgarMissing(url)
                err = e
            except (urllib.error.URLError, OSError) as e:
                err = e
            if k < tries - 1:
                sleep(2 ** (k + 1))
        raise EdgarError(f"{url}: {err}")
    return get


def parse_index(text):
    """[(accession, archive path)] of Form 4 (exactly '4') filings in a daily
    form index, one entry per accession."""
    out, seen = [], set()
    for line in text.splitlines():
        m = IDX_RE.match(line)
        if m and m.group(1) == "4" and m.group(3) not in seen:
            seen.add(m.group(3))
            out.append((m.group(3), m.group(2)))
    return out


def _flag(x):
    return (x or "").strip().lower() in ("1", "true")


def _num(x):
    try:
        v = float((x or "").strip().replace(",", ""))
    except ValueError:
        return None
    return v if v > 0 and v == v and v != float("inf") else None


def _norm(cik):
    return str(int(cik)).zfill(10)


def _date(s):
    try:
        return datetime.date.fromisoformat((s or "").strip()[:10])
    except ValueError:
        return None


def parse_form4(text):
    """Full-submission text of a Form 4 -> (accepted ET datetime, rows) or None
    when it is not a parseable plain Form 4. Rows are common-stock open-market
    purchases (code P) per reporting owner, in insider_data.read_quarter's
    shape minus filing_date."""
    m = ACCEPT_RE.search(text)
    a, b = text.find("<XML>"), text.find("</XML>")
    if not m or a < 0 or b < a:
        return None
    body = text[a + 5:b].strip()
    if "<!DOCTYPE" in body or "<!ENTITY" in body:
        return None
    try:
        accepted = datetime.datetime.strptime(m.group(1), "%Y%m%d%H%M%S")
        root = XML.fromstring(body.encode("utf-8"))
        if root.tag != "ownershipDocument" or \
                (root.findtext("documentType") or "").strip() != "4":
            return None
        cik = _norm(root.findtext("issuer/issuerCik"))
        sym = (root.findtext("issuer/issuerTradingSymbol") or "").strip() \
            .strip("\"'").upper()
    except (ValueError, XML.ParseError, TypeError):
        return None
    if not insider_data.SYMBOL_RE.match(sym):
        return accepted, []
    txns = []
    for t in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        if (t.findtext("transactionCoding/transactionCode") or "").strip() != "P":
            continue
        if "common" not in (t.findtext("securityTitle/value") or "").lower():
            continue
        td = _date(t.findtext("transactionDate/value"))
        sh = _num(t.findtext("transactionAmounts/transactionShares/value"))
        px = _num(t.findtext("transactionAmounts/transactionPricePerShare/value"))
        if td and sh and px:
            txns.append((td, sh, px))
    rows = []
    for o in root.findall("reportingOwner"):
        try:
            owner = _norm(o.findtext("reportingOwnerId/rptOwnerCik"))
        except (ValueError, TypeError):
            continue
        rel = o.find("reportingOwnerRelationship")
        off = rel is not None and (_flag(rel.findtext("isOfficer")) or
                                   _flag(rel.findtext("isDirector")))
        for td, sh, px in txns:
            rows.append({"trans_date": td, "cik": cik, "symbol": sym,
                         "owner": owner, "officer_or_director": off,
                         "code": "P", "shares": sh, "price": px})
    return accepted, rows


def effective_date(accepted):
    """Session date whose close first knows a filing accepted at `accepted`
    (ET, naive): the same day before 16:00, else the next calendar day (the
    engine maps a non-session day to the next session)."""
    d = accepted.date()
    if accepted.time() >= datetime.time(16, 0):
        d += datetime.timedelta(days=1)
    return d


# ------------------------------------------------------- daily Form 4 cache

def _atomic_json(path, obj, gz=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as f:
            data = json.dumps(obj, sort_keys=True).encode()
            f.write(gzip.compress(data) if gz else data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _load_json(path, gz=False):
    try:
        with (gzip.open(path, "rb") if gz else open(path, "rb")) as f:
            return json.loads(f.read().decode())
    except (OSError, ValueError):
        return None


def _rows_out(rows):
    return [dict(r, trans_date=r["trans_date"].isoformat()) for r in rows]


def _rows_in(rows):
    return [dict(r, trans_date=datetime.date.fromisoformat(r["trans_date"]))
            for r in rows]


def sync_day(cache, day, sessions, today, edgar, budget):
    """Make the cache for EDGAR day `day` complete. Returns True when complete.
    `budget` is a one-element list holding the filings still fetchable this
    run. A missing index is empty only when the day cannot have filings (not a
    session) or is old enough to be an SEC holiday."""
    path = os.path.join(cache, "days", day.strftime("%Y%m%d") + ".json")
    rec = _load_json(path)
    if rec and rec.get("complete"):
        return True
    if not rec:
        q = (day.month - 1) // 3 + 1
        try:
            text = edgar(INDEX_URL.format(y=day.year, q=q,
                                          d=day.strftime("%Y%m%d"))
                         ).decode("utf-8", "replace")
        except EdgarMissing:
            age = (today - day).days
            if day.isoformat() not in sessions or age >= EMPTY_INDEX_DAYS:
                _atomic_json(path, {"date": day.isoformat(), "listed": [],
                                    "accs": {}, "complete": True})
                return True
            return False
        except EdgarError:
            return False
        rec = {"date": day.isoformat(), "listed": parse_index(text),
               "accs": {}, "complete": False}
    for acc, rel in rec["listed"]:
        if acc in rec["accs"]:
            continue
        if budget[0] <= 0:
            _atomic_json(path, rec)
            return False
        try:
            text = edgar(ARCHIVE + rel).decode("utf-8", "replace")
        except EdgarMissing:
            if (today - day).days < LATE_MISSING_DAYS:
                _atomic_json(path, rec)
                return False
            rec["accs"][acc] = {"skip": "missing"}
            continue
        except EdgarError:
            _atomic_json(path, rec)
            return False
        budget[0] -= 1
        got = parse_form4(text)
        if got is None:
            rec["accs"][acc] = {"skip": "unparseable"}
        else:
            rec["accs"][acc] = {"accepted": got[0].isoformat(),
                                "rows": _rows_out(got[1])}
    rec["complete"] = True
    _atomic_json(path, rec)
    return True


def sync_days(cache, first, today, sessions, edgar, log=_log):
    """Walk weekdays first..today-1 in order; returns (ready_through or None,
    [(accepted, row)]) for the unbroken complete prefix."""
    budget = [MAX_FILINGS_PER_RUN]
    ready, out, day = None, [], first
    while day < today:
        if day.weekday() < 5:
            if not sync_day(cache, day, sessions, today, edgar, budget):
                log(f"e1: EDGAR day {day} incomplete, rows stop before it")
                break
            rec = _load_json(os.path.join(cache, "days",
                                          day.strftime("%Y%m%d") + ".json"))
            for a in rec["accs"].values():
                if "rows" in a:
                    acc = datetime.datetime.fromisoformat(a["accepted"])
                    out += [(acc, r) for r in _rows_in(a["rows"])]
        ready = day
        day += datetime.timedelta(days=1)
    return ready, out


# ------------------------------------------------- insider history (DERA)

def quarter_key(y, m):
    return (y, (m - 1) // 3 + 1)


def needed_quarters(day):
    """(year, quarter) of the three prior-year months an event effective on
    `day` can need: its own month and the previous one (Form 4 is due within
    two business days, so a purchase is from one of those months)."""
    months = [(day.year, day.month),
              (day.year, day.month - 1) if day.month > 1
              else (day.year - 1, 12)]
    return {quarter_key(y - k, m) for y, m in months
            for k in range(1, insider_data.ROUTINE_YEARS + 1)}


def _hist_path(cache, y, q):
    return os.path.join(cache, "hist", f"{y}q{q}.json.gz")


def build_hist_from_zip(zip_bytes):
    """Sorted unique 'cik|owner|year|month' keys of every common-stock P/S
    transaction (any owner) in one quarterly insider-transactions zip."""
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(zip_bytes)
        rows = insider_data.read_quarter(tmp)
    finally:
        os.remove(tmp)
    return sorted({f"{_norm(r['cik'])}|{_norm(r['owner'])}|"
                   f"{r['trans_date'].year}|{r['trans_date'].month}"
                   for r in rows})


def ensure_quarters(cache, wanted, edgar, log=_log):
    """Cache every wanted (y, q) that SEC has published (bounded downloads per
    run). Returns the set of cached quarters."""
    have, todo = set(), []
    for y, q in sorted(wanted):
        if _load_json(_hist_path(cache, y, q), gz=True) is not None:
            have.add((y, q))
        else:
            todo.append((y, q))
    for y, q in todo[:MAX_QUARTER_DOWNLOADS_PER_RUN]:
        for url in QUARTER_URLS:
            try:
                blob = edgar(url.format(y=y, q=q))
            except EdgarMissing:
                continue
            except EdgarError as e:
                log(f"e1: history {y}q{q} download failed: {e}")
                break
            try:
                keys = build_hist_from_zip(blob)
            except (zipfile.BadZipFile, KeyError, ValueError, OSError) as e:
                log(f"e1: history {y}q{q} unreadable: {e}")
                break
            _atomic_json(_hist_path(cache, y, q), {"keys": keys}, gz=True)
            have.add((y, q))
            break
        else:
            log(f"e1: history {y}q{q} not published yet")
    return have


def load_history(cache, quarters, wanted_keys):
    """Synthetic S-code non-officer rows (only their (cik, owner, month) counts
    toward the routine test in build_events) restricted to `wanted_keys`
    ((cik, owner) pairs)."""
    rows = []
    for y, q in sorted(quarters):
        rec = _load_json(_hist_path(cache, y, q), gz=True) or {"keys": []}
        for k in rec["keys"]:
            cik, owner, yy, mm = k.split("|")
            if (cik, owner) in wanted_keys:
                d = datetime.date(int(yy), int(mm), 1)
                rows.append({"filing_date": d, "trans_date": d, "cik": cik,
                             "symbol": "X", "owner": owner,
                             "officer_or_director": False, "code": "S",
                             "shares": 1.0, "price": 1.0})
    return rows


# --------------------------------------------------------------- Alpaca I/O

def _end(now):
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return min(midnight, now - datetime.timedelta(minutes=SIP_DELAY_MIN)
               ).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_bars(sym, start_day, now, timeframe, adjustment, alpaca_get):
    start = (start_day).strftime("%Y-%m-%dT00:00:00Z")
    rows, _ = sip_fetch.fetch(sym, "bars", start, _end(now), timeframe,
                              adjustment, http_get=alpaca_get, now=now)
    return rows


def fetch_symbol_bars(sym, start_day, now, alpaca_get):
    """(raw, adj) daily bars for an event symbol or None when the provider has
    none. Deterministic 4xx and invalid-symbol errors mean no data; network and
    5xx failures propagate (the whole sleeve then skips this run)."""
    try:
        raw = fetch_bars(sym, start_day, now, "1Day", "raw", alpaca_get)
        adj = fetch_bars(sym, start_day, now, "1Day", "split", alpaca_get)
    except sip_fetch.SipError:
        return None
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500 and e.code not in (408, 429):
            return None
        raise
    r = {b["t"][:10]: (float(b["o"]), float(b["c"]), float(b["v"]))
         for b in raw if b["o"] > 0 and b["c"] > 0}
    a = {b["t"][:10]: (float(b["o"]), float(b["h"]), float(b["l"]),
                       float(b["c"])) for b in adj if b["o"] > 0 and b["c"] > 0}
    return (r, a) if r and a else None


# ------------------------------------------------------------- ledger rows

def _rows(sid, sessions, equity, targets):
    rows, prev = [], None
    for d, eq in zip(sessions, equity):
        rows.append({"date": d, "sleeve": sid, "equity": round(eq, 4),
                     "ret": 0.0 if prev is None else round(eq / prev - 1, 8),
                     "target": targets.get(d)})
        prev = eq
    return rows


# ------------------------------------------------------------------- E1

def e1_events(fwd_rows, hist_rows, forward_start):
    """A-gate event construction (insider_data.build_events, MIN_VALUE) on
    forward purchases keyed by their effective decision date. Returns
    (events, counts)."""
    keep, late = [], 0
    for accepted, r in fwd_rows:
        eff = effective_date(accepted)
        months = {(eff.year, eff.month),
                  (eff.year, eff.month - 1) if eff.month > 1
                  else (eff.year - 1, 12)}
        if (r["trans_date"].year, r["trans_date"].month) not in months:
            late += 1
            continue
        keep.append(dict(r, filing_date=eff))
    wanted = {(r["cik"], r["owner"]) for r in keep
              if r["officer_or_director"]}
    events = [e for e in insider_data.build_events(
        keep + [h for h in hist_rows if (h["cik"], h["owner"]) in wanted])
        if e["date"] >= forward_start and e["value"] >= a_run_e1.MIN_VALUE]
    return events, {"late_filed_dropped": late}


def e1(now, forward_start, cash0, sessions_all, cash_bars, alpaca_get, edgar,
       cache, log=_log):
    today = now.astimezone(NY).date()
    first = datetime.date.fromisoformat(forward_start) - datetime.timedelta(days=3)
    ready, fwd = sync_days(cache, first, today, set(sessions_all), edgar, log)
    if ready is None:
        raise Incomplete("no complete EDGAR day yet")
    cand = [s for s in sessions_all if forward_start <= s <= ready.isoformat()]
    wanted_q = set()
    for s in cand:
        wanted_q |= needed_quarters(datetime.date.fromisoformat(s))
    have = ensure_quarters(cache, wanted_q, edgar, log)
    sessions = []
    for s in cand:
        if not needed_quarters(datetime.date.fromisoformat(s)) <= have:
            log(f"e1: insider history incomplete for {s}, rows stop before it")
            break
        sessions.append(s)
    if not sessions:
        raise Incomplete("no session with complete inputs")
    last = datetime.date.fromisoformat(sessions[-1])
    fwd = [(a, r) for a, r in fwd if effective_date(a) <= last]
    keys = {(r["cik"], r["owner"]) for _, r in fwd if r["officer_or_director"]}
    events, counts = e1_events(fwd, load_history(cache, have, keys),
                               forward_start)
    syms = sorted({e["symbol"] for e in events})
    if len(syms) > MAX_EVENT_SYMBOLS:
        raise Incomplete(f"{len(syms)} event symbols exceed the cap")
    start = datetime.date.fromisoformat(forward_start) - \
        datetime.timedelta(days=BAR_WARMUP_DAYS)
    raw, adj = {}, {}
    for s in syms:
        got = fetch_symbol_bars(s, start, now, alpaca_get)
        if got:
            raw[s], adj[s] = got
    cash_ret = [0.0] + [cash_bars[d][1] / cash_bars[p][1] - 1.0
                        for p, d in zip(sessions[:-1], sessions[1:])]
    out = {}
    for v, sid in E1_IDS.items():
        ent = a_run_e1.entered_symbols(events, raw, adj, sessions, v)
        prices = {s: {d: (b[0], b[3]) for d, b in adj[s].items()}
                  for s in ent}
        sl = a_run_e1._sleeve(events, raw, adj, sessions, v)
        res = portfolio.run(sessions, prices, sl.target_fn, cash0=cash0,
                            spread_bps=a_run_e1.TIERS[v]["spread_bps"],
                            cash_returns=cash_ret)
        out[sid] = (_rows(sid, sessions, res["equity"],
                          {d: w for d, w in res["weights"]}),
                    f"e1:{v} events={len(events)} {counts}")
    return out


# ------------------------------------------------------------------- I1

def days_from_rows(rows):
    """Regular-session 30-minute bars per ET date, with the same early-close
    rule as a_run_i1.read_days. Returns (days[date] = [(open, close)], dropped
    early-close dates, dates that had any regular-session bar)."""
    raw = {}
    for b in rows:
        t = datetime.datetime.fromisoformat(
            b["t"].replace("Z", "+00:00")).astimezone(NY)
        if not (datetime.time(9, 30) <= t.time() < datetime.time(16, 0)):
            continue
        if not (b["o"] > 0 and b["c"] > 0):
            raise ValueError(f"bad-bar:{b['t']}")
        raw.setdefault(t.date().isoformat(), []).append(
            (t.time(), float(b["o"]), float(b["c"]), float(b["v"])))
    days, dropped = {}, []
    for d, bars in raw.items():
        vol = {t: v for t, _o, _c, v in bars}
        v1230, v1530 = vol.get(datetime.time(12, 30)), \
            vol.get(datetime.time(15, 30))
        if v1230 and v1530 is not None and \
                v1530 < 0.25 * v1230:  # a_run_i1.EARLY_CLOSE_VOLUME_RATIO
            dropped.append(d)
            continue
        days[d] = [(o, c) for _t, o, c, _v in bars]
    return days, sorted(dropped), set(raw)


def i1(now, forward_start, cash0, sessions_all, cash_bars, alpaca_get,
       log=_log):
    start = datetime.date.fromisoformat(forward_start) - \
        datetime.timedelta(days=DAILY_WARMUP_DAYS)
    bars = fetch_bars("SPY", start, now, "30Min", "all", alpaca_get)
    days, dropped, seen = days_from_rows(bars)
    order = []
    for s in sessions_all:
        if s >= forward_start and s not in seen:
            log(f"i1: no SPY intraday bars for {s}, rows stop before it")
            break
        order.append(s)
    fwd = [i for i, s in enumerate(order) if s >= forward_start]
    if not fwd:
        raise Incomplete("no forward session with intraday bars")
    cash_ret = [0.0] + [cash_bars[d][1] / cash_bars[p][1] - 1.0
                        for p, d in zip(order[:-1], order[1:])]
    out = {}
    for v, sid in I1_IDS.items():
        res = intraday_mom.simulate(days, order, v, cash0=cash0)
        traded = {t[0] for t in res["trades"]}
        sessions, equity, eq = [], [], cash0
        for k, i in enumerate(fwd):
            if k:  # the first forward row is the rebased start
                eq *= 1.0 + cash_ret[i] + res["pnl"][i]
            sessions.append(order[i])
            equity.append(eq)
        out[sid] = (_rows(sid, sessions, equity,
                          {d: {"SPY": 1.0} for d in sessions if d in traded}),
                    f"i1:{v} early_close_dropped={len(dropped)}")
    return out


# ---------------------------------------------------------------- entry

def produce(d, now, forward_start, cash0, alpaca_get, edgar_get=None,
            sleep=time.sleep, ua=None, log=_log):
    """{sleeve_id: (rows, spec)} for every event sleeve that could be computed
    completely; the others are skipped and logged."""
    out = {}
    try:
        start = datetime.date.fromisoformat(forward_start) - \
            datetime.timedelta(days=DAILY_WARMUP_DAYS)
        spy, bil = (
            {b["t"][:10]: (float(b["o"]), float(b["c"]))
             for b in fetch_bars(s, start, now, "1Day", "all", alpaca_get)
             if b["o"] > 0 and b["c"] > 0} for s in ("SPY", "BIL"))
        sessions_all = sorted(set(spy) & set(bil))
    except Exception as e:  # noqa: BLE001 - degrade, never crash the loop
        log(f"skipped all event sleeves: calendar/cash bars unavailable: {e!r}")
        return out
    cache = os.path.join(d, "event_cache")
    jobs = [("i1", lambda: i1(now, forward_start, cash0, sessions_all, bil,
                              alpaca_get, log))]

    def e1_job():
        client = edgar_client(ua or fsds_fetch.user_agent(),
                              edgar_get or default_edgar_get, sleep)
        return e1(now, forward_start, cash0, sessions_all, bil, alpaca_get,
                  client, os.path.join(cache, "e1"), log)
    jobs.insert(0, ("e1", e1_job))
    for name, job in jobs:
        try:
            out.update(job())
        except Incomplete as e:
            log(f"{name}: not recorded this run: {e}")
        except Exception as e:  # noqa: BLE001
            log(f"{name}: skipped: {type(e).__name__}: {e}")
    return out
