"""Frozen doc-10 research spend governor (stdlib only).

R15 caps runaway loops; THIS caps money. Absolute stage caps per
30 days (frozen doc 10): G0/G1 $150, G2 $400, G3 $1000.

Tier input is the FROZEN projection: trailing-7-day run rate
extrapolated to 30 days (NOT trailing-30d cumulative), evaluated at
most HOURLY. Tier transitions are durably journaled with the
projection that caused them. Anti-flap (frozen): a tier escalates
immediately but falls back only after 6 consecutive hourly
evaluations below the lower threshold.

Tier effects (frozen doc 10 §10.4 — the graph implements them, this
module reports them):
  T0 normal: full research depth.
  T1 trim (>=60%): research cycle interval doubled (TTL 30->60min,
    harvest 5->10min), critique on TRIGGER-class symbols only,
    NULL-class source extraction suspended.
  T2 cheap (>=80%): non-JEV LLM work on the cheapest configured
    model, hypothesize prose capped at 200 chars, watchlist cut to
    the 2 best-calibrated symbols, SOFT kill (no new entries).
  T3 stop (>=100%, or ratio failed 3 consecutive days at G2/G3):
    research LLM stops (deny). MEDIUM-kill signalling is the graph's
    duty; this module reports the tier.

Pre-call absolute enforcement: reserve_usd() holds worst-case dollars
BEFORE the provider may be touched (spent_30d + outstanding holds +
amount <= cap, evaluated atomically in the ledger transaction).
A refused reservation raises SpendRefused (clean: nothing ran).
Timeout/ambiguous attempts keep their hold at the FULL reservation
and are marked UNKNOWN_SPEND; has_unreconciled() makes decision()
deny until a supervisor reconciles (reconcile_unknown in
attribution). An ambiguous billed attempt is NEVER encoded as $0.

Missing pricing blocks: without a {model_id: worst-leg-usd_per_1k}
table the governor cannot price a call, so construction raises
ConfigBlocked. PRICING SEMANTICS (frozen): each entry is the
MAXIMUM per-1k price across input/output legs — the reservation
prices every token at that leg, so the hold is a true worst case.
usd=0.0 therefore always means a zero-price model, never unknown.

Spend input is the attribution LEDGER. A missing-but-genuinely-new
ledger starts at zero; a DELETED authority (marker without DB)
raises LedgerUnavailable and the governor denies (fail closed — an
unmeasurable plane does not spend).

Ratio cap (G2/G3, frozen): rolling-30d spend <= 20% of trailing-90d
realized net profit, undefined (SUSPENDED, never failed) when profit
<= $0 or when no profit ledger is wired. Three consecutive FAILED
daily evaluations force Tier 3. Without a profit feed every day is
suspended and the absolute cap alone governs (G0/G1 have no ratio
cap at all — the suspension flag is report-only there).
"""
import json
import os
import time

from . import attribution
from . import locks
from . import workers as _workers

STAGE_CAPS_USD = {"G0": 150.0, "G1": 150.0, "G2": 400.0, "G3": 1000.0}
# Frozen tier entry thresholds (fraction of cap, on the projection).
TIER1_FRAC = 0.60
TIER2_FRAC = 0.80
TIER3_FRAC = 1.00
# Frozen projection: trailing 7-day run rate extrapolated to 30 days,
# evaluated at most hourly; fallback needs 6 consecutive below.
PROJECTION_WINDOW_S = 7 * 86400
PROJECTION_HORIZON_DAYS = 30
TIER_EVAL_S = 3600
ANTI_FLAP_HOURS = 6
# Ratio inputs (G2/G3): 30d spend vs 90d profit; 3 failed days -> T3.
RATIO_WINDOW_S = 30 * 86400
PROFIT_WINDOW_S = 90 * 86400
RATIO_MAX = 0.20
RATIO_FAIL_DAYS = 3

TIER_STATE_NAME = "tier_state.json"
TIER_JOURNAL_NAME = "tier_journal.jsonl"
RATIO_JOURNAL_NAME = "ratio_journal.jsonl"
STATE_MAX_BYTES = 4096

