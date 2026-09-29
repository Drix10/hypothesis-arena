"""S5 demonstration: prereg v2 protocol on a synthetic stream (machinery proof).

Stub answers only. Proves harness correctness (pairing, cluster bootstrap
CI + null test, sequential rule, power, walk-forward + holdout, curve,
mechanical bar), never a JEV-value claim. The bar is computed from the
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
    by_var = {v: s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                    variant=v, day_fn=test_s5.DAY,
                                    data_id=test_s5.DATA_ID)
              for v in s5.VARIANTS}
    stats = {}
    for v in s5.VARIANTS:
        _, _b = s5.segment_bounds(by_var[v], n_splits=2)
        stats[v] = [sum(s5.paired_deltas(te)) for _, te in
                    s5.walk_folds(by_var[v], n_splits=2,
                                  holdout_start=_b)]
    chosen = s5.select_variant(stats)  # frozen BEFORE holdout use
    # Split the SELECTED variant's stream: folds/holdout/sequential
    # then share one segmentation (snapshots/exits are
    # variant-independent, so pairing is unaffected).
    split = s5f.holdout_split(by_var[chosen], n_splits=2)
    folds, holdout, _bound, tok = split
    # power on the deduplicated pre-holdout training population, MDE
    # parsed from the prereg (no runner literal).
    seen, train_recs = set(), []
    for f in folds:
        for r in f[0]:
            if r["cid"] not in seen:
                seen.add(r["cid"])
                train_recs.append(r)
    pw = s5.power_study(train_recs, s5f.frozen_knobs()["power_mde"])
    # digest-bound split evidence (subsets, duplicates, wrong
    # multipliers, mutated content all rejected)
    hset = s5f.assert_exact_holdout(holdout, holdout)
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = {v: s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                    variant=v, spread_mult=mult,
                                    day_fn=test_s5.DAY,
                                    data_id=test_s5.DATA_ID)
              for v in s5.VARIANTS}
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    # synthetic bar panel matching the hand closes; sessions built
    # canonically inside the final path and rebuild-verified.
    _closes = {x["day"]: x["closes"]["SYN"]
               for x in test_s5.sessions_for(items)}
    bars = {"SYN": [test_s5.Bar(ts_ns=s5.et_close_ns(d), o=px, h=px,
                                l=px, c=px) for d, px in
                    sorted(_closes.items())]}
    sess, proof = s5f.build_holdout_sessions(bars, tok, test_s5.DATA_ID)
    # sequential is DERIVED inside the final path from the selected
    # variant's full stream (pre-holdout closed only); the rep carries
    # the authoritative result (interim stop => final NOT RUN).
    root = s5f.stream_roots(by_var, test_s5.DATA_ID)
    rep = s5f.final_report(split, h1x, stress, sess, proof, bars,
                           test_s5.DATA_ID, 100000.0, by_var, root,
                           selected_variant=chosen)
    seq_i, seq_f = rep["sequential"]["interim"], \
        rep["sequential"]["final"]
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
