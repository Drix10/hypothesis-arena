"""D2 sandboxed execution gate (doc 08 sec. 8.2 + doc 10 sec. 10.4).

Worker model: a smolagents CodeAgent over a prebuilt immutable Docker
image, non-root, read-only rootfs, dropped capabilities, CPU/RAM/pids
caps, seccomp/AppArmor, no docker socket, no writable trading-tree
mounts, and container egress only on the deployment proxy network, which
allowlists source APIs and the model provider. The prompt is not the
network boundary: enforcement lives in the sandbox firewall/proxy, checked
by the unauthorized-destination probe.

Invocation:
- The graph never holds a model object. deps["provider_factory"] is a
  module-level callable (picklable by reference) that builds a raw
  provider inside the worker child, so no code path reaches the provider
  without passing run_gated(). A refused reservation means the child is
  never spawned and the factory never runs.
- run_gated() (parent) does, in order: input validation, worst-leg
  pricing lookup, pre-call token reservation (measured prompt-byte upper
  bound + completion bound; agentic runs add the closed-form multi-step
  growth bound), worst-case dollar hold against the stage cap, then spawn.
- The child (spawn context, hard-killed on timeout, reaped on every path)
  builds provider/agent/executor from configs, executes, and returns
  JSON-safe results + usage. It gets no ledger paths and does no
  accounting, so a timed-out child cannot write late accounting. Executor
  cleanup runs in the child on the normal path; on the kill path the
  parent reaps the named container best-effort after the child is dead.
- Parent settlement is strict: an accounting failure after the child was
  spawned is AbortCycle, not a blocked result. Ambiguous outcomes
  (timeout, child crash, provider error, unaccountable usage) settle the
  full reservation as UNKNOWN_SPEND (never $0) and block future spend
  until a supervisor reconciles.

Token bounds (recorded in plan/10 §10.4.1):
- Prompt upper bound = utf-8 bytes of the exact outbound prompt. This is
  a true upper bound for byte-level-BPE providers (every token spans >= 1
  byte); it is an assumption, checked by a post-call tripwire.
- COMPLETION_MAX = 1500 tokens per provider step, clamped downward into
  every generate call.
- Agentic need = steps*P + (comp+TOOLS_PER_STEP_MAX*tool)*steps*
  (steps-1)/2 + steps*comp with AGENT_MAX_STEPS=5, TOOL_OUT_MAX_BYTES=1500
  (tool outputs are byte-truncated in the child) and TOOLS_PER_STEP_MAX=4
  tool slots per step (each slot can hold a large output).
- The reserved budget travels into the child UsageTape, which refuses
  before every provider call whose actual prompt bytes + requested
  completion exceed the remaining budget. The post-call reconciliation is
  a tripwire (a breach aborts), not the primary cap.
- The child validates the whole task/configuration (kind, messages, brief,
  defaults, limits, sandbox, container name, steps, budget shape) before
  constructing the provider.

Provider factories are deployment configuration, like pricing: the gate
guarantees every execution is reserved and accounted, but a factory that
bills during build is outside the accounting boundary (same class as a
wrong price table; both are supervisor-owned config and fail closed when
absent).
"""
import subprocess

from . import attribution
from . import r15
from . import schema as schema_mod
from . import timeout as timeout_mod

# mechanism constants (see module docstring; plan/10 §10.4.1: a change needs a doc edit and a fresh paper window)
COMPLETION_MAX = 1500
AGENT_MAX_STEPS = 5
TOOL_OUT_MAX_BYTES = 1500
TOOLS_PER_STEP_MAX = 4
PROMPT_BYTES_MAX = 32768
BRIEF_CHARS_MAX = 8192
IDENT_MAX = 64

# import allowlist (doc 08 §8.2, exact)
ALLOWLIST = {"json", "re", "datetime", "urllib", "xml", "html", "math",
             "statistics", "collections", "itertools", "hashlib",
             "base64", "requests", "bs4", "lxml", "pydantic", "pandas",
             "feedparser"}
FORBIDDEN = {"subprocess", "os", "sys", "socket", "pickle", "yaml",
             "shutil", "pathlib", "open"}


class ConfigBlocked(Exception):
    pass


def scan_imports(code):
    """Pre-execution static scan: literal imports and dynamic loading
    (__import__, importlib.import_module) must resolve to allowlisted
    top-level modules; anything else, including unparseable code, is
    rejected.

    AST catches every statically visible load. Deliberately obfuscated loads
    (eval-built strings) are not statically decidable; the Docker sandbox
    firewall/proxy is the boundary for those.
    Returns (ok, offending_name_or_None)."""
    import ast
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


def _check_ident(name, value):
    if not isinstance(value, str) or not 0 < len(value) <= IDENT_MAX:
        raise r15.AbortCycle("gate", {"bad-identity": name})


def _truncate_bytes(text, limit):
    raw = text.encode("utf-8", "replace")[:limit]
    return raw.decode("utf-8", "replace")


def _bounded_repr(exc, limit=256):
    """Exception text without materializing a hostile message: reprlib
    bounds containers/strings/levels before the final truncate."""
    import reprlib
    fmt = reprlib.Repr()
    fmt.maxstring = limit
    fmt.maxother = limit
    try:
        text = fmt.repr(exc)
    except Exception:
        text = "%s: <unrepresentable>" % type(exc).__name__
    return _truncate_bytes(text, limit)


