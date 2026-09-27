"""S5 paired evaluation: ALWAYS_TAKE vs JEV_FILTERED (research/shadow-only).

Contract (doc 11, eval_v1, s5_prereg.json v2):
- SAME deterministic candidate stream, paired at CID.
- ALWAYS_TAKE resolves every realized candidate at frozen economics.
- JEV_FILTERED takes only v4 PASS_* (+ prereg variant reading); HOLD never fills.
- Censored stays censored; Brier on CLOSED labels only.
- Resampling: day-cluster bootstrap (cluster-aware by construction) for BOTH
  the percentile CI and the null-centered one-sided test (separate procedures).
- Sequential: two pre-registered looks (interim 50% / final) with Bonferroni
  alpha split + futility stop. Power study on real-stream dependence with
  pre-declared MDE. Walk-forward folds for selection; holdout enters ONLY the
  separate final path after selection is frozen.
- Portfolio: daily equity curve with open positions marked at session closes,
  zero-days kept; Sharpe x sqrt(252) with Newey-West HAC SE; max drawdown
  from the curve. Absolute bar mechanically evaluated, never hardcoded.

No live orders. No threshold tuning. No strategy redesign.
"""
import hashlib
import inspect
import json
import math
import random

from . import backtest as bt

EVAL_PROTOCOL = "eval_v1"
BOOT_REPS = 2000
BOOT_SEED = 0x5EED
POWER_REPS = 200
POWER_INNER = 200
POWER_SEED = 41721
HOLM_ALPHA = 0.05
SEQ_ALPHA_INTERIM = 0.025
SEQ_ALPHA_FINAL = 0.025
R2_SINGLE_PCT = 25.0
R2_TOTAL_PCT = 75.0
MAX_POSITIONS = 3
SIDES = ("BUY", "SELL")
FAMILIES = ("mean_reversion", "momentum")

# Prereg variant family (names/semantics EXACTLY as s5_prereg.json v2).
VARIANTS = ("filtered-conv-any", "filtered-enter-gte-80-strong-plus")
VARIANT_RULE = {
    "filtered-conv-any": "take iff frozen v4 verdict in PASS_*",
    "filtered-enter-gte-80-strong-plus":
        "take iff PASS_* AND enter>=0.8 AND conviction in (strong, max)",
}


def eval_hash(record):
    body = {k: record[k] for k in sorted(record) if k != "eval_hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True,
                                     default=str).encode()).hexdigest()


def stub_answers_provider(model="stub-deterministic-v1",
                          revision="stub-v1", provider="s5-harness"):
    """Deterministic stub (harness proofs ONLY, never JEV evidence)."""
    from collector.jev import ed_pubkey
    seed = bytes.fromhex("ab" * 32)
    pub = ed_pubkey(seed)

    def provide(candidate, market, now_unix):
        from . import jev_v4 as v4
        rng = random.Random(int(candidate.cid[:16], 16))
        conv = ("flat", "lean", "strong", "max")[int(candidate.cid, 16) % 4]
        ans = {"enter": rng.random(), "edge_family": candidate.proposed_family,
               "conviction": conv, "latent_risk": rng.random()}
        payload = v4.make_v4_payload(candidate, market, ans, now_unix,
                                     now_unix + 60)
        art = v4.sign_v4(payload, seed)
        meta = {"model": model, "revision": revision, "provider": provider}
        return art, meta

    return provide, pub


def r_validate(candidate):
    """Frozen-risk admission screen (uses R semantics, redesigns nothing).

    A disqualified candidate must never be taken by any policy; the take
    gate and the bar both consume the flag. Ordinary 25% cap binding is
    sizing, NOT a violation (size_notional clamps; only degenerate asks
    that break the R definition disqualify). Pure function of candidate."""
    if candidate.proposed_side not in SIDES:
        return (True, "bad_side")
    if candidate.proposed_family not in FAMILIES:
        return (True, "bad_family")
    if not (candidate.entry_px > 0 and candidate.stop_px > 0 and
            candidate.tp_px > 0):
        return (True, "nonpositive_price")
    if abs(candidate.entry_px - candidate.stop_px) <= 0:
        return (True, "zero_risk")
    if candidate.time_exit_ns <= candidate.snapshot_ts_ns:
        return (True, "no_horizon")
    return (False, "ok")


def _exit_spread(candidate, bars_after, exit_ts_ns):
    for b in bars_after:
        if b.ts_ns == exit_ts_ns:
            return b.spread_bps
    return 0.0


