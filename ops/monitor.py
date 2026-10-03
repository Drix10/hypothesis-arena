"""Live terminal view of a running paper loop. Read-only: it never writes to
the loop directory and never places orders.

    python3 ops/monitor.py <loop_dir> [--interval 3] [--once] [--no-broker]

Panels: loop heartbeat, incoming candidates, per-candidate decisions (with the
veto reason and sizing), order journal (chain check + lifecycle), forward
ledgers, and the Alpaca PAPER account, positions and recent orders (needs
ALPACA_KEY_ID / ALPACA_SECRET in the environment or the repo .env)."""
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter

PAPER = "https://paper-api.alpaca.markets"
BROKER_TTL_S = 15
RST, DIM, BOLD = "\x1b[0m", "\x1b[2m", "\x1b[1m"
RED, GRN, YEL = "\x1b[31m", "\x1b[32m", "\x1b[33m"


def read_lines(path, tail=None):
    try:
        with open(path, "r", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    return lines[-tail:] if tail else lines


def jrows(path):
    out = []
    for ln in read_lines(path):
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


def ts(ns):
    try:
        return time.strftime("%H:%M:%S", time.localtime(int(ns) / 1e9))
    except (TypeError, ValueError, OverflowError, OSError):
        return "--:--:--"


def short(s, n=10):
    return str(s)[:n]


def load_env():
    env = dict(os.environ)
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    for ln in read_lines(p):
        ln = ln.lstrip("\ufeff").strip()
        if ln.startswith("export "):
            ln = ln[7:].lstrip()
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", ln)
        if m and m.group(1) not in env:
            v = m.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                v = v[1:-1]
            else:
                v = v.split(" #", 1)[0].rstrip()
            env[m.group(1)] = v
    return env


class Broker:
    def __init__(self, env):
        self.key = env.get("ALPACA_KEY_ID", "")
        self.sec = env.get("ALPACA_SECRET", "")
        self.at = 0.0
        self.data = None
        self.err = ""

    def get(self, path):
        req = urllib.request.Request(PAPER + path, headers={
            "APCA-API-KEY-ID": self.key, "APCA-API-SECRET-KEY": self.sec})
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read().decode())

    def snapshot(self):
        if not (self.key and self.sec):
            return None, "no ALPACA_KEY_ID/ALPACA_SECRET"
        if self.data is not None and time.time() - self.at < BROKER_TTL_S:
            return self.data, self.err
        try:
            self.data = {
                "account": self.get("/v2/account"),
                "positions": self.get("/v2/positions"),
                "orders": self.get("/v2/orders?status=all&limit=8&direction=desc"),
                "open": self.get("/v2/orders?status=open&limit=100&nested=true"),
                "clock": self.get("/v2/clock"),
            }
            self.err = ""
        except Exception as e:  # network/auth: show it, keep last data
            self.err = "%s: %s" % (type(e).__name__, e)
        self.at = time.time()
        return self.data, self.err


def f(x, nd=2):
    try:
        return "{:,.{}f}".format(float(x), nd)
    except (TypeError, ValueError):
        return str(x)


def col(s, c):
    return c + s + RST


def panel_loop(d, out, now):
    out.append(col("LOOP", BOLD))
    lp = os.path.join(d, "logs", "loop.log")
    lines = read_lines(lp)
    ticks = [l for l in lines if l.startswith("tick ")]
    bad = [l for l in lines if l.strip() and not l.startswith("tick ")
           and "screen size" not in l
           and "nohup: ignoring input" not in l]
    try:
        age = now - os.path.getmtime(lp)
    except OSError:
        age = None
    stage = read_lines(os.path.join(d, "STAGE"))
    st = next((l.split(":", 1)[1].strip() for l in stage
               if l.startswith("stage:")), "MISSING")
    if age is None:
        hb = col("no loop.log", RED)
    elif age > 180:
        hb = col("STALE %ds since last write" % age, RED)
    else:
        hb = col("alive, last tick %ds ago" % age, GRN)
    out.append("  stage %s | %d ticks | %s" % (st, len(ticks), hb))
    if ticks:
        kv = dict(re.findall(r"(\w+)=(\d+)", ticks[-1]))
        ok = kv.get("account_ok") == "1"
        out.append("  last tick: account_ok=%s seen=%s proceeded=%s held=%s" % (
            col(kv.get("account_ok", "?"), GRN if ok else RED),
            kv.get("seen"), kv.get("proceeded"), kv.get("held")))
        totals = Counter()
        for t in ticks:
            for k, v in re.findall(r"(seen|proceeded|held)=(\d+)", t):
                totals[k] += int(v)
        out.append("  totals: seen=%d proceeded=%d held=%d; account_ok=0 in %d ticks"
                   % (totals["seen"], totals["proceeded"], totals["held"],
                      sum(1 for t in ticks if "account_ok=0" in t)))
    for l in bad[-3:]:
        out.append("  " + col(l[:110], RED))
    for a in jrows(os.path.join(d, "alerts.jsonl"))[-3:]:
        out.append("  " + col("ALERT " + json.dumps(a)[:100], YEL))
    fz = os.path.join(d, "freeze.txt")
    if os.path.exists(fz):
        out.append("  " + col("FREEZE file present: " + short(
            " ".join(read_lines(fz)), 90), YEL))


