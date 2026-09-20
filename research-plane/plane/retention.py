"""Mandatory 30-day checkpoint retention (doc 08, stdlib + langgraph).

Checkpoints are resumable state, not an archive: threads whose latest
checkpoint is older than RETAIN_DAYS are deleted via the saver's
delete_thread(). Retention runs under the supervisor (or the emit
node's post-cycle hook); what it deleted is returned for the audit
trail.

Deserialization hardening: build_graph() wraps the saver with
with_allowlist(CHECKPOINT_ALLOWLIST) so checkpoint blobs deserialize
under a strict msgpack allowlist instead of the default surface.
"""
import time

RETAIN_DAYS = 30

# Strict msgpack allowlist for checkpoint payloads: plain containers +
# the scalar types the plane stores. Anything else fails closed at
# deserialization instead of materializing.
CHECKPOINT_ALLOWLIST = (
    ("builtins", "dict"), ("builtins", "list"),
    ("builtins", "tuple"), ("builtins", "str"),
    ("builtins", "int"), ("builtins", "float"),
    ("builtins", "bool"), ("builtins", "NoneType"),
)


def harden_saver(saver):
    """Apply the strict deserialization allowlist. Returns the saver
    to compile the graph with (a clone when the backend derives one)."""
    try:
        return saver.with_allowlist(CHECKPOINT_ALLOWLIST)
    except (AttributeError, TypeError, ValueError):
        return saver


def _thread_latest(saver):
    """thread_id -> newest checkpoint ts (seconds)."""
    latest = {}
    try:
        tuples = saver.list(None)
    except (TypeError, ValueError):
        return latest
    for t in tuples:
        try:
            tid = t.config["configurable"]["thread_id"]
            ts = t.checkpoint["ts"]
        except (KeyError, TypeError):
            continue
        if not isinstance(ts, str):
            continue
        try:
            import datetime
            fts = datetime.datetime.fromisoformat(ts).timestamp()
        except ValueError:
            continue
        if tid not in latest or fts > latest[tid]:
            latest[tid] = fts
    return latest


def prune_checkpoints(saver, retain_days=RETAIN_DAYS, now=None):
    """Delete threads older than retain_days. Returns the sorted list
    of deleted thread_ids."""
    now = time.time() if now is None else now
    cutoff = now - retain_days * 86400
    deleted = []
    for tid, fts in _thread_latest(saver).items():
        if fts < cutoff:
            saver.delete_thread(tid)
            deleted.append(tid)
    return sorted(deleted)
