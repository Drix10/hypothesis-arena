"""K7 outbound-only alert relay (doc 06 s6.4). Stdlib only.

Tails the kernel's alerts.jsonl and POSTs redacted one-line messages to an
HTTPS webhook (ALERT_WEBHOOK_URL). There is NO listener, no inbound path,
no command parsing: the relay only reads a local file and makes outbound
requests. Delivery is at-least-once (the byte offset advances only after a
successful send); malformed lines are counted and skipped, never fatal;
truncation/rotation resets the offset. Secrets are redacted defensively
because kernel `detail` text is free-form.
"""
import json
import os
import re
import urllib.request

LEVELS = {"INFO": 0, "WARN": 1, "SOFT": 1, "MEDIUM": 2, "HARD": 3}
MAX_MSG = 300
MAX_PER_RUN = 20
_TOKEN = re.compile(r"[A-Za-z0-9_\-+/=]{24,}")
_BEARER = re.compile(r"(?i)bearer\s+\S+")
_URLCRED = re.compile(r"(?i)https?://[^\s/@]*:[^\s/@]*@")
_KEYNAME = re.compile(r"(?i)(APCA[-_A-Z]*|key|secret|token|password|passwd)\s*[=:]\s*\S+")


class RelayError(Exception):
    pass


def redact(text):
    t = _URLCRED.sub("[redacted-url]", str(text))
    t = _BEARER.sub("[redacted]", t)
    t = _KEYNAME.sub("[redacted]", t)
    t = _TOKEN.sub("[redacted]", t)
    t = "".join(ch if ch.isprintable() else " " for ch in t)
    return t[:MAX_MSG]


def format_alert(row):
    """Row dict -> message, or None if the row is malformed."""
    if not isinstance(row, dict):
        return None
    ts, lv, code = row.get("ts_ns"), row.get("level"), row.get("code")
    if isinstance(ts, bool) or not isinstance(ts, int) or ts <= 0:
        return None
    if lv not in LEVELS or not isinstance(code, str) or not code:
        return None
    detail = row.get("detail", "")
    if not isinstance(detail, str):
        return None
    return redact(f"[{lv}] {code}: {detail}")


def _load_offset(state_path):
    try:
        with open(state_path) as f:
            v = json.load(f)
        o = v["offset"]
        if isinstance(o, int) and o >= 0:
            return o
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return 0


def _save_offset(state_path, offset):
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"offset": offset}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_path)


def run_once(alerts_path, state_path, send, min_level="WARN"):
    """One pass. Returns dict(sent, skipped, malformed, failed)."""
    floor = LEVELS[min_level]
    out = {"sent": 0, "skipped": 0, "malformed": 0, "failed": False}
    try:
        size = os.path.getsize(alerts_path)
    except OSError:
        return out
    off = _load_offset(state_path)
    if off > size:
        off = 0  # truncated or rotated
    with open(alerts_path, "rb") as f:
        f.seek(off)
        data = f.read()
    pos = 0
    while True:
        nl = data.find(b"\n", pos)
        if nl < 0:
            break  # partial last line stays unconsumed
        line, nxt = data[pos:nl], nl + 1
        msg = None
        try:
            row = json.loads(line.decode("utf-8"))
            msg = format_alert(row)
            lvl = LEVELS.get(row.get("level"), -1) if msg else -1
        except (ValueError, UnicodeDecodeError):
            msg = None
        if msg is None:
            out["malformed"] += 1
        elif lvl < floor:
            out["skipped"] += 1
        elif out["sent"] >= MAX_PER_RUN:
            break  # rest is delivered next pass; never dropped silently
        else:
            try:
                send(msg)
            except Exception:
                out["failed"] = True
                break
            out["sent"] += 1
        pos = nxt
        off_new = off + pos
        _save_offset(state_path, off_new)
    return out


def webhook_sender(url, timeout=10):
    if not url.startswith("https://"):
        raise RelayError("webhook-must-be-https")

    def send(msg):
        req = urllib.request.Request(
            url, data=json.dumps({"text": msg}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if not 200 <= r.status < 300:
                raise RelayError("http-%d" % r.status)
    return send


def main(argv=None):
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not url:
        raise SystemExit("alert relay: ALERT_WEBHOOK_URL not set")
    a = (argv or os.sys.argv)[1:]
    if len(a) != 2:
        raise SystemExit("usage: alert_relay.py ALERTS_JSONL STATE_JSON")
    r = run_once(a[0], a[1], webhook_sender(url))
    print(json.dumps(r))
    return 1 if r["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