# Frozen tier descriptors consumed by the graph. verdict drives node
# gating; effects are implemented by the graph, not here.
TIERS = {
    0: {"verdict": "allow", "thesis_cap": 500,
        "effects": ("full-depth",)},
    1: {"verdict": "throttle", "thesis_cap": 500,
        "effects": ("double-interval", "critique-triggers-only",
                    "null-extraction-suspended")},
    2: {"verdict": "cheap", "thesis_cap": 200,
        "effects": ("double-interval", "critique-triggers-only",
                    "null-extraction-suspended", "cheapest-model",
                    "watchlist-2", "soft-kill")},
    3: {"verdict": "deny", "thesis_cap": 0,
        "effects": ("research-llm-stopped", "medium-kill-signal")},
}


class SpendRefused(Exception):
    pass


class SpendGovernor:
    """Pre-call dollar gate + hourly tier evaluator."""

    def __init__(self, log_path, pricing, stage="G0", state_dir=None,
                 profit_since=None):
        if not isinstance(pricing, dict) or not pricing:
            raise _workers.ConfigBlocked(
                "research pricing table not configured")
        for model_id, price in pricing.items():
            if (not isinstance(model_id, str) or not model_id or
                    not isinstance(price, (int, float)) or
                    not 0 <= price < 10 ** 6 or price != price):
                raise _workers.ConfigBlocked("bad pricing entry")
        if stage not in STAGE_CAPS_USD:
            raise _workers.ConfigBlocked("bad spend stage: %r" % stage)
        self.log_path = log_path
        self.pricing = dict(pricing)
        self.stage = stage
        self.state_dir = state_dir
        self.profit_since = profit_since  # (since_ts)->profit or None
        self._tier_cache = None  # (tier, projection, evaluated_at)

    # -- pricing ----------------------------------------------------
    def price_for(self, model_id):
        try:
            return self.pricing[model_id]
        except KeyError:
            raise _workers.ConfigBlocked(
                "no price for model %r" % model_id)

    def cheapest_model(self):
        """The frozen T2 model: minimum worst-leg price. Ties break
        by model_id sort (deterministic)."""
        return sorted(self.pricing.items(),
                      key=lambda kv: (kv[1], kv[0]))[0][0]

    def worst_usd(self, model_id, token_bound):
        """True worst-case dollars for a call that may consume up to
        token_bound tokens: every token at the worst leg."""
        if type(token_bound) is not int or token_bound < 0:
            raise SpendRefused("unaccountable token bound")
        return token_bound / 1000.0 * self.price_for(model_id)

    # -- spend measurement ------------------------------------------
    def _measurable(self):
        """(spent_30d, holds) or raises LedgerUnavailable. A genuinely
        new path measures zero; a deleted authority raises."""
        db_path = attribution._db_for(self.log_path)
        if not os.path.exists(db_path):
            if locks.read_marker(db_path) is not None:
                raise attribution.LedgerUnavailable(
                    "spend authority deleted")
            return 0.0, 0.0
        now = time.time()
        spent = attribution.spend_since(self.log_path, now - 30 * 86400)
        holds = attribution.outstanding_holds(self.log_path)
        return spent, holds

    def committed_spend(self):
        """spent_30d + outstanding holds: the number the absolute cap
        is enforced against."""
        spent, holds = self._measurable()
        return spent + holds

    def projection_30d(self, now=None):
        """Frozen projection: (trailing-7d spend / 7) * 30."""
        now = time.time() if now is None else now
        db_path = attribution._db_for(self.log_path)
        if not os.path.exists(db_path):
            if locks.read_marker(db_path) is not None:
                raise attribution.LedgerUnavailable(
                    "spend authority deleted")
            return 0.0
        week = attribution.spend_since(self.log_path,
                                       now - PROJECTION_WINDOW_S)
        return week / 7.0 * PROJECTION_HORIZON_DAYS

    # -- durable tier state ------------------------------------------
    def _state_path(self):
        if not self.state_dir:
            return None
        return os.path.join(self.state_dir, TIER_STATE_NAME)

    def _load_state(self):
        st = {"tier": 0, "projection": 0.0, "evaluated_at": 0,
              "below_count": 0}
        path = self._state_path()
        if path is None:
            return st
        try:
            data = locks.load_json_bounded(path,
                                           max_bytes=STATE_MAX_BYTES)
        except (OSError, ValueError):
            return st
        if not isinstance(data, dict):
            return st
        try:
            tier = data.get("tier", 0)
            proj = data.get("projection", 0.0)
            eva = data.get("evaluated_at", 0)
            below = data.get("below_count", 0)
            if (type(tier) is not int or tier not in TIERS or
                    not isinstance(proj, (int, float)) or
                    proj != proj or proj < 0 or
                    type(eva) is not int or eva < 0 or
                    type(below) is not int or below < 0):
                return st
            st.update(tier=tier, projection=float(proj),
                      evaluated_at=eva, below_count=below)
        except (TypeError, ValueError):
            return st
        return st

    def _save_state(self, st):
        path = self._state_path()
        if path is None:
            return
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        with locks.FileLock(path + ".lock", purpose="tier"):
            locks.atomic_write_bytes(
                d, os.path.basename(path),
                json.dumps(st, sort_keys=True).encode("utf-8"))

    def _journal(self, name, row):
        if not self.state_dir:
            return
        path = os.path.join(self.state_dir, name)
        with locks.FileLock(path + ".lock", purpose="tier"):
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())

    @staticmethod
    def _tier_for(projection, cap):
        frac = projection / cap if cap > 0 else 1.0
        if frac >= TIER3_FRAC:
            return 3
        if frac >= TIER2_FRAC:
            return 2
        if frac >= TIER1_FRAC:
            return 1
        return 0

    def evaluate(self, now=None):
        """Hourly tier evaluation with journaled transitions and
        6-hour anti-flap fallback. Returns (tier, projection). Ledger-
        unavailable keeps the last tier (decision() separately denies
        on unmeasurable spend)."""
        now = int(time.time()) if now is None else now
        st = self._load_state()
        if now - st["evaluated_at"] < TIER_EVAL_S and self._tier_cache \
                and self._tier_cache[2] == st["evaluated_at"]:
            return self._tier_cache[0], self._tier_cache[1]
        if now - st["evaluated_at"] < TIER_EVAL_S:
            self._tier_cache = (st["tier"], st["projection"],
                                st["evaluated_at"])
            return st["tier"], st["projection"]
        cap = STAGE_CAPS_USD[self.stage]
        try:
            proj = self.projection_30d(now)
        except attribution.LedgerUnavailable:
            return st["tier"], st["projection"]
        # Ratio-forced Tier 3 (G2/G3 with a wired profit feed).
        if self._ratio_forces_stop(now):
            new_tier = 3
        else:
            new_tier = self._tier_for(proj, cap)
        old_tier = st["tier"]
        if new_tier > old_tier:
            st.update(tier=new_tier, below_count=0)
        elif new_tier < old_tier:
            st["below_count"] = st.get("below_count", 0) + 1
            if st["below_count"] >= ANTI_FLAP_HOURS:
                st.update(tier=new_tier, below_count=0)
        else:
            st["below_count"] = 0
        st.update(projection=proj, evaluated_at=now)
        if st["tier"] != old_tier:
            self._journal(TIER_JOURNAL_NAME,
                          {"ts": now, "from": old_tier, "to": st["tier"],
                           "projection_30d": proj, "cap": cap,
                           "stage": self.stage})
        self._save_state(st)
        self._tier_cache = (st["tier"], proj, now)
        try:
            attribution.prune_spans(self.log_path, now)
        except attribution.LedgerUnavailable:
            pass
        return st["tier"], proj

    # -- ratio (G2/G3; suspended without a profit feed) ---------------
    def ratio_status(self, now=None):
        """(state, detail): ok | failed | suspended. Suspended (no
        profit feed, or non-positive trailing profit) is report-only:
        the absolute cap governs. Never raises on missing data."""
        now = int(time.time()) if now is None else now
        if self.stage not in ("G2", "G3") or self.profit_since is None:
            return "suspended", "no-profit-feed"
        try:
            profit = self.profit_since(now - PROFIT_WINDOW_S)
            spent = attribution.spend_since(self.log_path,
                                            now - RATIO_WINDOW_S)
        except (attribution.LedgerUnavailable, TypeError, ValueError):
            return "suspended", "unmeasurable"
        if (not isinstance(profit, (int, float)) or profit != profit
                or profit <= 0):
            return "suspended", "unprofitable-window"
        if not isinstance(spent, (int, float)) or spent != spent:
            return "suspended", "unmeasurable"
        if spent <= RATIO_MAX * profit:
            return "ok", "within-ratio"
        return "failed", "ratio-exceeded"

    def _ratio_forces_stop(self, now):
        state, _detail = self.ratio_status(now)
        day = now - (now % 86400)
        if state == "suspended":
            return False
        self._journal(RATIO_JOURNAL_NAME,
                      {"day": day, "state": state, "stage": self.stage})
        if state == "ok":
            return False
        # Count consecutive failed days from the journal tail.
        fails = 0
        path = os.path.join(self.state_dir or "", RATIO_JOURNAL_NAME)
        try:
            with open(path, encoding="utf-8") as fh:
                rows = [json.loads(l) for l in fh if l.strip()]
        except (OSError, ValueError):
            rows = []
        for row in reversed(rows):
            if not isinstance(row, dict) or row.get("state") not in (
                    "ok", "failed"):
                continue
            if row.get("state") == "failed":
                fails += 1
            else:
                break
        return fails >= RATIO_FAIL_DAYS

    # -- node gating --------------------------------------------------
    def tier(self, now=None):
        return self.evaluate(now)[0]

    def decision(self, now=None):
        """(verdict, reason). Unknown-spend outstanding and
        unmeasurable spend both deny — an uncertain plane does not
        spend."""
        try:
            if attribution.has_unreconciled(self.log_path):
                return "deny", "unknown-spend-pending"
        except attribution.LedgerUnavailable:
            # Genuinely new path: no unknowns possible. A deleted
            # authority raises here too — and must deny. Distinguish
            # via the marker (same rule as measurement).
            import os as _os
            if _os.path.exists(
                    attribution._db_for(self.log_path)) or \
                    locks.read_marker(
                        attribution._db_for(self.log_path)) is not None:
                return "deny", "spend-unmeasurable"
        try:
            tier = self.evaluate(now)
        except attribution.LedgerUnavailable:
            return "deny", "spend-unmeasurable"
        t = tier[0] if isinstance(tier, tuple) else tier
        return TIERS[t]["verdict"], "tier-%d" % t

    def thesis_cap(self, now=None):
        t = self.tier(now)
        return TIERS[t]["thesis_cap"]

    # -- pre-call absolute hold ----------------------------------------
    def reserve_usd(self, amount_usd, lease_id, now=None):
        """Hold worst-case dollars pre-call. Refuses (SpendRefused)
        when spent_30d + outstanding + amount would cross the stage
        cap, when unknowns are pending, or when spend is
        unmeasurable. Clean refusal: the provider was not touched."""
        if (not isinstance(amount_usd, (int, float)) or
                amount_usd != amount_usd or amount_usd < 0):
            raise SpendRefused("unaccountable usd amount")
        try:
            if attribution.has_unreconciled(self.log_path):
                raise SpendRefused("unknown-spend-pending")
            committed = self.committed_spend()
        except attribution.LedgerUnavailable:
            raise SpendRefused("spend-unmeasurable")
        cap = STAGE_CAPS_USD[self.stage]
        if committed + amount_usd > cap:
            raise SpendRefused("stage-cap: %.2f+%.2f>%.2f" %
                               (committed, amount_usd, cap))
        try:
            attribution.reap_holds(self.log_path, now)
            attribution.hold_spend(self.log_path, lease_id, amount_usd,
                                   now)
        except attribution.LedgerUnavailable as e:
            raise SpendRefused("spend-unmeasurable:%s" % e)

    def mark_invoked(self, lease_id):
        try:
            attribution.mark_invoked(self.log_path, lease_id)
        except attribution.LedgerUnavailable as e:
            raise SpendRefused("spend-unmeasurable:%s" % e)

    def settle_usd(self, lease_id):
        """Release a cleanly accounted hold (the span carries actuals).
        Never raises for a missing hold."""
        try:
            attribution.settle_hold(self.log_path, lease_id)
        except attribution.LedgerUnavailable:
            pass
