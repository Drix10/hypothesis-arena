"""Research spend governor (doc 10, stdlib only).

R15 caps runaway loops; this module caps money. Absolute stage caps per
30 days: G0/G1 $150, G2 $400, G3 $1000.

Tier input is the trailing-7-day run rate extrapolated to 30 days (not the
trailing-30d cumulative), evaluated at most hourly. Tier transitions are
journaled with the projection that caused them; state and journal persist
under one tier lock with journal-carried snapshots so a crash between the
two recovers deterministically. Anti-flap: a tier escalates immediately but
falls back only after 6 consecutive hourly evaluations below the lower
threshold. First install starts at Tier 0, but missing/corrupt/future-dated
state with history, or a stage/pricing change without a fresh evaluation,
raises StateUnavailable (callers deny) rather than defaulting to Tier 0.

Tier effects (doc 10 §10.4; the graph implements them, this module reports
them):
  T0 normal: full research depth.
  T1 trim (>=60%): research cycle interval doubled (TTL 30->60min,
    harvest 5->10min), critique on TRIGGER-class symbols only, NULL-class
    source extraction suspended.
  T2 cheap (>=80%): non-JEV LLM work on the cheapest configured model,
    hypothesize prose capped at 200 chars, watchlist cut to the 2
    best-calibrated symbols, SOFT kill (no new entries).
  T3 stop (>=100%, or ratio failed 3 consecutive days at G2/G3): research
    LLM stops (deny). MEDIUM-kill signalling is the graph's duty; this
    module reports the tier.

Pre-call enforcement: reserve_usd() holds worst-case dollars before the
provider may be touched, in one atomic ledger transaction (reap expired,
refuse on pending unknowns, measure 30d-committed + outstanding holds,
compare, insert). A refusal raises SpendRefused (nothing ran).
Timeout/ambiguous attempts keep their hold at the full reservation and are
marked UNKNOWN_SPEND; has_unreconciled() (which also counts any
positive-dollar invoked hold, the crash backstop) makes decision() deny
until a supervisor reconciles (attribution.reconcile_unknown, recoverable
from every point of the ambiguity path). An ambiguous billed attempt is
never recorded as $0.

Pricing: without a {model_id: worst-leg-usd_per_1k} table the governor
cannot price a call, so construction raises ConfigBlocked. Each entry is
the maximum per-1k price across input/output legs and the reservation
prices every token at that leg, so the hold is a true worst case and
usd=0.0 always means a zero-price model.

Spend input is the attribution ledger. A genuinely new ledger starts at
zero; a deleted authority (marker without DB) raises LedgerUnavailable and
the governor denies.

Ratio cap (G2/G3): rolling-30d spend <= 20% of trailing-90d realized net
profit; undefined (suspended, not failed) when profit <= $0 or no profit
ledger is wired. Three distinct consecutive failed UTC days force Tier 3
(repeated hourly failures on one day count once; an ok or suspended day
breaks the streak). Without a profit feed every day is suspended and the
absolute cap alone governs (G0/G1 have no ratio cap; the suspension flag is
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
# tier entry thresholds (fraction of cap, on the projection)
TIER1_FRAC = 0.60
TIER2_FRAC = 0.80
TIER3_FRAC = 1.00
# projection: trailing 7-day run rate extrapolated to 30 days, evaluated at
# most hourly; fallback needs 6 consecutive below
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
# Ratio-row integrity chain: every ratio row commits to the previous row's
# digest, and the tier state anchors the newest row it has proven
# (ratio_head). Rewriting a decided day (failed -> ok) breaks the chain or
# the anchor, so valid-JSON tampering with Tier-3 history denies. The streak
# rule itself is unchanged.
RATIO_GENESIS_PREV = "ratio-genesis-v1"
STATE_MAX_BYTES = 4096
JOURNAL_TAIL_BYTES = 65536  # bounded crash-recovery scan
TIER_LOCK_NAME = "tier.lock"  # one lock file for state + journals
EVAL_FUTURE_SKEW_S = 300

# tier descriptors consumed by the graph: verdict drives node gating; the
# graph implements the effects
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


def _is_sha256_hex(v):
    return (type(v) is str and len(v) == 64
            and all(c in "0123456789abcdef" for c in v))


class SpendRefused(Exception):
    pass


class StateUnavailable(Exception):
    """Tier-state failure: corrupt, deleted, future-dated or otherwise
    unverifiable. Callers deny; never fall back to Tier 0."""
    pass


class SpendGovernor:
    """Pre-call dollar gate + hourly tier evaluator."""

    def __init__(self, log_path, pricing, stage="G0", state_dir=None,
                 profit_since=None):
        if not isinstance(pricing, dict) or not pricing:
            raise _workers.ConfigBlocked(
                "research pricing table not configured")
        for model_id, price in pricing.items():
            # type-exact numerics: bool and infinities are not prices; a bad table blocks construction
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
        # No in-memory tier-result cache, by design: a (tier, projection,
        # evaluated_at) cache is unsafe across governor instances (two processes
        # evaluating in the same second collide, and the first instance's cache
        # resurrects a weaker tier after the second durably raised it). The
        # durable state already enforces the hourly cadence, so every evaluation
        # reloads it.

    # -- pricing ----------------------------------------------------
    def price_for(self, model_id):
        # model identity is control-plane input: non-string or empty IDs block here, not as a TypeError
        if not isinstance(model_id, str) or not model_id:
            raise _workers.ConfigBlocked("bad model_id: %r" %
                                         (model_id,))
        try:
            return self.pricing[model_id]
        except KeyError:
            raise _workers.ConfigBlocked(
                "no price for model %r" % model_id)

    def cheapest_model(self):
        """The T2 model: minimum worst-leg price; ties break by model_id sort."""
        return sorted(self.pricing.items(),
                      key=lambda kv: (kv[1], kv[0]))[0][0]

    def worst_usd(self, model_id, token_bound):
        """Worst-case dollars for a call that may use up to token_bound
        tokens: every token at the worst leg."""
        if type(token_bound) is not int or token_bound < 0:
            raise SpendRefused("unaccountable token bound")
        return token_bound / 1000.0 * self.price_for(model_id)

    # -- spend measurement ------------------------------------------
    def _fresh(self):
        """True only for a genuinely new path (no DB, no marker). A deleted
        authority or a damaged marker reads as not fresh, so measurement raises
        instead of reporting zero."""
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
        """(spent_30d, holds), or raises LedgerUnavailable. A genuinely new path
        measures zero; a deleted authority raises."""
        if self._fresh():
            return 0.0, 0.0
        now = time.time()
        spent = attribution.spend_since(self.log_path, now - 30 * 86400)
        holds = attribution.outstanding_holds(self.log_path)
        return spent, holds

    def committed_spend(self):
        """spent_30d + outstanding holds: the number the absolute cap is enforced against."""
        spent, holds = self._measurable()
        return spent + holds

    def projection_30d(self, now=None):
        """Projection: (trailing-7d spend / 7) * 30."""
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
        # single lock file for the tier subsystem (state + both journals), so state
        # and its audit evidence are written under one inter-process lock
        if not self.state_dir:
            return None
        return os.path.join(self.state_dir, TIER_LOCK_NAME)

    def _binding(self):
        """Config identity the cached tier is bound to: a stage or pricing change
        forces a fresh evaluation."""
        import hashlib
        fp = hashlib.sha256(json.dumps(
            sorted(self.pricing.items()), sort_keys=True).encode(
            "utf-8")).hexdigest()
        return {"stage": self.stage, "pricing_fp": fp, "v": 1}

    def _initial_state(self):
        st = {"tier": 0, "projection": 0.0, "evaluated_at": 0,
              "below_count": 0, "ratio_day": 0, "tier_rev": 0,
              "ratio_head": None}
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
            # type-exact and finite: an infinite projection or a True tier must not govern spend
            if (type(tier) is not int or tier not in TIERS or
                    type(proj) not in (int, float) or
                    not math.isfinite(proj) or proj < 0 or
                    type(eva) is not int or eva < 0 or
                    type(below) is not int or below < 0):
                return None
            ratio_day = data.get("ratio_day", 0)
            if type(ratio_day) is not int or ratio_day < 0:
                return None
            tier_rev = data.get("tier_rev", 0)
            if type(tier_rev) is not int or tier_rev < 0:
                return None
            ratio_head = data.get("ratio_head", None)
            if ratio_head is not None and \
                    type(ratio_head) is not str:
                return None
            st = {"tier": tier, "projection": float(proj),
                  "evaluated_at": eva, "below_count": below,
                  "ratio_day": ratio_day, "tier_rev": tier_rev,
                  "ratio_head": ratio_head,
                  "binding": data.get("binding")}
        except (TypeError, ValueError):
            return None
        return st

    def _load_state(self, now=None):
        """Load tier state, failing closed. A genuine first install (no state
        and no journal) returns the initial Tier 0; missing state with journal
        history, corrupt state or a future-dated evaluation raises
        StateUnavailable. A binding mismatch (stage or pricing change) returns the
        initial state with evaluated_at=0 so the caller evaluates fresh."""
        path = self._state_path()
        if path is None:
            return self._initial_state()
        journal = os.path.join(self.state_dir, TIER_JOURNAL_NAME)
        try:
            data = locks.load_json_bounded(path,
                                           max_bytes=STATE_MAX_BYTES)
        except FileNotFoundError:
            if os.path.exists(journal):
                raise StateUnavailable("tier-state-deleted")
            return self._initial_state()
        except OSError:
            # present-but-unreadable (permissions, I/O) is not a fresh install: tier
            # state gates T1/T2/T3, so an uncertain state denies
            raise StateUnavailable("tier-state-unreadable")
        except ValueError:
            raise StateUnavailable("tier-state-corrupt")
        st = self._valid_state(data, self._binding())
        if st is None:
            raise StateUnavailable("tier-state-corrupt")
        if st["binding"] != self._binding():
            # config changed under the cache: evaluate fresh. The ratio deletion
            # tripwire survives the reset (ratio history is config-independent).
            init = self._initial_state()
            init["ratio_day"] = st["ratio_day"]
            init["ratio_head"] = st["ratio_head"]
            init["tier_rev"] = st["tier_rev"]
            return init
        if now is not None and st["evaluated_at"] > now + \
                EVAL_FUTURE_SKEW_S:
            raise StateUnavailable("tier-state-future")
        recovered = self._recover_from_journal(st, now)
        return recovered if recovered is not None else st

    @staticmethod
    def _valid_tier_row(row):
        """Exact tier-row shape for recovery: ts an exact int, rev (absent on
        legacy rows) an exact non-negative int, state a dict (content-validated
        against the binding later). Anything else is corruption, not a skippable
        line, so a damaged journal cannot hide a transition the state predates."""
        return (isinstance(row, dict)
                and type(row.get("ts")) is int
                and ("rev" not in row
                     or (type(row["rev"]) is int
                         and row["rev"] >= 0))
                and isinstance(row.get("state"), dict))

    def _check_tier_chain(self, new, st, now=None, windowed=False):
        """Semantic chain over non-legacy journal rows (file order): revs
        consecutive, from/to a legal governor step, snapshot tier matching its row,
        and the journal mirroring the state (max rev == state rev, last to == state
        tier). With now given, no row timestamp or embedded evaluated_at may lie
        beyond the clock-skew allowance, and a snapshot may not postdate its row.
        This proves the rows could only have come from the governor's own
        transition rule: a forged T3->T0 row cannot both continue the chain and
        match the state. Legacy (rev-less) rows are excluded (see the legacy
        recovery path). windowed: the bounded tail scan cut older rows, so the
        first visible revisioned row need not start at Tier 0 (revs, from/to
        continuity and the state mirror are still enforced over the window).
        Raises StateUnavailable on any violation."""
        binding = self._binding()
        cur_rows = [r for r in new
                    if isinstance(r.get("state"), dict)
                    and r["state"].get("binding") == binding]
        rev = st.get("tier_rev", 0)
        for r in new:
            if r["rev"] > rev:
                # state-first persist means the state file leads the journal: a newer row is forgery
                raise StateUnavailable("tier-journal-forged")
            if now is not None:
                if r["ts"] > now + EVAL_FUTURE_SKEW_S:
                    raise StateUnavailable("tier-journal-future")
                sev = r["state"].get("evaluated_at")
                if type(sev) is int and (sev > now +
                                         EVAL_FUTURE_SKEW_S or
                                         sev > r["ts"] +
                                         EVAL_FUTURE_SKEW_S):
                    raise StateUnavailable("tier-journal-future")
        expected = None
        prev_to = None
        first = True
        for r in cur_rows:
            if expected is None:
                # any start: the rev counter survives binding resets, so a post-reset era continues it
                expected = r["rev"]
            if r["rev"] != expected:
                raise StateUnavailable("tier-journal-chain")
            expected += 1
            frm, to = r.get("from"), r.get("to")
            if (type(frm) is not int or type(to) is not int
                    or frm not in (0, 1, 2, 3)
                    or to not in (0, 1, 2, 3) or frm == to
                    or r["state"].get("tier") != to):
                raise StateUnavailable("tier-journal-chain")
            if first:
                # every rev-0 tier is Tier 0 (fresh init and binding resets return there);
                # enforced only when the chain start is visible
                if frm != 0 and not (windowed and r is new[0]):
                    raise StateUnavailable("tier-journal-chain")
                first = False
            elif frm != prev_to:
                raise StateUnavailable("tier-journal-chain")
            prev_to = to
        if cur_rows:
            if cur_rows[-1]["rev"] != rev:
                # tail rows lost (or a crash between state save and journal append): the
                # surviving history cannot mirror the state, so deny rather than resolve to
                # the older tier; recovery is an explicit supervisor re-baseline
                raise StateUnavailable("tier-journal-truncated")
            if cur_rows[-1]["to"] != st.get("tier"):
                raise StateUnavailable("tier-journal-chain")

    def _recover_from_journal(self, st, now=None):
        """Crash recovery: adopt a transition journaled but never saved to the
        state file (possible only for legacy journal-first persists) from the
        journal tail. Strict: a missing journal with transitions on record means
        deleted evidence; a journal whose max rev trails the state's means lost
        tail rows; a structurally invalid row means corruption. Legacy (rev-less)
        rows recover only in an explicitly legacy deployment (state rev 0, no
        revisioned rows anywhere); once revisioned history exists, a rev-less row
        newer than state is forgery and older ones are audit-only. All raise
        StateUnavailable, so a damaged journal never resolves to the older (weaker)
        tier. Returns the recovered state or None."""
        rows, had, windowed = self._journal_rows_raw(
            TIER_JOURNAL_NAME, "tier")
        rev = st.get("tier_rev", 0)
        if not had:
            if rev > 0:
                raise StateUnavailable("tier-journal-deleted")
            return None
        if not rows:
            if rev > 0:
                raise StateUnavailable("tier-journal-deleted")
            return None
        for row in rows:
            if not self._valid_tier_row(row):
                raise StateUnavailable("tier-journal-corrupt")
        has_rev = rev > 0 or any("rev" in r for r in rows)
        if has_rev:
            for r in rows:
                if "rev" not in r and \
                        r["ts"] > st["evaluated_at"]:
                    # the writer always stamps revs: a rev-less row newer than revisioned state
                    # is a forged downgrade path (legacy rows can only be older)
                    raise StateUnavailable(
                        "tier-journal-legacy-forged")
        new = [r for r in rows if "rev" in r]
        if new:
            self._check_tier_chain(new, st, now, windowed)
        if rev > 0:
            have = [r["rev"] for r in rows if "rev" in r]
            if not have or max(have) < rev:
                raise StateUnavailable("tier-journal-truncated")
        best = None
        for row in reversed(rows):  # newest first
            if has_rev and "rev" not in row:
                continue
            snap = row.get("state")
            ts = row.get("ts")
            if (not isinstance(snap, dict) or type(ts) is not int or
                    ts <= st["evaluated_at"]):
                continue
            cand = self._valid_state(snap, self._binding())
            if cand is None or cand["binding"] != self._binding():
                continue
            if now is not None and cand["evaluated_at"] > now + \
                    EVAL_FUTURE_SKEW_S:
                raise StateUnavailable("tier-journal-future")
            if best is None or ts > best["evaluated_at"]:
                best = cand
        return best

    def _save_state_locked(self, st):
        """State-file write; the tier lock must be held."""
        path = self._state_path()
        if path is None:
            return
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        locks.atomic_write_bytes(
            d, os.path.basename(path),
            json.dumps(st, sort_keys=True).encode("utf-8"))

    def _save_state(self, st):
        lock = self._tier_lock_path()
        if lock is None:
            self._save_state_locked(st)
            return
        with locks.FileLock(lock, purpose="tier"):
            self._save_state_locked(st)

    def _journal_locked(self, name, row):
        """Journal append; the tier lock must be held."""
        if not self.state_dir:
            return
        path = os.path.join(self.state_dir, name)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def _journal(self, name, row):
        if not self.state_dir:
            return
        lock = self._tier_lock_path()
        if lock is None:
            self._journal_locked(name, row)
            return
        with locks.FileLock(lock, purpose="tier"):
            self._journal_locked(name, row)

    def _save_state_and_journal_locked(self, st, journal_name,
                                       journal_row):
        """Transition persist with the tier lock held: state first, then the
        journal row. A crash leaves new state without its audit row (audit gap,
        tier-safe) or old state with no new row (consistent old), never a journaled
        transition with stale state on disk."""
        self._save_state_locked(st)
        if journal_row is not None:
            journal_row = dict(journal_row)
            journal_row["state"] = dict(st)
            self._heal_journal_tail_locked(journal_name, "tier")
            self._journal_locked(journal_name, journal_row)

    def _save_state_and_journal(self, st, journal_name, journal_row):
        """Crash-consistent transition persist: state, then journal (carrying the
        full post-transition snapshot for audit and legacy tail recovery), under one
        acquisition of the tier lock so no second evaluator can enter between them."""
        lock = self._tier_lock_path()
        if lock is None:
            self._save_state_and_journal_locked(st, journal_name,
                                                journal_row)
            return
        with locks.FileLock(lock, purpose="tier"):
            self._save_state_and_journal_locked(st, journal_name,
                                                journal_row)

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
        """Hourly tier evaluation with journaled transitions and 6-hour
        anti-flap fallback. Returns (tier, projection). Tier-state failure raises
        StateUnavailable (the caller denies); ledger-unavailable keeps the last tier
        (decision() separately denies on unmeasurable spend). Load, compute and
        persist hold one tier-lock acquisition, so a second evaluator cannot
        overwrite a newer, more restrictive tier. Nested subsystems (spend ledger,
        journals) are always acquired tier-first."""
        now = int(time.time()) if now is None else now
        lock = self._tier_lock_path()
        if lock is None:
            return self._evaluate_once(now, locked=False)
        with locks.FileLock(lock, purpose="tier"):
            return self._evaluate_once(now, locked=True)

    def _evaluate_once(self, now, locked):
        """One evaluation; with locked=True the caller holds the tier lock (see evaluate)."""
        st = self._load_state(now)
        if now - st["evaluated_at"] < TIER_EVAL_S:
            # within the hour the durable reading wins and is always reloaded (see __init__)
            return st["tier"], st["projection"]
        cap = STAGE_CAPS_USD[self.stage]
        try:
            proj = self.projection_30d(now)
        except attribution.LedgerUnavailable:
            return st["tier"], st["projection"]
        # ratio-forced Tier 3 (G2/G3 with a wired profit feed)
        if self._ratio_forces_stop(now, st, locked=locked):
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
            st["tier_rev"] = st.get("tier_rev", 0) + 1
            row = {"ts": now, "from": old_tier, "to": st["tier"],
                   "projection_30d": proj, "cap": cap,
                   "stage": self.stage, "rev": st["tier_rev"]}
            if locked:
                self._save_state_and_journal_locked(
                    st, TIER_JOURNAL_NAME, row)
            else:
                self._save_state_and_journal(
                    st, TIER_JOURNAL_NAME, row)
        elif locked:
            self._save_state_locked(st)
        else:
            self._save_state(st)
        try:
            attribution.prune_spans(self.log_path, now)
        except attribution.LedgerUnavailable:
            pass
        return st["tier"], proj

    # ratio (G2/G3; suspended without a profit feed)
    def ratio_status(self, now=None):
        """(state, detail): ok | failed | suspended. Suspended (no profit feed or
        non-positive trailing profit) is report-only; the absolute cap governs.
        Never raises on missing data. Type-exact numerics: bool/NaN/infinite profit
        or spend cannot pass or poison the ratio."""
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

    def _journal_rows_raw(self, name, tag):
        """Oldest-first parsed rows from a journal tail, strict. Returns (rows,
        had_file, windowed). A missing file yields ([], False, False). windowed is
        True when the bounded tail scan cut the file, so chain checks must not
        demand a visible genesis row. An unreadable file or any malformed line
        raises StateUnavailable(<tag>-journal-unreadable/corrupt), except one
        trailing line without its newline (crash mid-append; every append heals the
        tail first under the same lock). All parsed values are returned (dict or
        not) so callers can reject structurally invalid rows."""
        if not self.state_dir:
            return [], False, False
        path = os.path.join(self.state_dir, name)
        try:
            size = os.path.getsize(path)
        except FileNotFoundError:
            return [], False, False
        except OSError:
            raise StateUnavailable("%s-journal-unreadable" % tag)
        if size == 0:
            return [], True, False
        windowed = False
        try:
            with open(path, "rb") as fh:
                if size > JOURNAL_TAIL_BYTES:
                    windowed = True
                    fh.seek(size - JOURNAL_TAIL_BYTES)
                    fh.readline()  # drop the partial first line
                chunk = fh.read(JOURNAL_TAIL_BYTES + 4096)
        except OSError:
            raise StateUnavailable("%s-journal-unreadable" % tag)
        text = chunk.decode("utf-8", "replace")
        ends_clean = text.endswith("\n")
        parts = text.split("\n")
        rows = []
        last = len(parts) - 1
        for i, line in enumerate(parts):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                if i == last and not ends_clean:
                    continue
                raise StateUnavailable("%s-journal-corrupt" % tag)
        return rows, True, windowed

    def _heal_journal_tail_locked(self, name, tag):
        """Drop a crash-partial trailing line (bytes after the last newline) so
        partials never accumulate; every append heals the tail first, under the
        tier lock. A complete row always ends with a newline. No newline in the
        trailing window means the tail is not a row stream: fail closed."""
        path = os.path.join(self.state_dir, name)
        try:
            with open(path, "rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - 4096))
                tail = fh.read()
        except FileNotFoundError:
            return
        except OSError:
            raise StateUnavailable("%s-journal-unreadable" % tag)
        if tail and not tail.endswith(b"\n"):
            idx = tail.rfind(b"\n")
            if idx < 0:
                raise StateUnavailable("%s-journal-corrupt" % tag)
            cut = size - (len(tail) - (idx + 1))
            try:
                with open(path, "r+b") as fh:
                    fh.truncate(cut)
            except OSError:
                raise StateUnavailable("%s-journal-unreadable" % tag)

    @staticmethod
    def _ratio_digest(day, state, stage, prev):
        """Chain digest for one ratio row: canonical, no floats."""
        import hashlib
        body = json.dumps({"day": day, "state": state,
                           "stage": stage, "prev": prev},
                          sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(body.encode("utf-8")).hexdigest()

    @staticmethod
    def _valid_ratio_row(row):
        """Exact ratio-row schema, two eras: legacy 3-key rows (pre-chain) or
        chained 5-key rows. A syntactically valid but structurally wrong line is
        corruption, not a skippable line, since ratio history controls the Tier-3
        rule. Stage need only be a known stage, not the current one: history
        survives binding resets by design."""
        if not isinstance(row, dict):
            return False
        if set(row) == {"day", "state", "stage"}:
            return (type(row["day"]) is int and row["day"] >= 0
                    and row["state"] in ("ok", "failed",
                                            "suspended")
                    and row["stage"] in STAGE_CAPS_USD)
        if set(row) != {"day", "state", "stage", "prev",
                         "digest"}:
            return False
        return (type(row["day"]) is int and row["day"] >= 0
                and row["state"] in ("ok", "failed", "suspended")
                and row["stage"] in STAGE_CAPS_USD
                and (row["prev"] == RATIO_GENESIS_PREV
                     or _is_sha256_hex(row["prev"]))
                and _is_sha256_hex(row["digest"]))

    def _ratio_rows_strict(self, journaled_day, now=None,
                             anchor=None):
        """Newest-first ratio-journal rows, failing closed on anomalies.
        journaled_day is the last day the tier state proves was journaled (the
        deletion tripwire): a missing/empty journal with journaled_day > 0 means
        deleted evidence; an unreadable journal, an invalid row or a newest row
        older than the tripwire (lost tail rows) means corruption. Days must be
        strictly increasing (the writer appends at most one row per UTC day in
        order), so a duplicate or out-of-order day, which could flip a day's newest
        row without malformed JSON, is edited history. Chained (5-key) rows must
        form one valid digest chain from genesis; legacy (3-key) rows survive only
        for days older than the first chained row. anchor is the tier state's proven
        chain head: when set it must match a chained row's digest, so a silent
        rewrite of decided history (failed -> ok, with or without recomputed
        digests) denies. Rows journaled after the anchor are the crash window
        (append landed, state persist did not): fully schema/order/future-checked
        and adopted by the next evaluation. Any violation raises StateUnavailable,
        so lost ratio history denies rather than resetting the 3-day streak. A
        missing journal with journaled_day == 0 is a fresh path. One trailing line
        without its newline is tolerated (crash mid-append; the next append heals
        it)."""
        rows, had, windowed = self._journal_rows_raw(
            RATIO_JOURNAL_NAME, "ratio")
        if not had:
            if journaled_day > 0:
                raise StateUnavailable("ratio-journal-deleted")
            return []
        if not rows:
            if journaled_day > 0:
                raise StateUnavailable("ratio-journal-deleted")
            return []
        for row in rows:
            if not self._valid_ratio_row(row):
                raise StateUnavailable("ratio-journal-corrupt")
        today = None if now is None else now - (now % 86400)
        prev = -1
        for row in rows:  # file order is append order
            day = row["day"]
            if day <= prev:
                raise StateUnavailable("ratio-journal-order")
            if today is not None and day > today:
                raise StateUnavailable("ratio-journal-order")
            prev = day
        chained = [r for r in rows if "digest" in r]
        if chained:
            first_day = chained[0]["day"]
            for r in rows:
                if "digest" not in r and r["day"] >= first_day:
                    raise StateUnavailable("ratio-journal-forged")
            # a cut tail whose first visible row is chained starts mid-chain: link from
            # that row's own prev. Otherwise (whole file visible, or legacy rows precede
            # the chain) the chain must start at genesis. The forward digests pin
            # everything from there to the anchor.
            expect = chained[0]["prev"] if (
                windowed and rows[0] is chained[0]) else \
                RATIO_GENESIS_PREV
            for r in chained:
                if r["prev"] != expect or r["digest"] != \
                        self._ratio_digest(r["day"], r["state"],
                                         r["stage"], r["prev"]):
                    raise StateUnavailable("ratio-journal-forged")
                expect = r["digest"]
        digests = [r["digest"] for r in chained]
        if anchor is not None:
            if anchor not in digests:
                # rewritten history: the proven head matches no chained row (a legacy-only
                # journal with an anchor is a format downgrade)
                raise StateUnavailable("ratio-anchor-unknown")
            at = digests.index(anchor)
            if chained[at]["day"] != journaled_day:
                # the writer sets day and head together: a head proving a different day
                # than the tripwire is an impossible (edited) state
                raise StateUnavailable("ratio-anchor-mismatch")
            if len(chained) - 1 - at > 1:
                # only one row can sit beyond the proven head (append landed, state persist
                # did not): every append first adopts and persists it, so more is fabricated
                raise StateUnavailable("ratio-journal-unadopted")
        elif len(chained) > 1:
            # a chain with no proven head in state: only the first chained append's crash window is legitimate
            raise StateUnavailable("ratio-anchor-missing")
        rows.reverse()  # newest first (single-writer append order)
        if journaled_day > 0:
            newest = rows[0]["day"]
            if newest < journaled_day:
                # tail rows were lost (truncation/restore): the history cannot prove the streak
                raise StateUnavailable("ratio-journal-truncated")
        return rows

    def _ratio_day_state(self, day, journaled_day=0, now=None,
                           anchor=None):
        """Recorded ratio state for one UTC day (newest row wins), or None when
        the day was never evaluated (suspended days never journal and never count
        as failed). journaled_day is the deletion tripwire (see _ratio_rows_strict);
        anchor is the proven chain head."""
        for row in self._ratio_rows_strict(journaled_day, now,
                                           anchor):
            if (type(row.get("day")) is int and row["day"] == day
                    and row.get("state") in ("ok", "failed",
                                               "suspended")):
                return row["state"]
        return None

    def _ratio_forces_stop(self, now, st=None, locked=False):
        """st is the caller's loaded tier state (see evaluate): its ratio_day is
        the journal-deletion tripwire and is advanced here whenever a row is
        journaled. locked=True means the caller holds the tier lock, making the
        tail heal, the per-day check+append and the strict streak read one critical
        section, so two evaluators cannot double-count a UTC day."""
        state, _detail = self.ratio_status(now)
        day = now - (now % 86400)
        if state == "suspended":
            return False
        if not self.state_dir:
            # no durable journal: consecutive-day counting is impossible, so the ratio
            # cannot force a stop (the absolute cap still governs; production governors
            # always carry state_dir, enforced at graph build)
            return False
        journaled_day = st["ratio_day"] if st is not None else 0
        anchor = st.get("ratio_head") if st is not None else None
        # At most one counted evaluation per UTC day: repeated hourly failures on a
        # day are one failed day. The record block runs unconditionally under the
        # tier lock. Crash window (journal append landed, state persist did not):
        # the newest validated row is adopted (day and chain head, no duplicate)
        # and persisted before any new append, so at most one unadopted row exists
        # (the reader refuses more) and a restart on a later day still links to the
        # true chain tail.
        def _record():
            rows = self._ratio_rows_strict(journaled_day, now, anchor)
            if st is not None and rows and \
                    rows[0]["day"] > st["ratio_day"]:
                st["ratio_day"] = rows[0]["day"]
                if "digest" in rows[0]:
                    st["ratio_head"] = rows[0]["digest"]
                self._save_state_locked(st)
            if not any(r["day"] == day for r in rows):
                self._heal_journal_tail_locked(RATIO_JOURNAL_NAME,
                                               "ratio")
                # link to the validated chain tail, not the possibly-stale state anchor
                tail = next((r["digest"] for r in rows
                             if "digest" in r), None)
                prev = tail if tail is not None else \
                    RATIO_GENESIS_PREV
                digest = self._ratio_digest(day, state,
                                            self.stage, prev)
                self._journal_locked(RATIO_JOURNAL_NAME,
                                     {"day": day, "state": state,
                                      "stage": self.stage,
                                      "prev": prev,
                                      "digest": digest})
                if st is not None:
                    st["ratio_day"] = day
                    st["ratio_head"] = digest
        if locked:
            # outer tier lock already held (see evaluate)
            _record()
        else:
            lock = self._tier_lock_path()
            with locks.FileLock(lock, purpose="tier"):
                _record()
        # distinct consecutive failed days ending today; an ok, missing or
        # suspended day breaks the streak. One strict read after the record (the
        # tripwire and head follow a just-journaled advance above).
        trip = st["ratio_day"] if st is not None else journaled_day
        head = st.get("ratio_head") if st is not None else anchor
        by_day = {r["day"]: r["state"]
                  for r in self._ratio_rows_strict(trip, now, head)}
        streak = 0
        d = day
        while streak < RATIO_FAIL_DAYS:
            if by_day.get(d) != "failed":
                break
            streak += 1
            d -= 86400
        return streak >= RATIO_FAIL_DAYS

    # node gating
    def tier(self, now=None):
        return self.evaluate(now)[0]

    def verdict_snapshot(self, now=None):
        """Coherent (verdict, tier, reason) from one durable pass: the
        unknowns/measurability checks plus a single tier evaluation. The graph
        uses this triple as the authority for one node decision and never composes
        decision() and tier() reads from different instants (a concurrent evaluator
        can raise the durable tier between them, producing e.g. (allow, 3) and
        skipping the Tier-3 research stop). Deny-dominant: unknowns, unmeasurable
        spend and unverifiable tier state all deny with the most restrictive tier.
        The snapshot is the node's plan, not the provider authorization:
        reserve_research_call re-reads the durable tier atomically with the dollar
        hold (and re-refuses on pending unknowns), so a raise after this snapshot
        never reaches a provider."""
        try:
            if attribution.has_unreconciled(self.log_path):
                pending = True
            else:
                pending = False
        except attribution.LedgerUnavailable:
            # genuinely new path: no unknowns possible. A deleted authority raises here
            # too and must deny; distinguish via freshness (as for measurement).
            try:
                fresh = self._fresh()
            except attribution.LedgerUnavailable:
                return "deny", 3, "spend-unmeasurable"
            if not fresh:
                return "deny", 3, "spend-unmeasurable"
            pending = False
        try:
            tier = self.evaluate(now)[0]
        except attribution.LedgerUnavailable:
            return "deny", 3, "spend-unmeasurable"
        except StateUnavailable:
            return "deny", 3, "tier-state-unavailable"
        if pending:
            return "deny", tier, "unknown-spend-pending"
        return TIERS[tier]["verdict"], tier, "tier-%d" % tier

    def decision(self, now=None):
        """(verdict, reason). Outstanding unknown spend, unmeasurable spend and
        unverifiable tier state all deny."""
        verdict, _tier, reason = self.verdict_snapshot(now)
        return verdict, reason

    def check_research_tier(self, entry_tier):
        """Early refusal of a Tier-3 snapshot before any R15 reservation (clean
        SpendRefused, provider untouched). Pre-filter only: the authority is the
        durable tier re-read inside reserve_research_call, atomically with the
        dollar hold, which also refuses stale snapshots and callers without one
        (entry_tier None). A non-int (bool included) or unknown tier is a malformed
        plan and is refused."""
        if entry_tier is not None and (type(entry_tier) is not int
                                       or entry_tier not in TIERS):
            raise SpendRefused("bad-entry-tier:%r" % (entry_tier,))
        if entry_tier is not None and entry_tier >= 3:
            raise SpendRefused("research-llm-stopped:tier-3")

    def thesis_cap(self, now=None):
        t = self.tier(now)
        return TIERS[t]["thesis_cap"]

    # pre-call absolute hold
    def reserve_usd(self, amount_usd, lease_id, now=None):
        """Hold worst-case dollars pre-call in one atomic ledger transaction
        (reap, block-check, measure, compare, insert). Raises SpendRefused when the
        cap would cross, unknowns are pending or spend is unmeasurable; the provider
        was not touched. This is the only authorization path."""
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

    def reserve_research_call(self, amount_usd, lease_id,
                              entry_tier=None, now=None):
        """Research-call admission (run_gated's only dollar path): durable tier
        check + worst-case hold in one tier-lock critical section. The graph's
        snapshot tier is only a plan (model choice, prose cap, watchlist); the
        authority is the durable tier read here under the lock every tier writer
        holds. A Tier-3 persist therefore either precedes this admission (refused,
        provider untouched) or follows the hold insert (admitted before the stop,
        in flight). A durable tier above the snapshot also refuses: the call was
        planned for a weaker tier (e.g. a non-cheapest model under Tier 2).
        Unverifiable tier state or unmeasurable spend refuses. Lock order is
        tier-first, ledger-second, as in evaluate()."""
        eval_now = int(time.time()) if now is None else int(now)

        def _admit():
            try:
                tier = self._evaluate_once(eval_now, locked=lock
                                           is not None)[0]
            except StateUnavailable as e:
                raise SpendRefused("tier-state-unavailable:%s" % e)
            except attribution.LedgerUnavailable as e:
                raise SpendRefused("spend-unmeasurable:%s" % e)
            if tier >= 3:
                raise SpendRefused("research-llm-stopped:tier-3")
            if entry_tier is not None and tier > entry_tier:
                raise SpendRefused("tier-raised-since-snapshot:%d>%d"
                                   % (tier, entry_tier))
            self.reserve_usd(amount_usd, lease_id, now)

        lock = self._tier_lock_path()
        if lock is None:
            _admit()
            return
        with locks.FileLock(lock, purpose="tier"):
            _admit()

    def mark_invoked(self, lease_id):
        try:
            attribution.mark_invoked(self.log_path, lease_id)
        except attribution.LedgerUnavailable as e:
            raise SpendRefused("spend-unmeasurable:%s" % e)

    def settle_usd(self, lease_id):
        """Release a cleanly accounted hold (the span carries actuals). A ledger
        failure propagates: a success-path settlement that did not land is an
        incomplete protocol, so the caller aborts with the hold retained (still
        blocking). A missing hold is a no-op (already settled or pre-hold failure)."""
        attribution.settle_hold(self.log_path, lease_id)
