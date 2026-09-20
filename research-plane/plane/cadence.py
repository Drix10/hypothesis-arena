"""D10 cadence + cost gating (doc 08 sec. 8.3a, stdlib only).

- harvest/extract/fuse run every 5-min cycle (pure I/O + code, ~free).
- hypothesize/critique re-run per symbol only when (a) a new
  TRIGGER-eligible feature landed since the last thesis, or (b) the
  thesis is older than the 30-min staleness TTL.
- Tier-1 throttle (doc 10 §10.4 "research cycle interval doubled"):
  TTL 30 -> 60 min, harvest cadence 5 -> 10 min. Parameter change only.
- Steady-state estimate recorder: compares measured LLM-call rate vs the
  §8.3a estimate (20/hour for 5 quiet symbols) for the D10 proof. The
  graph feeds record_cycle() with the per-cycle budget totals in the
  emit node (durable attribution rows are the audit source; the counter
  here is the cheap estimate input).

Freshness rule (frozen): ONLY a successful thesis run advances
last_thesis_epoch. AbortCycle/ConfigBlocked attempts never reset
freshness — a failed plane must look stale, not fresh.

Persistence: unique temp + file fsync + POSIX dir fsync + writer
serialization under the inter-process lock (same atomic-file pattern
as the bundle writer). Load is size-capped and shape-validated BEFORE
use: oversized/corrupt state = start empty (fail-safe: extra refresh
is bounded by R15).
"""
import os

from . import locks

HARVEST_MIN = 5
THESIS_TTL_MIN = 30
THROTTLED_HARVEST_MIN = 10
THROTTLED_THESIS_TTL_MIN = 60
# §8.3a steady-state floor: 5 symbols x 2 refreshes/h x 2 calls.
ESTIMATE_BASE_CALLS_PER_H = 20

STATE_MAX_BYTES = 65536
STATE_MAX_SYMBOLS = 256
STATE_MAX_EPOCH = 2 ** 31 - 1


class CadenceState:
    def __init__(self, throttled=False, persist_path=None):
        self.throttled = throttled
        self.persist_path = persist_path
        self.last_thesis_epoch = {}  # symbol -> epoch of last SUCCESS
        self.epoch_min = HARVEST_MIN
        self.llm_calls = 0
        self.cycle_count = 0
        if persist_path:
            self._load()

    def _load(self):
        try:
            data = locks.load_json_bounded(self.persist_path,
                                           max_bytes=STATE_MAX_BYTES)
        except (OSError, ValueError):
            return  # corrupt/missing/oversized = start empty (fail-safe)
        if not isinstance(data, dict) or len(data) > STATE_MAX_SYMBOLS:
            return
        clean = {}
        for k, v in data.items():
            if (isinstance(k, str) and 0 < len(k) <= 64 and
                    type(v) is int and 0 <= v <= STATE_MAX_EPOCH):
                clean[k] = v
            else:
                return  # one bad entry poisons the file: start empty
        self.last_thesis_epoch = clean

    def _save(self):
        if not self.persist_path:
            return
        d = os.path.dirname(os.path.abspath(self.persist_path))
        os.makedirs(d, exist_ok=True)
        import json
        with locks.FileLock(self.persist_path + ".lock"):
            # Merge under the SAME lock (read-modify-write): concurrent
            # writers converge instead of clobbering each other.
            try:
                current = locks.load_json_bounded(
                    self.persist_path, max_bytes=STATE_MAX_BYTES)
            except (OSError, ValueError):
                current = {}
            if not isinstance(current, dict):
                current = {}
            for k, v in self.last_thesis_epoch.items():
                if (isinstance(k, str) and 0 < len(k) <= 64 and
                        type(v) is int and 0 <= v <= STATE_MAX_EPOCH and
                        len(current) < STATE_MAX_SYMBOLS):
                    current[k] = v
            raw = json.dumps(current, sort_keys=True).encode("utf-8")
            locks.atomic_write_bytes(
                d, os.path.basename(self.persist_path), raw)

    @property
    def thesis_ttl_epochs(self):
        ttl = (THROTTLED_THESIS_TTL_MIN if self.throttled
               else THESIS_TTL_MIN)
        cad = (THROTTLED_HARVEST_MIN if self.throttled else HARVEST_MIN)
        return max(1, ttl // cad)

    def should_refresh(self, symbol, epoch, trigger_symbols):
        if symbol in set(trigger_symbols or ()):
            return True
        last = self.last_thesis_epoch.get(symbol)
        if last is None:
            return True
        return (epoch - last) >= self.thesis_ttl_epochs

    def mark_run(self, epoch, symbols):
        """Record SUCCESSFUL thesis runs only. Callers must filter to
        symbols whose thesis actually completed; failures never land
        here. Raises OSError on persist failure (the graph records it
        as blocked evidence instead of crashing the cycle)."""
        for s in symbols:
            self.last_thesis_epoch[s] = epoch
        self._save()

    def record_cycle(self, llm_calls):
        self.llm_calls += llm_calls
        self.cycle_count += 1

    def measured_per_hour(self):
        if not self.cycle_count:
            return 0.0
        per_cycle = self.llm_calls / self.cycle_count
        cad = (THROTTLED_HARVEST_MIN if self.throttled else HARVEST_MIN)
        return per_cycle * (60.0 / cad)

    def within_estimate(self, factor=2.0):
        return (self.measured_per_hour() <=
                ESTIMATE_BASE_CALLS_PER_H * factor)
