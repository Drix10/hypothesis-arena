"""JEV paired A/B, log-only: each shadow sleeve vs its JEV-FILTERED TWIN.

No orders, no broker calls beyond the read-only SIP daily bars that
ops/sleeve_shadow.py already uses. For core/T1/T2 (the sleeves in
sleeve_shadow.sleeve_specs) every target-weight change that adds to or
increases a long in a non-cash symbol becomes ONE candidate in the existing
candidate-bound JEV contract (candidate_wire c1 record -> jev.state_from_
candidate). The verdict comes from collector.jev.decide exactly as
ops/jev_shadow.py obtains it (same spend governor, cache, one contract, pinned
model jev.MODEL / jev.REVISION, verdict through jev_filter.evaluate with
jev_shadow.ENGINE). The twin is the same sleeve run through the same engine
(research/strategy/portfolio.run, cost_v2) with every VETOED add dropped: a
vetoed add keeps at most the twin's previous weight in that symbol and the
freed weight goes to BIL. Everything else is identical, so the daily return
difference twin - base isolates the filter.

    python3 ops/jev_twin.py <dir>            # decide new candidates, extend twins
    python3 ops/jev_twin.py <dir> --report   # paired report (no LLM calls)
    ... --verify                             # replay must equal the twin log

Writes  <dir>/jev_twin/decisions.jsonl   append-only, hash-chained, one line per
                                         candidate: context hash, model id,
                                         output, verdict, decision time
        <dir>/sleeves/<sleeve>__jev.jsonl  twin ledger, same schema and hash
                                         chain as ops/sleeve_shadow.py
With no OPENROUTER_API_KEY the run logs one line and exits 0.

Design rules
- Idempotent: a candidate (keyed by its CID) already in decisions.jsonl is never
  re-asked. A decision is appended and fsynced BEFORE the twin uses it. A
  provider failure (no artifact) is NOT journaled: the candidate stays pending,
  and the twin ledger is only extended up to the first pending decision date,
  so a logged twin row never changes.
- Decisions are only asked for decision dates >= FORWARD_START (earlier targets
  are pre-cutoff history and are applied unfiltered). The decision timestamp is
  wall clock at the call; `pre_outcome` is true when no session after the
  decision date existed in the data at that moment. Analysis should use only
  pre_outcome decisions.
- What the LLM sees (contract fields only; the c1 schema carries no free text):
  strategy_version, symbol, snapshot ts, prices, family, cost/exit versions.
  The contract does NOT forbid opaque strings there (nothing validates a symbol
  against a universe), so ticker and sleeve name are replaced by salted-hash
  aliases and prices are rebased to 100 at the first forward session. What
  stays visible and cannot be hidden under this contract: the snapshot
  timestamp (the model is post-cutoff for these dates by construction) and the
  rebased price path shape. Real ticker <-> alias is kept only in the local
  journal.
- Verdict classes: PASS_* = approve; HOLD with a model-driven reason (VETO_
  REASONS) = veto; any other HOLD reason with an artifact (signature, binding,
  expiry, malformed...) = invalid: journaled, applied unfiltered, excluded from
  the approve/veto analysis and counted separately.
- Not covered: event sleeves (E1/I1) run their own engines in event_shadow.py."""
import datetime
import hashlib
import json
import math
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from collector import jev
from ops import jev_shadow
from ops import sleeve_shadow as S
from research.strategy import jev_filter, portfolio, sip_fetch
from research.strategy.candidate_wire import WireError, wire_record
from research.strategy.sleeves import trend

CASH = trend.CASH_LEG            # "BIL"
SUFFIX = "__jev"
SALT = "jev_twin_v1"
FAMILY = "momentum"              # a filter family; the model must agree with it
EPS = 1e-9
HORIZON_SESSIONS = 20
TIME_EXIT_DAYS = 28
RISK_MULT, RISK_MIN, RISK_MAX, TP_R = 3.0, 0.02, 0.25, 2.0   # fixed, not tuned
VETO_REASONS = frozenset({"latent_risk", "no_edge", "midband", "execution",
                          "flat", "family_binding"})
DECISIONS = os.path.join("jev_twin", "decisions.jsonl")


def _log(msg):
    print(json.dumps({"jev_twin": msg}))


def alias(kind, name):
    return kind + hashlib.sha256((SALT + "|" + name).encode()).hexdigest()[:8]


# ---- journal (same chain scheme as sleeve_shadow, keyed by cid) ----------

