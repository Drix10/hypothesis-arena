"""D10 cadence + cost gating (doc 08 sec. 8.3a, stdlib only).

- harvest/extract/fuse run every 5-min cycle (pure I/O + code, ~free).
- hypothesize/critique re-run per symbol only when (a) a new
  TRIGGER-eligible feature landed since the last thesis, or (b) the
  thesis is older than the 30-min staleness TTL.
- Tier-1 throttle (doc 10 §10.4 "research cycle interval doubled"):
  TTL 30 -> 60 min, harvest cadence 5 -> 10 min. Parameter change only.
- Steady-state estimate recorder: compares measured LLM-call rate vs the
  §8.3a estimate (20/hour for 5 quiet symbols) for the D10 proof.
"""
HARVEST_MIN = 5
THESIS_TTL_MIN = 30
THROTTLED_HARVEST_MIN = 10
THROTTLED_THESIS_TTL_MIN = 60
# §8.3a steady-state floor: 5 symbols x 2 refreshes/h x 2 calls.
ESTIMATE_BASE_CALLS_PER_H = 20


class CadenceState:
    def __init__(self, throttled=False):
        self.throttled = throttled
        self.last_thesis_epoch = {}  # symbol -> epoch of last thesis run
        self.epoch_min = HARVEST_MIN
        self.llm_calls = 0
        self.cycle_count = 0

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
        for s in symbols:
            self.last_thesis_epoch[s] = epoch

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
