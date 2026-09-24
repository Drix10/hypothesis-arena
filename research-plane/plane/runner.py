"""Phase-2.5 production cycle runner (Track A wiring, no D/H1).

Ownership (explicit): ONE Runner per process owns ONE Seam (hence one
adapter instance per source) plus ONE graph app for their joint
lifetime. Cycles never reconstruct the seam or adapters: repeated
run() calls share pacing state, dedupe sets, throttle episodes, and
canonical lineage. No globals, no singletons-by-module — ownership is
an explicit object the production entrypoint holds.

The runner does NOT invent graph dependencies: the caller supplies
the full build_graph deps (LLM providers, spend governor, budgets,
fuse/hypothesize/critique); the runner only binds deps["harvest"] to
the owned seam. Nothing here trades, sizes, routes orders, or touches
kill-switch state (D/H1 remain unauthorized and absent).

Stdlib-safe: graph (langgraph) imports lazily inside the two
functions that need it, so importing this module never requires
third-party deps.
"""


class Runner:
    def __init__(self, app, seam):
        self.app = app
        self.seam = seam

    def run(self, watchlist, epoch, thread_id):
        from plane import graph as _graph
        return _graph.run_cycle(self.app, watchlist, epoch, thread_id)


def build_runner(graph_deps, seam_kwargs=None):
    """Bind an owned seam into a graph app. graph_deps: complete
    build_graph deps WITHOUT harvest (it is bound here)."""
    from plane import graph as _graph
    from plane import source_seam as _seam_mod
    seam_kwargs = dict(seam_kwargs or {})
    seam = _seam_mod.build_seam(**seam_kwargs)
    deps = dict(graph_deps)
    deps["harvest"] = seam.harvest
    app = _graph.build_graph(deps)
    return Runner(app, seam)