def read_decisions(path):
    rows = []
    if os.path.exists(path):
        with open(path) as f:
            rows = [json.loads(ln) for ln in f if ln.strip()]
    prev = "GENESIS"
    for r in rows:
        body = {k: v for k, v in r.items() if k not in ("prev", "hash")}
        if r["prev"] != prev or r["hash"] != S._digest(prev, body):
            raise ValueError("chain-broken:" + str(r.get("cid", "?")))
        prev = r["hash"]
    return rows, prev


def append_decision(path, rows, rec):
    prev = rows[-1]["hash"] if rows else "GENESIS"
    line = dict(rec, prev=prev, hash=S._digest(prev, rec))
    with open(path, "a") as f:
        f.write(json.dumps(line, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())
    rows.append(line)


# ---- candidates ------------------------------------------------------------

def target_changes(targets, forward_start):
    """[(date, sym, w_prev, w_new)] for every add/increase of a non-cash long.
    `targets` is the engine's weights log [(date, {sym: w})]; w_prev is the
    previous BASE target. Only dates >= forward_start are returned."""
    out, prev = [], {}
    for d, w in targets:
        if d >= forward_start:
            for s in sorted(w):
                if s != CASH and w[s] > prev.get(s, 0.0) + EPS:
                    out.append((d, s, prev.get(s, 0.0), w[s]))
        prev = w
    return out


def _epoch_ns(date):
    dt = datetime.datetime.fromisoformat(date).replace(
        hour=21, tzinfo=datetime.timezone.utc)
    return int(dt.timestamp()) * 10**9


def build_candidate(sleeve, sym, date, px, sessions, ref_date):
    """c1 wire record + jev state for one add, anonymised (see module doc).
    Raises WireError/KeyError/ValueError when it cannot be built."""
    closes = [px[sym][x][1] for x in sessions if x <= date and x in px[sym]]
    ref = px[sym][ref_date][1]
    if len(closes) < 22 or not ref > 0:
        raise WireError("history")
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(-20, 0)]
    mu = sum(rets) / len(rets)
    sig = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1))
    risk = min(RISK_MAX, max(RISK_MIN, RISK_MULT * sig * math.sqrt(20)))
    entry = 100.0 * closes[-1] / ref
    ts = _epoch_ns(date)
    rec = wire_record(alias("V", sleeve), alias("S", sym), ts, entry,
                      entry * (1 - risk), entry * (1 + TP_R * risk),
                      time_exit_ns=ts + TIME_EXIT_DAYS * 86400 * 10**9,
                      side="BUY", family=FAMILY)
    cand = rec["candidate"]
    fhash = hashlib.sha256(json.dumps(
        {"cid": cand["cid"], "ref": "rebased100"}, sort_keys=True
    ).encode()).hexdigest()
    market = {"snapshot_epoch": ts // 10**9, "price_s": cand["entry_px"],
              "spread_bps_s": "unknown", "session": "unknown",
              "regime": "unknown"}
    state = jev.state_from_candidate(cand, market, jev_shadow.STAGE, fhash)
    return cand, state


def classify(verdict, reason):
    if verdict in ("PASS_BASE", "PASS_ELEVATED_ELIGIBLE"):
        return "approve"
    if verdict == "HOLD" and reason in VETO_REASONS:
        return "veto"
    return "invalid"


def decide_one(sleeve, sym, date, w_prev, w_new, cand, state, sessions_after,
               key, post_fn, wall):
    """-> journal record or None (provider gave no artifact: stays pending)."""
    now = wall()
    row, art = jev.decide(state, now=now, key=key, post_fn=post_fn)
    if art is None:
        return None
    summ = jev_shadow.summarize(cand, state, row, art, now)
    verdict, reason = summ["verdict"], summ["reason"]
    p = art["payload"]
    return {"cid": cand["cid"], "sleeve": sleeve, "symbol": sym,
            "alias": cand["symbol"], "date": date, "w_prev": w_prev,
            "w_new": w_new, "snapshot_ts_ns": cand["snapshot_ts_ns"],
            "ctx_hash": jev.sha256_hex(jev.canon(jev.build_request(state))),
            "model": p["model"], "revision": p["revision"],
            "provider": p["provider"], "action": row.get("action"),
            "answers": p["answers"], "response_hash": art["response_hash"],
            "verdict": verdict, "reason": reason,
            "class": classify(verdict, reason), "decided_at": now,
            "decided_at_iso": datetime.datetime.fromtimestamp(
                now, datetime.timezone.utc).isoformat(),
            "sessions_after": sessions_after,
            "pre_outcome": sessions_after == 0}


# ---- twin ------------------------------------------------------------------