def panel_candidates(d, out):
    rows = jrows(os.path.join(d, "candidates.jsonl"))
    out.append(col("INCOMING CANDIDATES (%d)" % len(rows), BOLD))
    for r in rows[-5:]:
        c = r.get("candidate", r)
        try:
            risk = float(c["entry_px"]) - float(c["stop_px"])
            rp = "risk/sh %s (%.2f%%)" % (f(risk), 100 * risk / float(c["entry_px"]))
        except (KeyError, ValueError, ZeroDivisionError):
            rp = ""
        out.append("  %s %-5s %s entry %s stop %s tp %s  %s %s" % (
            ts(c.get("snapshot_ts_ns")), c.get("symbol"), c.get("side"),
            c.get("entry_px"), c.get("stop_px"), c.get("tp_px"),
            col(short(c.get("cid", ""), 8), DIM), rp))


def panel_decisions(d, out):
    rows = jrows(os.path.join(d, "decisions.jsonl"))
    out.append(col("KERNEL DECISIONS (%d)  candidate -> veto -> size -> submit" % len(rows), BOLD))
    for r in rows[-6:]:
        tag = col("PROCEED", GRN) if r.get("proceed") else col("HOLD   ", YEL)
        out.append("  %s %-5s %s reason=%s qty=%s limiter=%s submit=%s" % (
            ts(r.get("ts_ns")), r.get("symbol"), tag, r.get("reason"),
            r.get("qty"), r.get("limiter"), r.get("submit")))


def panel_journal(d, out):
    # journal.jsonl is the live chained file; journal-YYYYMMDD.jsonl are
    # full day-roll copies of it (counting them would double the rows).
    rows = []
    for ln in read_lines(os.path.join(d, "journal.jsonl")):
        p = ln.split("|")
        if len(p) == 7:
            rows.append(p)
    kinds = Counter(p[2] for p in rows)
    try:
        chain = all(rows[i][5] == rows[i - 1][6] and
                    int(rows[i][0]) == int(rows[i - 1][0]) + 1
                    for i in range(1, len(rows)))
        chain_txt = col("chain intact", GRN) if chain else col("CHAIN BROKEN", RED)
    except ValueError:
        chain_txt = col("CHAIN UNREADABLE (torn or garbled row)", RED)
    out.append(col("ORDER JOURNAL (%d rows)" % len(rows), BOLD) + "  " + chain_txt +
        "  " + " ".join("%s=%d" % kv for kv in sorted(kinds.items())))
    for p in rows[-6:]:
        c = RED if p[2] in ("unknown", "exit", "demotion") else DIM
        out.append("  #%s %s %-9s intent %s" % (p[0], ts(p[1]), col(p[2], c), short(p[3], 12)))


def eval_line(ev, sid, last):
    """EVAL line from ledgers/eval.json (read-only): checkpoint state and HAC
    t-stat of the paired active return; flagged stale if the eval lags the
    ledger. 'ELIGIBLE-FOR-REVIEW' means a human may review, never promote."""
    try:
        if sid in (ev.get("benchmarks") or {}):
            return "    " + col("EVAL BENCHMARK (control)", DIM)
        e = (ev.get("ledgers") or {}).get(sid)
        if e is None:
            return "    " + col("EVAL n/a (not evaluated yet)", DIM)
        st = e["checkpoint"]["state"]
        t = (e.get("paired") or {}).get("t_hac")
        txt = "EVAL %s  t=%s  vs %s" % (
            st, "n/a" if t is None else "%+.2f" % t, e.get("benchmark"))
        if e.get("last_date") != last:
            txt += "  (stale: eval to %s)" % e.get("last_date")
        bad = st in ("CHAIN-BROKEN", "KILL-FUTILE")
        return "    " + col(txt, RED if bad else DIM)
    except (KeyError, TypeError, AttributeError):
        return "    " + col("EVAL unreadable", YEL)


