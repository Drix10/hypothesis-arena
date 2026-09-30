"""End-to-end drills for g0_paper_loop over the real libcurl transport.

A local mock of the Alpaca paper and data APIs (loopback only, reachable
through the G0_TEST_BASE build) stands in for the venue so broker faults can
be injected. STAGE here is a test fixture in a temp dir against a mock; it
authorizes nothing.

    python3 kernel/tests/e2e_mock_venue.py <g0_paper_loop_test_binary>
"""
import datetime
import hashlib
import http.server
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import zoneinfo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, ROOT)
from research.strategy import candidate_wire as W  # noqa: E402

ET = zoneinfo.ZoneInfo("America/New_York")
BRACKET = json.load(open(os.path.join(ROOT, "kernel/fixtures/alpaca_bracket_reply.json")))
ACCOUNT = json.load(open(os.path.join(ROOT, "kernel/fixtures/alpaca_account.json")))
CAL = os.path.join(ROOT, "ops/deploy/session_calendar.json")
HOL = {d for k, v in json.load(open(CAL)).items() if k.startswith("holidays_")
       for d in v}
KEY, SECRET = "TESTKEYID0001", "TESTSECRET0001"


def bars_for(sym, now):
    """Hourly regular-session bars ending at the last completed session hour."""
    day = now.astimezone(ET).date()
    rnd = random.Random(sym)
    price = 100.0
    starts = []
    while len(starts) < 700:
        if day.weekday() < 5 and day.isoformat() not in HOL:
            for h in range(15, 8, -1):
                st = datetime.datetime(day.year, day.month, day.day, h,
                                       tzinfo=ET).astimezone(datetime.timezone.utc)
                if st + datetime.timedelta(hours=1) <= now:
                    starts.append(st)
        day -= datetime.timedelta(days=1)
    out = []
    for st in reversed(starts):
        price *= 1 + rnd.gauss(0, 0.002)
        out.append({"t": st.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": price,
                    "h": price, "l": price, "c": price, "v": 1000, "n": 10,
                    "vw": price})
    return out


class Venue:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.orders = {}       # client_order_id -> order
        self.positions = {}    # symbol -> qty
        self.posts = 0         # accepted order POSTs
        self.mode = "ok"       # ok | outage_orders | outage_all
        self.fail_posts = 0    # next N order POSTs are refused
        self.fail_code = 429
        self.hits = []
        self.bodies = []       # accepted order POST bodies
        # Alpaca-like lifecycle (off by default): a market bracket entry is
        # first seen partly filled, our cancel takes the bracket legs but the
        # venue frees their shares only after release_s, and an OCO repair is
        # refused until then. cancel_fills: the entry completes before the
        # cancel lands.
        self.realistic = False
        self.cancel_fills = False
        self.release_s = 3.0
        self.release_at = {}   # symbol -> monotonic time the legs' shares free
        self.oco_refused = 0


