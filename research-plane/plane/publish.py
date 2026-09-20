"""Production resolve+emit step (doc 08 sec. 8.5, stdlib only).

The graph's emit node calls this (injected as deps["resolve_emit"]).
For each fused advisory candidate: resolve deterministically against
its canonical record (deps supply the canonical lookup + pinned map);
collect resolved features; emit ONE committed bundle when at least one
feature resolved, otherwise publish NOTHING (empty=True — an aborted or
fully-dropped cycle leaves the last complete bundle standing, exactly
like an R15 abort).

Canonical lookup: deps["canonical_for"](candidate) -> canonical record
dict or None (no record -> candidate dropped + counted, never emitted
on prose alone).
"""
from . import emit as emit_mod
from . import resolver


def resolve_emit(deps, state):
    outdir = deps["outdir"]
    resolved = []
    dropped = 0
    for cand in state.get("fused", []):
        canon = deps["canonical_for"](cand)
        if canon is None:
            dropped += 1
            continue
        ok, out = resolver.resolve(
            cand, canon, deps["entity_map"],
            llm_touched=cand.get("llm_touched", True))
        if not ok:
            dropped += 1
            continue
        feat, _capped = out
        # No side-channel: R12 capping is already encoded as
        # evidence=inference by the resolver (no published ts can never
        # be mechanically identical). Nothing extra enters the bundle.
        resolved.append(feat)
    if not resolved:
        return {"emitted": None, "empty": True, "dropped_resolve": dropped,
                "aborted": False}
    clean = [dict(f) for f in resolved]
    wm = deps["watermarks"](state)
    bid, path = emit_mod.emit_bundle(outdir, state["epoch"], clean, wm,
                                     state.get("history"))
    return {"emitted": bid, "bundle_path": path, "empty": False,
            "dropped_resolve": dropped, "aborted": False}