# bounds for tool-output shaping
_TOOL_STR_SLICE = TOOL_OUT_MAX_BYTES * 4  # chars (pre-truncate slice)
_TOOL_INT_BITS_MAX = 65536
_TOOL_JSON_NODES_MAX = 4096
_TOOL_JSON_STR_MAX = 8192


def _bounded_tool_text(out):
    """Shape a tool return into bounded text: no repr() of arbitrary
    objects, no full encode of huge strings, no unbounded JSON dumps."""
    if isinstance(out, str):
        # slice first, then byte-truncate; the full string is never encoded
        if len(out) > _TOOL_STR_SLICE:
            out = out[:_TOOL_STR_SLICE]
        return _truncate_bytes(out, TOOL_OUT_MAX_BYTES)
    if isinstance(out, bytes):
        # decode only the prefix that can survive truncation (+4 bytes for a split multibyte char)
        return _truncate_bytes(
            out[:TOOL_OUT_MAX_BYTES + 4].decode("utf-8", "replace"),
            TOOL_OUT_MAX_BYTES)
    if out is None or isinstance(out, (bool, float)):
        return _truncate_bytes(repr(out), TOOL_OUT_MAX_BYTES)
    if isinstance(out, int):
        # a huge int's repr is ~1 char per 3.3 bits: gate by bit length
        try:
            bits = out.bit_length()
        except (AttributeError, OverflowError):
            bits = _TOOL_INT_BITS_MAX + 1
        if bits > _TOOL_INT_BITS_MAX:
            return "<int:%d-bits>" % bits
        return _truncate_bytes(repr(out), TOOL_OUT_MAX_BYTES)
    if isinstance(out, (dict, list)):
        import json
        ok, _why = schema_mod.json_safe(
            out, max_nodes=_TOOL_JSON_NODES_MAX,
            max_str=_TOOL_JSON_STR_MAX)
        if not ok:
            return "<unserializable-tool-output:%s>" % type(out).__name__
        try:
            raw = json.dumps(out, sort_keys=True, default=str)
        except (TypeError, ValueError):
            return "<unserializable-tool-output:%s>" % type(out).__name__
        return _truncate_bytes(raw, TOOL_OUT_MAX_BYTES)
    return "<tool-output:%s>" % type(out).__name__


def _usage_of(msg):
    """(prompt_tokens, completion_tokens) from a provider message, or None
    when unaccountable (missing, non-integer, negative); the caller then
    settles the full reservation."""
    usage = getattr(msg, "token_usage", None)
    if usage is None:
        return None
    try:
        pt = getattr(usage, "input_tokens", 0) or 0
        ct = getattr(usage, "output_tokens", 0) or 0
    except (TypeError, ValueError):
        return None
    if type(pt) is not int or type(ct) is not int or pt < 0 or ct < 0:
        return None
    return [pt, ct]


class UsageTape:
    """Child-side usage accumulator: wraps a raw provider, clamps per-call
    max_tokens downward to the completion bound, refuses before every
    provider call whose prompt bytes + requested completion exceed the
    remaining reserved budget, and sums usage across multi-step agent runs.
    Unaccountable usage poisons the tape (totals() -> None) and the parent
    settles the full reservation."""

    def __init__(self, provider, completion_max, token_budget=None):
        self._provider = provider
        self._completion_max = completion_max
        # reserved token budget from the parent; None is the unit-test path with no budget
        self._remaining = token_budget
        self._pt = 0
        self._ct = 0
        self._ok = True
        self.calls = 0

    def _prompt_bytes(self, messages):
        try:
            raw = schema_mod.canon(messages)
        except (TypeError, ValueError):
            raw = None
        if raw is not None:
            return len(raw)
        # provider message objects (e.g. smolagents ChatMessage): project the
        # known text fields instead of serializing arbitrary objects
        try:
            proj = []
            for m in messages:
                role = getattr(m, "role", None)
                # smolagents passes a MessageRole enum: project its value
                role = getattr(role, "value", role)
                content = getattr(m, "content", None)
                if not isinstance(role, str):
                    raise ValueError("unprojectable-role")
                if isinstance(content, str):
                    proj.append({"role": role, "content": content})
                elif isinstance(content, list):
                    # canon() returns bytes: decode (ASCII-safe via ensure_ascii) before embedding
                    proj.append({"role": role,
                                 "content": schema_mod.canon(
                                     content).decode("ascii")})
                else:
                    raise ValueError("unprojectable-content")
            return len(schema_mod.canon(proj))
        except (TypeError, ValueError):
            raise ConfigBlocked("tape-messages-unserializable")

    def generate(self, messages, **kwargs):
        try:
            asked = int(kwargs.get("max_tokens", self._completion_max))
        except (TypeError, ValueError):
            asked = self._completion_max
        comp = max(1, min(asked, self._completion_max))
        if self._remaining is not None:
            prompt_bytes = self._prompt_bytes(messages)
            if prompt_bytes + comp > self._remaining:
                # the outbound prompt does not fit the reserved budget: refuse before the provider is touched
                raise ConfigBlocked(
                    "prompt-exceeds-reservation:%d+%d>%d" %
                    (prompt_bytes, comp, self._remaining))
        kwargs["max_tokens"] = comp
        msg = self._provider.generate(messages, **kwargs)
        self.calls += 1
        usage = _usage_of(msg)
        if usage is None:
            self._ok = False
        else:
            self._pt += usage[0]
            self._ct += usage[1]
            if self._remaining is not None:
                self._remaining -= (usage[0] + usage[1])
        return msg

    def totals(self):
        if not self._ok:
            return None
        return [self._pt, self._ct]

    def __getattr__(self, name):
        return getattr(self.__dict__["_provider"], name)


