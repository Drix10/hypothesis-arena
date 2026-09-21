"""Frozen doc-10 research spend governor (stdlib only).

R15 caps runaway loops; THIS caps money. Absolute stage caps per
30 days (frozen doc 10): G0/G1 $150, G2 $400, G3 $1000. Tier
transitions on the 30-day projection (frozen):
  >=60%  -> Tier 1 (cadence throttled: TTL 30->60min, harvest 5->10min)
  >=80%  -> Tier 2 (hypothesize paused except TRIGGER-immediate)
  >=100% -> Tier 3 (all LLM blocked, research_abort accounting)

Missing pricing blocks: without a {model_id: usd_per_1k_tokens} table
the governor cannot price a call, so model construction raises
ConfigBlocked instead of recording usd=0.0 forever. usd=0.0 on a span
therefore always means a zero-price model (free tier), never
"unpriced" — unpriced models never run.

Spend input is the attribution LEDGER (spend_since); a missing ledger
raises LedgerUnavailable and the governor denies (fail closed — an
unmeasurable plane does not spend).
"""
import time

from . import attribution
from . import workers as _workers

STAGE_CAPS_USD = {"G0": 150.0, "G1": 150.0, "G2": 400.0, "G3": 1000.0}
TIER1_FRAC = 0.60
TIER2_FRAC = 0.80
WINDOW_S = 30 * 86400


class SpendGovernor:
    """Pre-call dollar gate. decision() returns (verdict, reason):
    allow | throttle (tier 1) | triggers-only (tier 2) | deny."""

    def __init__(self, log_path, pricing, stage="G0"):
        if not isinstance(pricing, dict) or not pricing:
            raise _workers.ConfigBlocked(
                "research pricing table not configured")
        for model_id, price in pricing.items():
            if (not isinstance(model_id, str) or
                    not isinstance(price, (int, float)) or
                    not 0 <= price < 10 ** 6):
                raise _workers.ConfigBlocked("bad pricing entry")
        if stage not in STAGE_CAPS_USD:
            raise _workers.ConfigBlocked("bad spend stage: %r" % stage)
        self.log_path = log_path
        self.pricing = dict(pricing)
        self.stage = stage

    def price_for(self, model_id):
        try:
            return self.pricing[model_id]
        except KeyError:
            raise _workers.ConfigBlocked(
                "no price for model %r" % model_id)

    def window_spend(self, now=None):
        now = time.time() if now is None else now
        try:
            return attribution.spend_since(self.log_path,
                                           now - WINDOW_S)
        except attribution.LedgerUnavailable:
            # Fresh plane (no ledger file yet) starts at zero; a
            # CORRUPT ledger raises LedgerUnavailable above and denies.
            import os
            if not os.path.exists(
                    attribution._db_for(self.log_path)):
                return 0.0
            raise

    def decision(self, now=None):
        cap = STAGE_CAPS_USD[self.stage]
        try:
            spent = self.window_spend(now)
        except attribution.LedgerUnavailable:
            return "deny", "spend-unmeasurable"
        frac = spent / cap if cap > 0 else 1.0
        if frac >= 1.0:
            return "deny", "stage-cap-reached"
        if frac >= TIER2_FRAC:
            return "triggers-only", "tier-2"
        if frac >= TIER1_FRAC:
            return "throttle", "tier-1"
        return "allow", "ok"

    def usd_for(self, model_id, prompt_tokens, completion_tokens):
        return ((prompt_tokens + completion_tokens) / 1000.0 *
                self.price_for(model_id))
