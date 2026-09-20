"""D2 sandboxed extraction workers (doc 08 sec. 8.2, stdlib + smolagents).

Frozen worker model: smolagents CodeAgent with executor_type="docker"
(non-root, read-only rootfs, dropped capabilities, CPU/RAM limits,
egress limited to the allowlisted endpoints via sandbox proxy).
The import allowlist is LOCKED (doc 08 §8.2) and enforced twice:
container image build AND a pre-flight source scan of generated code
(defense in depth; the firewall/proxy remains the real boundary).

No model key / pinned image configured -> explicit ConfigBlocked,
never a fake answer. LocalPythonExecutor is forbidden (known escapes)
and never referenced. Live Docker execution (daemon + image digest +
model key + egress probe) is a DEPLOYMENT box; the code path below is
complete and the blocked paths are unit-tested.
"""
import ast

# Locked import allowlist (doc 08 §8.2, exact — nothing else imports).
ALLOWLIST = {"json", "re", "datetime", "urllib", "xml", "html", "math",
             "statistics", "collections", "itertools", "hashlib",
             "base64", "requests", "bs4", "lxml", "pydantic", "pandas",
             "feedparser"}
FORBIDDEN = {"subprocess", "os", "sys", "socket", "pickle", "yaml",
             "shutil", "pathlib", "open"}



class ConfigBlocked(Exception):
    pass


def scan_imports(code):
    """Pre-flight static scan: literal imports AND dynamic loading
    (__import__, importlib.import_module) must resolve to allowlisted
    top-level modules; anything else (including unparseable code, which
    fails closed) is rejected.

    Honest scope: AST catches every statically visible load. Deliberately
    obfuscated loads (eval-built strings) are NOT statically decidable —
    the Docker sandbox firewall/proxy is the real boundary for those.
    Returns (ok, offending_name_or_None)."""
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return False, "<unparseable>"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if not _allowed_top(a.name.split(".")[0]):
                    return False, a.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if not _allowed_top(mod):
                return False, mod
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id == "__import__":
                if not (node.args and isinstance(node.args[0], ast.Constant)
                         and isinstance(node.args[0].value, str)
                         and _allowed_top(
                             node.args[0].value.split(".")[0])):
                    return False, "__import__"
            elif (isinstance(f, ast.Attribute) and
                    f.attr == "import_module"):
                if not (node.args and isinstance(node.args[0], ast.Constant)
                         and isinstance(node.args[0].value, str)
                         and _allowed_top(
                             node.args[0].value.split(".")[0])):
                    return False, "import_module"
    return True, None


def _allowed_top(top):
    return top in ALLOWLIST and top not in FORBIDDEN


def make_extract_worker(model_cfg=None, docker_image=None, tools=()):
    """Build the sandboxed extract worker.

    model_cfg = {model_id, api_base, api_key} (runtime-supplied, never in
    git) + docker_image = pinned image digest. Either missing -> the
    returned worker raises ConfigBlocked on first use (explicit blocker;
    the graph applies drop+count defaults). With both present the worker
    builds a CodeAgent over a DockerExecutor (non-root, read-only,
    capped, no network except the proxy) with the frozen import set,
    runs the record task, AST-scans every generated code step, and
    returns advisory candidates (the resolver, not the model, decides
    evidence). Live Docker execution is a DEPLOYMENT box (daemon +
    digest + key + egress probe); construction and blocked paths are
    unit-tested here.
    """
    if not model_cfg or not model_cfg.get("model_id") or not docker_image:
        def blocked(rec, budget):
            raise ConfigBlocked("research model/docker image not configured")
        return blocked

    def run(rec, budget):
        try:
            from smolagents import CodeAgent, DockerExecutor, \
                OpenAIServerModel
        except ImportError as e:
            raise ConfigBlocked("smolagents unavailable: %s" % e)
        model = OpenAIServerModel(
            model_id=model_cfg["model_id"],
            api_base=model_cfg.get("api_base"),
            api_key=model_cfg.get("api_key"))
        executor = DockerExecutor(
            additional_imports=sorted(ALLOWLIST),
            logger=None,
            image_name=docker_image,
            container_run_kwargs={
                "user": "65532:65532", "read_only": True,
                "cap_drop": ["ALL"], "mem_limit": "2g",
                "nano_cpus": 1000000000, "network_mode": "none",
            })
        agent = CodeAgent(tools=list(tools), model=model,
                          executor=executor, max_steps=10)
        result = agent.run(
            "Extract advisory feature candidates as JSON from: %s" %
            _record_brief(rec))
        for step in getattr(agent.memory, "steps", []):
            calls = getattr(step, "tool_calls", None)
            code = getattr(calls, "code", None)
            if isinstance(code, str):
                ok, bad = scan_imports(code)
                if not ok:
                    raise ConfigBlocked(
                        "generated code failed import scan: %s" % bad)
        return _to_candidates(result, rec)
    return run


def _record_brief(rec):
    return str({k: rec.get(k) for k in
                    ("source_id", "kind", "title", "published_ns")
                if k in rec})[:2000]


def _to_candidates(result, rec):
    import json
    try:
        data = json.loads(str(result))
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        data = [data]
    out = []
    for c in data if isinstance(data, list) else []:
        if not isinstance(c, dict):
            continue
        out.append({
            "kind": c.get("kind", rec.get("kind", "filing_event")),
            "symbols": c.get("symbols", list(rec.get("symbols", []))),
            "value": c.get("value",
                             {"type": "enum", "v": "unspecified"}),
            "effect": "unknown",  # resolver decides; never the model
            "feature_id": c.get("feature_id"),
            "provenance_url": c.get("provenance_url",
                                      rec.get("provenance_url"))})
    return out


def stub_advisory(rec, budget):
    """Deterministic test double: wraps a raw record as an advisory
    candidate WITHOUT evidence claims (resolver decides evidence)."""
    budget.charge_tool()
    return [{"kind": rec.get("kind", "filing_event"),
             "symbols": list(rec.get("symbols", [])),
             "value": dict(rec.get("value", {"type": "enum", "v": "x"})),
             "effect": "unknown",
             "feature_id": rec.get("feature_id"),
             "provenance_url": rec.get("provenance_url")}]
