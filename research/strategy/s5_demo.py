"""S5 demonstration: prereg v2 protocol on a synthetic stream (machinery proof).

STUB ANSWERS ONLY — proves harness correctness (pairing, cluster bootstrap
CI + null test, sequential rule, power, walk-forward + holdout, curve,
mechanical bar), never a JEV-value claim. The bar is COMPUTED from the
metrics; on stub answers it FAILS, with failed conditions listed.
Results: data/s5_out/ (gitignored runtime evidence).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))

from research.strategy import s5_eval as s5
from research.strategy import s5_final as s5f
import test_s5

ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}


def main():
    provide, pub = s5.stub_answers_provider()
    items = test_s5.synth_stream(120)
    pre = json.load(open(os.path.join(os.path.dirname(__file__),
                                      "s5_prereg.json")))
    bar = {"filtered_net_sharpe_gt": 1.0, "holm_adjusted_p_lt": 0.05,
           "max_drawdown_pct_lte": 15.0, "min_closed_trades": 100}
    by_var = {v: s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                    variant=v, day_fn=test_s5.DAY,
                                    data_id=test_s5.DATA_ID)
              for v in s5.VARIANTS}
    recs = by_var[s5.VARIANTS[0]]
    folds, holdout, _bound = s5f.holdout_split(recs, n_splits=2)
    stats = {}
    for v in s5.VARIANTS:
        _, _b = s5.segment_bounds(by_var[v], n_splits=2)
        stats[v] = [sum(s5.paired_deltas(te)) for _, te in
                    s5.walk_folds(by_var[v], n_splits=2,
                                  holdout_start=_b)]
    chosen = s5.select_variant(stats)
    dall = s5.paired_deltas(recs)
    o = sorted(range(len(recs)), key=lambda i: recs[i]["snapshot_ts_ns"])
    dod = [dall[i] for i in o]
    dyd = [recs[i]["day"] for i in o]
    seq_i = s5.seq_decision(dod, dyd, "interim")
    seq_f = s5.seq_decision(dod, dyd, "final")
    pw = s5.power_study(s5.paired_deltas([r for f in folds for r in f[0]]),
                        [r["day"] for f in folds for r in f[0]], 0.15)
    hdays = {r["day"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["day"] in hdays]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = {v: s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                    variant=v, spread_mult=mult,
                                    day_fn=test_s5.DAY,
                                    data_id=test_s5.DATA_ID)
              for v in s5.VARIANTS}
        stress[lab] = {v: [r for r in sv[v] if r["day"] in hdays]
                       for v in s5.VARIANTS}
    sess = [s for s in test_s5.sessions_for(items) if s["day"] in hdays]
    _scope = pre["amendment_b"]["r_out_of_scope"]
    rep = s5f.final_report(h1x, stress, sess, 100000.0, bar,
                           r_out_of_scope=_scope)
    out = {"experiment_id": pre["experiment_id"], "protocol": "eval_v1",
           "prereg": "v2", "n_candidates": len(items),
           "answers": "stub-deterministic-v1 (MACHINERY PROOF ONLY)",
           "selection": {"fold_stats": stats, "chosen": chosen},
           "sequential": {"interim": seq_i, "final": seq_f},
           "power_mde0.15": pw,
           "holdout": rep}
    os.makedirs("data/s5_out", exist_ok=True)
    jp = "data/s5_out/s5_demo_stub.json"
    json.dump(out, open(jp, "w"), indent=2, default=str)
    for v, s in rep["variants"].items():
        print(f"{v}: meanR={s['paired_mean_R']:.4f} "
              f"CI=[{s['ci95'][0]:.4f},{s['ci95'][1]:.4f}] p={s['null_p']:.4f} "
              f"sharpe={s['sharpe_f']:.3f} dd={s['max_dd_pct']:.2f}% "
              f"closed={s['n_closed']} bar={s['bar_verdict']} "
              f"failed={s['bar_failed']}")
    print("holm:", rep["holm"])
    print("seq:", seq_i[0], "/", seq_f[0], "| power@1x:",
          pw["by_multiplier"][1], "| chosen:", chosen)
    print("wrote", jp)


if __name__ == "__main__":
    main()
