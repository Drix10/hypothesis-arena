"""Candidate contract c1 (frozen schema identity; see plan/12 + manifest).

A Candidate is fully specified BEFORE JEV ever sees it. Identity is
deterministic: sha256 over the frozen field recipe. No JEV output, no
randomness, no post-creation mutation (frozen dataclass).
"""
import hashlib
from dataclasses import dataclass, field

CANDIDATE_SCHEMA_VERSION = "c1"

# Frozen identity recipe (pipe-joined, exact field order). Do not reword:
# kernel-side bindings (JEV decision_key) recompute field-for-field.
_ID_FIELDS = ("strategy_version", "symbol", "snapshot_ts_ns", "proposed_side",
              "proposed_family", "entry_px", "stop_px", "tp_px",
              "time_exit_ns", "exit_profile_version", "cost_model_version",
              "feature_revision")


def candidate_id(**kw) -> str:
    parts = []
    for f in _ID_FIELDS:
        v = kw[f]
        parts.append(str(v))
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Candidate:
    strategy_version: str   # e.g. "baseline_v1"
    symbol: str
    snapshot_ts_ns: int
    proposed_side: str      # "BUY" | "SELL" — originated by the generator, never JEV
    proposed_family: str    # "mean_reversion" | "momentum" (v1 has no macro/event entries)
    entry_px: float
    stop_px: float
    tp_px: float
    time_exit_ns: int
    exit_profile_version: str  # "exit_profile_v1"
    cost_model_version: str    # "paper_fill_v1"
    expected_cost_bps: float
    feature_snapshot_hash: str
    feature_revision: str
    cid: str = field(default="", init=False)  # always derived; unforgable

    def __post_init__(self):
        if self.proposed_side not in ("BUY", "SELL"):
            raise ValueError("side must be BUY/SELL")
        if self.stop_px <= 0 or self.entry_px <= 0 or self.tp_px <= 0:
            raise ValueError("non-positive economics")
        if self.proposed_side == "BUY" and not (self.stop_px < self.entry_px < self.tp_px):
            raise ValueError("BUY must satisfy stop<entry<tp")
        if self.proposed_side == "SELL" and not (self.tp_px < self.entry_px < self.stop_px):
            raise ValueError("SELL must satisfy tp<entry<stop")
        object.__setattr__(
            self, "cid",
            candidate_id(**{f: getattr(self, f) for f in _ID_FIELDS}))


def make_candidate(**kw) -> Candidate:
    # cid is derived in __post_init__; the factory only forwards fields.
    kw.pop("cid", None)
    return Candidate(**kw)
