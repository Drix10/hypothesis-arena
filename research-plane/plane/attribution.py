"""D9 spend/token attribution log (doc 08 sec. 8.2 + doc 10 sec. 10.4).

Every model call appends one span row (JSONL, fsynced): epoch, node,
model_id, call counts, token usage, dollar cost. The daily projection
(spend_30d = day_spend x 30) derives from durable rows only — never
from in-memory counters. A self-hosted Langfuse sink can tail this file;
the file itself is the load-bearing record.
"""
import json
import os
import time


def append_span(log_path, epoch, node, model_id, calls=1, tokens=0,
                dollars=0.0):
    row = {"ts": int(time.time()), "research_epoch": epoch, "node": node,
           "model_id": model_id, "calls": calls, "tokens": tokens,
           "dollars": dollars}
    d = os.path.dirname(os.path.abspath(log_path))
    os.makedirs(d, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return row


def day_summary(log_path, day_ts=None):
    """Aggregate spans for the UTC day containing day_ts (default now).

    Returns {calls, tokens, dollars, by_node, by_model, spend_30d}.
    """
    if day_ts is None:
        day_ts = int(time.time())
    day = day_ts - (day_ts % 86400)
    out = {"calls": 0, "tokens": 0, "dollars": 0.0, "by_node": {},
           "by_model": {}, "spend_30d": 0.0}
    try:
        fh = open(log_path, encoding="utf-8")
    except OSError:
        return out
    with fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not (day <= r.get("ts", 0) < day + 86400):
                continue
            out["calls"] += r.get("calls", 0)
            out["tokens"] += r.get("tokens", 0)
            out["dollars"] += r.get("dollars", 0.0)
            n = r.get("node", "?")
            out["by_node"][n] = out["by_node"].get(n, 0) + r.get("calls", 0)
            m = r.get("model_id", "?")
            out["by_model"][m] = out["by_model"].get(m, 0.0) + \
                r.get("dollars", 0.0)
    out["spend_30d"] = out["dollars"] * 30
    return out