class _ChildTool:
    """Child-side tool wrapper: counts calls, byte-truncates outputs (the
    parent's token bound relies on it) and records per-tool evidence for the
    parent to span. Never builds an unbounded repr() just to truncate it:
    strings slice then truncate, bytes decode bounded, small primitives repr
    directly, huge ints and arbitrary objects become placeholders."""

    def __init__(self, tool):
        self._tool = tool
        self.calls = 0
        self.records = []
        try:
            self.__name__ = getattr(tool, "__name__", "tool")
        except TypeError:
            self.__name__ = "tool"

    def __call__(self, *args, **kwargs):
        self.calls += 1
        try:
            out = self._tool(*args, **kwargs)
        except Exception as e:
            self.records.append({"ok": False,
                                 "reason": _bounded_repr(e)})
            raise
        self.records.append({"ok": True})
        return _bounded_tool_text(out)


class _ChildExec:
    """Child-side executor wrapper: AST scan before execution, call
    counting, output truncation. The parent reserved the budget up front."""

    def __init__(self, delegate):
        self._delegate = delegate
        self.calls = 0

    def __call__(self, code):
        ok, bad = scan_imports(code)
        if not ok:
            raise ConfigBlocked(
                "generated code failed import scan: %s" % bad)
        self.calls += 1
        out = self._delegate(code)
        # pass executor protocol objects through, truncating only their text
        # (stringifying a CodeOutput would lose is_final_answer)
        if isinstance(out, str):
            return _truncate_bytes(out, TOOL_OUT_MAX_BYTES)
        try:
            from smolagents.local_python_executor import CodeOutput
        except ImportError:
            return out
        if isinstance(out, CodeOutput) and isinstance(out.output, str):
            out.output = _truncate_bytes(out.output,
                                         TOOL_OUT_MAX_BYTES)
        return out

    def __getattr__(self, name):
        return getattr(self.__dict__["_delegate"], name)


SANDBOX_REQUIRED = ("image_digest", "proxy_network", "seccomp_profile",
                    "apparmor_profile")


def _sandbox_kwargs(sandbox_cfg):
    """Locked runtime spec -> docker container kwargs. A missing proxy
    network is ConfigBlocked."""
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


def make_raw_provider(provider_cfg):
    """Module-level provider factory (picklable by reference): build the
    raw provider with host egress forced through the deployment allowlist
    proxy. provider_cfg needs model_id + egress_proxy (+ api_base/api_key).
    No proxy -> ConfigBlocked, never direct."""
    proxy = (provider_cfg or {}).get("egress_proxy")
    if not proxy:
        raise ConfigBlocked("provider egress proxy not configured")
    model_id = (provider_cfg or {}).get("model_id")
    if not model_id:
        raise ConfigBlocked("provider model_id not configured")
    try:
        from smolagents import OpenAIServerModel
    except ImportError as e:
        raise ConfigBlocked("smolagents unavailable: %s" % e)
    try:
        import httpx
    except ImportError as e:
        raise ConfigBlocked("httpx unavailable: %s" % e)
    # httpx.Client(proxy=...) is ignored by some httpx versions (silently
    # direct), so the proxy is pinned on an explicit HTTPTransport
    transport = httpx.HTTPTransport(proxy=proxy)
    return OpenAIServerModel(
        model_id=model_id,
        api_base=provider_cfg.get("api_base"),
        api_key=provider_cfg.get("api_key"),
        client_kwargs={"http_client": httpx.Client(
            transport=transport)})


def _record_brief(rec):
    return str({k: rec.get(k) for k in
                    ("source_id", "kind", "title", "published_ns")
                if k in rec})[:2000]


# child-result bounds, enforced in the child before IPC
RESULT_TEXT_MAX_BYTES = 1 << 20
CHILD_CANDIDATES_MAX = 256
CHILD_CANDIDATE_BYTES_MAX = 16384
CHILD_TOOL_RECORDS_MAX = 64
# Reservation bound for the agent's first outbound prompt beyond the task
# brief: CodeAgent framing measured 9330 bytes for a 4-byte brief with no
# tools; 32 KiB adds headroom for small tool sets. The UsageTape checks the
# actual per-call prompt and refuses pre-provider if a tool-heavy config
# exceeds it. Do not shrink below a fresh measurement.
EXTRACT_PROMPT_OVERHEAD_BYTES = 32768


def _to_candidates(result, rec_defaults):
    """Shape agent output into advisory candidate dicts. Native lists/dicts
    are accepted; JSON text is parsed (text over RESULT_TEXT_MAX_BYTES is
    rejected before json.loads); anything else yields [] (the graph counts
    the empty extract). At most CHILD_CANDIDATES_MAX dicts are shaped, each
    JSON-safe and canonically small. Shaping is not evidence; the resolver
    decides."""
    import json
    if isinstance(result, dict):
        data = [result]
    elif isinstance(result, list):
        data = result
    elif isinstance(result, str):
        # byte cap before json.loads; the char count avoids encoding huge text (utf-8 bytes >= chars)
        if len(result) > RESULT_TEXT_MAX_BYTES or \
                len(result.encode("utf-8", "replace")) > \
                RESULT_TEXT_MAX_BYTES:
            return []
        try:
            data = json.loads(result)
        except (ValueError, TypeError):
            return []
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            return []
    else:
        return []
    out = []
    for c in data[:CHILD_CANDIDATES_MAX]:
        if not isinstance(c, dict):
            continue
        ok, _why = schema_mod.json_safe(c)
        if not ok:
            continue
        try:
            if len(schema_mod.canon(c)) > CHILD_CANDIDATE_BYTES_MAX:
                continue
        except (TypeError, ValueError):
            continue
        out.append({
            "kind": c.get("kind", rec_defaults.get("kind",
                                                   "filing_event")),
            "symbols": c.get("symbols", list(rec_defaults.get("symbols",
                                                              []))),
            "value": c.get("value",
                           {"type": "enum", "v": "unspecified"}),
            "effect": "unknown",  # the resolver decides, never the model
            "provenance_url": c.get("provenance_url",
                                    rec_defaults.get("provenance_url"))})
    return out


