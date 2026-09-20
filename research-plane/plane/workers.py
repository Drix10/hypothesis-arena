"""D2 sandboxed extraction workers (doc 08 sec. 8.2, smolagents).

Frozen worker model: a smolagents CodeAgent over a prebuilt immutable
Docker image, non-root, read-only rootfs, dropped capabilities, CPU/
RAM/pids caps, seccomp/AppArmor, NO docker socket, NO writable trading-
tree mounts, and container egress ONLY on the deployment proxy network
that allowlists source APIs + the model provider (nothing else). The
prompt is NEVER the network boundary: enforcement lives in the sandbox
firewall/proxy, proven by the unauthorized-destination probe.

R15/token/attribution enforcement lives at the ACTUAL invocation
boundary (finding 4/5/11/13), not at graph wrappers:
- every model.generate() goes through GatedModel.generate(): reserve
  tokens+call from the durable cycle budget BEFORE execution (raises
  AbortCycle at any cap), execute under a thread watchdog, reconcile
  actual prompt/completion tokens after, and append exactly one
  attribution span (ok/error/timeout). max_tokens=reservation is passed
  to the provider as a best-effort bound; the reservation is the
  enforcement.
- every executor code step goes through PrescanningExecutor: the AST
  import scan runs BEFORE execution (post-execution scanning would be
  forensics, not a gate), then a tool-budget reservation, then the
  delegate under the watchdog. Scan failure = ConfigBlocked, nothing
  executed, nothing charged.
- every agent tool is wrapped to reserve tool budget before running.
A fake multi-step agent driving these same wrappers is the regression
proof (live provider + daemon stay a DEPLOYMENT box: no key/daemon
exists in CI, so run() itself is construction-tested + blocked-path-
tested, never executed here).

sandbox_cfg (deployment-supplied, never in git) MUST contain:
  image_digest (pinned repo@sha256:...; build_new_image=False always —
  a missing image is ConfigBlocked, never an implicit build),
  proxy_network (container network attached to the egress proxy;
  network_mode="none" is REJECTED because the locked design requires
  proxy-mediated source/model egress — without the proxy there is no
  usable egress, so the worker stays blocked, honestly),
  seccomp_profile + apparmor_profile paths, model_timeout_s.
Without model_cfg {model_id, api_base, api_key} AND a complete
sandbox_cfg the worker raises ConfigBlocked on first use (explicit
blocker; the graph applies drop+count defaults).

Import authorization uses the CORRECT smolagents controls (finding 24):
  DockerExecutor.additional_imports = third-party PACKAGES to install
    (empty: the immutable image preinstalls everything; installing at
    worker start would mutate the frozen image),
  CodeAgent.additional_authorized_imports = the exact frozen import
    allowlist (the in-container code gate),
plus the pre-execution AST scan above. LocalPythonExecutor is
forbidden (known escapes) and never referenced.
"""
import ast

