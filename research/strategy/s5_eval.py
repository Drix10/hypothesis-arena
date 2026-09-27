"""S5 paired evaluation: ALWAYS_TAKE vs JEV_FILTERED (research/shadow-only).

Contract (doc 11, eval_v1):
- SAME deterministic candidate stream for both policies (paired at CID).
- ALWAYS_TAKE resolves every candidate with frozen economics (backtest).
- JEV_FILTERED invokes v4 (answers_fn supplied; stub in harness proofs,
  never live provider) and takes only PASS_*; HOLD never fills.
- Censored stays censored (label preserved); efficacy uses realized R.
- Statistics: candidate-level paired delta with stationary-bootstrap CI;
  daily portfolio returns/Sharpe with HAC SE (zero-days kept); Holm over
  the PRE-DECLARED variant family; calibration (Brier) reported separately.
- Replay: every record carries an eval-hash; byte-identical on re-run.
- Leakage guards: stream built first (bars[..i] only); walk-forward splits
  with purge + embargo; holdout segment inaccessible to selection;
  thresholds frozen before the window; search budget declared in prereg.

No live orders. No threshold tuning. No strategy redesign.
"""
import hashlib
import json
import math
import random

from . import backtest as bt
from . import jev_v4 as v4

EVAL_PROTOCOL = "eval_v1"
BOOT_REPS = 2000
BOOT_BLOCK_MEAN = 20
BOOT_SEED = 0x5EED
HOLM_ALPHA = 0.05
R2_SINGLE_PCT = 25.0
R2_TOTAL_PCT = 75.0
MAX_POSITIONS = 3


def eval_hash(record):
    body = {k: record[k] for k in sorted(record) if k != "eval_hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True,
                                     default=str).encode()).hexdigest()


def stub_answers_provider(model="stub-deterministic-v1",
                          revision="stub-v1", provider="s5-harness"):
    """Deterministic stub (harness proofs ONLY, never JEV evidence).

    Answers derive from CID alone; conviction cycles to exercise HOLD and
    PASS paths. Signed with an ephemeral key; metadata labels the stub."""
    from collector.jev import ed_pubkey
    seed = bytes.fromhex("ab" * 32)
    pub = ed_pubkey(seed)

    def provide(candidate, market, now_unix):
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


def evaluate_stream(items, answers_fn, pubkey, engine, spread_mult=1.0,
                    variant="table"):
    """items: [(candidate, bars_after, market, regime, entry_spread_bps)].

    variant 'table': take on v4 PASS_* (frozen table). Variant 'strict':
    v4 PASS_* AND enter>=0.8 AND conviction in (strong, max) — a
    pre-declared stricter reading of the SAME answers (prereg family).
    Returns eval records (one per candidate, both policies). Deterministic.
    """
    assert variant in ("table", "strict")
    records = []
    for c, bars_after, market, regime, spread_bps in items:
        res = v4.resolve_v4_label(c, bars_after, spread_mult=spread_mult,
                                  entry_spread_bps=spread_bps)
        art, meta = answers_fn(c, market, market["snapshot_epoch"])
        action, reason = v4.evaluate_v4(c, art, market["snapshot_epoch"],
                                        pubkey, engine)
        if variant == "strict" and action.startswith("PASS"):
            a = art["payload"]["answers"]
            if not (a["enter"] >= 0.8 and
                    a["conviction"] in ("strong", "max")):
                action, reason = "HOLD", "strict_reading"
        filt_r = res["r_realized"] if action.startswith("PASS") else 0.0
        filt_taken = action.startswith("PASS") and res["realized"]
        rec = {
            "eval_protocol": EVAL_PROTOCOL,
            "variant": variant,
            "cid": c.cid, "symbol": c.symbol,
            "snapshot_ts_ns": c.snapshot_ts_ns,
            "proposed_side": c.proposed_side,
            "proposed_family": c.proposed_family,
            "entry_px": c.entry_px, "stop_px": c.stop_px, "tp_px": c.tp_px,
            "time_exit_ns": c.time_exit_ns,
            "feature_snapshot_hash": c.feature_snapshot_hash,
            "entry_spread_bps": spread_bps,
            "exit_ts_ns": res["exit_ts_ns"],
            "always_r": res["r_realized"] if res["realized"] else 0.0,
            "always_label": res["label"],
            "always_realized": res["realized"],
            "filtered_action": action, "filtered_reason": reason,
            "filtered_r": filt_r, "filtered_taken": filt_taken,
            "regime": regime,
            "enter": art["payload"]["answers"]["enter"],
            "latent_risk": art["payload"]["answers"]["latent_risk"],
            "family_answer": art["payload"]["answers"]["edge_family"],
            "conviction": art["payload"]["answers"]["conviction"],
            "artifact_hash": hashlib.sha256(
                json.dumps(art, sort_keys=True).encode()).hexdigest(),
            "decision_key": art["payload"]["decision_key"],
            "model": meta["model"], "revision": meta["revision"],
            "provider": meta["provider"],
        }
        rec["eval_hash"] = eval_hash(rec)
        records.append(rec)
    return records


def paired_deltas(records):
    """Per-candidate filtered-minus-always R (HOLD contributes 0, never a fill)."""
    return [r["filtered_r"] - r["always_r"] for r in records]