def evaluate_stream(items, answers_fn, pubkey, engine, variant,
                    spread_mult=1.0, day_fn=None, data_id=None):
    """items: [(candidate, bars_after, market, regime, entry_spread_bps)].

    variant in VARIANTS (prereg names). Deterministic. Every record binds
    the exact frozen inputs needed for replay (candidate meta, two-leg
    costs, spread multiplier, v4 response_hash+signature, data slice id)."""
    from . import jev_v4 as v4
    assert variant in VARIANTS, variant
    day_fn = day_fn or (lambda ts: str(ts))
    data_id = data_id or {"slice": "unspecified", "dataset_sha": "unspecified"}
    records = []
    for c, bars_after, market, regime, spread_bps in items:
        res = v4.resolve_v4_label(c, bars_after, spread_mult=spread_mult,
                                  entry_spread_bps=spread_bps)
        art, meta = answers_fn(c, market, market["snapshot_epoch"])
        action, reason = v4.evaluate_v4(c, art, market["snapshot_epoch"],
                                        pubkey, engine)
        if variant == "filtered-enter-gte-80-strong-plus" and \
                action.startswith("PASS"):
            a = art["payload"]["answers"]
            if not (a["enter"] >= 0.8 and
                    a["conviction"] in ("strong", "max")):
                action, reason = "HOLD", "strict_reading"
        disq, disq_reason = r_validate(c)
        filt_pass = action.startswith("PASS")  # JEV verdict (pre-R-gate)
        filt_r = res["r_realized"] if filt_pass else 0.0
        filt_taken = filt_pass and res["realized"] and not disq
        # policy outcomes: disqualified is never taken by either policy,
        # so it contributes ZERO policy R (diagnostic economics kept in
        # resolved_r / always_label). No false paired delta from forbiddens.
        always_r = (res["r_realized"] if res["realized"] else 0.0) \
            if not disq else 0.0
        if disq:
            filt_r = 0.0
        # R-breach attempt: policy would have taken but frozen R forbids.
        breach_attempted = bool(disq and filt_pass and res["realized"])
        exit_sp = _exit_spread(c, bars_after, res["exit_ts_ns"]) \
            if res["realized"] else 0.0
        rec = {
            "eval_protocol": EVAL_PROTOCOL,
            "variant": variant,
            "cid": c.cid, "symbol": c.symbol,
            "snapshot_ts_ns": c.snapshot_ts_ns,
            "day": day_fn(c.snapshot_ts_ns),
            "proposed_side": c.proposed_side,
            "proposed_family": c.proposed_family,
            "entry_px": c.entry_px, "stop_px": c.stop_px, "tp_px": c.tp_px,
            "time_exit_ns": c.time_exit_ns,
            "strategy_version": c.strategy_version,
            "exit_profile_version": c.exit_profile_version,
            "cost_model_version": c.cost_model_version,
            "expected_cost_bps": c.expected_cost_bps,
            "feature_revision": c.feature_revision,
            "feature_snapshot_hash": c.feature_snapshot_hash,
            "entry_spread_bps": spread_bps,
            "exit_spread_bps": exit_sp,
            "spread_mult": spread_mult,
            "entry_fill": res["entry_fill"], "exit_fill": res["exit_fill"],
            "exit_ts_ns": res["exit_ts_ns"],
            "resolved_r": res["r_realized"],  # diagnostic only
            "always_r": always_r,
            "always_label": res["label"],
            "always_realized": res["realized"] and not disq,
            "disqualified": disq, "disqualify_reason": disq_reason,
            "filtered_pass": filt_pass,
            "filtered_action": action, "filtered_reason": reason,
            "filtered_r": filt_r, "filtered_taken": filt_taken,
            "r_breach_attempted": breach_attempted,
            "regime": regime,
            "enter": art["payload"]["answers"]["enter"],
            "latent_risk": art["payload"]["answers"]["latent_risk"],
            "family_answer": art["payload"]["answers"]["edge_family"],
            "conviction": art["payload"]["answers"]["conviction"],
            "response_hash": art["response_hash"],
            "signature": art["signature"],
            "decision_key": art["payload"]["decision_key"],
            "model": meta["model"], "revision": meta["revision"],
            "provider": meta["provider"],
            "data_slice": data_id["slice"],
            "dataset_sha": data_id["dataset_sha"],
        }
        rec["eval_hash"] = eval_hash(rec)
        records.append(rec)
    return records


