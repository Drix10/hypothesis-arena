"""Frozen doc-10 research spend governor (stdlib only).

R15 caps runaway loops; THIS caps money. Absolute stage caps per
30 days (frozen doc 10): G0/G1 $150, G2 $400, G3 $1000.

Tier input is the FROZEN projection: trailing-7-day run rate
extrapolated to 30 days (NOT trailing-30d cumulative), evaluated at
most HOURLY. Tier transitions are durably journaled with the
projection that caused them; state and journal persist under ONE
tier lock with journal-carried snapshots so a crash between the two
recovers deterministically. Anti-flap (frozen): a tier escalates
immediately but falls back only after 6 consecutive hourly
evaluations below the lower threshold. Tier state is FAIL-CLOSED:
first install starts Tier 0, but a missing/corrupt/future-dated
state with history, or a stage/pricing change without fresh
evaluation, raises StateUnavailable (callers deny) instead of
defaulting to Tier 0.

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
BEFORE the provider may be touched, through ONE atomic ledger
transaction (reap expired + refuse on pending unknowns + measure
30d-committed + outstanding holds + compare + insert — no second
non-atomic check exists). A refused reservation raises SpendRefused
(clean: nothing ran). Timeout/ambiguous attempts keep their hold at
the FULL reservation and are marked UNKNOWN_SPEND; has_unreconciled()
(which also counts any positive-dollar invoked hold, the crash
backstop) makes decision() deny until a supervisor reconciles
(reconcile_unknown in attribution, recoverable from every point of
the ambiguity path). An ambiguous billed attempt is NEVER encoded
as $0.

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
<= $0 or when no profit ledger is wired. Three DISTINCT consecutive
FAILED UTC days force Tier 3 (repeated hourly failures on one day
count once; an ok or suspended day breaks the streak). Without a
profit feed every day is suspended and the absolute cap alone
governs (G0/G1 have no ratio cap at all — the suspension flag is
report-only there).
"""
import json
import math
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
JOURNAL_TAIL_BYTES = 65536  # bounded crash-recovery scan
TIER_LOCK_NAME = "tier.lock"  # ONE lock file for state + journals
EVAL_FUTURE_SKEW_S = 300

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


class StateUnavailable(Exception):
    """Tier-state failure: corrupt, deleted, future-dated, or
    otherwise unverifiable. Callers deny (fail closed), never fall
    back to Tier 0."""
    pass