V = Venue()


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        data = (json.dumps(obj, separators=(",", ":")) if obj is not None else "").encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode()) if n else None
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        with V.lock:
            V.hits.append((self.command, u.path))
            if self.headers.get("APCA-API-KEY-ID") != KEY:
                return self._send(401, {"message": "forbidden"})
            if V.mode == "outage_all":
                return self._send(500, {"message": "down"})
            if u.path == "/v2/clock":
                return self._send(200, {"is_open": True})
            if u.path == "/v2/account":
                return self._send(200, dict(ACCOUNT))
            if u.path == "/v2/positions":
                return self._send(200, [
                    {"symbol": s, "qty": str(qty), "side": "long",
                     "market_value": "%.2f" % (qty * 100.0)}
                    for s, qty in V.positions.items() if qty])
            if u.path == "/v2/stocks/bars":
                now = datetime.datetime.now(datetime.timezone.utc)
                syms = q["symbols"][0].split(",")
                return self._send(200, {"bars": {s: bars_for(s, now) for s in syms},
                                        "next_page_token": None})
            if u.path == "/v2/orders" and self.command == "GET":
                if q.get("status") == ["open"]:
                    return self._send(200, [o for o in V.orders.values()
                                            if o["status"] in ("accepted", "new",
                                                               "partially_filled")])
                return self._send(200, [])
            if u.path == "/v2/orders" and self.command == "POST":
                if V.mode == "outage_orders":
                    return self._send(500, {"message": "down"})
                if V.fail_posts > 0:
                    V.fail_posts -= 1
                    return self._send(V.fail_code, {"message": "throttled"})
                cid = body["client_order_id"]
                if cid in V.orders:
                    return self._send(422, {"message": "client_order_id must be unique"})
                if V.realistic and body.get("order_class") == "oco":
                    if time.monotonic() < V.release_at.get(body["symbol"], 0):
                        V.oco_refused += 1
                        return self._send(403, {
                            "message": "insufficient qty available for order"})
                    V.posts += 1
                    n = V.posts
                    o = {"id": "%08d-2222-3333-4444-555555555555" % n,
                         "client_order_id": cid, "symbol": body["symbol"],
                         "qty": body["qty"], "filled_qty": "0",
                         "side": "sell", "order_class": "oco", "type": "limit",
                         "order_type": "limit", "status": "new",
                         "legs": [{"id": "%08d-6666-3333-4444-555555555555" % n,
                                   "type": "stop_limit", "status": "held",
                                   "symbol": body["symbol"], "qty": body["qty"],
                                   "side": "sell", "filled_qty": "0"}]}
                    V.bodies.append(body)
                    V.orders[cid] = o
                    return self._send(200, o)
                V.posts += 1
                o = json.loads(json.dumps(BRACKET))
                o.update({"id": "%08d-2222-3333-4444-555555555555" % V.posts,
                          "client_order_id": cid, "symbol": body["symbol"],
                          "qty": body["qty"], "filled_qty": "0",
                          "side": body["side"], "status": "accepted"})
                V.bodies.append(body)
                if body.get("order_class") == "oto":
                    o["order_class"] = "oto"
                    o["legs"] = [l for l in o["legs"] if l.get("type") == "stop"]
                elif body.get("order_class") != "bracket":
                    for k in ("legs", "order_class"):
                        o.pop(k, None)
                V.orders[cid] = o
                return self._send(200, o)
            if u.path == "/v2/orders:by_client_order_id":
                o = V.orders.get(q["client_order_id"][0])
                if not o:
                    return self._send(404, {"message": "order not found"})
                if V.realistic and o["status"] == "accepted" \
                        and o.get("order_class") in ("bracket", "oto"):
                    q0 = int(o["qty"])
                    got = max(1, q0 - 2) if q0 > 2 else 1
                    o["status"], o["filled_qty"] = "partially_filled", str(got)
                    o["filled_avg_price"] = "100.00"
                    V.positions[o["symbol"]] = got
                    return self._send(200, o)
                if o["status"] == "accepted":  # fills on first look
                    o["status"], o["filled_qty"] = "filled", o["qty"]
                    d = 1 if o["side"] == "buy" else -1
                    V.positions[o["symbol"]] = (V.positions.get(o["symbol"], 0)
                                                + d * int(o["qty"]))
                return self._send(200, o)
            if u.path.startswith("/v2/orders/") and self.command == "DELETE":
                if V.realistic:
                    oid = u.path.rsplit("/", 1)[1]
                    for o in V.orders.values():
                        if o["id"] != oid:
                            continue
                        if V.cancel_fills:
                            o["status"], o["filled_qty"] = "filled", o["qty"]
                            V.positions[o["symbol"]] = int(o["qty"])
                        else:
                            o["status"] = "canceled"
                        for lg in o.get("legs") or []:
                            lg["status"] = "canceled"
                        V.release_at[o["symbol"]] = time.monotonic() + V.release_s
                return self._send(204)
            self._send(404, {"message": "nope"})

    do_GET = do_POST = do_DELETE = _handle


def make_dir(sleeve="core_passive_v1"):
    d = tempfile.mkdtemp(prefix="e2e_")
    at = "2026-09-25T00:00:00Z"
    h = hashlib.sha256(("G0_PAPER|human-test|%s|0|GENESIS" % at).encode()).hexdigest()
    open(d + "/STAGE", "w").write(
        "stage: G0_PAPER\napproved_by: human-test\napproved_at: %s\n"
        "capital_usd: 0\nattest_hash: %s\n" % (at, h))
    json.dump({"sleeves": [{"id": sleeve, "window_s": 86400}],
               "allowlist": ["VTI", "IEF", "SPY"]}, open(d + "/approved.json", "w"))
    return d