def paired_deltas(records):
    return [r["filtered_r"] - r["always_r"] for r in records]


# ---- day-cluster bootstrap (cluster-aware dependence procedure) ----

def _day_clusters(days):
    order, groups = [], {}
    for i, d in enumerate(days):
        groups.setdefault(d, []).append(i)
    order = sorted(groups)
    return [groups[d] for d in order]


def cluster_reps(values, days, reps=BOOT_REPS, seed=BOOT_SEED):
    """Resample whole day-clusters with replacement; mean per replicate."""
    rng = random.Random(seed)
    clusters = _day_clusters(days)
    n = len(values)
    assert n > 0
    out = []
    for _ in range(reps):
        s, m = 0.0, 0
        for _ in range(len(clusters)):
            for i in rng.choice(clusters):
                s += values[i]
                m += 1
        out.append(s / m if m else 0.0)
    return out


def cluster_bootstrap_ci(values, days, reps=BOOT_REPS, seed=BOOT_SEED,
                         alpha=0.05):
    """Percentile CI for the mean (dependence-aware; NOT a test)."""
    means = sorted(cluster_reps(values, days, reps, seed))
    return (sum(values) / len(values),
            means[int(alpha / 2 * reps)],
            means[int((1 - alpha / 2) * reps) - 1])


def cluster_null_p(values, days, reps=BOOT_REPS, seed=BOOT_SEED):
    """One-sided null p for H0: mean <= 0 vs H1: mean > 0.

    The resample distribution is CENTERED under H0 (observed mean
    subtracted) and p = P(boot mean >= observed mean). Separate procedure
    from the CI with explicit null semantics."""
    mu = sum(values) / len(values)
    centered = [v - mu for v in values]
    boots = cluster_reps(centered, days, reps, seed + 1)
    return sum(1 for b in boots if b >= mu) / len(boots)


# ---- pre-registered sequential rule (prereg v2 §seq) ----

def seq_decision(deltas, days, look, reps=BOOT_REPS, seed=BOOT_SEED):
    """look='interim' (first 50% by snapshot order) or 'final'.

    Interim: futility stop if mean<=0; efficacy stop iff null p<0.025;
    else continue. Final: efficacy iff null p<0.025 (Bonferroni over the
    two pre-registered looks; conservative under dependence)."""
    assert look in ("interim", "final")
    if look == "interim":
        half = len(deltas) // 2
        d, dy = deltas[:half], days[:half]
        mu = sum(d) / len(d)
        if mu <= 0:
            return ("stop-futility", mu, 1.0)
        p = cluster_null_p(d, dy, reps, seed)
        return ("stop-efficacy" if p < SEQ_ALPHA_INTERIM else "continue",
                mu, p)
    mu = sum(deltas) / len(deltas)
    p = cluster_null_p(deltas, days, reps, seed)
    return ("efficacy" if p < SEQ_ALPHA_FINAL else "fail", mu, p)


# ---- power study (pre-declared MDE, real-stream dependence) ----

def _null_reject(sample, days, alpha, seed, inner=POWER_INNER):
    """Single null-test decision (shared by seq/final/power paths)."""
    m0 = sum(sample) / len(sample)
    c0 = [v - m0 for v in sample]
    b0 = cluster_reps(c0, days, reps=inner, seed=seed)
    return sum(1 for b in b0 if b >= m0) / len(b0) < alpha


def power_study(train_values, train_days, mde, alpha=SEQ_ALPHA_FINAL,
                reps=POWER_REPS, seed=POWER_SEED, target=0.8,
                multipliers=(1, 2, 4, 8)):
    """Power of the cluster null test under mean shift = mde.

    Dependence comes from resampling the TRAIN stream's own day-clusters
    (centered, then shifted by mde) — never from holdout, never from the
    final JEV comparison. Size scaling circularly tiles relabeled clusters.
    Deterministic. Returns achieved power per multiplier and the required
    multiplier for target power (None if unreached)."""
    rng = random.Random(seed)
    mu = sum(train_values) / len(train_values)
    pairs = [(v - mu + mde, d) for v, d in zip(train_values, train_days)]
    out = {"mde": mde, "alpha": alpha, "reps": reps, "seed": seed,
           "n_base": len(pairs), "by_multiplier": {}, "required": None}
    for mult in multipliers:
        tiled = [(v, "%s#%d" % (d, k)) for k in range(mult)
                 for (v, d) in pairs]
        idx = sorted(set(d for _, d in tiled))
        groups = [[i for i, (_, d) in enumerate(tiled) if d == lab]
                  for lab in idx]
        hits = 0
        for r in range(reps):
            samp_idx = [i for _ in range(len(groups))
                        for i in rng.choice(groups)]
            samp = [tiled[i][0] for i in samp_idx]
            sdays = [tiled[i][1] for i in samp_idx]
            if _null_reject(samp, sdays, alpha, seed + r):
                hits += 1
        pw = hits / reps
        out["by_multiplier"][mult] = pw
        if pw >= target and out["required"] is None:
            out["required"] = mult
    return out


