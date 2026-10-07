"""Human-run collector of research/data/ticker_observations.jsonl: the dated
cik-to-symbol observations behind the point-in-time ticker map (plan/data.md),
from cover-page symbols, Alpaca symbol-change corporate actions, Form 4 issuer
symbols and former names, for the ciks of reference.json. SEC requests need
MIRO_CONTACT, Alpaca requests ALPACA_KEY_ID and ALPACA_SECRET, both from the
environment. Each cik is cached once fetched, so a rerun resumes. A failed fetch
writes nothing."""
import argparse
import datetime
import glob
import json
import os
import sys
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, ".."))
sys.path.insert(0, ROOT)

from sources import edgar, ticker_observations
from research.strategy import form4, sip_fetch

DATA = os.path.join(ROOT, "data")
OUT_NAME = "ticker_observations.jsonl"
ACTIONS_URL = ("https://data.alpaca.markets/v1/corporate-actions?"
               "types=name_change&limit=1000&start=%s&end=%s")
ASSETS_URL = ("https://paper-api.alpaca.markets/v2/assets?"
              "asset_class=us_equity&status=%s")
FIRST_DAY = "2016-01-01"


def _get_json(adapter, url):
    _status, _headers, body, err = adapter._get(url)
    if err or body is None:
        raise OSError("%s: %s" % (url, err or "empty body"))
    return json.loads(body.decode("utf-8"))


def fetch_record(adapter, cik):
    """What the dei and former-name builders read of one cik."""
    sub = _get_json(adapter, edgar.SUBMISSIONS_URL % cik)
    dei = ((_get_json(adapter, edgar.COMPANYFACTS_URL % cik).get("facts")
            or {}).get("dei") or {})
    recent = (sub.get("filings") or {}).get("recent") or {}
    return {"cik": cik,
            "facts": {"cik": cik, "facts": {"dei": {
                "TradingSymbol": dei.get("TradingSymbol") or {}}}},
            "submissions": {
                "cik": cik, "formerNames": sub.get("formerNames") or [],
                "filings": {"recent": {k: recent.get(k) or []
                                       for k in ("form", "filingDate")}}}}


def _atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def cached(cache_dir, cik, end):
    path = os.path.join(cache_dir, "%010d.json" % cik)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        rec = json.load(f)
    return rec if rec.get("fetched", "") >= end else None


def load_records(ciks, cache_dir, adapter, end, today, log):
    """({cik: record}, {symbol: reason}); a failed fetch is never cached."""
    os.makedirs(cache_dir, exist_ok=True)
    records, failed = {}, {}
    for cik, sym in sorted(ciks.items(), key=lambda kv: kv[1]):
        rec = cached(cache_dir, int(cik), end)
        if rec is None:
            try:
                rec = dict(fetch_record(adapter, int(cik)), fetched=today)
            except (OSError, ValueError) as e:
                failed[sym] = "fetch-failed: %s" % e
                continue
            _atomic(os.path.join(cache_dir, "%010d.json" % int(cik)),
                    json.dumps(rec))
            log("fetched %s" % sym)
        records[int(cik)] = rec
    return records, failed


def fetch_actions(http_get, headers, start, end):
    """Alpaca name-change records over [start, end], following page tokens."""
    url = ACTIONS_URL % (start, end)
    out, token = [], None
    while True:
        q = url + ("&" + urllib.parse.urlencode({"page_token": token})
                   if token else "")
        payload = http_get(q, headers)
        out += (payload.get("corporate_actions") or {}).get("name_changes") or []
        token = payload.get("next_page_token")
        if not token:
            return out


def fetch_assets(http_get, headers):
    assets = []
    for status in ("active", "inactive"):
        assets += [{"symbol": a.get("symbol"), "name": a.get("name")}
                   for a in http_get(ASSETS_URL % status, headers)]
    return assets


def _single_date(rec):
    """Alpaca dates a name change by process_date alone; as with a Form 4
    filing date it is then both when the change took effect and when it was
    known."""
    return dict(rec, effective_date=rec.get("effective_date")
                or rec.get("process_date"))


