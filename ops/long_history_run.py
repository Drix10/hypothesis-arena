"""Run the L1 long-history replication and write research/reports/
long_history_<date>.json.

    python3 ops/long_history_run.py [--dir data/long_history]
        [--industries FILE.zip] [--factors FILE.zip] [--block-index N]
        [--custom-csv PATH ...] [--out PATH] [--force]
        [--ledger PATH | --no-ledger]

Refuses to run unless research/prereg/l1_long_history_v1.json validates and
agrees with the constants in research/strategy/long_history.py, and unless
every input file matches the sha256 in the fetch manifest. Nothing is tuned
here: the rules, periods and costs are fixed by the prereg. --custom-csv adds
an exploratory trend run on user-supplied total-return indices (columns
date,close; the symbol is the file stem); it is outside the prereg.

Every run opens one trial per rule in the global trial ledger before any
result exists and closes each afterwards (pass = all five descriptive flags,
fail otherwise, void when the sample is too short, crashed on an error), then
rewrites the checkpoint. A broken chain or checkpoint refuses the run. A data
vintage (the sha256 set of the two files) is run once; --force runs it again
and opens NEW trials, so N stays honest. --custom-csv runs open their own
trials under experiment_id + ":custom". --boot other than the prereg's is a
smoke run: it needs --ledger PATH (a temp ledger) or --no-ledger, never the
real ledger, and the report records which."""
import argparse
import datetime
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))

from ops import long_history_fetch as F
from research.strategy import ledger, prereg
from research.strategy import long_history as L

ROOT = F.ROOT
PREREG = os.path.join(ROOT, "research", "prereg", "l1_long_history_v1.json")
REPORTS = os.path.join(ROOT, "research", "reports")
LEDGER = os.path.join(ROOT, "research", "ledger", "trials.jsonl")
COST_MODEL = "prop_10bp_per_side"
CODE = ("research/strategy/long_history.py", "research/strategy/stats.py",
        "research/strategy/sleeves/trend.py",
        "research/strategy/sleeves/sector_mom.py",
        "research/strategy/ledger.py", "research/strategy/prereg.py",
        "ops/long_history_fetch.py", "ops/long_history_run.py")
ASSUMPTIONS = {
    "cost": "10 bp of traded notional per side on industry legs, cash legs "
            "free; French data has no spreads, so this is an assumption",
    "timing": "signal from the month-end close t, entry at that close, "
              "returns from session t+1",
    "cash": "French RF series compounded daily; the sleeves' BIL symbol is "
            "this synthetic index",
    "universe": "industries with no missing daily return in the whole file",
    "returns": "French value-weighted daily returns include dividends; they "
               "carry no fees, taxes, borrow limits or capacity limits",
    "benchmark": "ew_monthly (equal weight, monthly rebalance, same cost) is "
                 "primary; ew_drift is a one-off equal-weight purchase",
}


