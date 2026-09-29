"""Outbound-only relay: tails the kernel's alerts.jsonl and POSTs redacted
one-line messages to an HTTPS webhook (ALERT_WEBHOOK_URL). It listens on
nothing and reads nothing but the local file. Delivery is at-least-once: the
saved offset advances only after a successful send."""
import hashlib
import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

RANK = {"INFO": 0, "WARN": 1, "SOFT": 1, "MEDIUM": 2, "HARD": 3}
UNKNOWN_RANK = 2
LEVEL_RE = re.compile(r"^[A-Z0-9_]{1,15}$")
MAX_MSG = 300
MAX_PER_RUN = 20
MAX_READ = 1 << 20
HEAD = 64

_KEYED = re.compile(
    r"""(?ix)\b[\w-]*(?:key|secret|token|passw(?:or)?d|credential|
        authorization)[\w-]*\s*[=:]\s*(?:"[^"]*"|'[^']*'|(?:basic|bearer)\s+\S+|\S+)""")
_BEARER = re.compile(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+")
_JWT = re.compile(r"eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*")
_PREFIXED = re.compile(
    r"\b(?:PK|AK)[A-Z0-9]{16,}\b|\bsk-[\w-]{8,}|\bgh[pousr]_\w{20,}"
    r"|\bxox[baprs]-[\w-]+")
_URLCRED = re.compile(r"(?i)https?://[^\s/@]*:[^\s/@]*@")
_LONG = re.compile(r"[A-Za-z0-9_\-+/=]{24,}")


class RelayError(Exception):
    pass


def redact(text):
    t = str(text)
    for rx, sub in ((_URLCRED, "[redacted-url]"), (_KEYED, "[redacted]"),
                    (_JWT, "[redacted]"), (_BEARER, "[redacted]"),
                    (_PREFIXED, "[redacted]"), (_LONG, "[redacted]")):
        t = rx.sub(sub, t)
    return "".join(c if c.isprintable() else " " for c in t)[:MAX_MSG]


def parse_alert(row):
    """Returns (rank, message), or None for a malformed row."""
    if not isinstance(row, dict):
        return None
    ts, lv, code, detail = (row.get(k) for k in
                            ("ts_ns", "level", "code", "detail"))
    if isinstance(ts, bool) or not isinstance(ts, int) or ts <= 0:
        return None
    if not isinstance(lv, str) or not LEVEL_RE.match(lv):
        return None
    if not isinstance(code, str) or not code or not isinstance(detail, str):
        return None
    return RANK.get(lv, UNKNOWN_RANK), redact(f"[{lv}] {code}: {detail}")


def _head_digest(path, n):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read(n)).hexdigest()


def _load_offset(state_path, alerts_path, size):
    try:
        with open(state_path) as f:
            st = json.load(f)
        off, head = st["offset"], st["head"]
        if isinstance(off, int) and 0 < off <= size and isinstance(head, str) \
                and _head_digest(alerts_path, min(off, HEAD)) == head:
            return off
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return 0  # first run, truncation or rotation


def _save_offset(state_path, alerts_path, offset):
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"offset": offset,
                   "head": _head_digest(alerts_path, min(offset, HEAD))}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_path)


def run_once(alerts_path, state_path, send, min_level="WARN"):
    floor = RANK[min_level]
    out = {"sent": 0, "skipped": 0, "malformed": 0, "failed": False}
    try:
        size = os.path.getsize(alerts_path)
    except OSError:
        return out
    off = _load_offset(state_path, alerts_path, size)
    with open(alerts_path, "rb") as f:
        f.seek(off)
        data = f.read(MAX_READ)
    pos = 0
    while pos < len(data):
        nl = data.find(b"\n", pos)
        if nl < 0:
            if len(data) - pos < MAX_READ:
                break  # partial line: wait for the rest
            nl = len(data) - 1  # oversized line: drop this chunk
            line, parsed = b"", None
        else:
            line = data[pos:nl]
            try:
                parsed = parse_alert(json.loads(line.decode("utf-8")))
            except ValueError:
                parsed = None
        if parsed is None:
            out["malformed"] += 1
        elif parsed[0] < floor:
            out["skipped"] += 1
        elif out["sent"] >= MAX_PER_RUN:
            break
        else:
            try:
                send(parsed[1])
            except Exception:
                out["failed"] = True
                break
            out["sent"] += 1
        pos = nl + 1
        _save_offset(state_path, alerts_path, off + pos)
    return out


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _check_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or not u.hostname:
        raise RelayError("webhook-must-be-https")
    if u.hostname.lower() == "localhost":
        raise RelayError("webhook-host-not-public")
    try:
        ip = ipaddress.ip_address(u.hostname)
    except ValueError:
        return
    if not ip.is_global:
        raise RelayError("webhook-host-not-public")


def webhook_sender(url, timeout=10):
    _check_url(url)
    opener = urllib.request.build_opener(_NoRedirect)

    def send(msg):
        req = urllib.request.Request(
            url, data=json.dumps({"text": msg}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with opener.open(req, timeout=timeout) as r:
            if not 200 <= r.status < 300:
                raise RelayError("http-%d" % r.status)
    return send


def main(argv):
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not url:
        raise SystemExit("ALERT_WEBHOOK_URL not set")
    if len(argv) != 3:
        raise SystemExit("usage: alert_relay.py ALERTS_JSONL STATE_JSON")
    r = run_once(argv[1], argv[2], webhook_sender(url))
    print(json.dumps(r))
    return 1 if r["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