class SpendGovernor:
    """Pre-call dollar gate + hourly tier evaluator."""

    def __init__(self, log_path, pricing, stage="G0", state_dir=None,
                 profit_since=None):
        if not isinstance(pricing, dict) or not pricing:
            raise _workers.ConfigBlocked(
                "research pricing table not configured")
        for model_id, price in pricing.items():
            # Type-exact numerics: bool is not a price, infinities
            # are not prices. A bad table blocks construction.
            if (not isinstance(model_id, str) or not model_id or
                    type(price) not in (int, float) or
                    not math.isfinite(price) or
                    not 0 <= price < 10 ** 6):
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
        # Model identity is control-plane input: non-string or empty
        # IDs block here, never as a TypeError from the dict lookup.
        if not isinstance(model_id, str) or not model_id:
            raise _workers.ConfigBlocked("bad model_id: %r" %
                                         (model_id,))
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
    def _fresh(self):
        """True only for a genuinely new path (no DB, no marker).
        A deleted authority (valid marker) or a damaged marker both
        read as NOT fresh: measurement raises instead of reporting
        zero."""
        import os as _os
        db_path = attribution._db_for(self.log_path)
        if _os.path.exists(db_path):
            return False
        mstate, _tok = locks.marker_state(db_path)
        if mstate != "absent":
            raise attribution.LedgerUnavailable(
                "spend authority deleted or marker invalid")
        return True

    def _measurable(self):
        """(spent_30d, holds) or raises LedgerUnavailable. A genuinely
        new path measures zero; a deleted authority raises."""
        if self._fresh():
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
        if self._fresh():
            return 0.0
        week = attribution.spend_since(self.log_path,
                                       now - PROJECTION_WINDOW_S)
        return week / 7.0 * PROJECTION_HORIZON_DAYS

    # -- durable tier state ------------------------------------------
    def _state_path(self):
        if not self.state_dir:
            return None
        return os.path.join(self.state_dir, TIER_STATE_NAME)

    def _tier_lock_path(self):
        # Single lock file for the whole tier subsystem (state +
        # both journals): state and its audit evidence are written
        # under ONE inter-process lock, never two lock files that
        # concurrent processes could interleave between.
        if not self.state_dir:
            return None
        return os.path.join(self.state_dir, TIER_LOCK_NAME)

    def _binding(self):
        """Config identity the cached tier is bound to: a stage or
        pricing change must force a FRESH evaluation, never reuse an
        old cached tier."""
        import hashlib
        fp = hashlib.sha256(json.dumps(
            sorted(self.pricing.items()), sort_keys=True).encode(
            "utf-8")).hexdigest()
        return {"stage": self.stage, "pricing_fp": fp, "v": 1}

    def _initial_state(self):
        st = {"tier": 0, "projection": 0.0, "evaluated_at": 0,
              "below_count": 0}
        st["binding"] = self._binding()
        return st

    @staticmethod
    def _valid_state(data, binding):
        if not isinstance(data, dict):
            return None
        try:
            tier = data.get("tier", 0)
            proj = data.get("projection", 0.0)
            eva = data.get("evaluated_at", 0)
            below = data.get("below_count", 0)
            # Type-exact + finite: an infinite projection or a
            # True-tier must never govern spend.
            if (type(tier) is not int or tier not in TIERS or
                    type(proj) not in (int, float) or
                    not math.isfinite(proj) or proj < 0 or
                    type(eva) is not int or eva < 0 or
                    type(below) is not int or below < 0):
                return None
            st = {"tier": tier, "projection": float(proj),
                  "evaluated_at": eva, "below_count": below,
                  "binding": data.get("binding")}
        except (TypeError, ValueError):
            return None
        return st

    def _load_state(self, now=None):
        """Fail-closed tier state load. Genuine first install (no
        state AND no journal) returns the initial Tier 0; a missing
        state with journal history, a corrupt state, or a
        future-dated evaluation raises StateUnavailable. A stage or
        pricing change (binding mismatch) returns the initial state
        with evaluated_at=0 so the caller evaluates FRESH immediately
        instead of reusing the stale cached tier."""
        path = self._state_path()
        if path is None:
            return self._initial_state()
        journal = os.path.join(self.state_dir, TIER_JOURNAL_NAME)
        try:
            data = locks.load_json_bounded(path,
                                           max_bytes=STATE_MAX_BYTES)
        except OSError:
            if os.path.exists(journal):
                raise StateUnavailable("tier-state-deleted")
            return self._initial_state()
        except ValueError:
            raise StateUnavailable("tier-state-corrupt")
        st = self._valid_state(data, self._binding())
        if st is None:
            raise StateUnavailable("tier-state-corrupt")
        if st["binding"] != self._binding():
            # Config changed under the cache: fresh evaluation now.
            return self._initial_state()
        if now is not None and st["evaluated_at"] > now + \
                EVAL_FUTURE_SKEW_S:
            raise StateUnavailable("tier-state-future")
        recovered = self._recover_from_journal(st)
        return recovered if recovered is not None else st

    def _journal_tail(self, name):
        """Newest-first parsed rows from the bounded tail of a
        journal (never the whole file)."""
        if not self.state_dir:
            return
        path = os.path.join(self.state_dir, name)
        try:
            size = os.path.getsize(path)
        except OSError:
            return
        try:
            with open(path, "rb") as fh:
                if size > JOURNAL_TAIL_BYTES:
                    fh.seek(size - JOURNAL_TAIL_BYTES)
                    fh.readline()  # drop the partial first line
                chunk = fh.read(JOURNAL_TAIL_BYTES + 4096)
        except OSError:
            return
        rows = []
        for line in chunk.decode("utf-8", "replace").split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                rows.append(row)
        for row in reversed(rows):
            yield row

    def _recover_from_journal(self, st):
        """Crash recovery: a transition journaled but never saved to
        the state file (crash between the two writes) is adopted from
        the journal tail — the journal row carries the full post-
        transition state snapshot. Returns the recovered state or
        None."""
        best = None
        for row in self._journal_tail(TIER_JOURNAL_NAME):
            snap = row.get("state")
            ts = row.get("ts")
            if (not isinstance(snap, dict) or type(ts) is not int or
                    ts <= st["evaluated_at"]):
                continue
            cand = self._valid_state(snap, self._binding())
            if cand is None or cand["binding"] != self._binding():
                continue
            if best is None or ts > best["evaluated_at"]:
                best = cand
        return best

    def _save_state(self, st):
        path = self._state_path()
        if path is None:
            return
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        lock = self._tier_lock_path()
        with locks.FileLock(lock, purpose="tier"):
            locks.atomic_write_bytes(
                d, os.path.basename(path),
                json.dumps(st, sort_keys=True).encode("utf-8"))

    def _journal(self, name, row):
        if not self.state_dir:
            return
        path = os.path.join(self.state_dir, name)
        lock = self._tier_lock_path()
        with locks.FileLock(lock, purpose="tier"):
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())

    def _save_state_and_journal(self, st, journal_name, journal_row):
        """Crash-consistent transition persist: journal (carrying the
        full post-transition state snapshot for tail recovery) THEN
        state, under the SINGLE tier lock. A crash between the two is
        recovered by _recover_from_journal on the next load."""
        if journal_row is not None:
            journal_row = dict(journal_row)
            journal_row["state"] = dict(st)
            self._journal(journal_name, journal_row)
        self._save_state(st)

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
        6-hour anti-flap fallback. Returns (tier, projection).
        Tier-state failure raises StateUnavailable (fail closed — the
        caller denies); ledger-unavailable keeps the last tier
        (decision() separately denies on unmeasurable spend)."""
        now = int(time.time()) if now is None else now
        st = self._load_state(now)
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
            self._save_state_and_journal(
                st, TIER_JOURNAL_NAME,
                {"ts": now, "from": old_tier, "to": st["tier"],
                 "projection_30d": proj, "cap": cap,
                 "stage": self.stage})
        else:
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
        the absolute cap governs. Never raises on missing data.
        Type-exact numerics: bool/NaN/infinite profit or spend cannot
        pass or poison the ratio."""
        now = int(time.time()) if now is None else now
        if self.stage not in ("G2", "G3") or self.profit_since is None:
            return "suspended", "no-profit-feed"
        try:
            profit = self.profit_since(now - PROFIT_WINDOW_S)
            spent = attribution.spend_since(self.log_path,
                                            now - RATIO_WINDOW_S)
        except (attribution.LedgerUnavailable, TypeError, ValueError):
            return "suspended", "unmeasurable"
        if (type(profit) not in (int, float) or
                not math.isfinite(profit) or profit <= 0):
            return "suspended", "unprofitable-window"
        if (type(spent) not in (int, float) or
                not math.isfinite(spent)):
            return "suspended", "unmeasurable"
        if spent <= RATIO_MAX * profit:
            return "ok", "within-ratio"
        return "failed", "ratio-exceeded"

    def _ratio_day_state(self, day):
        """Recorded ratio state for one UTC day (newest row wins),
        or None when the day was never evaluated (suspended days
        journal too — audit completeness — but never count as
        failed)."""
        for row in self._journal_tail(RATIO_JOURNAL_NAME):
            if (type(row.get("day")) is int and row["day"] == day
                    and row.get("state") in ("ok", "failed",
                                               "suspended")):
                return row["state"]
        return None

    def _ratio_forces_stop(self, now):
        state, _detail = self.ratio_status(now)
        day = now - (now % 86400)
        if state == "suspended":
            return False
        if not self.state_dir:
            # No durable journal: consecutive-day counting is
            # impossible, so the ratio cannot force a stop here
            # (the absolute cap still governs; production governors
            # always carry state_dir — enforced at graph build).
            return False
        if self._ratio_day_state(day) is None:
            # At most ONE counted evaluation per UTC day: repeated
            # hourly failures on the same day are one failed day.
            self._journal(RATIO_JOURNAL_NAME,
                          {"day": day, "state": state,
                           "stage": self.stage})
        # Distinct consecutive FAILED days ending today; an ok day or
        # a missing/suspended day breaks the streak. Only the first
        # RATIO_FAIL_DAYS days matter (bounded journal scans).
        streak = 0
        d = day
        while streak < RATIO_FAIL_DAYS:
            if self._ratio_day_state(d) != "failed":
                break
            streak += 1
            d -= 86400
        return streak >= RATIO_FAIL_DAYS

    # -- node gating --------------------------------------------------
    def tier(self, now=None):
        return self.evaluate(now)[0]

    def decision(self, now=None):
        """(verdict, reason). Unknown-spend outstanding, unmeasurable
        spend, and unverifiable tier state all deny — an uncertain
        plane does not spend."""
        try:
            if attribution.has_unreconciled(self.log_path):
                return "deny", "unknown-spend-pending"
        except attribution.LedgerUnavailable:
            # Genuinely new path: no unknowns possible. A deleted
            # authority raises here too — and must deny. Distinguish
            # via freshness (same rule as measurement).
            try:
                fresh = self._fresh()
            except attribution.LedgerUnavailable:
                return "deny", "spend-unmeasurable"
            if not fresh:
                return "deny", "spend-unmeasurable"
        try:
            tier = self.evaluate(now)
        except attribution.LedgerUnavailable:
            return "deny", "spend-unmeasurable"
        except StateUnavailable:
            return "deny", "tier-state-unavailable"
        t = tier[0] if isinstance(tier, tuple) else tier
        return TIERS[t]["verdict"], "tier-%d" % t

    def thesis_cap(self, now=None):
        t = self.tier(now)
        return TIERS[t]["thesis_cap"]

    # -- pre-call absolute hold ----------------------------------------
    def reserve_usd(self, amount_usd, lease_id, now=None):
        """Hold worst-case dollars pre-call: a SINGLE atomic ledger
        transaction (reap + block-check + measure + compare + insert).
        Refuses (SpendRefused) when the cap would cross, when unknowns
        are pending, or when spend is unmeasurable. Clean refusal: the
        provider was not touched. There is deliberately no second
        read/check/insert path — this is the only authorization."""
        if (type(amount_usd) not in (int, float) or
                not math.isfinite(amount_usd) or amount_usd < 0):
            raise SpendRefused("unaccountable usd amount")
        cap = STAGE_CAPS_USD[self.stage]
        try:
            attribution.reserve_spend_hold(self.log_path, lease_id,
                                           amount_usd, cap, now)
        except attribution.SpendBlocked as e:
            raise SpendRefused(str(e))
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