def code_hash():
    h = hashlib.sha256()
    for rel in CODE:
        with open(os.path.join(ROOT, rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    return h.hexdigest()


def load_prereg(path):
    with open(path) as f:
        pre = json.load(f)
    errs = prereg.validate(pre) + L.check_prereg(pre)
    if errs:
        raise L.LongHistoryError("prereg: " + ";".join(errs))
    return pre, prereg.prereg_hash(pre)


def checkpoint_path(ledger_path):
    return os.path.join(os.path.dirname(os.path.abspath(ledger_path)),
                        "checkpoint.json")


def open_ledger(path):
    """Verified ledger, or LedgerError: chain intact and, for a non-empty
    ledger, a checkpoint that it still matches."""
    led = ledger.TrialLedger(path)
    cp = checkpoint_path(path)
    if os.path.exists(cp):
        led.verify(cp)
    elif led.rows():
        raise ledger.LedgerError("checkpoint-missing")
    return led


def refuse_if_vintage_seen(led, card, dataset_hashes):
    want = sorted(dataset_hashes)
    for r in led.rows():
        if r["kind"] == "open" and r["hypothesis_card_id"] == card \
                and sorted(r["dataset_hashes"]) == want:
            raise ledger.LedgerError("vintage-already-run:" + r["trial_id"])


def open_trials(led, pre, pre_hash, ch, card, variants, dataset_hashes,
                window):
    """Open one trial per variant; a rerun of the same code and vintage
    (--force) gets a new id suffix."""
    ids = {}
    for v in variants:
        base = "%s:%s:%s:%s" % (card, v, ch[:12],
                                sorted(dataset_hashes)[0][:8])
        k = sum(1 for r in led.rows()
                if r["kind"] == "open" and r["trial_id"].split("#")[0] == base)
        tid = base if k == 0 else "%s#r%d" % (base, k + 1)
        led.open_trial(trial_id=tid, hypothesis_card_id=card,
                       prereg_hash=pre_hash, family=pre["family"], variant=v,
                       dataset_hashes=sorted(dataset_hashes), code_hash=ch,
                       cost_model_version=COST_MODEL, window=window,
                       split_scheme=pre["split"]["scheme"],
                       runner="ops.long_history_run")
        ids[v] = tid
    return ids


def close_trials(led, ids, study, criteria, void, checkpoint):
    """Verdicts: crashed (study None), void, else pass iff every descriptive
    flag of the rule is set."""
    for v, tid in ids.items():
        rule = v.split(":")[-1]
        if study is None:
            led.close_trial(tid, "crashed", {})
            continue
        res = study["rules"][rule]
        flags = (criteria or {}).get(rule)
        verdict = "void" if void else (
            "pass" if flags and all(flags.values()) else "fail")
        led.close_trial(tid, verdict, {
            "flags": flags, "sharpe_pre_1999":
            res["periods"]["pre_1999"].get("sharpe"),
            "sharpe_post_1999": res["periods"]["post_1999"].get("sharpe"),
            "decay_ratio_post_1999": res["decay"]["post_1999"].get("ratio")})
    led.write_checkpoint(checkpoint)


def _fmt(x, pct=False, nd=2):
    if x is None:
        return "  n/a"
    return ("%.*f" % (nd, x * 100.0 if pct else x)).rjust(6)


def print_summary(study, title, out=None):
    out = out or sys.stdout
    w = study["eval_window"]
    print("%s: %s..%s, %d sessions, %d months"
          % (title, w["first"], w["last"], w["sessions"], w["months"]),
          file=out)
    print("  %-11s %-12s %5s %6s %6s %6s %6s %6s %6s" % (
        "series", "period", "mths", "exc%", "vol%", "sharpe", "mdd%", "t",
        "act%"), file=out)
    rows = [(b, study["benchmarks"][b], None) for b in L.BENCHES]
    rows += [(r, res["periods"], res["active_vs_" + L.PRIMARY_BENCH])
             for r, res in study["rules"].items()]
    for name, per, act in rows:
        for p, _, _ in L.PERIODS:
            m = per[p]
            if "sharpe" not in m:
                print("  %-11s %-12s %5d  insufficient" % (
                    name, p, m["n_months"]), file=out)
                continue
            a = (act or {}).get(p, {}).get("ann_active_return")
            print("  %-11s %-12s %5d %s %s %s %s %s %s" % (
                name, p, m["n_months"], _fmt(m["ann_excess_return"], True),
                _fmt(m["ann_vol"], True), _fmt(m["sharpe"]),
                _fmt(m["max_drawdown"], True), _fmt(m["hac_t"]),
                _fmt(a, True)), file=out)
    for r, res in study["rules"].items():
        for wn in L.DECAY_WINDOWS:
            d = res["decay"][wn]
            if "ratio" not in d:
                continue
            ci = d.get("ratio_ci95")
            print("  decay %-11s %-11s pre %s post %s ratio %s ci %s%s" % (
                r, wn, _fmt(d["sharpe_pre"]), _fmt(d["sharpe_post"]),
                _fmt(d["ratio"]), "n/a" if ci is None else
                "[%.2f, %.2f]" % tuple(ci),
                " (unstable)" if d.get("ratio_unstable") else ""), file=out)


def main(argv=None, today=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default=F.DEFAULT_DIR)
    ap.add_argument("--industries", default=F.FILES["industries"])
    ap.add_argument("--factors", default=F.FILES["factors"])
    ap.add_argument("--block-index", type=int, default=None,
                    help="nth daily block of the industry file (default: "
                         "the block titled 'Value Weighted')")
    ap.add_argument("--custom-csv", action="append", default=[])
    ap.add_argument("--prereg", default=PREREG)
    ap.add_argument("--out", default=None)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--boot", type=int, default=L.BOOT_B)
    ap.add_argument("--ledger", default=None,
                    help="trial ledger path (default: the real ledger; "
                         "smoke runs must pass a temp path)")
    ap.add_argument("--no-ledger", action="store_true",
                    help="skip the ledger (smoke runs only)")
    a = ap.parse_args(argv)
    day = (today or datetime.date.today()).isoformat()
    out_path = a.out or os.path.join(REPORTS, "long_history_%s.json" % day)
    if os.path.exists(out_path) and not a.force:
        print("refusing to overwrite %s (use --force)" % out_path,
              file=sys.stderr)
        return 2
    smoke = a.boot != L.BOOT_B
    real = os.path.realpath(LEDGER)
    if a.no_ledger and a.ledger:
        print("--ledger and --no-ledger are exclusive", file=sys.stderr)
        return 2
    if a.no_ledger and not smoke:
        print("--no-ledger is for smoke runs (--boot != %d)" % L.BOOT_B,
              file=sys.stderr)
        return 2
    if smoke and not a.no_ledger and (
            not a.ledger or os.path.realpath(a.ledger) == real):
        print("a smoke run needs --ledger <temp path> or --no-ledger, never "
              "the real ledger", file=sys.stderr)
        return 2
    ledger_path = None if a.no_ledger else (a.ledger or LEDGER)
    led, ids, cids = None, {}, {}
    prep = study = custom = cstudy = None
    try:
        pre, pre_hash = load_prereg(a.prereg)
        manifest = F.load_manifest(a.dir)
        data = {}
        for name in (a.industries, a.factors):
            data[name] = F.verify_file(a.dir, name, manifest)
        ind_blocks = L.parse_french_text(L.read_french_text(
            os.path.join(a.dir, a.industries)))
        fac_blocks = L.parse_french_text(L.read_french_text(
            os.path.join(a.dir, a.factors)))
        ind = L.select_block(ind_blocks, "daily", "value weighted",
                             a.block_index)
        fac = L.select_block(fac_blocks, "daily")
        prep = L.prepare_french(ind, fac)
        series, cprep, chash = {}, None, []
        for p in a.custom_csv:
            stem = os.path.splitext(os.path.basename(p))[0]
            with open(p, "rb") as f:
                raw = f.read()
            chash.append(F.sha256_bytes(raw))
            series[stem] = L.parse_index_csv(raw.decode("utf-8-sig"))
        if series:
            cprep = L.prepare_custom(prep["rf_level_by_date"], series)
        dh = [e["sha256"] for e in data.values()]
        card = pre["experiment_id"]
        ch = code_hash()
        n_before = n_after = None
        if ledger_path:
            led = open_ledger(ledger_path)
            if not a.force:
                refuse_if_vintage_seen(led, card, dh)
            n_before = led.count_trials()
            ids = open_trials(
                led, pre, pre_hash, ch, card, list(L.RULES), dh,
                {"start": prep["info"]["first"], "end": prep["info"]["last"],
                 "publication_split": ["1999-01-01"]})
            if cprep:
                crules = [r for r in L.RULES if L.RULES[r][0] != "sector"
                          or len(series) > L.TOP_K]
                cids = open_trials(
                    led, pre, pre_hash, ch, card + ":custom",
                    ["custom:" + r for r in crules], dh + chash,
                    {"start": cprep["info"]["first"],
                     "end": cprep["info"]["last"],
                     "publication_split": ["1999-01-01"]})
        try:
            study = L.build_study(prep, boot=a.boot)
            if cprep:
                cstudy = L.build_study(cprep, boot=a.boot)
        except BaseException:
            if led:
                for i2 in (ids, cids):
                    close_trials(led, i2, None, None, False,
                                 checkpoint_path(ledger_path))
            raise
    except (L.LongHistoryError, F.FetchError, prereg.PreregError,
            ledger.LedgerError, OSError, ValueError) as e:
        print("run failed: %s" % e, file=sys.stderr)
        return 2
    dec = pre["decision"]
    void = [p for p in ("pre_1999", "post_1999")
            if study["periods"][p]["sessions"] < dec["min_days"]]
    criteria = None if void else L.evaluate_criteria(study, dec)
    if cstudy:
        custom = {"status": "exploratory, outside the prereg",
                  "data": cprep["info"], "study": cstudy,
                  "criteria": L.evaluate_criteria(cstudy, dec)}
    led_info = {"status": "skipped (explicit --no-ledger, smoke run)"}
    if led:
        try:
            close_trials(led, ids, study, criteria, bool(void),
                         checkpoint_path(ledger_path))
            if cids:
                close_trials(led, cids, cstudy, custom["criteria"], False,
                             checkpoint_path(ledger_path))
            n_after = led.count_trials()
        except (ledger.LedgerError, OSError) as e:
            print("ledger close failed: %s" % e, file=sys.stderr)
            return 2
        led_info = {"status": "recorded", "path": os.path.relpath(
            os.path.abspath(ledger_path), ROOT), "trial_ids":
{**ids, **cids},
                    "n_trials_before": n_before, "n_trials_after": n_after,
                    "vintage_sha256": dh, "forced_rerun": a.force}
    report = {
        "schema": "long_history_report_v1", "experiment_id":
        pre["experiment_id"], "prereg_hash": pre_hash, "generated": day,
        "code_sha256": ch, "ledger": led_info,
        "bootstrap_b_used": a.boot,
        "prereg_conformant": not smoke and not void,
        "void_reason": (["fewer than min_days sessions in: " + ",".join(void)]
                        if void else []),
        "assumptions": ASSUMPTIONS,
        "data": {"files": data, "universe": prep["universe"],
                 "info": prep["info"]},
        "study": study, "criteria": criteria, "custom_trend": custom}
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2, sort_keys=True, allow_nan=False)
        f.write("\n")
    print_summary(study, "L1 long history")
    if custom:
        print_summary(custom["study"], "custom trend (exploratory)")
    if report["criteria"]:
        for r, c in report["criteria"].items():
            print("  flags %-11s %s" % (r, ", ".join(
                "%s=%s" % (k, "Y" if v else "n") for k, v in c.items())))
    if void:
        print("VOID: %s" % report["void_reason"][0])
    print("ledger: %s" % led_info["status"])
    print("wrote %s" % out_path)
    return 3 if void else 0


if __name__ == "__main__":
    sys.exit(main())
