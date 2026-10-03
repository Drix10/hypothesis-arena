"""Phase-2.5 production cycle composition (Track A wiring, no D/H1).

Dependency composition:
- The caller supplies the other graph dependencies: LLM providers
  (provider_factory/cfgs), fuse, hypothesize/critique build+parse,
  extract_workers, budgets, spend governor, cadence, checkpointer,
  tools/executors, model timeouts, signal/digest dirs. It must not
  supply "harvest", "parser_extract" or "resolve_emit"; those are
  seam-owned and supplying them raises ConfigError.
- build_production_runner owns the heartbeat sink (required), lineage DB
  path (MIRO_CANONICAL_DB-honoring default), bundle outdir, pinned map
  path, the Seam (one adapter per source), and the graph app with the
  three seam callbacks bound.
- The Seam owns adapter singletons + pacing, the harvest envelope (with
  the authority hash stamped on each kept record), the deterministic
  parser extract, canonical lineage (CanonicalStore over the shared
  records table), the publisher canonical lookup (store.canonical_for),
  the watermark callback (Seam.watermarks) and history tails (with
  bundle recovery across restart).
- publish.resolve_emit receives {outdir, map_path,
  canonical_for=seam.store.canonical_for,
  source_watermarks=seam.watermarks} plus graph state {epoch, fused,
  history}. The graph's emit node is the only publisher caller.

One Runner per process owns one Seam and one graph app; cycles never
rebuild them. A restart resumes over the same lineage DB + bundle dir.

Nothing here trades, sizes, routes orders, or touches kill-switch state.

graph (langgraph) is imported lazily, so importing this module needs no
third-party deps.
"""


class ConfigError(Exception):
    pass


def default_paths(env=None):
    """Deterministic production runtime layout (repo-relative)."""
    import os
    src = env if env is not None else os.environ
    root = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", ".."))
    hb = os.path.join(root, "data", "heartbeats")
    return {"heartbeat_dir": hb, "repo_root": root, "env": src,
            "outdir": os.path.join(root, "data", "bundles"),
            "map_path": os.path.join(root, "collector",
                                     "entity_map.json")}


class Runner:
    def __init__(self, app, seam):
        self.app = app
        self.seam = seam

    def run(self, watchlist, epoch, thread_id):
        from engine import graph as _graph
        return _graph.run_cycle(self.app, watchlist, epoch, thread_id)


def build_runner(graph_deps, seam_kwargs=None, publish_paths=None):
    """Bind the owned seam into a graph app, including the seam-owned
    harvest/extract/publisher callbacks. graph_deps must not contain
    harvest/parser_extract/resolve_emit (ConfigError). A runner without
    a heartbeat sink is refused. Returns the Runner; the emit node
    publishes through publish.resolve_emit into outdir and the bundle
    path appears on the cycle output."""
    from engine import graph as _graph
    from engine import publish as _publish
    from engine import source_seam as _seam_mod
    seam_kwargs = dict(seam_kwargs or {})
    for owned in ("harvest", "parser_extract", "resolve_emit"):
        if owned in graph_deps:
            raise ConfigError("runner: %s is seam-owned" % owned)
    if not seam_kwargs.get("heartbeat_dir"):
        raise ConfigError("runner: heartbeat_dir is required")
    paths = dict(publish_paths or {})
    outdir = paths.get("outdir")
    map_path = paths.get("map_path")
    if not isinstance(outdir, str) or not outdir:
        raise ConfigError("runner: outdir is required")
    if not isinstance(map_path, str) or not map_path:
        raise ConfigError("runner: map_path is required")
    import os
    os.makedirs(outdir, exist_ok=True)
    seam = _seam_mod.build_seam(**seam_kwargs)
    params = {"outdir": outdir, "map_path": map_path,
              "canonical_for": seam.store.canonical_for,
              "source_watermarks": seam.watermarks}

    def resolve_emit(state):
        return _publish.resolve_emit(params, state)

    deps = dict(graph_deps)
    deps["harvest"] = seam.harvest
    deps["parser_extract"] = seam.parser_extract
    deps["resolve_emit"] = resolve_emit
    app = _graph.build_graph(deps)
    return Runner(app, seam)


def build_production_runner(graph_deps, env=None, paths=None,
                            seam_extra=None):
    """Production composition: sets up the heartbeat sink, lineage DB,
    bundle outdir and pinned map defaults, restores durable history into
    the seam, then calls build_runner."""
    import os
    paths = dict(paths or default_paths(env))
    hb = paths.get("heartbeat_dir")
    hb = hb.strip() if isinstance(hb, str) else ""
    if not hb:
        raise ConfigError("production runner: no heartbeat_dir")
    os.makedirs(hb, exist_ok=True)
    seam_kwargs = dict(seam_extra or {})
    seam_kwargs.setdefault("env", env)
    seam_kwargs["heartbeat_dir"] = hb
    outdir = paths.get("outdir")
    if not isinstance(outdir, str) or not outdir:
        raise ConfigError("production runner: no outdir")
    map_path = paths.get("map_path")
    if not isinstance(map_path, str) or not map_path:
        raise ConfigError("production runner: no map_path")
    runner = build_runner(
        graph_deps, seam_kwargs,
        {"outdir": outdir, "map_path": map_path})
    runner.seam.restore_from_bundles(outdir)
    return runner