def _token_need(kind, prompt_bytes, completion_max, steps):
    if kind == "generate":
        return prompt_bytes + completion_max
    # Closed-form multi-step bound: each step's context holds the initial
    # prompt plus all prior completions and tool outputs. Tool growth per
    # prior step is TOOLS_PER_STEP_MAX slots of up to TOOL_OUT_MAX_BYTES each,
    # not one output per step.
    per_step_growth = (completion_max +
                       TOOLS_PER_STEP_MAX * TOOL_OUT_MAX_BYTES)
    return (steps * prompt_bytes +
            per_step_growth * steps * (steps - 1) // 2 +
            steps * completion_max)


CONTAINER_NAME_RE = None  # compiled lazily below


def _valid_container_name(name):
    import re
    global CONTAINER_NAME_RE
    if CONTAINER_NAME_RE is None:
        CONTAINER_NAME_RE = re.compile(r"[A-Za-z0-9_.\-]{1,128}")
    return isinstance(name, str) and bool(
        CONTAINER_NAME_RE.fullmatch(name))


def _llm_child_main(payload):
    """Worker-child entry (spawn context). Builds everything from configs,
    executes, returns a JSON-safe envelope. Never touches ledgers. Statuses:
      ok: {"result", "usage" ([pt,ct] or None), "tool_calls"}
      config-error: build-time failure; provider untouched by our build path
        (the factory itself is trusted config)
      provider-error: anything after the provider may have been touched
        (ambiguous by construction).

    The whole task/configuration validates first and the provider factory runs
    only after every check passes, so an invalid sandbox/task/config returns
    config-error with the factory untouched."""
    if not isinstance(payload, dict):
        return {"status": "config-error", "reason": "bad-payload"}
    kind = payload.get("kind")
    if kind not in ("generate", "extract"):
        return {"status": "config-error", "reason": "bad-kind"}
    factory = payload.get("provider_factory")
    if not callable(factory):
        return {"status": "config-error",
                "reason": "factory-not-callable"}
    provider_cfg = payload.get("provider_cfg")
    if not isinstance(provider_cfg, dict):
        return {"status": "config-error",
                "reason": "provider-cfg-shape"}
    max_tokens = payload.get("max_tokens")
    if type(max_tokens) is not int or \
            not 1 <= max_tokens <= COMPLETION_MAX:
        return {"status": "config-error", "reason": "bad-max-tokens"}
    token_budget = payload.get("token_budget")
    if type(token_budget) is not int or token_budget < 0:
        return {"status": "config-error",
                "reason": "bad-token-budget"}
    messages = brief = rec_defaults = None
    steps = 1
    sandbox_cfg = {}
    container_name = ""
    if kind == "generate":
        messages = payload.get("messages")
        ok, why = schema_mod.json_safe(messages)
        if not ok:
            return {"status": "config-error",
                    "reason": "messages:%s" % why}
        try:
            if len(schema_mod.canon(messages)) > PROMPT_BYTES_MAX:
                return {"status": "config-error",
                        "reason": "prompt-too-large"}
        except (TypeError, ValueError):
            return {"status": "config-error",
                    "reason": "messages-unserializable"}
    else:
        try:
            sandbox_cfg = payload["sandbox_cfg"]
            _sandbox_kwargs(sandbox_cfg)
        except (KeyError, TypeError, ConfigBlocked) as e:
            return {"status": "config-error",
                    "reason": _truncate_bytes("sandbox:%r" % (e,),
                                              256)}
        container_name = payload.get("container_name")
        if not _valid_container_name(container_name):
            return {"status": "config-error",
                    "reason": "bad-container-name"}
        for key in ("tool_factory", "executor_factory"):
            fac = payload.get(key)
            if fac is not None and not callable(fac):
                return {"status": "config-error",
                        "reason": "bad-%s" % key}
        brief = payload.get("brief")
        rec_defaults = payload.get("rec_defaults")
        steps = payload.get("steps")
        if (not isinstance(brief, str) or not brief or
                len(brief) > BRIEF_CHARS_MAX):
            return {"status": "config-error", "reason": "bad-brief"}
        ok, why = schema_mod.json_safe(rec_defaults)
        if not ok:
            return {"status": "config-error",
                    "reason": "rec-defaults:%s" % why}
        if type(steps) is not int or \
                not 1 <= steps <= AGENT_MAX_STEPS:
            return {"status": "config-error", "reason": "bad-steps"}
    # validation complete: only now may the provider be constructed
    try:
        provider = factory(provider_cfg)
    except Exception as e:
        return {"status": "config-error",
                "reason": _truncate_bytes("factory:%r" % (e,), 256)}
    if not hasattr(provider, "generate"):
        return {"status": "config-error", "reason": "factory-no-model"}
    tape = UsageTape(provider, max_tokens, token_budget)
    if kind == "generate":
        try:
            msg = tape.generate(messages, max_tokens=max_tokens)
        except ConfigBlocked as e:
            # pre-provider refusal (budget fit): provider untouched, clean config-error
            return {"status": "config-error",
                    "reason": _truncate_bytes(str(e), 256)}
        except Exception as e:
            return {"status": "provider-error",
                    "reason": _bounded_repr(e)}
        text = getattr(msg, "content", None)
        if isinstance(text, str) and \
                len(text.encode("utf-8")) > RESULT_TEXT_MAX_BYTES:
            # oversize provider text is dropped here, before IPC (the parent accounts
            # the spend and records result-too-large, as for its own post-IPC check);
            # measuring costs one transient encode in the disposable child
            text = None
        return {"status": "ok",
                "text": text if isinstance(text, str) else None,
                "usage": tape.totals(), "tool_calls": 0}
    if kind == "extract":
        try:
            from smolagents import CodeAgent
        except ImportError as e:
            return {"status": "config-error",
                    "reason": "smolagents:%r" % (e,)}
        # task/config validated above; only construction that cannot touch the provider remains
        container_kwargs = _sandbox_kwargs(sandbox_cfg)
        container_kwargs["name"] = container_name
        try:
            tool_factory = payload.get("tool_factory")
            raw_tools = tool_factory() if tool_factory else []
        except Exception as e:
            return {"status": "config-error",
                    "reason": _truncate_bytes("tools:%r" % (e,), 256)}
        if not isinstance(raw_tools, (list, tuple)) or \
                len(raw_tools) > 64:
            return {"status": "config-error",
                    "reason": "bad-tools"}
        wrapped_tools = [_ChildTool(t) for t in raw_tools]
        try:
            executor_factory = payload.get("executor_factory")
            if executor_factory is not None:
                executor = executor_factory()
            else:
                from smolagents import DockerExecutor
                executor = DockerExecutor(
                    additional_imports=[],
                    logger=None,
                    image_name=sandbox_cfg["image_digest"],
                    build_new_image=False,
                    container_run_kwargs=container_kwargs)
        except Exception as e:
            return {"status": "config-error",
                    "reason": _truncate_bytes("executor:%r" % (e,),
                                              256)}
        cleanup_note = None
        try:
            agent = CodeAgent(
                tools=wrapped_tools,
                model=tape,
                additional_authorized_imports=sorted(ALLOWLIST),
                executor=executor, max_steps=steps)
            agent.python_executor = _ChildExec(agent.python_executor)
            result = agent.run(
                "Extract advisory feature candidates as JSON from: %s"
                % brief)
        except ConfigBlocked as e:
            # pre-provider refusal inside the agent loop (tape budget or import scan): provider untouched
            return {"status": "config-error",
                    "reason": _truncate_bytes(str(e), 256)}
        except Exception as e:
            return {"status": "provider-error",
                    "reason": _bounded_repr(e)}
        finally:
            # child-side cleanup outcome rides the envelope; on failure the parent
            # reclaims the container after the child (a successful result must not leak it)
            for meth in ("cleanup", "delete"):
                try:
                    getattr(executor, meth, lambda: None)()
                except Exception as e:
                    if cleanup_note is None:
                        cleanup_note = _bounded_repr(e)
        tool_calls = sum(t.calls for t in wrapped_tools)
        tool_calls += getattr(agent.python_executor, "calls", 0)
        cands = _to_candidates(result, rec_defaults)
        records = [r for t in wrapped_tools for r in t.records]
        return {"status": "ok", "candidates": cands,
                "usage": tape.totals(), "tool_calls": tool_calls,
                "tool_records": records[:CHILD_TOOL_RECORDS_MAX],
                "cleanup": cleanup_note}
    return {"status": "config-error", "reason": "bad-kind"}