# ---- portfolio: daily curve with mark-to-close ----

def portfolio_curve(records, policy, equity, sessions):
    """Single chronological sweep: admission + marking in ts order.

    sessions: [{day, end_ts, closes:{symbol: px}}] chronological.
    Entries open only at/after their snapshot ts; exits settle only when
    their exit ts is reached (exits-first at identical ts, frozen rule);
    opens are marked only at session closes after entry; sizing uses
    then-current realized equity. Zero-activity sessions stay zero-return.
    Positions still open past the final session stay open, marked at the
    last close (never settled on unobserved prices). No future position
    ever enters an earlier mark. Returns (trades, curve, returns, max_dd)."""
    assert policy in ("always", "filtered")
    assert all(sessions[i]["end_ts"] <= sessions[i + 1]["end_ts"]
               for i in range(len(sessions) - 1))
    # event queue: (ts, kind, record) with exits(0) before entries(1)
    evts = []
    for r in records:
        take = (r["always_realized"] if policy == "always"
                else r["filtered_taken"])
        if take:
            evts.append((r["snapshot_ts_ns"], 1, r))
    evts.sort(key=lambda e: (e[0], e[1]))
    open_pos = []  # [exit_ts, symbol, sign, qty, entry_px, con_usd, pnl]
    cash, realized = equity, 0.0
    trades, curve = [], []
    eff_cache = {}
    pending = sorted(evts, key=lambda e: (e[0], e[1]))

    def settle(limit):
        nonlocal cash, realized, open_pos
        due = sorted([p for p in open_pos if p[0] <= limit],
                     key=lambda p: p[0])
        open_pos = [p for p in open_pos if p[0] > limit]
        for p in due:
            cash += p[3] * p[2] * p[4] + p[6]
            realized += p[6]

    for s in sessions:
        end = s["end_ts"]
        # merged ts order: exits due at/before each entry ts settle first
        # (frozen exits-first at identical ts; chronological otherwise)
        while pending and pending[0][0] <= end:
            settle(pending[0][0])
            _, _, r = pending.pop(0)
            ts = r["snapshot_ts_ns"]
            if any(p[1] == r["symbol"] for p in open_pos):
                continue
            if len(open_pos) >= MAX_POSITIONS:
                continue
            sizing_eq = equity + realized
            risk = abs(r["entry_px"] - r["stop_px"])
            key = (r["cid"], round(sizing_eq, 6))
            if key not in eff_cache:
                eff_cache[key] = bt.size_notional(sizing_eq, risk,
                                                  r["entry_px"])
            _, con, _, _, eff_frac = eff_cache[key]
            con_usd = con / 100.0 * sizing_eq
            if (sum(p[5] for p in open_pos) + con_usd) / sizing_eq > \
                    R2_TOTAL_PCT / 100.0:
                continue
            rr = r["always_r"] if policy == "always" else r["filtered_r"]
            pnl = rr * eff_frac * sizing_eq
            sign = 1 if r["proposed_side"] == "BUY" else -1
            qty = con_usd / r["entry_px"]
            cash -= sign * qty * r["entry_px"]
            open_pos.append([r["exit_ts_ns"], r["symbol"], sign, qty,
                             r["entry_px"], con_usd, pnl])
            trades.append({"cid": r["cid"], "symbol": r["symbol"],
                           "side": r["proposed_side"], "entry_ts": ts,
                           "exit_ts": r["exit_ts_ns"],
                           "con_usd": con_usd,
                           "entry_equity": sizing_eq, "pnl_usd": pnl,
                           "spread_mult": r["spread_mult"],
                           "policy": policy})
        settle(end)  # exits due later in this session, before its mark
        mark = sum(p[2] * p[3] * s["closes"].get(p[1], p[4])
                   for p in open_pos)
        curve.append((s["day"], cash + mark))
    # Positions still open past the final session stay open, marked at the
    # last close (computed in-loop above). Never settle the unobserved.
    rets = [(curve[i][1] - curve[i - 1][1]) / curve[i - 1][1]
            if curve[i - 1][1] else 0.0 for i in range(1, len(curve))]
    return trades, curve, rets, max_drawdown(curve)


