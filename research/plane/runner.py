"""Phase-2.5 production cycle composition (Track A wiring, no D/H1).

DEPENDENCY COMPOSITION (explicit — no hidden wiring):
- CALLER supplies every unrelated graph dependency: LLM providers
  (provider_factory/cfgs), fuse, hypothesize/critique build+parse,
  extract_workers, budgets, spend governor, cadence, checkpointer,
  tools/executors, model timeouts, signal/digest dirs. The caller must
  NOT supply "harvest", "parser_extract", or "resolve_emit": all
  three are seam-owned and the composition refuses them (ConfigError
  — no silent override of production publisher wiring by a fake).
- build_production_runner OWNS: heartbeat sink (required), lineage
  DB path (MIRO_CANONICAL_DB-honoring default), bundle outdir, the
  pinned map path, the Seam (one adapter per source), and the graph
  app with ALL THREE seam callbacks bound.
- SEAM owns: adapter singletons + pacing, harvest envelope (with the
  authority hash stamped on each kept record), the deterministic
  parser extract (adapter rec -> lineage-bound candidate), canonical
  lineage (CanonicalStore over the shared records table), the
  publisher canonical lookup (store.canonical_for, restart-safe via
  the durable projection), the publisher watermark callback
  (Seam.watermarks from latest healthy stamps), and history tails
  (+ bundle recovery across restart).
- publish.resolve_emit receives: {outdir, map_path,
  canonical_for=seam.store.canonical_for,
  source_watermarks=seam.watermarks} + graph state {epoch, fused,
  history}. The graph's own emit node is the ONLY publisher caller
  in production — no manual second invocation.

Ownership lifetime: ONE Runner per process owns ONE Seam (hence one
adapter instance per source) plus ONE graph app for their joint
lifetime. Cycles never reconstruct the seam or adapters. Restart
across processes resumes over the same lineage DB + bundle dir
(canonical cache table + accepted-bundle history).

Nothing here trades, sizes, routes orders, or touches kill-switch
state (D/H1 remain unauthorized and absent).

Stdlib-safe: graph (langgraph) imports lazily inside the functions
that need it, so importing this module never requires third-party
deps.
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
        from plane import graph as _graph
        return _graph.run_cycle(self.app, watchlist, epoch, thread_id)


def build_runner(graph_deps, seam_kwargs=None, publish_paths=None):
    """Bind the owned seam into a graph app, INCLUDING the seam-owned
    harvest/extract/publisher callbacks. graph_deps: complete
    caller-side deps WITHOUT harvest/parser_extract/resolve_emit
    (supplying any is a ConfigError). A production runner without a
    heartbeat sink is refused. Returns the Runner; the graph's emit
    node publishes through the real publish.resolve_emit into outdir
    (bundle path surfaces on the cycle output — no manual publisher
    invocation exists)."""
    from plane import graph as _graph
    from plane import publish as _publish
    from plane import source_seam as _seam_mod
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
    """The tracked production composition: establishes heartbeat sink
    + lineage DB + bundle outdir + pinned map defaults, restores
    durable history into the fresh seam, then delegates to
    build_runner."""
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
