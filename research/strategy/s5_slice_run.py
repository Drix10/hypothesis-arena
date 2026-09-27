"""S5 real-stream pipeline proof: S2 validation slice + stub answers.

PIPELINE EVIDENCE ONLY — proves the corrected harness runs end-to-end on
the real deterministic candidate stream (2272 AAPL/MSFT candidates):
pairing, cluster bootstrap, sequential, walk-forward + holdout, marked
curves, mechanical bar. STUB ANSWERS: zero JEV-value claim.
Results: data/s5_out/ (gitignored runtime evidence).
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import s5_eval as s5
from research.strategy import s5_final as s5f
from research.strategy import backtest as bt
from research.strategy import s2_run

ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}
DAY = lambda ts: datetime.datetime.fromtimestamp(ts / 1e9,
    tz=datetime.timezone.utc).strftime("%Y-%m-%d")


def main():
    manifest = json.load(open("data/s2_raw/dataset_manifest.json"))
    bars = {s: s2_run.load(s) for s in ("AAPL", "MSFT")}
    idx = {s: {b.ts_ns: i for i, b in enumerate(bs)}
           for s, bs in bars.items()}
    bt_recs, _ = bt.run(bars, universe_mode="diagnostic")
    items = []
    for r in [x for x in bt_recs if x["res"]["realized"]]:
        c = r["c"]
        i = idx[c.symbol][c.snapshot_ts_ns]
        mkt = {"snapshot_epoch": c.snapshot_ts_ns,
               "price_s": str(c.entry_px),
               "spread_bps_s": str(bars[c.symbol][i].spread_bps),
               "session": "us_slice", "regime": "slice-unclassified"}
        items.append((c, bars[c.symbol][i + 1:], mkt, "slice-unclassified",
                      bars[c.symbol][i].spread_bps))
    provide, pub = s5.stub_answers_provider()
    data_id = {"slice": s2_run.SLICE_ID,
               "dataset_sha": manifest.get("dataset_sha", "manifest")}
    by_var = {v: s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                    variant=v, day_fn=DAY, data_id=data_id)
              for v in s5.VARIANTS}
    recs = by_var[s5.VARIANTS[0]]
    folds, holdout, _bound = s5f.holdout_split(recs, n_splits=2)
    stats = {}
    for v in s5.VARIANTS:
        _, _b = s5.segment_bounds(by_var[v], n_splits=2)
        stats[v] = [sum(s5.paired_deltas(te)) for _, te in
                    s5.walk_folds(by_var[v], n_splits=2,
                                  holdout_start=_b)]
    chosen = s5.select_variant(stats)  # frozen BEFORE holdout use
    # sequential evidence: closed deltas of the SELECTED variant only
    _sd, _sy = s5.closed_stream(by_var[chosen])
    seq_i = s5.seq_decision(_sd, _sy, "interim")
    seq_f = s5.seq_decision(_sd, _sy, "final")
    # power on the deduplicated pre-holdout training population
    _seen, train_recs = set(), []
    for f in folds:
        for r in f[0]:
            if r["cid"] not in _seen:
                _seen.add(r["cid"])
                train_recs.append(r)
    pw = s5.power_study(train_recs, 0.15)
    assert not ({r["cid"] for r in holdout} &
                {r["cid"] for r in train_recs})
    # exact-CID holdout materialization (day reconstruction rejected)
    hset = s5f.assert_exact_holdout(holdout, holdout)
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = {v: s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                    variant=v, spread_mult=mult,
                                    day_fn=DAY, data_id=data_id)
              for v in s5.VARIANTS}
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    # sessions: UTC day boundaries with last-close marks per symbol
    sess = []
    for d in sorted({r["day"] for r in holdout}):
        end = int(datetime.datetime.strptime(
            d, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).
            timestamp() * 1e9) + 86400 * 10 ** 9 - 1
        closes = {}
        for sym, bs in bars.items():
            last = None
            for b in bs:
                if b.ts_ns <= end:
                    last = b.c
                else:
                    break
            closes[sym] = last
        sess.append({"day": d, "end_ts": end, "closes": closes})
    bar = {"filtered_net_sharpe_gt": 1.0, "holm_adjusted_p_lt": 0.05,
           "max_drawdown_pct_lte": 15.0, "min_closed_trades": 100}
    rep = s5f.final_report(h1x, stress, sess, 100000.0, bar, hset,
                           selected_variant=chosen)
    out = {"slice": s2_run.SLICE_ID, "n_stream": len(items),
           "n_holdout": len(holdout),
           "n_selection_train": sum(len(tr) for tr, _ in folds),
           "n_selection_test": sum(len(te) for _, te in folds),
           "selection_crossing_holdout": 0,  # asserted in holdout_split
           "answers": "stub-deterministic-v1 (PIPELINE PROOF ONLY)",
           "chosen": chosen,
           "sequential": {"interim": seq_i, "final": seq_f},
           "power_mde0.15": pw, "holdout": rep,
           "r_rules_checked": rep["r_rules_checked"],
           "r_rules_unavailable": rep["r_rules_unavailable"]}
    jp = "data/s5_out/s5_slice_stub.json"
    json.dump(out, open(jp, "w"), indent=2, default=str)
    for v, s in rep["variants"].items():
        print(f"{v}: n_ho={len(h1x[v])} meanR={s['paired_mean_R']:.4f} "
              f"CI=[{s['ci95'][0]:.4f},{s['ci95'][1]:.4f}] p={s['null_p']:.4f} "
              f"sharpe={s['sharpe_f']:.3f} dd={s['max_dd_pct']:.2f}% "
              f"closed_taken={s['n_closed']}/{s['n_trades_taken']} "
              f"breach={s['r_breach_count']} mon={s['r_monitor_breaches']} "
              f"bar={s['bar_verdict']} failed={s['bar_failed']}")
    print("holm:", rep["holm"], "| chosen:", chosen)
    print("seq:", seq_i[0], "/", seq_f[0], "| power@1x:",
          pw["by_multiplier"][1], "required:", pw["required"])
    print("wrote", jp)


if __name__ == "__main__":
    main()