def max_drawdown(curve):
    peak, dd = curve[0][1] if curve else 0.0, 0.0
    for _, eq in curve:
        peak = max(peak, eq)
        dd = max(dd, (peak - eq) / peak if peak else 0.0)
    return dd * 100.0


def sharpe_hac(rets):
    """Annualized Sharpe with Newey-West (Bartlett) HAC SE.

    Bandwidth = floor(4*(n/100)^(2/9)) (documented per run). Returns
    (sharpe, se, t)."""
    n = len(rets)
    if n < 2:
        return (0.0, float("inf"), 0.0)
    mu = sum(rets) / n
    var = sum((x - mu) ** 2 for x in rets) / n
    if var <= 0:
        return (0.0, float("inf"), 0.0)
    bw = max(0, int(4 * (n / 100.0) ** (2.0 / 9.0)))
    omega = var
    for lag in range(1, min(bw, n - 1) + 1):
        cov = sum((rets[t] - mu) * (rets[t - lag] - mu)
                  for t in range(lag, n)) / n
        omega += 2 * (1 - lag / (bw + 1)) * cov
    if omega <= 0:
        return (0.0, float("inf"), 0.0)
    se_daily = math.sqrt(omega / n)
    return (mu / math.sqrt(var) * math.sqrt(252.0),
            se_daily / math.sqrt(var) * math.sqrt(252.0),
            mu / se_daily if se_daily > 0 else 0.0)


def holm(pvals, alpha=HOLM_ALPHA):
    """Proper Holm step-down adjusted p-values (monotone cummax).

    Sort by raw p; candidate adj = min(1, (m-i)*p_i); adjusted p_i =
    cumulative MAX of candidates; reject while adj < alpha in order.
    Returns [(name, adj_p, reject)] sorted by raw p."""
    m = len(pvals)
    ordered = sorted(pvals, key=lambda t: t[1])
    cand = [min(1.0, (m - i) * p) for i, (_, p) in enumerate(ordered)]
    adj, peak = [], 0.0
    for c in cand:
        peak = max(peak, c)
        adj.append(peak)
    out, stop = [], False
    for (name, _), a in zip(ordered, adj):
        rej = (not stop) and (a < alpha)
        stop = stop or not rej
        out.append((name, a, rej))
    return out


def brier(pairs):
    """Mean (p - y)^2 over CLOSED labels only (censored never scored)."""
    closed = [(p, 1.0 if lab == "win" else 0.0) for p, lab in pairs
              if lab in ("win", "loss")]
    if not closed:
        return (0.0, 0)
    return (sum((p - y) ** 2 for p, y in closed) / len(closed), len(closed))


