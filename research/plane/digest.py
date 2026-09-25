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


# Per-process seen-key cache: path -> ((size, mtime_ns), {key: sha}).
# The lock serializes writers, so the cache is always validated
# against the live file before use — a changed file rescans, an
# unchanged one answers O(1). Without this every append re-scans the
# whole JSONL (O(n^2) over a 24/7 runtime). Per-path entries are
# BOUNDED (oldest evicted first): many epochs must not grow memory
# without limit. Values are text SHAs: the same (epoch, symbol, node)
# with CHANGED text is a CONFLICT (first write wins, reported loud),
# never a silent duplicate.
_SEEN = {}
_SEEN_PATHS_MAX = 64
_SEEN_KEYS_MAX = 4096


def _seen_keys(path):
    """path -> {key: text_sha}. Bounded per path (oldest evicted).
    A changed file rescans; the registry itself holds at most
    _SEEN_PATHS_MAX paths."""
    import hashlib
    try:
        st = os.stat(path)
    except OSError:
        return {}
    key = (st.st_size, st.st_mtime_ns)
    hit = _SEEN.get(path)
    if hit is not None and hit[0] == key:
        return hit[1]
    seen = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    k = (r.get("research_epoch"), r.get("symbol"),
                         r.get("node"))
                    text = r.get("text")
                    if isinstance(text, str):
                        seen[k] = hashlib.sha256(
                            text.encode("utf-8",
                                      "replace")).hexdigest()
                    elif k not in seen:
                        seen[k] = None
                    while len(seen) > _SEEN_KEYS_MAX:
                        seen.pop(next(iter(seen)))
    except OSError:
        return {}
    _SEEN[path] = (key, seen)
    if len(_SEEN) > _SEEN_PATHS_MAX:
        _SEEN.pop(next(iter(_SEEN)))
    return seen


def _scan_key(path, key):
    """Targeted file scan for one digest key (streaming, nothing
    materialized): returns the text sha when the key is on file, else
    None. Used ONLY on cache miss (evicted ancient keys): normal
    appends answer O(1) from the cache; a miss costs one file pass
    instead of ever duplicating or conflicting blindly."""
    import hashlib
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(r, dict) and
                        (r.get("research_epoch"), r.get("symbol"),
                         r.get("node")) == key and
                        isinstance(r.get("text"), str)):
                    return hashlib.sha256(r["text"].encode(
                        "utf-8", "replace")).hexdigest()
    except OSError:
        pass
    return None


def _remember(path, epoch, symbol, node, text_sha):
    # Called right after our own append (still under the lock): the
    # file stat is new, so refresh the key AND the set together.
    try:
        st = os.stat(path)
    except OSError:
        _SEEN.pop(path, None)
        return
    hit = _SEEN.get(path)
    seen = dict(hit[1]) if hit is not None else _seen_keys(path)
    seen[(epoch, symbol, node)] = text_sha
    while len(seen) > _SEEN_KEYS_MAX:
        seen.pop(next(iter(seen)))
    _SEEN[path] = ((st.st_size, st.st_mtime_ns), seen)


def append_digest(outdir, epoch, symbol, node, text, extra=None):
    """Append one digest row. Returns (ok, reason). Idempotent: a row
    with the same (epoch, symbol, node) AND the same text is never
    duplicated. The same key with DIFFERENT text is a conflict
    (digest-conflict, first write wins): two producers disagreeing
    about one slot is evidence of a defect, not a duplicate."""
    import hashlib
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
    sha = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
    row = {"research_epoch": epoch, "symbol": symbol, "node": node,
           "text": text, "evidence": "prose",
           "extra": dict(extra) if extra else {}}
    os.makedirs(outdir, exist_ok=True)
    path = _digest_path(outdir)
    with locks.FileLock(path + ".lock", purpose="digest"):
        prior = _seen_keys(path).get((epoch, symbol, node), "absent")
        if prior == "absent":
            # Evicted from the bounded cache (ancient key): consult
            # the file before deciding duplicate/conflict/append.
            scanned = _scan_key(path, (epoch, symbol, node))
            if scanned is not None:
                prior = scanned
                _remember(path, epoch, symbol, node, scanned)
        if prior == sha:
            return True, "duplicate"
        if prior != "absent":
            return False, "digest-conflict"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        locks.fsync_dir(outdir)
        _remember(path, epoch, symbol, node, sha)
    return True, "ok"