def panel_ledgers(d, out):
    out.append(col("SHADOW LEDGERS (virtual $100k each, no orders)", BOLD))
    sd = os.path.join(d, "ledgers")
    names = sorted(f for f in os.listdir(sd) if f.endswith(".jsonl")) if os.path.isdir(sd) else []
    if not names:
        out.append("  " + col("none yet (runs after each close)", DIM))
    try:  # written by ops/forward_eval.py (shadow --loop); absent is fine
        with open(os.path.join(sd, "eval.json")) as f:
            ev = json.load(f)
    except (OSError, ValueError):
        ev = {}
    for n in names:
        rows = jrows(os.path.join(sd, n))
        if not rows:
            continue
        eq, last = rows[-1].get("equity"), rows[-1].get("date")
        pct = (eq / rows[0]["equity"] - 1) * 100 if rows[0].get("equity") else 0.0
        flag = ""
        try:
            with open(os.path.join(sd, "status.json")) as f:
                st = json.load(f).get(n[:-6], {}).get("state", "ok")
            flag = "" if st == "ok" else "  " + col("KILL-LIMIT " + st.upper(), RED)
        except (OSError, ValueError):
            pass
        out.append("  %-24s %s  equity %10.2f  %+6.2f%%  (%d sessions)%s" % (
            n[:-6], last, eq, pct, len(rows), flag))
        out.append(eval_line(ev, n[:-6], last))


def panel_broker(broker, out):
    out.append(col("ALPACA PAPER (live from broker)", BOLD))
    data, err = broker.snapshot()
    if data is None:
        out.append("  " + col(err, YEL))
        return
    a, clk = data["account"], data["clock"]
    try:
        chg = float(a["equity"]) - float(a["last_equity"])
    except (KeyError, ValueError):
        chg = 0.0
    out.append("  market %s | equity $%s (%s today) | cash $%s | buying power $%s | %s" % (
        col("OPEN", GRN) if clk.get("is_open") else col("CLOSED", YEL),
        f(a.get("equity")), col("%+.2f" % chg, GRN if chg >= 0 else RED),
        f(a.get("cash")), f(a.get("buying_power")), a.get("status")))
    if data["positions"]:
        out.append(DIM + "  %-6s %6s %10s %10s %11s %8s" % (
            "SYMBOL", "QTY", "AVG", "LAST", "P/L $", "P/L %") + RST)
    live = ("new", "accepted", "held", "partially_filled", "pending_new",
            "accepted_for_bidding", "pending_replace")
    sells = Counter()
    for o in data.get("open", []):
        for x in [o] + list(o.get("legs") or []):
            if x.get("side") == "sell" and x.get("status") in live:
                sells[x["symbol"]] += 1
    for p in data["positions"]:
        pl = float(p.get("unrealized_pl", 0))
        n = sells.get(p["symbol"], 0)
        prot = col("stop ok (%d sell)" % n, GRN) if n else col("NO STOP", RED)
        out.append("  %-6s %6s %10s %10s %s %8s  %s" % (
            p["symbol"], p["qty"], f(p["avg_entry_price"]), f(p["current_price"]),
            col("%11s" % f(pl), GRN if pl >= 0 else RED),
            f(float(p.get("unrealized_plpc", 0)) * 100) + "%", prot))
    if not data["positions"]:
        out.append("  no open positions")
    out.append(DIM + "  recent orders" + RST)
    for o in data["orders"][:5]:
        out.append("  %s %-5s %-4s %s/%s %-10s %s" % (
            (o.get("submitted_at") or "")[11:19], o["symbol"], o["side"],
            o.get("filled_qty"), o.get("qty"), o.get("status"), o.get("type", "")))
    if err:
        out.append("  " + col("broker refresh failed: " + err[:90], YEL))


def render(d, broker):
    now = time.time()
    out = [col("MiroHedge paper monitor", BOLD) + "  %s  dir=%s" % (
        time.strftime("%Y-%m-%d %H:%M:%S"), d), ""]
    panels = [lambda: panel_loop(d, out, now), lambda: panel_candidates(d, out),
              lambda: panel_decisions(d, out), lambda: panel_journal(d, out),
              lambda: panel_ledgers(d, out)]
    if broker:
        panels.append(lambda: panel_broker(broker, out))
    for fn in panels:
        try:
            fn()
        except Exception as e:  # a bad file must not kill the view
            out.append(col("panel error: %s: %s" % (type(e).__name__, e), RED))
        out.append("")
    return "\n".join(out)


def main(argv):
    interval = 3.0
    rest = list(argv[1:])
    if "--interval" in rest:
        i = rest.index("--interval")
        try:
            interval = float(rest[i + 1])
        except (IndexError, ValueError):
            raise SystemExit("--interval needs a number of seconds")
        del rest[i:i + 2]
    args = [a for a in rest if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    d = os.path.expanduser(args[0])
    broker = None if "--no-broker" in rest else Broker(load_env())
    if "--once" in rest:
        print(render(d, broker))
        return 0
    try:
        while True:
            sys.stdout.write("\x1b[H\x1b[2J" + render(d, broker) + DIM +
                             "ctrl+c to exit (the loop keeps running)" + RST + "\n")
            sys.stdout.flush()
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