def _clamp_completion(asked):
    try:
        asked = int(asked)
    except (TypeError, ValueError):
        asked = COMPLETION_MAX
    # downward only: callers shrink the bound, never widen it
    return max(1, min(asked, COMPLETION_MAX))


def _release_pre_provider(budget, governor, lease, lease_id,
                          release_hold=True):
    """Unwind a pre-provider reservation (provider untouched): settle the R15
    lease at zero and release the dollar hold. Returns None when both unwind
    cleanly, else a diagnostic dict; the caller aborts with it and the
    conservative reservation stays in place. Rule: pre-provider cleanup
    failure -> cycle abort + preserved reservation + diagnostic snapshot."""
    cleanup = {}
    try:
        budget.settle_call(lease, 0)
    except r15.AbortCycle as e:
        cleanup["lease-cleanup-failed"] = str(e.snapshot)
    if release_hold:
        try:
            governor.settle_usd(lease_id)
        except Exception as e:
            cleanup["hold-cleanup-failed"] = _bounded_repr(e)
    return cleanup or None


def run_gated(kind, node, symbol, cycle_id, epoch, task, provider_cfg,
              provider_factory, sandbox_cfg, budget, governor,
              model_id, log_path, timeout_s, max_tokens_asked=None,
              tool_factory=None, executor_factory=None, steps=None,
              container_name=None, entry_tier=None):
    """Invocation gate (parent process). Every provider touch in production
    passes through here, in this order:

    0. snapshot Tier-3 pre-filter (clean refusal),
    1. validate identities + task shape (clean failures),
    2. price lookup (missing pricing blocks clean),
    3. R15 reservation of the true token bound (clean refusal),
    4. durable tier check + worst-case dollar hold against the stage cap in
       one tier-lock section (reserve_research_call: Tier 3, a tier raised
       above entry_tier, or unverifiable tier state refuse clean),
    5. mark invoked, spawn the worker child, await with hard kill,
    6. settle actuals + exactly one span + hold release (any failure here is
       AbortCycle),
    7. ambiguous outcomes (timeout/crash/provider-error/unaccountable usage)
       settle the full reservation as UNKNOWN_SPEND, keep the hold, poison the
       R15 row and AbortCycle (future spend blocks until reconcile_unknown).

    kind: "generate" (task={messages, max_tokens_asked?}) or "extract"
    (task={brief, rec_defaults}). Returns the child result payload on accounted
    success: {"text"...} or {"candidates"...}. A malformed provider result
    (not accounting) returns {"blocked": reason} with accounting settled; the
    graph records drop+count, no abort.
    """
    _check_ident("node", node)
    _check_ident("symbol", symbol)
    _check_ident("cycle", cycle_id)
    # snapshot Tier-3 pre-filter, before any reservation. Not the authority: a
    # stale snapshot passes and step 4 (reserve_research_call) re-reads the
    # durable tier atomically with the hold. SpendRefused lives in spend;
    # importing it here would be circular.
    governor.check_research_tier(entry_tier)
    if type(epoch) is not int or not 0 <= epoch <= 2 ** 31 - 1:
        raise r15.AbortCycle("gate", {"bad-identity": "epoch"})
    if kind not in ("generate", "extract"):
        raise r15.AbortCycle("gate", {"bad-kind": kind})
    if not callable(provider_factory):
        raise ConfigBlocked("provider_factory not callable")
    # timeout is control-plane input: an invalid value blocks the attempt
    if (type(timeout_s) not in (int, float) or
            not timeout_s == timeout_s or
            not 0 < timeout_s <= 3600):
        raise ConfigBlocked("bad-timeout:%r" % (timeout_s,))
    # the priced model_id and the model the provider config names must be the
    # same string; a mismatch is a clean refusal before any reservation
    if not isinstance(provider_cfg, dict):
        raise ConfigBlocked("provider-cfg-shape")
    ok, why = schema_mod.json_safe(provider_cfg)
    if not ok:
        raise ConfigBlocked("provider-cfg:%s" % why)
    if provider_cfg.get("model_id") != model_id:
        raise ConfigBlocked("model-identity-mismatch:%r" %
                            (provider_cfg.get("model_id"),))
    # single pricing authority: the governor's deployment table (a second
    # table could diverge from cap enforcement)
    price = governor.price_for(model_id)

    steps = AGENT_MAX_STEPS if steps is None else steps
    if type(steps) is not int or not 1 <= steps <= AGENT_MAX_STEPS:
        raise r15.AbortCycle("gate", {"bad-steps": steps})
    comp = _clamp_completion(
        COMPLETION_MAX if max_tokens_asked is None else max_tokens_asked)
    if kind == "generate":
        messages = task.get("messages") if isinstance(task, dict) \
            else None
        ok, why = schema_mod.json_safe(messages)
        if not ok:
            raise ConfigBlocked("generate-messages:%s" % why)
        prompt_bytes = len(schema_mod.canon(messages))
        if prompt_bytes > PROMPT_BYTES_MAX:
            raise ConfigBlocked("prompt-too-large")
        need = _token_need("generate", prompt_bytes, comp, 1)
        tools_needed = 0
        brief, rec_defaults = "", {}
    else:
        if not isinstance(task, dict):
            raise ConfigBlocked("extract-task-shape")
        brief = task.get("brief", "")
        rec_defaults = task.get("rec_defaults", {})
        if not isinstance(brief, str) or not brief or \
                len(brief) > BRIEF_CHARS_MAX:
            raise ConfigBlocked("extract-brief")
        ok, why = schema_mod.json_safe(rec_defaults)
        if not ok:
            raise ConfigBlocked("extract-defaults:%s" % why)
        prompt_bytes = len(brief.encode("utf-8"))
        # true outbound bound: the brief plus the agent framing the provider
        # receives (system instructions, task framing, tool descriptions);
        # brief-only would understate the first call and trip the tape refusal
        prompt_bytes += EXTRACT_PROMPT_OVERHEAD_BYTES
        need = _token_need("extract", prompt_bytes, comp, steps)
        tools_needed = steps * TOOLS_PER_STEP_MAX
        messages = None
    if need > r15.TOKENS:
        # a bound that cannot fit the cycle is refused before any spend (counted upstream as blocked evidence)
        raise ConfigBlocked("call-bound-exceeds-cycle")

    # pre-call gates: R15 tokens first, then absolute dollars; a refusal is clean (provider untouched)
    lease = budget.reserve_call(need, tools_needed)
    lease_id = "spend:%s" % lease["lease_id"]
    try:
        worst = governor.worst_usd(model_id, need)
        governor.reserve_research_call(worst, lease_id,
                                       entry_tier=entry_tier)
    except Exception as orig:
        cleanup = _release_pre_provider(
            budget, governor, lease, lease_id, release_hold=False)
        if cleanup is not None:
            cleanup["original"] = _bounded_repr(orig)
            raise r15.AbortCycle(
                symbol, {"pre-provider-cleanup-failure": cleanup})
        raise
    try:
        governor.mark_invoked(lease_id)
    except Exception as orig:
        cleanup = _release_pre_provider(budget, governor, lease,
                                        lease_id)
        if cleanup is not None:
            cleanup["original"] = _bounded_repr(orig)
            raise r15.AbortCycle(
                symbol, {"pre-provider-cleanup-failure": cleanup})
        raise

    if container_name is None:
        container_name = "miro-%s-%s-%d" % (cycle_id, symbol,
                                            lease["seq"])
    if not _valid_container_name(container_name):
        cleanup = _release_pre_provider(budget, governor, lease,
                                        lease_id)
        if cleanup is not None:
            cleanup["original"] = "bad-container-name"
            raise r15.AbortCycle(
                symbol, {"pre-provider-cleanup-failure": cleanup})
        raise ConfigBlocked("bad-container-name")
    payload = {"kind": kind, "provider_factory": provider_factory,
               "provider_cfg": dict(provider_cfg),
               "max_tokens": comp, "container_name": container_name,
               "token_budget": need}
    if kind == "generate":
        payload["messages"] = messages
    else:
        payload["sandbox_cfg"] = dict(sandbox_cfg or {})
        payload["brief"] = brief
        payload["rec_defaults"] = rec_defaults
        payload["steps"] = steps
        payload["tool_factory"] = tool_factory
        payload["executor_factory"] = executor_factory
    # spawn pickles the payload: unpicklable task content must fail here (clean), not as a child crash
    import pickle
    try:
        pickle.dumps(payload)
    except Exception as e:
        cleanup = _release_pre_provider(budget, governor, lease,
                                        lease_id)
        if cleanup is not None:
            cleanup["original"] = "task-unpicklable:%r" % (e,)
            raise r15.AbortCycle(
                symbol, {"pre-provider-cleanup-failure": cleanup})
        raise ConfigBlocked("task-unpicklable:%r" % (e,))

    try:
        child = timeout_mod.run_in_process(_llm_child_main, timeout_s,
                                           payload)
    except timeout_mod.CallTimeout:
        note = _unknown(budget, governor, log_path, epoch, node,
                        model_id, cycle_id, symbol, lease, lease_id,
                        worst, need, "timeout", container_name)
        raise r15.AbortCycle(symbol, {"timeout": True,
                                      "unknown-spend": worst,
                                      "reap": note})
    except Exception as e:
        # run_in_process transport failure (not a child envelope): the child may
        # or may not have run, so ambiguous like a timeout
        note = _unknown(budget, governor, log_path, epoch, node,
                        model_id, cycle_id, symbol, lease, lease_id,
                        worst, need, "transport:%r" % (e,),
                        container_name)
        raise r15.AbortCycle(symbol, {"transport-ambiguous": True,
                                      "unknown-spend": worst,
                                      "reap": note})

    status = child.get("status") if isinstance(child, dict) else None
    if status == "config-error":
        # build-time failure through our build path: provider untouched. Settle the
        # reservation at zero, release the hold, no span; the graph records blocked evidence
        cleanup = _release_pre_provider(budget, governor, lease,
                                        lease_id)
        if cleanup is not None:
            cleanup["original"] = str(child.get("reason",
                                                 "config-error"))
            raise r15.AbortCycle(
                symbol, {"pre-provider-cleanup-failure": cleanup})
        raise ConfigBlocked(str(child.get("reason", "config-error")))
    if status == "provider-error":
        note = _unknown(budget, governor, log_path, epoch, node,
                        model_id, cycle_id, symbol, lease, lease_id,
                        worst, need, "provider-error", container_name)
        raise r15.AbortCycle(symbol, {"provider-error": True,
                                      "unknown-spend": worst,
                                      "reap": note})
    if status != "ok" or not isinstance(child, dict):
        note = _unknown(budget, governor, log_path, epoch, node,
                        model_id, cycle_id, symbol, lease, lease_id,
                        worst, need, "bad-envelope", container_name)
        raise r15.AbortCycle(symbol, {"bad-envelope": True,
                                      "unknown-spend": worst,
                                      "reap": note})

    usage = child.get("usage")
    if (not isinstance(usage, list) or len(usage) != 2 or
            type(usage[0]) is not int or type(usage[1]) is not int or
            usage[0] < 0 or usage[1] < 0):
        # the call happened but its cost is unknowable: keep the full reservation as UNKNOWN_SPEND
        note = _unknown(budget, governor, log_path, epoch, node,
                        model_id, cycle_id, symbol, lease, lease_id,
                        worst, need, "unaccountable-usage",
                        container_name)
        raise r15.AbortCycle(symbol, {"unaccountable-usage": True,
                                      "unknown-spend": worst,
                                      "reap": note})
    actual = usage[0] + usage[1]
    tool_calls = child.get("tool_calls", 0)
    if type(tool_calls) is not int or tool_calls < 0:
        tool_calls = tools_needed + 1  # force the breach path below
    if actual > need or tool_calls > tools_needed:
        # post-call tripwire: the bound was violated. Record truth, then abort;
        # every accounting step reports into the abort snapshot
        breach = {"bound-breach": actual}
        try:
            budget.settle_call(lease, actual)
        except r15.AbortCycle as e:
            breach["settle-failed"] = str(e.snapshot)
        try:
            usd = (actual / 1000.0) * price
            _span(log_path, epoch, node, model_id, cycle_id, symbol,
                  usage[0], usage[1], usd, "error", lease)
            governor.settle_usd(lease_id)
        except Exception as e:
            breach["span-or-settle-failed"] = _bounded_repr(e)
        try:
            budget.invalidate()
        except r15.AbortCycle as e:
            breach["invalidate-failed"] = str(e.snapshot)
        raise r15.AbortCycle(symbol, breach)
    # accounted success: settle actuals, exactly one span, release the hold.
    # Any failure from here is AbortCycle: the call was real.
    try:
        budget.settle_call(lease, actual)
        _span(log_path, epoch, node, model_id, cycle_id, symbol,
              usage[0], usage[1], (actual / 1000.0) * price,
              "success", lease)
        governor.settle_usd(lease_id)
    except r15.AbortCycle:
        raise
    except Exception as e:
        try:
            budget.invalidate()
        except r15.AbortCycle:
            pass
        raise r15.AbortCycle(symbol, {"accounting-failure": _bounded_repr(e)})
    return _shape_success_result(kind, child, usage, tool_calls,
                                 container_name)


