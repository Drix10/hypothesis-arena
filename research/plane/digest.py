"""Durable research-digest writer (doc 08 topology, stdlib only).

hypothesize writes a <=500-character thesis and critique writes its
advisory metadata into research_digest.jsonl, separate from
features.jsonl (prose never enters the trading boundary).

- Append-only JSONL under the inter-process lock; idempotency key is
  (research_epoch, symbol, node), so a retried node yields one row.
- Over-limit thesis text is rejected (digest-too-long), not truncated:
  it is a producer defect to count.
- Rows carry disagreement + evidence=prose markers so digest text is
  never mistaken for evidence.
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
# Validated against the live file before use (changed file rescans), so
# appends are O(1) instead of rescanning the JSONL. Per-path entries are
# bounded, oldest evicted first. Values are text SHAs: the same key with
# changed text is a conflict (first write wins), not a duplicate.
_SEEN = {}
_SEEN_PATHS_MAX = 64
_SEEN_KEYS_MAX = 4096


class DigestCorrupt(Exception):
    """The digest file holds a malformed row. It is the first-write-wins
    authority, so a malformed row poisons instead of being skipped."""


def _seen_keys(path):
    """path -> {key: text_sha}, bounded per path and by _SEEN_PATHS_MAX
    paths. A changed file rescans. Raises DigestCorrupt on any malformed
    non-empty row."""
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
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    raise DigestCorrupt(path)
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
    """Streaming scan for one digest key: the text sha if on file, else
    None. Used only on a cache miss (evicted key)."""
    import hashlib
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    raise DigestCorrupt(path)
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
    # called right after our own append, under the lock: refresh key and set together
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
    """Append one digest row. Returns (ok, reason). Idempotent on the same
    (epoch, symbol, node) and text; the same key with different text is
    a digest-conflict (first write wins)."""
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
        # a corrupt file refuses the whole append
        try:
            prior = _seen_keys(path).get((epoch, symbol, node),
                                         "absent")
        except DigestCorrupt:
            return False, "digest-corrupt"
        if prior == "absent":
            # evicted from the bounded cache: consult the file
            try:
                scanned = _scan_key(path, (epoch, symbol, node))
            except DigestCorrupt:
                return False, "digest-corrupt"
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