def build(records, ciks, actions, assets, form4_rows):
    """(sorted observations, {source: skipped count})."""
    by_symbol = {sym: int(cik) for cik, sym in ciks.items()}
    obs, skipped = [], {}

    def add(source, result):
        found, n = result
        obs.extend(found)
        skipped[source] = skipped.get(source, 0) + n

    for rec in records.values():
        add("dei", ticker_observations.dei_observations(rec["facts"]))
        add("former_name", ticker_observations.former_name_observations(
            rec["submissions"], assets))
    add("corp_action", ticker_observations.corp_action_observations(
        [_single_date(r) for r in actions], by_symbol))
    wanted = set(by_symbol.values())
    add("form4", ticker_observations.form4_observations(
        [r for r in form4_rows if int(r["cik"]) in wanted]))
    return sorted(set(obs), key=lambda o: (o.cik, o.source, o.observed_date,
                                           o.known_at, o.symbol)), skipped


def _line(o):
    return json.dumps({"cik": o.cik, "symbol": o.symbol, "source": o.source,
                       "observed_date": o.observed_date.isoformat(),
                       "known_at": o.known_at.isoformat()}, sort_keys=True)


def main(argv=None, env=None, log=print, today=None, http_get=None,
         **adapter_kw):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--zips", help="default <data>/form4_zips")
    ap.add_argument("--start", default=FIRST_DAY)
    ap.add_argument("--end", help="ISO date, default today")
    ap.add_argument("--cache", help="default <data>/ticker_cache")
    ap.add_argument("--yes", action="store_true",
                    help="start the requests after the estimate")
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    contact = edgar.contact_from_env(env)
    if not contact:
        log("MIRO_CONTACT must be exported")
        return 2
    if not (env.get("ALPACA_KEY_ID") and env.get("ALPACA_SECRET")):
        log("ALPACA_KEY_ID and ALPACA_SECRET must be exported")
        return 2
    headers = {"APCA-API-KEY-ID": env["ALPACA_KEY_ID"],
               "APCA-API-SECRET-KEY": env["ALPACA_SECRET"]}
    today = today or datetime.datetime.now(datetime.timezone.utc).date(
        ).isoformat()
    end = a.end or today
    try:
        with open(os.path.join(a.data, "reference.json"),
                  encoding="utf-8") as f:
            ciks = json.load(f)["data"]["ciks"]
    except (OSError, ValueError, KeyError) as e:
        log("reference.json unreadable: %s" % e)
        return 1
    zips = sorted(glob.glob(os.path.join(
        a.zips or os.path.join(a.data, "form4_zips"), "*_form345.zip")))
    if not zips:
        log("no Form 4 zips: run strategy/build_form4_events.py first")
        return 1
    cache = a.cache or os.path.join(a.data, "ticker_cache")
    todo = [c for c in ciks if cached(cache, int(c), end) is None]
    log("%d symbols, %d to fetch: about %d SEC requests" % (
        len(ciks), len(todo), 2 * len(todo)))
    if not a.yes:
        log("not fetching: pass --yes to start")
        return 2
    adapter = edgar.Adapter(contact, cache_dir=cache, **adapter_kw)
    records, failed = load_records(ciks, cache, adapter, end, today, log)
    if failed:
        log(json.dumps(failed, sort_keys=True))
        log("not written: rerun to retry the failed fetches")
        return 1
    http_get = http_get or sip_fetch.default_http_get
    try:
        actions = fetch_actions(http_get, headers, a.start, end)
        assets = fetch_assets(http_get, headers)
    except OSError as e:
        log("alpaca fetch failed: %s" % e)
        return 1
    rows = [r for z in zips for r in form4.read_quarter(z)]
    obs, skipped = build(records, ciks, actions, assets, rows)
    _atomic(os.path.join(a.data, OUT_NAME),
            "".join(_line(o) + "\n" for o in obs))
    log("wrote %d observations; skipped %s" % (
        len(obs), json.dumps(skipped, sort_keys=True)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