def twin_targets(targets, vetoed):
    """{date: weights} for the twin. vetoed = {(date, sym)} of dropped adds."""
    out, prev_b, prev_t = {}, {}, {}
    for d, w in targets:
        tw = dict(w)
        for s, x in list(w.items()):
            if s != CASH and x > prev_b.get(s, 0.0) + EPS and (d, s) in vetoed:
                tw[s] = min(x, prev_t.get(s, 0.0))
                if tw[s] <= EPS:
                    del tw[s]
        dropped = sum(w.values()) - sum(tw.values())
        if dropped > 1e-12:
            tw[CASH] = tw.get(CASH, 0.0) + dropped
        out[d] = tw
        prev_b, prev_t = w, tw
    return out


def _twin_factory(tt):
    def factory(sessions):
        return lambda date, closes: (dict(tt[date]) if date in tt else None)
    return factory


def process_sleeve(d, sid, universe, factory, spec, prices, jrows, jpath, key,
                   post_fn, wall, verify, bad, summary):
    px = {s: prices[s] for s in universe}
    sessions = S.common_sessions(px)
    if not sessions:
        return 0
    res = portfolio.run(sessions, px, factory(sessions), cash0=S.CASH0)
    targets = res["weights"]
    fwd = [x for x in sessions if x >= S.FORWARD_START]
    if not fwd:
        return 0
    asked, pending_from = 0, None
    have = {r["cid"]: r for r in jrows}
    for date, sym, w0, w1 in target_changes(targets, S.FORWARD_START):
        try:
            cand, state = build_candidate(sid, sym, date, px, sessions, fwd[0])
        except (WireError, KeyError, ValueError) as e:
            cid = "unbuildable|%s|%s|%s" % (sid, sym, date)
            if cid not in have:
                if verify:
                    continue
                rec = {"cid": cid, "sleeve": sid, "symbol": sym, "date": date,
                       "w_prev": w0, "w_new": w1, "verdict": "HOLD",
                       "reason": "wire:%s" % e, "class": "invalid",
                       "decided_at": wall(), "pre_outcome": False}
                append_decision(jpath, jrows, rec)
                have[cid] = rec
            continue
        if cand["cid"] in have or verify:
            continue
        after = sum(1 for x in sessions if x > date)
        rec = decide_one(sid, sym, date, w0, w1, cand, state, after, key,
                         post_fn, wall)
        if rec is None:
            pending_from = pending_from or date
            continue
        append_decision(jpath, jrows, rec)   # journaled before it is used
        have[cand["cid"]] = rec
        asked += 1
    vetoed = {(r["date"], r["symbol"]) for r in have.values()
              if r["sleeve"] == sid and r["class"] == "veto"}
    tt = twin_targets(targets, vetoed)
    tsym = list(universe) if CASH in universe else list(universe) + [CASH]
    tid = sid + SUFFIX
    fresh = S.replay(tid, prices, _twin_factory(tt), tsym)
    if pending_from is not None:
        fresh = [r for r in fresh if r["date"] <= pending_from]
    S._settle(d, tid, fresh, spec + "+jev", verify, bad, summary, lenient=True)
    summary[tid]["decisions"] = sum(1 for r in have.values()
                                    if r["sleeve"] == sid)
    summary[tid]["vetoed"] = len(vetoed)
    summary[tid]["pending_from"] = pending_from
    return asked


def run(d, now, key, prices=None, post_fn=None, wall=time.time, verify=False,
        http_get=sip_fetch.default_http_get):
    if not key:
        _log("skipped: no OPENROUTER_API_KEY")
        return [], {}
    specs = S.sleeve_specs()
    if prices is None:
        symbols = sorted({s for u, _, _ in specs.values() for s in u} | {CASH})
        prices = S.fetch_prices(symbols, now, http_get)
    os.makedirs(os.path.join(d, "jev_twin"), exist_ok=True)
    os.makedirs(os.path.join(d, "sleeves"), exist_ok=True)
    jpath = os.path.join(d, DECISIONS)
    jrows, _ = read_decisions(jpath)
    bad, summary = [], {}
    for sid, (universe, factory, spec) in specs.items():
        process_sleeve(d, sid, universe, factory, spec, prices, jrows, jpath,
                       key, post_fn, wall, verify, bad, summary)
    return bad, summary


# ---- report ----------------------------------------------------------------

def _mean(x):
    return sum(x) / len(x)