# ---- R1-R17 classification for the S5 research environment ----
# CHECKED = evaluated on S5 inputs (enforced and/or post-hoc verified).
# NOT_APPLICABLE = no agent/spend/stage/calibration object exists in S5.
# UNAVAILABLE = needs live/online authoritative inputs absent in research;
#   must be prereg-declared out-of-scope or the bar fails closed.
R_S5_STATUS = {
    "R1-positions": ("CHECKED", "sweep enforces max-3 + 1-per-symbol"),
    "R1-same-direction": ("CHECKED", "post-hoc: never >2 concurrent"),
    "R1-pending": ("UNAVAILABLE", "no order/ack model in research fills"),
    "R2-single": ("CHECKED", "size_notional clamp + post-hoc verify"),
    "R2-total": ("CHECKED", "sweep admission + post-hoc verify"),
    "R2-pending": ("UNAVAILABLE", "no order/ack model in research fills"),
    "R3-churn": ("CHECKED", "post-hoc: 20/day, 3/symbol/hour"),
    "R4-fliplock": ("CHECKED", "post-hoc: no opposite entry <1h post-exit"),
    "R5-halt": ("CHECKED", "post-hoc monitor: curve DD>10 run-local peak"),
    "R6-vol": ("UNAVAILABLE", "no 480+24h baselines / data-age gates"),
    "R7-corr": ("UNAVAILABLE", "no trailing-30 correlation engine"),
    "R8-maxgate": ("CHECKED", "frozen v4 table per decision"),
    "R9-venue": ("UNAVAILABLE", "no broker adapter / venue calendar"),
    "R10-spend": ("NOT_APPLICABLE", "no AI spend object in S5"),
    "R11-isolation": ("NOT_APPLICABLE", "no research-plane writes in S5"),
    "R12-lookahead": ("CHECKED", "structural: bars[..i], tested"),
    "R13-calib": ("NOT_APPLICABLE", "calibration tracked separately"),
    "R14-disagree": ("CHECKED", "engine disagreement flag per decision"),
    "R15-caps": ("NOT_APPLICABLE", "no research cycles in S5"),
    "R16-killswitch": ("NOT_APPLICABLE", "no live stages in S5"),
    "R17-escalation": ("NOT_APPLICABLE", "no stages in S5"),
    "stop-rule": ("CHECKED", "frozen resolve exits per candidate"),
}
R_CHECKED = sorted(k for k, (s, _) in R_S5_STATUS.items() if s == "CHECKED")
R_UNAVAILABLE = sorted(k for k, (s, _) in R_S5_STATUS.items()
                       if s == "UNAVAILABLE")
REQUIRED_STRESS = ("1.5x", "2x", "3x")


def verify_r_monitor(trades, curve, day_of=None):
    """Post-hoc verification of CHECKED monitor rules on taken trades.

    day_of: {cid: day label} for the R3 day bucket (else '?' single bucket).
    Time-based rules (R4 1h lock, R3 symbol-hour) apply only to ns-scale
    timestamps; int-scale synthetic streams skip them (documented).
    Returns [breach strings]. Pure function of the ledger + curve:
    R3 day/symbol-hour churn, R4 flip-lock, R5 DD>10 (run-local peak),
    R1 same-direction concurrency, R2 single/total concurrency."""
    breaches = []
    day_of = day_of or {}
    ns = any(t["entry_ts"] > 10 ** 12 for t in trades)
    by_day, by_sym_hour = {}, {}
    for t in trades:
        by_day.setdefault(day_of.get(t["cid"], "?"), []).append(t)
        hr = t["entry_ts"] // 3600000000000 if ns else t["entry_ts"] // 3600
        by_sym_hour.setdefault((t["symbol"], hr), []).append(t)
    for d, ts in by_day.items():
        if len(ts) > 20:
            breaches.append("R3-day:%s:%d" % (d, len(ts)))
    for (sym, hr), ts in by_sym_hour.items():
        if len(ts) > 3:
            breaches.append("R3-symhour:%s:%s:%d" % (sym, hr, len(ts)))
    # R4: opposite-side entry within 1h after same-symbol exit (ns only)
    exits = {}
    for t in sorted(trades, key=lambda x: x["entry_ts"]):
        key = t["symbol"]
        if key in exits and ns:
            ets, eside = exits[key]
            if t["side"] != eside and \
                    0 <= t["entry_ts"] - ets < 3600000000000:
                breaches.append("R4-fliplock:%s:%s" % (key, t["cid"]))
        exits[key] = (t["exit_ts"], t["side"])
    if max_drawdown(curve) > 10.0:
        breaches.append("R5-halt:dd=%.2f" % max_drawdown(curve))
    # concurrency sweeps: same-direction (R1) and totals (R2)
    pts = []
    for t in trades:
        sgn = 1 if t["side"] == "BUY" else -1
        pts.append((t["entry_ts"], 1, sgn, t["con_usd"],
                    t["entry_equity"], t["cid"], t["symbol"]))
        pts.append((t["exit_ts"], -1, sgn, t["con_usd"],
                    t["entry_equity"], t["cid"], t["symbol"]))
    pts.sort()
    live, syms = {}, {}
    for ts, kind, sgn, con, eq, cid, sym in pts:
        if kind == 1:
            live[cid] = (sgn, con, eq)
            syms[sym] = syms.get(sym, 0) + 1
            same = sum(1 for s, _, _ in live.values() if s == sgn)
            if same > 2:
                breaches.append("R1-direction:%s" % cid)
            if con / eq > 0.25 + 1e-9:
                breaches.append("R2-single:%s" % cid)
            if sum(c for _, c, _ in live.values()) / eq > 0.75 + 1e-9:
                breaches.append("R2-total:%s" % cid)
        else:
            live.pop(cid, None)
            syms[sym] = syms.get(sym, 1) - 1
    return sorted(set(breaches))

