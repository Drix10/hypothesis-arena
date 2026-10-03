"""Writer for candidates.jsonl: the candidate record the kernel gate reads.

Every identity field is emitted as the exact string the id was hashed over,
prices at two decimals, so the kernel recomputes the same digest."""
import hashlib
import json

SCHEMA = "candidate"  # the kernel gate rejects any other schema

# Identity recipe: pipe-joined, in this exact order. The kernel recomputes it
# field for field.
ID_FIELDS = ("strategy_id", "symbol", "snapshot_ts_ns", "side", "entry_px",
             "stop_px", "tp_px", "time_exit_ns", "exit_rule", "cost_model",
             "feature_revision")


class WireError(ValueError):
    pass


def candidate_id(**kw) -> str:
    parts = [str(kw[f]) for f in ID_FIELDS]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _px(x):
    if not isinstance(x, (int, float)) or isinstance(x, bool) or not x > 0:
        raise WireError("price")
    return "%.2f" % x


def wire_record(strategy, symbol, snapshot_ts_ns, entry, stop, tp,
                time_exit_ns=0, side="BUY", exit_rule="exit_trend",
                cost_model="costs", feature_revision="1", created_ns=None):
    if side not in ("BUY", "SELL"):
        raise WireError("side")
    e, s, t = _px(entry), _px(stop), _px(tp)
    fe, fs, ft = float(e), float(s), float(t)
    if side == "BUY" and not fs < fe < ft:
        raise WireError("BUY needs stop < entry < tp")
    if side == "SELL" and not ft < fe < fs:
        raise WireError("SELL needs tp < entry < stop")
    if snapshot_ts_ns < 0 or time_exit_ns < 0:
        raise WireError("timestamps")
    f = {"strategy_id": strategy, "symbol": symbol,
         "snapshot_ts_ns": str(int(snapshot_ts_ns)), "side": side,
         "entry_px": e, "stop_px": s, "tp_px": t,
         "time_exit_ns": str(int(time_exit_ns)), "exit_rule": exit_rule,
         "cost_model": cost_model, "feature_revision": feature_revision}
    if any("|" in v for v in f.values()):
        raise WireError("separator in field")
    cand = dict(f, cid=candidate_id(**{k: f[k] for k in ID_FIELDS}))
    created = snapshot_ts_ns if created_ns is None else created_ns
    return {"schema": SCHEMA, "created_ns": str(int(created)),
            "candidate": cand}


def wire_line(*a, **kw):
    return json.dumps(wire_record(*a, **kw), sort_keys=True,
                      separators=(",", ":")) + "\n"


def atr_stop(highs, lows, closes, mult=3.0, n=20):
    """Stop = last close - mult x ATR(n) from daily bars (oldest first)."""
    if len(closes) < n + 1:
        raise WireError("history")
    tr = [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]),
              abs(lows[i] - closes[i - 1])) for i in range(-n, 0)]
    stop = closes[-1] - mult * sum(tr) / n
    if not stop > 0:
        raise WireError("stop")
    return stop
