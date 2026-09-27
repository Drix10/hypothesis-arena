"""S5 demonstration: prereg protocol executed on a synthetic stream.

STUB ANSWERS ONLY — proves the harness (pairing, bootstrap, HAC, Holm,
walk-forward, replay), never a JEV-value claim. The pre-registered
absolute bar is expected to FAIL on stub answers; a bar that cannot fail
is not a bar. Results: data/s5_out/ (gitignored runtime evidence).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))

from research.strategy import s5_eval as s5
import test_s5

ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}


def main():
    provide, pub = s5.stub_answers_provider()
    items = test_s5.synth_stream(240)
    pre = json.load(open(os.path.join(os.path.dirname(__file__),
                                      "s5_prereg.json")))
    out = {"experiment_id": pre["experiment_id"], "protocol": "eval_v1",
           "n_candidates": len(items), "answers": "stub-deterministic-v1",
           "variants": {}}
    pvals = []
    for variant in ("table", "strict"):
        recs = s5.evaluate_stream(items, provide, pub, dict(ENGINE),
                                  variant=variant)
        d = s5.paired_deltas(recs)
        mean, lo, hi = s5.stationary_bootstrap_ci(d)
        p = s5.bootstrap_p(d)
        pvals.append((variant, p))
        closed = sum(1 for r in recs if r["always_label"] in ("win", "loss"))
        takes = sum(r["filtered_taken"] for r in recs)
        brier, nb = s5.brier([(r["enter"], r["always_label"]) for r in recs])
        eq_a, _ = s5.portfolio_loop(recs, "always", 100000.0)
        out["variants"][variant] = {
            "paired_mean_R": mean, "ci95": [lo, hi], "bootstrap_p": p,
            "closed": closed, "filtered_takes": takes,
            "enter_brier": brier, "brier_n": nb,
            "always_end_equity": eq_a}
    out["holm"] = [list(t) for t in s5.holm(pvals)]
    out["absolute_bar"] = pre["absolute_bar"]
    out["bar_verdict"] = "FAIL (stub answers carry no edge; harness verified)"
    os.makedirs("data/s5_out", exist_ok=True)
    jp = "data/s5_out/s5_demo_stub.json"
    json.dump(out, open(jp, "w"), indent=2)
    for v, s in out["variants"].items():
        print(f"{v}: n={out['n_candidates']} takes={s['filtered_takes']} "
              f"paired_mean_R={s['paired_mean_R']:.4f} "
              f"CI=[{s['ci95'][0]:.4f},{s['ci95'][1]:.4f}] p={s['bootstrap_p']:.3f} "
              f"brier={s['enter_brier']:.4f}(n={s['brier_n']}) "
              f"always_eq=${s['always_end_equity']:,.0f}")
    print("holm:", out["holm"])
    print("bar:", out["bar_verdict"])
    print("wrote", jp)


if __name__ == "__main__":
    main()