def paired_bootstrap(diffs, reps=2000, block=5, seed=0, level=0.95):
    """Circular block bootstrap of the mean daily difference."""
    n = len(diffs)
    if n == 0:
        return None
    m = _mean(diffs)
    sd = math.sqrt(sum((x - m) ** 2 for x in diffs) / (n - 1)) if n > 1 else 0.0
    rng, means = random.Random(seed), []
    b = max(1, min(block, n))
    for _ in range(reps):
        s, got = 0.0, 0
        while got < n:
            i = rng.randrange(n)
            for j in range(min(b, n - got)):
                s += diffs[(i + j) % n]
                got += 1
        means.append(s / n)
    means.sort()
    lo = means[int((1 - level) / 2 * reps)]
    hi = means[min(reps - 1, int((1 + level) / 2 * reps))]
    return {"n": n, "mean": m, "ci_lo": lo, "ci_hi": hi,
            "t_naive": (m / (sd / math.sqrt(n))) if sd > 0 else None}


def realized(prices, sym, date, h=HORIZON_SESSIONS):
    """Open of the next session to close h sessions after `date`; None if
    not yet known."""
    dates = sorted(prices.get(sym, {}))
    if date not in prices.get(sym, {}):
        return None
    i = dates.index(date)
    if i + h >= len(dates):
        return None
    return prices[sym][dates[i + h]][1] / prices[sym][dates[i + 1]][0] - 1.0


def _welch(a, b):
    if len(a) < 2 or len(b) < 2:
        return None
    va = sum((x - _mean(a)) ** 2 for x in a) / (len(a) - 1)
    vb = sum((x - _mean(b)) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return (_mean(a) - _mean(b)) / se if se > 0 else None


def report(d, prices=None, reps=2000, block=5, seed=0):
    out = {"paired": {}, "decisions": {}}
    for sid in S.sleeve_specs():
        base, _ = S.read_log(os.path.join(d, "sleeves", sid + ".jsonl"))
        twin, _ = S.read_log(os.path.join(d, "sleeves", sid + SUFFIX + ".jsonl"))
        b = {r["date"]: r["ret"] for r in base}
        diffs = [r["ret"] - b[r["date"]] for r in twin if r["date"] in b]
        out["paired"][sid] = paired_bootstrap(diffs, reps, block, seed)
    jrows, _ = read_decisions(os.path.join(d, DECISIONS))
    cls = {"approve": [], "veto": []}
    counts = {"approve": 0, "veto": 0, "invalid": 0, "late": 0, "no_outcome": 0}
    for r in jrows:
        counts[r["class"]] += 1
        if not r.get("pre_outcome"):
            counts["late"] += 1
            continue
        if r["class"] not in cls:
            continue
        x = realized(prices, r["symbol"], r["date"]) if prices else None
        if x is None:
            counts["no_outcome"] += 1
        else:
            cls[r["class"]].append(x)
    a, v = cls["approve"], cls["veto"]
    t = _welch(a, v)
    diff = (_mean(a) - _mean(v)) if a and v else None
    out["decisions"] = {
        "counts": counts, "n_approve_20d": len(a), "n_veto_20d": len(v),
        "mean_approve_20d": _mean(a) if a else None,
        "mean_veto_20d": _mean(v) if v else None,
        "approve_minus_veto": diff, "t_welch": t,
        # Working hypothesis from plan/appendix/11 (200+ decisions, > 50 bp,
        # t > 2). Illustrative: the criterion is NOT preregistered by this code.
        "meets_working_criterion": bool(
            diff is not None and t is not None and len(a) + len(v) >= 200
            and diff > 0.005 and t > 2)}
    return out


def main(argv, now=None, post_fn=None):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit("usage: jev_twin.py <dir> [--report|--verify]")
    d = args[0]
    from research.strategy import a_run
    if "--report" in argv:
        a_run._load_env()
        prices = None
        try:
            specs = S.sleeve_specs()
            symbols = sorted({s for u, _, _ in specs.values() for s in u})
            prices = S.fetch_prices(
                symbols, now or datetime.datetime.now(datetime.timezone.utc))
        except Exception as e:  # noqa: BLE001 - report still gives paired part
            _log("no prices, outcome section empty: %r" % (e,))
        print(json.dumps(report(d, prices), sort_keys=True))
        return 0
    key = jev.api_key()
    if not key:
        _log("skipped: no OPENROUTER_API_KEY")
        return 0
    a_run._load_env()
    n = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        bad, summary = run(d, n, key, post_fn=post_fn, verify="--verify" in argv)
    except (ValueError, OSError, sip_fetch.SipError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 2
    print(json.dumps({"twins": summary, "mismatch": bad}))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
