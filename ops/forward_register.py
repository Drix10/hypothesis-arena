"""Register the forward-shadow program in the global trial ledger (doc 11
0a: every evaluation appends a row BEFORE results are shown; N comes only from
the ledger).

    python3 ops/forward_register.py <dir>

Appends ONE `open` trial row per forward shadow ledger to
research/ledger/trials.jsonl through research.strategy.ledger.TrialLedger
(hash chain verified first, and against research/ledger/checkpoint.json when it
exists; the checkpoint is rewritten after an append). Today that is
core_passive_v1; a sleeve that passes its A-gate adds its entry in entries().

Benchmarks (cash, SPY) are comparators and are NOT trials. Every row:
hypothesis_card_id = experiment id `forward_shadow_2026q4`, cost_v2, window
start 2026-09-30 (forward, open end), split scheme `forward_only`, dataset =
SIP daily adjusted bars, prereg_hash = hash of the sleeve's spec.

Idempotent per (ledger id, spec hash): the trial id embeds both, an existing
open row is never re-appended, so a second run appends nothing. Changing a
sleeve's spec changes its hash and opens a NEW trial (N counts it). Rows are
left open; the evaluator closes them at checkpoints, this module never
closes a trial or invents a verdict.

<dir> is the shadow data dir (the one ops/sleeve_shadow.py uses). It is only
read, to flag a ledger whose forward rows already exist when it is
registered, and to hold the informational receipt <dir>/forward_register.json
(the trial ledger, not the receipt, is the source of truth).

Refuses (exit 2, nothing appended) on a broken chain or a checkpoint
mismatch."""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from research.strategy import ledger

EXPERIMENT = "forward_shadow_2026q4"
WINDOW = {"start": "2026-09-30", "end": "open", "forward_only": True}
SPLIT_SCHEME = "forward_only"
COST_MODEL = "cost_v2"
RUNNER = "ops.forward_register"
ROOT = os.path.join(os.path.dirname(__file__), "..")
LEDGER = os.path.join(ROOT, "research", "ledger", "trials.jsonl")
CHECKPOINT = os.path.join(ROOT, "research", "ledger", "checkpoint.json")
CORE_SPEC = ("core_passive_v1: 60/40 VTI/IEF buy and hold, no rebalance; "
             "SIP daily adjusted; cost_v2; forward from 2026-09-30")
SIP_DATASET = "alpaca_sip:bars:1Day:adjustment=all:forward"
CODE = ("ops/sleeve_shadow.py", "research/strategy/portfolio.py",
        "research/strategy/costs_v2.py", "research/strategy/settlement.py")
RECEIPT = "forward_register.json"


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def code_hash():
    h = hashlib.sha256()
    for rel in CODE:
        with open(os.path.join(ROOT, rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    return h.hexdigest()


def entries():
    """Every forward ledger as a dict: ledger_id, family, variant, spec_hash,
    datasets, trial_id."""
    sip = [_sha(SIP_DATASET)]
    out = [{"ledger_id": "core_passive_v1", "family": "core_passive",
            "variant": "buy_and_hold", "spec_hash": _sha(CORE_SPEC),
            "datasets": sip}]
    for e in out:
        e["trial_id"] = "%s:%s:%s" % (EXPERIMENT, e["ledger_id"],
                                      e["spec_hash"][:12])
    return out


def _late(d, lids):
    """Ledgers whose forward log already has rows (registered after results)."""
    out = []
    for lid in lids:
        try:
            with open(os.path.join(d, "sleeves", lid + ".jsonl")) as f:
                if any(ln.strip() for ln in f):
                    out.append(lid)
        except OSError:
            pass
    return out


def register(d, ledger_path=None, checkpoint_path=None):
    """Append the missing open rows. Returns
    {"registered": [trial ids], "already": n, "rows": n, "late": [ids]}.
    Raises ledger.LedgerError; appends nothing then."""
    ledger_path = ledger_path or LEDGER          # resolved late: patchable
    checkpoint_path = checkpoint_path or CHECKPOINT
    led = ledger.TrialLedger(ledger_path)
    led.verify(checkpoint_path if os.path.exists(checkpoint_path) else None)
    ents = entries()
    have = {r["trial_id"] for r in led.rows() if r["kind"] == "open"}
    ch = code_hash()
    done, already = [], 0
    for e in ents:
        if e["trial_id"] in have:
            already += 1
            continue
        try:
            led.open_trial(
                trial_id=e["trial_id"], hypothesis_card_id=EXPERIMENT,
                prereg_hash=e["spec_hash"], family=e["family"],
                variant=e["variant"], dataset_hashes=e["datasets"],
                code_hash=ch, cost_model_version=COST_MODEL,
                window=dict(WINDOW), split_scheme=SPLIT_SCHEME,
                runner=RUNNER)
        except ledger.LedgerError as ex:
            if str(ex) != "trial-id-reused":   # a concurrent run won the race
                raise
            already += 1
            continue
        done.append(e["trial_id"])
    if done:
        led.write_checkpoint(checkpoint_path)
        _receipt(d, done)
    return {"registered": done, "already": already,
            "rows": led.verify(),
            "late": _late(d, [e["ledger_id"] for e in ents
                              if e["trial_id"] in done])}


def _receipt(d, ids):
    """Informational only; never fails the registration."""
    try:
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, RECEIPT)
        try:
            with open(path) as f:
                prior = json.load(f).get("registered", [])
        except (OSError, ValueError, AttributeError):
            prior = []
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"experiment": EXPERIMENT,
                       "registered": sorted(set(prior) | set(ids))}, f,
                      sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError:
        pass


def main(argv):
    if len(argv) != 2 or argv[1].startswith("-"):
        raise SystemExit("usage: forward_register.py <dir>")
    try:
        res = register(argv[1])
    except (ledger.LedgerError, ValueError, OSError) as e:
        print(json.dumps({"forward_register": "refused: %s: %s"
                          % (type(e).__name__, str(e)[:300])}),
              file=sys.stderr)
        return 2
    if res["late"]:
        print(json.dumps({"forward_register": "registered after forward rows "
                          "existed", "ledgers": res["late"]}), file=sys.stderr)
    print(json.dumps(res, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
