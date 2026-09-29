"""Writer for candidates.jsonl: the c1 wire record the kernel gate reads.

Every CID-recipe field is emitted as the exact string the CID was hashed
over, prices at two decimals, so the kernel recomputes the same digest."""
import json

from research.strategy.candidate import _ID_FIELDS, candidate_id

SCHEMA = "c1"


class WireError(ValueError):
    pass


def _px(x):
    if not isinstance(x, (int, float)) or isinstance(x, bool) or not x > 0:
        raise WireError("price")
    return "%.2f" % x


def wire_record(sleeve, symbol, snapshot_ts_ns, entry, stop, tp,
                time_exit_ns=0, side="BUY", family="trend",
                exit_profile="exit_trend_v1", cost_model="cost_v2",
                feature_revision="f1", created_ns=None):
    if side != "BUY":
        raise WireError("only BUY entries are written")
    e, s, t = _px(entry), _px(stop), _px(tp)
    if not float(s) < float(e) < float(t):
        raise WireError("stop < entry < tp required")
    if snapshot_ts_ns < 0 or time_exit_ns < 0:
        raise WireError("timestamps")
    f = {"strategy_version": sleeve, "symbol": symbol,
         "snapshot_ts_ns": str(int(snapshot_ts_ns)), "proposed_side": side,
         "proposed_family": family, "entry_px": e, "stop_px": s, "tp_px": t,
         "time_exit_ns": str(int(time_exit_ns)),
         "exit_profile_version": exit_profile,
         "cost_model_version": cost_model, "feature_revision": feature_revision}
    if any("|" in v for v in f.values()):
        raise WireError("separator in field")
    cand = dict(f, cid=candidate_id(**{k: f[k] for k in _ID_FIELDS}))
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