def _shape_success_result(kind, child, usage, tool_calls,
                          container_name):
    """Shape an accounted ok-envelope into a run_gated result. Pure shaping
    plus the container reclaim: spend is already settled and spanned, so every
    outcome here is a result or blocked evidence, never an abort. Split out so
    the cleanup-before-shape ordering is unit-testable without spawning."""
    if kind == "generate":
        text = child.get("text")
        if text is None or not isinstance(text, str):
            # result failure with good accounting: blocked evidence, not an abort
            return {"blocked": "non-string-output"}
        if len(text.encode("utf-8")) > RESULT_TEXT_MAX_BYTES:
            # second net behind the child-side drop: the spend is accounted, the
            # result is dropped and counted
            return {"blocked": "result-too-large"}
        return {"text": text, "usage": usage}
    cleanup_evidence = None
    if child.get("cleanup"):
        # child-side cleanup failed: reclaim the container here (the child is dead,
        # so docker rm -f cannot race it). Runs before candidate-shape
        # validation so a malformed result cannot skip surfacing the leak.
        try:
            _reap_container(container_name)
            cleanup_evidence = "container-reaped-by-parent"
        except Exception as e:
            return {"blocked": "reap-failed:%s" % _bounded_repr(e)}
    cands = child.get("candidates")
    if not isinstance(cands, list):
        blocked = "non-list-candidates"
        if cleanup_evidence is not None:
            blocked += "+%s" % cleanup_evidence
        return {"blocked": blocked}
    out = {"candidates": cands, "usage": usage,
           "tool_calls": tool_calls,
           "tool_records": child.get("tool_records", [])}
    if cleanup_evidence is not None:
        out["cleanup"] = cleanup_evidence
    return out


