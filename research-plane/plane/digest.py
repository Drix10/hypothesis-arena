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


def _has_locked(path, epoch, symbol, node):
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(r, dict) and r.get("research_epoch")
                        == epoch and r.get("symbol") == symbol
                        and r.get("node") == node):
                    return True
    except OSError:
        pass
    return False


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
    with locks.FileLock(path + ".lock"):
        if _has_locked(path, epoch, symbol, node):
            return True, "duplicate"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        locks.fsync_dir(outdir)
    return True, "ok"
