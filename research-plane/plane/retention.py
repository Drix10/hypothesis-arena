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


def make_saver(conn):
    """Build a SqliteSaver whose deserialization is STRICT: explicit
    msgpack module allowlist (containers + scalars only), no pickle
    fallback. FAILS CLOSED: if the strict configuration cannot be
    established AND verified on the effective serializer, raise
    instead of compiling a graph over a permissive checkpointer (a
    security control that fails open is not a control).

    NOTE: this intentionally bypasses with_allowlist(), which is a
    no-op derivation when the requested types are already inside the
    default SAFE set — it cannot prove strictness. Construction with
    explicit allowed_msgpack_modules can."""
    try:
        from langgraph.checkpoint.sqlite import SqliteSaver
        from langgraph.checkpoint.serde.jsonplus import \
            JsonPlusSerializer
    except ImportError as e:
        raise RuntimeError("checkpoint backend unavailable: %s" % e)
    allowed = [tuple(t) for t in CHECKPOINT_ALLOWLIST]
    try:
        serde = JsonPlusSerializer(pickle_fallback=False,
                                   allowed_msgpack_modules=allowed,
                                   allowed_json_modules=allowed)
    except (TypeError, ValueError) as e:
        raise RuntimeError("checkpoint hardening unavailable: %s" % e)
    if getattr(serde, "pickle_fallback", True) is not False:
        raise RuntimeError("checkpoint pickle fallback not disabled")
    eff = getattr(serde, "_allowed_msgpack_modules", True)
    if eff is True or eff is None:
        raise RuntimeError("checkpoint allowlist not applied")
    try:
        saver = SqliteSaver(conn, serde=serde)
    except TypeError as e:
        raise RuntimeError("checkpoint saver rejects serde: %s" % e)
    if getattr(saver, "serde", None) is not serde:
        raise RuntimeError("checkpoint saver dropped hardened serde")
    return saver


def harden_saver(saver):
    """Legacy entry: the saver object alone cannot prove strictness
    (see make_saver). Refuse rather than bless an unverifiable saver."""
    raise RuntimeError("use retention.make_saver(conn): hardening must "
                       "be constructed, not derived")


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
