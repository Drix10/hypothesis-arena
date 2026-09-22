#!/usr/bin/env python3
"""live-provider-probe.py — Phase-D Box 4 live proof (OpenRouter).

First live-spend evidence: the EXACT production accounting path, no mocks:
  root .env (via collector.config.load) -> SpendGovernor(pricing) ->
  reserve_usd -> mark_invoked -> UsageTape(make_raw_provider).generate
  (through the Squid egress proxy, transport-pinned) -> append_span
  (real prompt/completion tokens + dollar math) -> settle_usd.

Pricing (OpenRouter contract 2026-09-23, meta/muse-spark-1.3-contributor):
  $0.10/M input + $0.20/M output -> worst-leg $0.00020/1k in the table.
Call is capped to max_tokens=16 (~$0.00002 worst case).

Usage: python3 research-plane/sandbox/live-provider-probe.py [--out PATH]
Exit 0 only on: HTTP-200-class success AND tape totals present AND
lease settled AND computed dollars > 0 and < reservation.
NEVER prints the API key. Writes evidence JSON with --out.
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from collector import config as config_mod
from plane import spend as spend_mod
from plane import workers as workers_mod
from plane import attribution as attr_mod

IN_PER_1K = 0.00010
OUT_PER_1K = 0.00020
WORST_LEG_PER_1K = max(IN_PER_1K, OUT_PER_1K)


def main():
    cfg = config_mod.load()
    vals = cfg["values"]
    api_key = vals.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("BLOCKED: no OPENROUTER_API_KEY in root .env (fail-closed)")
        return 2
    model_id = os.environ.get("RESEARCH_MODEL_ID", "").strip()
    if not model_id:
        print("BLOCKED: no RESEARCH_MODEL_ID (fail-closed)")
        return 2
    out = sys.argv[sys.argv.index("--out") + 1] \
        if "--out" in sys.argv else None
    tmp = tempfile.mkdtemp(prefix="liveprov-")
    log_path = os.path.join(tmp, "ledger.db")
    gov = spend_mod.SpendGovernor(
        log_path, {model_id: WORST_LEG_PER_1K}, stage="G0",
        state_dir=os.path.join(tmp, "state"))
    lease = "live-%d" % int(time.time())
    worst_case_usd = (64 * IN_PER_1K + 16 * OUT_PER_1K) / 1000.0 * 4
    gov.reserve_usd(worst_case_usd, lease)
    print("reserved lease %s worst-case $%.6f" % (lease, worst_case_usd))
    gov.mark_invoked(lease)
    tape = workers_mod.UsageTape(workers_mod.make_raw_provider({
        "model_id": model_id,
        "egress_proxy": "http://127.0.0.1:3128",
        "api_base": "https://openrouter.ai/api/v1",
        "api_key": api_key,
    }), completion_max=16, token_budget=4096)
    t0 = time.monotonic()
    msg = tape.generate(
        [{"role": "user",
          "content": "Reply with exactly: PROBE-OK"}],
        max_tokens=16)
    ms = (time.monotonic() - t0) * 1000.0
    totals = tape.totals()
    if totals is None:
        print("FAIL: unaccountable usage (tape poisoned)")
        return 1
    pt, ct = totals
    dollars = (pt * IN_PER_1K + ct * OUT_PER_1K) / 1000.0
    text = ""
    try:
        text = str(msg.content)[:64]
    except Exception:
        text = "<unprojectable>"
    attr_mod.append_span(log_path, 1, "live-probe", model_id, calls=1,
                         tokens=pt + ct, dollars=dollars,
                         span_id="live-" + lease, cycle_id="live",
                         stage="G0", symbol="PROBE",
                         prompt_tokens=pt, completion_tokens=ct,
                         usd=dollars)
    gov.settle_usd(lease)
    ev = {"ts": int(time.time()), "model": model_id,
          "via": "squid-127.0.0.1:3128", "latency_ms": round(ms, 1),
          "prompt_tokens": pt, "completion_tokens": ct,
          "dollars": round(dollars, 6),
          "reserved_usd": worst_case_usd, "lease": lease,
          "reply_head": text}
    print(json.dumps(ev, indent=1))
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(ev, fh, indent=1)
        print("wrote", out)
    ok = (dollars > 0) and (dollars < worst_case_usd)
    print("LIVE-PROOF: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