def stationary_bootstrap_ci(values, reps=BOOT_REPS, block_mean=BOOT_BLOCK_MEAN,
                            seed=BOOT_SEED, alpha=0.05):
    """Stationary (geometric-block) bootstrap CI for the mean. Seeded."""
    rng = random.Random(seed)
    n = len(values)
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = 1.0 / block_mean
    means = []
    for _ in range(reps):
        s, total = 0.0, 0
        i = rng.randrange(n)
        while total < n:
            s += values[i]
            total += 1
            i = i + 1 if rng.random() > p else rng.randrange(n)
            if i >= n:
                i %= n
        means.append(s / total)
    means.sort()
    lo = means[int(alpha / 2 * reps)]
    hi = means[int((1 - alpha / 2) * reps) - 1]
    return (sum(values) / n, lo, hi)


def daily_returns_from_ledger(exit_pnls, all_days, start_equity):
    """exit_pnls: [(day_str, pnl_usd)] realized. Zero-days kept (0.0)."""
    by_day = {}
    for d, p in exit_pnls:
        by_day[d] = by_day.get(d, 0.0) + p
    eq, rets = start_equity, []
    for d in all_days:
        rets.append(by_day.get(d, 0.0) / eq)
        eq += by_day.get(d, 0.0)
    return rets


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
    """Holm step-down: [(name, adj_p, reject)] sorted by raw p."""
    m = len(pvals)
    ordered = sorted(pvals, key=lambda t: t[1])
    out, stop = [], False
    for i, (name, p) in enumerate(ordered):
        adj = min(1.0, (m - i) * p)
        rej = (not stop) and (adj < alpha)
        stop = stop or not rej
        out.append((name, adj, rej))
    return out


def bootstrap_p(values, reps=BOOT_REPS, block_mean=BOOT_BLOCK_MEAN,
                seed=BOOT_SEED):
    """One-sided p: P(boot mean <= 0) under the stationary resample."""
    rng = random.Random(seed + 1)
    n = len(values)
    if n == 0:
        return 1.0
    p = 1.0 / block_mean
    hits = 0
    for _ in range(reps):
        s, total = 0.0, 0
        i = rng.randrange(n)
        while total < n:
            s += values[i]
            total += 1
            i = i + 1 if rng.random() > p else rng.randrange(n)
            if i >= n:
                i %= n
        if s / total <= 0:
            hits += 1
    return hits / reps


def brier(pairs):
    """Mean (p - y)^2 over CLOSED labels only (censored never scored)."""
    closed = [(p, 1.0 if lab == "win" else 0.0) for p, lab in pairs
              if lab in ("win", "loss")]
    if not closed:
        return (0.0, 0)
    return (sum((p - y) ** 2 for p, y in closed) / len(closed), len(closed))


def time_splits(records, n_splits=3, embargo_frac=0.05):
    """Walk-forward over sorted snapshot times; embargo gap between train
    and test; test windows never overlap; last segment = holdout."""
    recs = sorted(records, key=lambda r: r["snapshot_ts_ns"])
    n = len(recs)
    if n_splits < 1 or n < n_splits + 3:
        return []
    # n_splits+2 segments: pair k trains [0..k], tests [k+1];
    # the last segment is the untouched holdout.
    edges = [i * n // (n_splits + 2) for i in range(n_splits + 3)]
    out = []
    for k in range(n_splits):
        t_end = recs[edges[k + 1] - 1]["snapshot_ts_ns"]
        horizon = max(r["time_exit_ns"] - r["snapshot_ts_ns"] for r in recs)
        emb = int(horizon * embargo_frac) + 1
        train = [r for r in recs[:edges[k + 1]]
                 if r["time_exit_ns"] <= t_end]  # purge overlapping labels
        test = [r for r in recs[edges[k + 1]:edges[k + 2]]
                if r["snapshot_ts_ns"] >= t_end + emb]
        out.append((train, test))
    holdout = recs[edges[n_splits + 1]:]
    return out, holdout


def portfolio_loop(records, policy, equity, spread_mult=1.0):
    """Chronological R2-admission ledger mirroring backtest.run rules.

    policy: 'always' (take all realized) | 'filtered' (take PASS realized).
    Same event order/purge/sizing as bt.run; JEV gate is the only delta."""
    assert policy in ("always", "filtered")
    evts = sorted(records, key=lambda r: (r["snapshot_ts_ns"], r["symbol"]))
    open_pos = []  # [exit_ts_ns, symbol, con_usd, pnl_usd]
    eq, exits = equity, []
    eff_cache = {}
    for r in evts:
        ts = r["snapshot_ts_ns"]
        still = []
        for p in open_pos:
            if p[0] <= ts:
                eq += p[3]
                exits.append(p[3])
            else:
                still.append(p)
        open_pos = still
        take = r["always_realized"] if policy == "always" else \
            (r["filtered_taken"] and r["always_realized"])
        if not take:
            continue
        if any(p[1] == r["symbol"] for p in open_pos):
            continue
        if len(open_pos) >= MAX_POSITIONS:
            continue
        risk = abs(r["entry_px"] - r["stop_px"])
        key = (r["cid"], round(eq, 6))
        if key not in eff_cache:
            eff_cache[key] = bt.size_notional(eq, risk, r["entry_px"])
        unc, con, _, _, eff_frac = eff_cache[key]
        con_usd = con / 100.0 * eq
        if (sum(p[2] for p in open_pos) + con_usd) / eq > R2_TOTAL_PCT / 100.0:
            continue
        pnl = r["always_r" if policy == "always" else "filtered_r"] * \
            eff_frac * eq
        open_pos.append([r["exit_ts_ns"], r["symbol"], con_usd, pnl])
    for p in open_pos:
        eq += p[3]
        exits.append(p[3])
    return eq, exits