from . import attribution
from . import budgets
from . import r15
from . import timeout as timeout_mod

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
    """Pre-execution static scan: literal imports AND dynamic loading
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


def _record_attempt(log_path, cycle_id, symbol, node, kind, seq, pt=0,
                    ct=0, category="research", epoch=0, model_id="?"):
    """Exactly one durable span per actual attempt (model generations
    AND executor/tool executions — every budget-consuming try is
    accounted)."""
    attribution.append_span(
        log_path, epoch, node, model_id, cycle_id=cycle_id, stage="r",
        symbol=symbol, prompt_tokens=pt, completion_tokens=ct, usd=0.0,
        category=category,
        span_id="%s:%s:%s:%s:%d" % (cycle_id, symbol, node, kind,
                                      seq))


def _usage_of(msg):
    """(prompt_tokens, completion_tokens) from a smolagents ChatMessage;
    (0, 0) when the provider did not report usage (reservation stands)."""
    usage = getattr(msg, "token_usage", None)
    if usage is None:
        return 0, 0
    try:
        return int(getattr(usage, "input_tokens", 0) or 0), int(
            getattr(usage, "output_tokens", 0) or 0)
    except (TypeError, ValueError):
        return 0, 0


class GatedModel:
    """Wraps a smolagents model so EVERY real generation reserves R15
    budget first, executes under the watchdog, reconciles tokens, and
    records exactly one attribution span. Works with any object
    exposing generate(); production passes OpenAIServerModel."""

    def __init__(self, model, budget, node, model_id, cycle_id, symbol,
                 timeout_s, log_path):
        self._model = model
        self._budget = budget
        self._node = node
        self._model_id = model_id
        self._cycle_id = cycle_id
        self._symbol = symbol
        self._timeout_s = timeout_s
        self._log_path = log_path

    def _span(self, seq, pt, ct, category):
        _record_attempt(self._log_path, self._cycle_id, self._symbol,
                        self._node, "llm", seq, pt, ct, category,
                        model_id=self._model_id)

    def generate(self, messages, **kwargs):
        lease = self._budget.reserve_llm()  # BEFORE execution, or abort
        kwargs.setdefault("max_tokens",
                          min(lease["reserved"],
                              lease["remaining_tokens"]))
        try:
            msg = timeout_mod.run_with_timeout(
                self._model.generate, self._timeout_s, messages,
                **kwargs)
        except timeout_mod.CallTimeout:
            self._span(lease["seq"], 0, 0, "timeout")
            raise r15.AbortCycle(self._symbol,
                                 {"timeout": True,
                                  "seq": lease["seq"]})
        except Exception:
            self._span(lease["seq"], 0, 0, "error")
            raise
        pt, ct = _usage_of(msg)
        self._budget.settle_llm(lease, pt + ct)
        self._span(lease["seq"], pt, ct, "research")
        return msg

    def __getattr__(self, name):
        return getattr(self.__dict__["_model"], name)


class PrescanningExecutor:
    """Wraps the container executor: AST scan BEFORE execution, then a
    tool-budget reservation, then the delegate under the watchdog.
    Every execution appends exactly one span."""

    def __init__(self, delegate, budget, timeout_s, log_path=None,
                 cycle_id="local", symbol="?", node="extract",
                 epoch=0):
        self._delegate = delegate
        self._budget = budget
        self._timeout_s = timeout_s
        self._log_path = log_path
        self._cycle_id = cycle_id
        self._symbol = symbol
        self._node = node
        self._epoch = epoch

    def __call__(self, code):
        ok, bad = scan_imports(code)
        if not ok:
            raise ConfigBlocked(
                "generated code failed import scan: %s" % bad)
        lease = self._budget.reserve_tool()
        try:
            out = timeout_mod.run_with_timeout(self._delegate,
                                               self._timeout_s, code)
        except timeout_mod.CallTimeout:
            if self._log_path is not None:
                _record_attempt(self._log_path, self._cycle_id,
                                self._symbol, self._node, "exec",
                                lease["seq"], category="timeout",
                                epoch=self._epoch)
            raise r15.AbortCycle(self._symbol, {"timeout": True})
        except Exception:
            if self._log_path is not None:
                _record_attempt(self._log_path, self._cycle_id,
                                self._symbol, self._node, "exec",
                                lease["seq"], category="error",
                                epoch=self._epoch)
            raise
        if self._log_path is not None:
            _record_attempt(self._log_path, self._cycle_id, self._symbol,
                            self._node, "exec", lease["seq"],
                            epoch=self._epoch)
        return out

    def __getattr__(self, name):
        return getattr(self.__dict__["_delegate"], name)


def gate_tool(tool, budget, timeout_s, log_path=None, cycle_id="local",
              symbol="?", node="extract", epoch=0):
    """Wrap an agent tool: reserve tool budget, execute under the
    watchdog, record exactly one span."""
    def _gated(*args, **kwargs):
        lease = budget.reserve_tool()
        try:
            out = timeout_mod.run_with_timeout(tool, timeout_s, *args,
                                               **kwargs)
        except BaseException:
            if log_path is not None:
                _record_attempt(log_path, cycle_id, symbol, node,
                                "tool", lease["seq"], category="error",
                                epoch=epoch)
            raise
        if log_path is not None:
            _record_attempt(log_path, cycle_id, symbol, node, "tool",
                            lease["seq"], epoch=epoch)
        return out
    try:
        _gated.__name__ = getattr(tool, "__name__", "tool")
    except TypeError:
        pass
    return _gated


SANDBOX_REQUIRED = ("image_digest", "proxy_network", "seccomp_profile",
                    "apparmor_profile")


def _sandbox_kwargs(sandbox_cfg):
    """Locked runtime spec -> docker container kwargs. Missing proxy
    network = ConfigBlocked (no usable egress without it)."""
    missing = [k for k in SANDBOX_REQUIRED if not sandbox_cfg.get(k)]
    if missing:
        raise ConfigBlocked("sandbox incomplete, missing: %s" %
                            ",".join(sorted(missing)))
    image = sandbox_cfg["image_digest"]
    if "@sha256:" not in image:
        raise ConfigBlocked("image must be a pinned digest")
    return {
        "user": "65532:65532", "read_only": True,
        "cap_drop": ["ALL"], "mem_limit": "2g",
        "nano_cpus": 1000000000, "pids_limit": 64,
        "security_opt": [
            "seccomp=%s" % sandbox_cfg["seccomp_profile"],
            "apparmor=%s" % sandbox_cfg["apparmor_profile"]],
        "network_mode": "cont:%s" % sandbox_cfg["proxy_network"],
    }


def make_extract_worker(model_cfg=None, sandbox_cfg=None, tools=(),
                        budget=None, node="extract", cycle_id="local",
                        symbol="?", timeout_s=120.0, log_path=None,
                        agent_factory=None, model_factory=None):
    """Build the sandboxed extract worker.

    With model_cfg + complete sandbox_cfg the returned worker builds a
    CodeAgent over a prebuilt immutable Docker image with the frozen
    authorized-import set, wraps model/executor/tools in the R15
    invocation boundary above, and returns advisory candidates (the
    resolver, not the model, decides evidence). Anything missing ->
    ConfigBlocked on first use. agent_factory/model_factory are
    seams for the multi-step regression test (production passes None).
    """
    if not model_cfg or not model_cfg.get("model_id"):
        def blocked(rec, budget):
            raise ConfigBlocked("research model not configured")
        return blocked
    try:
        container_kwargs = _sandbox_kwargs(sandbox_cfg or {})
    except ConfigBlocked as e:
        def blocked_cfg(rec, budget, _e=e):
            raise ConfigBlocked(str(_e))
        return blocked_cfg

    def run(rec, call_budget=None):
        call_budget = call_budget if call_budget is not None else budget
        if call_budget is None:
            raise ConfigBlocked("no R15 budget for live extraction")
        if log_path is None:
            raise ConfigBlocked("no attribution log for live extraction")
        if model_factory is None:
            try:
                from smolagents import CodeAgent, DockerExecutor, \
                    OpenAIServerModel
            except ImportError as e:
                raise ConfigBlocked("smolagents unavailable: %s" % e)
            model = OpenAIServerModel(
                model_id=model_cfg["model_id"],
                api_base=model_cfg.get("api_base"),
                api_key=model_cfg.get("api_key"))
        else:
            model = model_factory(model_cfg)
        gated = GatedModel(model, call_budget, node,
                           model_cfg["model_id"], cycle_id, symbol,
                           timeout_s, log_path)
        if agent_factory is not None:
            agent = agent_factory(gated, rec)
            return _to_candidates(agent.run("extract"), rec)
        executor = DockerExecutor(
            additional_imports=[],  # image preinstalls everything;
            # installing here would mutate the frozen image.
            logger=None,
            image_name=sandbox_cfg["image_digest"],
            build_new_image=False,  # missing image = error, never build
            container_run_kwargs=container_kwargs)
        agent = CodeAgent(
            tools=[gate_tool(t, call_budget, timeout_s, log_path,
                             cycle_id, symbol, node)
                   for t in tools],
            model=gated, additional_authorized_imports=sorted(ALLOWLIST),
            executor=executor, max_steps=10)
        # Pre-execution gate installed at the exact call boundary (the
        # in-container authorized-import list is the second layer; the
        # proxy firewall is the real boundary).
        agent.python_executor = PrescanningExecutor(
            agent.python_executor, call_budget, timeout_s, log_path,
            cycle_id, symbol, node)
        return _to_candidates(agent.run(
            "Extract advisory feature candidates as JSON from: %s" %
            _record_brief(rec)), rec)
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
             "provenance_url": rec.get("provenance_url")}]