def candidate(sym="VTI", side="BUY", tag=0, profile="exit_trend_v1"):
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1e9) + tag
    entry, stop, tp = (100.0, 90.0, 150.0) if side == "BUY" else (100.0, 150.0, 90.0)
    return W.wire_line("core_passive_v1", sym, now, entry, stop, tp,
                       family="core", side=side, exit_profile=profile)


def loop_env(port, key=KEY):
    return dict(os.environ, ALPACA_KEY_ID=key, ALPACA_SECRET=SECRET,
                G0_TEST_BASE="http://127.0.0.1:%d" % port,
                G0_TEST_TIMEOUT_MS="2000")


def run_loop(binary, port, d, ticks=3, key=KEY):
    p = subprocess.run([binary, d, CAL, "--ticks", str(ticks), "--interval-s", "1"],
                       env=loop_env(port, key), capture_output=True, text=True,
                       timeout=120)
    return p.returncode, p.stdout


def decisions(d):
    try:
        return [json.loads(x) for x in open(d + "/decisions.jsonl")]
    except OSError:
        return []


def start_venue():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def main():
    binary = os.path.abspath(sys.argv[1])
    port = start_venue()
    res = []

    def check(name, ok, info=""):
        res.append(ok)
        if not ok:
            print("FAIL %s %s" % (name, info))

    # 1. Happy path, then a restart: one order, never two.
    V.reset()
    d = make_dir()
    open(d + "/candidates.jsonl", "w").write(candidate())
    rc, out = run_loop(binary, port, d)
    check("happy-runs", rc == 0, out)
    check("happy-one-order", V.posts == 1, "posts=%d %s" % (V.posts, out))
    dec = decisions(d)
    check("happy-logged", len(dec) == 1 and dec[0]["submit"] == "submitted", dec)
    rc, out = run_loop(binary, port, d, ticks=2)
    check("restart-no-duplicate", rc == 0 and V.posts == 1, "posts=%d" % V.posts)
    # A replayed line after the offset is lost: the cid dedupes.
    os.remove(d + "/candidates.offset")
    run_loop(binary, port, d, ticks=1)
    check("replay-no-duplicate", V.posts == 1, "posts=%d" % V.posts)
    shutil.rmtree(d)

    # 2. Rate limit on the order POST: the entry is dropped (journaled as a
    # cancel), never retried blind; the next candidate goes through.
    V.reset()
    V.fail_posts, V.fail_code = 1, 429
    d = make_dir()
    open(d + "/candidates.jsonl", "w").write(candidate())
    rc, out = run_loop(binary, port, d, ticks=4)
    check("429-no-crash", rc == 0, out)
    check("429-entry-dropped", V.posts == 0, "posts=%d" % V.posts)
    check("429-journaled-cancel", "|cancel|" in open(d + "/journal.jsonl").read())
    open(d + "/candidates.jsonl", "a").write(candidate("IEF", "BUY", 3))
    rc, out = run_loop(binary, port, d, ticks=3)
    check("429-next-candidate-placed", V.posts == 1, "posts=%d %s" % (V.posts, out))
    shutil.rmtree(d)

    # 3. Full broker outage: nothing is placed, the loop stays up and holds.
    V.reset()
    V.mode = "outage_all"
    d = make_dir()
    open(d + "/candidates.jsonl", "w").write(candidate())
    rc, out = run_loop(binary, port, d, ticks=3)
    check("outage-exit-clean", rc == 0, out)
    check("outage-no-orders", V.posts == 0)
    check("outage-consumes-nothing", decisions(d) == [] and "account_ok=0" in out, out)
    V.mode = "ok"
    rc, out = run_loop(binary, port, d, ticks=2)
    check("recovery-places-once", V.posts == 1, "posts=%d %s" % (V.posts, out))
    shutil.rmtree(d)

    # 4. Order endpoint down while reads work: nothing placed, audited.
    V.reset()
    V.mode = "outage_orders"
    d = make_dir()
    open(d + "/candidates.jsonl", "w").write(candidate())
    rc, out = run_loop(binary, port, d, ticks=3)
    check("orders-down-none-placed", V.posts == 0)
    check("orders-down-audited", len(decisions(d)) >= 1, out)
    shutil.rmtree(d)

    # 5. Exit stays alive when entries are halted.
    V.reset()
    V.positions["VTI"] = 40
    d = make_dir()
    open(d + "/HALT", "w").write("")
    open(d + "/candidates.jsonl", "w").write(candidate("VTI", "SELL"))
    rc, out = run_loop(binary, port, d, ticks=2)
    dec = decisions(d)
    check("halt-exit-placed", V.posts == 1 and dec and dec[0]["proceed"],
          "%s %s" % (dec, out))
    open(d + "/candidates.jsonl", "a").write(candidate("IEF", "BUY", 7))
    run_loop(binary, port, d, ticks=2)
    dec = decisions(d)
    check("halt-entry-held", V.posts == 1 and
          any(x["reason"] == "entry-halt" for x in dec), dec)
    shutil.rmtree(d)

    # 6. Wrong credentials: the venue refuses everything, nothing happens.
    V.reset()
    d = make_dir()
    open(d + "/candidates.jsonl", "w").write(candidate())
    rc, out = run_loop(binary, port, d, ticks=2, key="WRONGKEY0001")
    check("bad-creds-no-orders", V.posts == 0 and "account_ok=0" in out, out)
    shutil.rmtree(d)

    # 7. Stop-only (OTO) entries: the intraday and event profiles place one
    # OTO order, its single stop leg proves protection, nothing is flattened.
    for prof, gtc in (("exit_intraday_v1", "day"), ("exit_event_v1", "gtc")):
        V.reset()
        d = make_dir()
        open(d + "/candidates.jsonl", "w").write(candidate("SPY", "BUY", 5, prof))
        rc, out = run_loop(binary, port, d, ticks=4)
        b = V.bodies[0] if V.bodies else {}
        check("oto-%s-one-order" % prof, V.posts == 1, "posts=%d %s" % (V.posts, out))
        check("oto-%s-shape" % prof, b.get("order_class") == "oto" and
              "take_profit" not in b and "stop_loss" in b and
              b.get("time_in_force") == gtc, b)
        check("oto-%s-protected-not-flattened" % prof,
              rc == 0 and V.posts == 1 and V.positions.get("SPY", 0) > 0, out)
        shutil.rmtree(d)

    # 8. Alpaca-like partial fill: the entry is first seen partly filled, the
    # kernel cancels the remainder (which takes the bracket legs), and the
    # venue refuses an OCO repair until the legs release their shares. The
    # position must end up protected by the repair OCO, never flattened,
    # frozen or alerted, whether the entry stayed partial or completed.
    for label, fills in (("partial", False), ("filled-before-cancel", True)):
        V.reset()
        V.realistic, V.cancel_fills = True, fills
        d = make_dir()
        open(d + "/candidates.jsonl", "w").write(candidate("VTI", "BUY", 9))
        rc, out = run_loop(binary, port, d, ticks=12)
        ocos = [o for o in V.orders.values() if o.get("order_class") == "oco"
                and o["status"] == "new"]
        sells = [b for b in V.bodies if b.get("side") == "sell"
                 and b.get("order_class") != "oco"]
        alerts = open(d + "/alerts.jsonl").read() if os.path.exists(
            d + "/alerts.jsonl") else ""
        jr = open(d + "/journal.jsonl").read()
        check("real-%s-runs" % label, rc == 0, out)
        check("real-%s-repair-refused-then-placed" % label,
              V.oco_refused >= 1 and len(ocos) == 1,
              "refused=%d ocos=%d %s" % (V.oco_refused, len(ocos), out))
        check("real-%s-not-flattened" % label,
              not sells and "-flatten" not in jr, "%s %s" % (sells, jr[-300:]))
        check("real-%s-no-freeze" % label,
              not os.path.exists(d + "/freeze.txt"), "freeze")
        check("real-%s-no-alerts" % label,
              "flatten" not in alerts and "unprotected" not in alerts, alerts)
        shutil.rmtree(d)

    print("CHECKS: %d/%d PASS" % (sum(res), len(res)))
    sys.exit(0 if all(res) else 1)


if __name__ == "__main__":
    main()
