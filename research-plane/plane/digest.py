"""Durable research-digest writer (doc 08 topology, stdlib only).

hypothesize writes a ≤500-character thesis and critique writes its
advisory metadata into research_digest.jsonl — a durable research
artifact SEPARATE from features.jsonl (prose never enters the trading
boundary; the digest stays in the research plane for audit/debug).

- Append-only JSONL under the inter-process lock; idempotency key =
  (research_epoch, symbol, node): a retried node converges to one row.
- Over-limit thesis text is REJECTED (digest-too-long), never silently
  truncated: the frozen topology says hypothesize writes ≤500 chars,
  so a longer thesis is a producer defect to count, not to rewrite.
- Rows carry disagreement + evidence=prose markers so no consumer can
  mistake digest text for evidence (defense in depth alongside the
  ctx prose-key scan).
"""
import json
import os

from . import locks

DIGEST_NAME = "research_digest.jsonl"
THESIS_MAX_CHARS = 500
CRITIQUE_MAX_CHARS = 2000
NODES = ("hypothesize", "critique")


def _digest_path(outdir):
    return os.path.join(outdir, DIGEST_NAME)


# Per-process seen-key cache: (size, mtime_ns, set). The lock
# serializes writers, so the cache is always validated against the
# live file before use — a changed file rescans, an unchanged one
# answers O(1). Without this every append re-scans the whole JSONL
# (O(n^2) over a 24/7 runtime).
_SEEN = {}


def _seen_keys(path):
    try:
        st = os.stat(path)
    except OSError:
        return set()
    key = (st.st_size, st.st_mtime_ns)
    hit = _SEEN.get(path)
    if hit is not None and hit[0] == key:
        return hit[1]
    seen = set()
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    seen.add((r.get("research_epoch"),
                              r.get("symbol"), r.get("node")))
    except OSError:
        return set()
    _SEEN[path] = (key, seen)
    # Bounded registry: one entry per digest path in the process.
    # A process that cycles thousands of outdirs would grow this;
    # digest dirs are deployment-fixed (one per plane), documented.
    if len(_SEEN) > 64:
        _SEEN.pop(next(iter(_SEEN)))
    return seen


def _remember(path, epoch, symbol, node):
    # Called right after our own append (still under the lock): the
    # file stat is new, so refresh the key AND the set together.
    try:
        st = os.stat(path)
    except OSError:
        _SEEN.pop(path, None)
        return
    hit = _SEEN.get(path)
    seen = set(hit[1]) if hit is not None else _seen_keys(path)
    seen.add((epoch, symbol, node))
    _SEEN[path] = ((st.st_size, st.st_mtime_ns), seen)


def append_digest(outdir, epoch, symbol, node, text, extra=None):
    """Append one digest row. Returns (ok, reason). Idempotent: a row
    with the same (epoch, symbol, node) is never duplicated."""
    if node not in NODES:
        return False, "digest-node"
    if not isinstance(symbol, str) or not symbol:
        return False, "digest-symbol"
    if not isinstance(text, str) or not text:
        return False, "digest-text"
    limit = (THESIS_MAX_CHARS if node == "hypothesize"
             else CRITIQUE_MAX_CHARS)
    if len(text) > limit:
        return False, "digest-too-long"
    row = {"research_epoch": epoch, "symbol": symbol, "node": node,
           "text": text, "evidence": "prose",
           "extra": dict(extra) if extra else {}}
    os.makedirs(outdir, exist_ok=True)
    path = _digest_path(outdir)
    with locks.FileLock(path + ".lock", purpose="digest"):
        if (epoch, symbol, node) in _seen_keys(path):
            return True, "duplicate"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        locks.fsync_dir(outdir)
        _remember(path, epoch, symbol, node)
    return True, "ok"