def segment_bounds(records, n_splits=3):
    """Timestamp-only segmentation: (edges, holdout_start_ts).

    holdout_start is the first holdout record's snapshot ts — a boundary
    timestamp, NOT holdout data. Selection may know the boundary; it must
    never observe records at/after it."""
    recs = sorted(records, key=lambda r: r["snapshot_ts_ns"])
    n = len(recs)
    edges = [i * n // (n_splits + 2) for i in range(n_splits + 3)]
    return edges, recs[edges[n_splits + 1]]["snapshot_ts_ns"]


def walk_folds(records, n_splits=3, embargo_frac=0.05, holdout_start=None):
    """Walk-forward (train, test) folds ONLY, label-purged at BOTH ends.

    holdout_start (required in the real path): NO selection record may
    resolve at/after it — train AND test records with
    time_exit_ns >= holdout_start are dropped, so no outcome used for
    selection depends on any price inside the holdout window. The holdout
    itself is NOT returned: selection never observes holdout records."""
    recs = sorted(records, key=lambda r: r["snapshot_ts_ns"])
    n = len(recs)
    if n_splits < 1 or n < n_splits + 3:
        return []
    edges = [i * n // (n_splits + 2) for i in range(n_splits + 3)]
    out = []
    for k in range(n_splits):
        t_end = recs[edges[k + 1] - 1]["snapshot_ts_ns"]
        horizon = max(r["time_exit_ns"] - r["snapshot_ts_ns"] for r in recs)
        emb = int(horizon * embargo_frac) + 1
        train = [r for r in recs[:edges[k + 1]]
                 if r["time_exit_ns"] <= t_end]
        test = [r for r in recs[edges[k + 1]:edges[k + 2]]
                if r["snapshot_ts_ns"] >= t_end + emb]
        if holdout_start is not None:
            # holdout-boundary purge: selection labels must resolve BEFORE
            # the untouched window (preferred invariant).
            train = [r for r in train if r["time_exit_ns"] < holdout_start]
            test = [r for r in test if r["time_exit_ns"] < holdout_start]
        out.append((train, test))
    return out


def select_variant(fold_stats):
    """Pure metrics choice: {variant: [fold paired-mean...]} -> variant.

    Takes ONLY per-fold statistics, never records: the holdout boundary
    is structural (see signature — no records parameter exists)."""
    assert set(fold_stats) == set(VARIANTS), set(fold_stats)
    return max(sorted(fold_stats), key=lambda v: sum(fold_stats[v]))


def select_variant_signature_clean():
    """Regression guard: select_variant must not accept records/holdout."""
    params = inspect.signature(select_variant).parameters
    assert list(params) == ["fold_stats"], list(params)


def _stress_ok(stress):
    """Fail-closed: exact three levels, each a finite (filtered, always)
    Sharpe pair. Empty/partial/malformed -> False (never vacuous True)."""
    if set(stress or {}) != set(REQUIRED_STRESS):
        return False
    try:
        return all(math.isfinite(f) and math.isfinite(a) and f > a
                   for f, a in (stress[k] for k in REQUIRED_STRESS))
    except (TypeError, ValueError):
        return False


def evaluate_bar(metrics, bar):
    """metrics: {sharpe_f, holm_p, max_dd_pct, n_closed, stress, breach(es),
    r_unavailable, r_out_of_scope}. Fail-closed on stress shape and R scope.
    Returns (verdict, failed, detail)."""
    checks = {
        "sharpe_gt": metrics["sharpe_f"] > bar["filtered_net_sharpe_gt"],
        "holm_p": metrics["holm_p"] < bar["holm_adjusted_p_lt"],
        "maxdd": metrics["max_dd_pct"] <= bar["max_drawdown_pct_lte"],
        "closed": metrics["n_closed"] >= bar["min_closed_trades"],
        "stress": _stress_ok(metrics["stress"]),
        "no_r_breach": metrics["r_breach_count"] == 0,
        "r_scope": set(metrics["r_unavailable"]) <=
        set(metrics["r_out_of_scope"]),
    }
    failed = [k for k, v in checks.items() if not v]
    return (not failed, failed, checks)
