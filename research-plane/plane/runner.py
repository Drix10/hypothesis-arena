"""Phase-2.5 production cycle composition (Track A wiring, no D/H1).

Ownership (explicit): ONE Runner per process owns ONE Seam (hence one
adapter instance per source) plus ONE graph app for their joint
lifetime. Cycles never reconstruct the seam or adapters: repeated
run() calls share pacing state, dedupe sets, throttle episodes, and
canonical lineage. No globals, no singletons-by-module — ownership is
an explicit object the production entrypoint holds.

The production composition (build_production_runner) is the tracked
in-repo caller: it establishes the heartbeat sink (required — plan 09
makes heartbeat part of source health; a runner without heartbeats is
refused), resolves the MIRO_CANONICAL_DB-honoring lineage DB, and
binds the owned seam into the graph app.

The runner does NOT invent graph dependencies: the caller supplies
the full build_graph deps (LLM providers, spend governor, budgets,
fuse/hypothesize/critique); composition only binds deps["harvest"].
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
    return {"heartbeat_dir": hb, "repo_root": root, "env": src}


class Runner:
    def __init__(self, app, seam):
        self.app = app
        self.seam = seam

    def run(self, watchlist, epoch, thread_id):
        from plane import graph as _graph
        return _graph.run_cycle(self.app, watchlist, epoch, thread_id)


def build_runner(graph_deps, seam_kwargs=None):
    """Bind an owned seam into a graph app. graph_deps: complete
    build_graph deps WITHOUT harvest (it is bound here). A production
    runner without a heartbeat sink is refused (ConfigError): silent
    heartbeat-less deployment is not a healthy deployment."""
    from plane import graph as _graph
    from plane import source_seam as _seam_mod
    seam_kwargs = dict(seam_kwargs or {})
    if not seam_kwargs.get("heartbeat_dir"):
        raise ConfigError("runner: heartbeat_dir is required")
    seam = _seam_mod.build_seam(**seam_kwargs)
    deps = dict(graph_deps)
    deps["harvest"] = seam.harvest
    app = _graph.build_graph(deps)
    return Runner(app, seam)


def build_production_runner(graph_deps, env=None, paths=None,
                            seam_extra=None):
    """The tracked production composition: establishes heartbeat sink
    + lineage DB defaults, then delegates to build_runner."""
    import os
    paths = dict(paths or default_paths(env))
    hb = (paths.get("heartbeat_dir") or "").strip() \
        if isinstance(paths.get("heartbeat_dir"), str) else ""
    if not hb:
        raise ConfigError("production runner: no heartbeat_dir")
    os.makedirs(hb, exist_ok=True)
    seam_kwargs = dict(seam_extra or {})
    seam_kwargs.setdefault("env", env)
    seam_kwargs["heartbeat_dir"] = hb
    return build_runner(graph_deps, seam_kwargs)