def _span(log_path, epoch, node, model_id, cycle_id, symbol, pt, ct,
          usd, outcome, lease):
    """Exactly one span for an accounted call. usd is explicit; ambiguous
    spans are written by _unknown with the full reservation."""
    attribution.append_span(
        log_path, epoch, node, model_id, cycle_id=cycle_id, stage="r",
        symbol=symbol, prompt_tokens=pt, completion_tokens=ct,
        usd=usd, category="research",
        outcome=outcome, is_unknown=False,
        span_id="%s:%s:%s:run:%d" % (cycle_id, symbol, node,
                                     lease["seq"]))


def _unknown(budget, governor, log_path, epoch, node, model_id,
             cycle_id, symbol, lease, lease_id, worst, need, outcome,
             container_name):
    """Ambiguous attempt. The spend hold (marked invoked pre-spawn) is never
    released on this path, so the dollars stay counted and future spend stays
    blocked even if every write below fails. Recording is one atomic ledger
    operation (record_unknown: span + unknown row + invoked mark); any failure
    there raises AbortCycle with an unresolved-spend snapshot.

    When worst == 0.0 (a free model) there are no uncertain dollars: the R15
    reservation still settles at the full bound and the row is poisoned, but
    no unknown rows are written (an unknown $0 row is rejected) and the hold
    is released, so nothing needs reconciling.

    Returns the container-reap note (None when reaped cleanly); a reap failure
    folds into the abort snapshot."""
    try:
        budget.settle_call(lease, need)
    except r15.AbortCycle:
        pass
    span_id = "%s:%s:%s:run:%d" % (cycle_id, symbol, node, lease["seq"])
    if worst > 0:
        try:
            attribution.record_unknown(
                log_path, lease_id, span_id, worst,
                "timeout" if outcome == "timeout" else "error",
                epoch, node, model_id, cycle_id, symbol)
        except Exception as e:
            # the hold stays invoked so the money is counted and has_unreconciled()
            # blocks on the invoked-hold backstop even without unknown rows
            try:
                budget.invalidate()
            except r15.AbortCycle:
                pass
            raise r15.AbortCycle(
                symbol, {"unresolved-spend": _bounded_repr(e),
                         "unknown-spend": worst})
    else:
        # zero-price ambiguity: no dollars uncertain, so release the hold and keep
        # the R15 poison; a surviving $0 hold can neither block nor move money
        try:
            governor.settle_usd(lease_id)
        except Exception:
            pass
    try:
        budget.invalidate()
    except r15.AbortCycle:
        pass
    try:
        _reap_container(container_name)
        return None
    except Exception as e:
        return "reap-failed:%s" % e


def _reap_container(container_name):
    """Post-kill container reclaim, best-effort: the child is dead, so no
    live worker uses the executor. Failure is reported via the exception
    message (folded into the abort snapshot); a leaked container wastes
    sandbox CPU, it does not move money."""
    if not container_name:
        return
    try:
        proc = subprocess.run(
            ["docker", "rm", "-f", container_name], timeout=30,
            capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError("docker rm failed: %s" %
                               _truncate_bytes(
                                   proc.stderr.decode("utf-8",
                                                      "replace")[:200],
                                   200))
    except FileNotFoundError:
        raise RuntimeError("docker unavailable for container reap")
