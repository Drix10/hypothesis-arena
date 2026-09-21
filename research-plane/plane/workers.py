"""D2 sandboxed execution gate (doc 08 sec. 8.2 + doc 10 sec. 10.4).

Frozen worker model: a smolagents CodeAgent over a prebuilt immutable
Docker image, non-root, read-only rootfs, dropped capabilities, CPU/
RAM/pids caps, seccomp/AppArmor, NO docker socket, NO writable trading-
tree mounts, and container egress ONLY on the deployment proxy network
that allowlists source APIs + the model provider (nothing else). The
prompt is NEVER the network boundary: enforcement lives in the sandbox
firewall/proxy, proven by the unauthorized-destination probe.

INVOCATION ARCHITECTURE (the gate owns everything; the child owns
nothing authoritative):
- The graph NEVER holds a model object. deps["provider_factory"] is a
  module-level callable (picklable by reference) that BUILDS a raw
  provider inside the worker child. No provider object exists in the
  parent process, so no code path can touch the provider without
  passing run_gated() first. A refused reservation means the child is
  never spawned and the factory never runs (proven, not documented).
- run_gated() (parent) performs, IN ORDER: input validation, worst-
  leg pricing lookup, TRUE pre-call token reservation (measured
  prompt-byte upper bound + completion bound; agentic runs add the
  closed-form multi-step growth bound), worst-case dollar HOLD against
  the stage cap, then spawn. The provider may be touched ONLY after
  all three succeed.
- The child (spawn context, hard-killed on timeout, reaped on every
  path) builds provider/agent/executor from configs, executes, and
  returns JSON-safe results + usage. It receives NO ledger paths and
  performs NO accounting — a timed-out child cannot write late
  accounting because it never could. Executor cleanup runs in the
  child on the normal path; on the kill path the parent reaps the
  named container best-effort AFTER the child is dead (never while a
  live worker may use it).
- Parent settlement is a HARD protocol: any accounting failure after
  the child was spawned is AbortCycle, never a downgraded blocked
  result. Ambiguous outcomes (timeout, child crash, provider error,
  unaccountable usage) settle the FULL reservation as UNKNOWN_SPEND
  (never $0) and block future spend until a supervisor reconciles.

Token bounds (frozen mechanism constants):
- Prompt upper bound = utf-8 bytes of the exact outbound prompt. True
  upper bound for byte-level-BPE providers (every token spans >= 1
  byte); documented assumption, tripwire-verified post-call.
- COMPLETION_MAX = 1500 tokens per provider step (clamped downward
  into every generate call; callers can only shrink).
- Agentic need = steps*P + (comp+TOOLS_PER_STEP_MAX*tool)*steps*
  (steps-1)/2 + steps*comp with AGENT_MAX_STEPS=5,
  TOOL_OUT_MAX_BYTES=1500 (tool outputs are byte-truncated in the
  child, so tool context is truly bounded) and TOOLS_PER_STEP_MAX=4
  tool slots per step (every slot counts — four large tool outputs
  on one step grow context by four outputs).
- The reserved budget travels into the child UsageTape, which
  refuses BEFORE every provider call whose actual prompt bytes +
  requested completion cannot fit the remaining budget. The
  post-call reconciliation is a tripwire (breach aborts), never the
  primary cap.
- The child validates the complete task/configuration BEFORE
  constructing the provider (kind, messages, brief, defaults,
  limits, sandbox, container name, steps, budget shape); only then
  does the factory run.

Provider factories are deployment configuration (like pricing): the
gate guarantees every execution is reserved + accounted; a factory
that billed during BUILD would be a compromised deployment, outside
the accounting boundary (documented, same class as a lying price
table — both are supervisor-owned config, both fail closed when
absent).
"""
import subprocess

from . import attribution
from . import r15
from . import schema as schema_mod
from . import timeout as timeout_mod

# Frozen mechanism constants (see module docstring; recorded in
# plan/10 §10.4.1 — change = doc edit + fresh paper window).
COMPLETION_MAX = 1500
AGENT_MAX_STEPS = 5
TOOL_OUT_MAX_BYTES = 1500
TOOLS_PER_STEP_MAX = 4
PROMPT_BYTES_MAX = 32768
BRIEF_CHARS_MAX = 8192
IDENT_MAX = 64

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


# Bounds for bounded tool-output shaping (never materialize more).
_TOOL_STR_SLICE = TOOL_OUT_MAX_BYTES * 4  # chars (pre-truncate slice)
_TOOL_INT_BITS_MAX = 65536
_TOOL_JSON_NODES_MAX = 4096
_TOOL_JSON_STR_MAX = 8192


def _bounded_tool_text(out):
    """Shape a tool return into bounded text WITHOUT ever building
    an unbounded representation: no repr() of arbitrary objects, no
    full encode of huge strings, no unbounded JSON dumps."""
    if isinstance(out, str):
        # Slice first (bounded copy), then byte-truncate: the full
        # string is never encoded.
        if len(out) > _TOOL_STR_SLICE:
            out = out[:_TOOL_STR_SLICE]
        return _truncate_bytes(out, TOOL_OUT_MAX_BYTES)
    if isinstance(out, bytes):
        # Bounded decode: only the prefix that can survive truncation
        # (+4 bytes so a split multibyte char degrades gracefully).
        return _truncate_bytes(
            out[:TOOL_OUT_MAX_BYTES + 4].decode("utf-8", "replace"),
            TOOL_OUT_MAX_BYTES)
    if out is None or isinstance(out, (bool, float)):
        return _truncate_bytes(repr(out), TOOL_OUT_MAX_BYTES)
    if isinstance(out, int):
        # A huge int's repr is ~1 char per 3.3 bits: gate by bit
        # length instead of materializing it.
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
    """(prompt_tokens, completion_tokens) from a provider message, or
    None when unaccountable (missing, non-integer, negative). The
    caller settles the FULL reservation on None — never fiction."""
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
    """Child-side usage accumulator: wraps a raw provider, clamps
    per-call max_tokens DOWNWARD to the completion bound, enforces
    the parent's reserved token budget BEFORE every provider call
    (prompt bytes + requested completion must fit the remaining
    budget — refusal happens pre-provider, never post-call), and sums
    usage across multi-step agent runs. No authority, pure counting —
    unaccountable usage poisons the tape (totals() -> None) and the
    parent settles the full reservation."""

    def __init__(self, provider, completion_max, token_budget=None):
        self._provider = provider
        self._completion_max = completion_max
        # Reserved budget from the parent (the pre-call R15/token
        # reservation). None = legacy unit-test path with no budget.
        self._remaining = token_budget
        self._pt = 0
        self._ct = 0
        self._ok = True
        self.calls = 0

    def _prompt_bytes(self, messages):
        try:
            raw = schema_mod.canon(messages)
        except (TypeError, ValueError):
            raise ConfigBlocked("tape-messages-unserializable")
        return len(raw)

    def generate(self, messages, **kwargs):
        try:
            asked = int(kwargs.get("max_tokens", self._completion_max))
        except (TypeError, ValueError):
            asked = self._completion_max
        comp = max(1, min(asked, self._completion_max))
        if self._remaining is not None:
            prompt_bytes = self._prompt_bytes(messages)
            if prompt_bytes + comp > self._remaining:
                # The actual outbound prompt does not fit the reserved
                # budget: refuse BEFORE the provider is touched.
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
    """Child-side tool wrapper: counts calls, byte-truncates outputs
    (bounded context growth — the parent's token bound relies on it),
    records per-tool evidence for the parent to span.

    Bounded-output discipline: NEVER build an unbounded repr() just
    to truncate it. Strings slice-then-truncate, bytes decode bounded,
    small primitives repr directly, huge ints/arbitrary objects become
    bounded placeholders without invoking their __repr__."""

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
                                 "reason": _truncate_bytes(repr(e),
                                                           256)})
            raise
        self.records.append({"ok": True})
        return _bounded_tool_text(out)


class _ChildExec:
    """Child-side executor wrapper: AST scan BEFORE execution (gate,
    not forensics), call counting, output truncation. No budget
    authority in the child — the parent reserved up front."""

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
        # Pass executor protocol objects through (truncating only
        # their text payloads): stringifying a CodeOutput would
        # destroy is_final_answer and break the agent loop.
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


def make_raw_provider(provider_cfg):
    """Module-level provider factory (picklable by reference): build
    the raw provider with host egress FORCED through the deployment
    allowlist proxy. provider_cfg needs model_id + egress_proxy
    (+ api_base/api_key). No proxy -> ConfigBlocked, never direct."""
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
    # NOTE: httpx.Client(proxy=...) is IGNORED by some httpx versions
    # (silently direct!). The proxy is pinned on an explicit
    # HTTPTransport, which is the version-stable enforcement point.
    transport = httpx.HTTPTransport(proxy=proxy)
    return OpenAIServerModel(
        model_id=model_id,
        api_base=provider_cfg.get("api_base"),
        api_key=provider_cfg.get("api_key"),
        client_kwargs={"http_client": httpx.Client(
            transport=transport)})


# Keep the historical name: make_model IS the raw-provider factory.
make_model = make_raw_provider


def _record_brief(rec):
    return str({k: rec.get(k) for k in
                    ("source_id", "kind", "title", "published_ns")
                if k in rec})[:2000]


# Child-result bounds (enforced in the child BEFORE IPC so a huge
# provider result never crosses the process boundary unbounded).
RESULT_TEXT_MAX_BYTES = 1 << 20
CHILD_CANDIDATES_MAX = 256
CHILD_CANDIDATE_BYTES_MAX = 16384
CHILD_TOOL_RECORDS_MAX = 64


def _to_candidates(result, rec_defaults):
    """Shape agent output into advisory candidate dicts. Accepts
    native lists/dicts directly; a JSON TEXT result is parsed (text
    over RESULT_TEXT_MAX_BYTES is rejected BEFORE json.loads), and
    anything else yields [] (the graph counts the empty extract).
    At most CHILD_CANDIDATES_MAX dicts are shaped, each validated
    JSON-safe and canonically small (oversize/hostile items skipped) —
    shaping is never evidence (the resolver decides)."""
    import json
    if isinstance(result, dict):
        data = [result]
    elif isinstance(result, list):
        data = result
    elif isinstance(result, str):
        # Byte cap BEFORE json.loads: the char-count fast path avoids
        # encoding huge text at all (utf-8 bytes >= char count).
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
            "effect": "unknown",  # resolver decides; never the model
            "provenance_url": c.get("provenance_url",
                                    rec_defaults.get("provenance_url"))})
    return out


def _token_need(kind, prompt_bytes, completion_max, steps):
    if kind == "generate":
        return prompt_bytes + completion_max
    # Closed-form multi-step bound: each step's context holds the
    # initial prompt plus all prior completions and tool outputs.
    # Tool growth per prior step is TOOLS_PER_STEP_MAX tool slots
    # each holding up to TOOL_OUT_MAX_BYTES (byte-truncated outputs),
    # NOT one output per step — four large tool outputs on one step
    # grow context by four outputs, and the bound counts all four.
    per_step_growth = (completion_max +
                       TOOLS_PER_STEP_MAX * TOOL_OUT_MAX_BYTES)
    return (steps * prompt_bytes +
            per_step_growth * steps * (steps - 1) // 2 +
            steps * completion_max)


CONTAINER_NAME_RE = None  # compiled lazily below (stdlib re)


def _valid_container_name(name):
    import re
    global CONTAINER_NAME_RE
    if CONTAINER_NAME_RE is None:
        CONTAINER_NAME_RE = re.compile(r"[A-Za-z0-9_.\-]{1,128}")
    return isinstance(name, str) and bool(
        CONTAINER_NAME_RE.fullmatch(name))


def _llm_child_main(payload):
    """Worker-child entry (spawn context). Builds everything from
    configs, executes, returns a JSON-safe envelope. NEVER touches
    ledgers (it is not given their paths). Envelope statuses:
      ok: {"result", "usage" ([pt,ct] or None), "tool_calls"}
      config-error: build-time failure, provider untouched by OUR
        build path (the factory itself is trusted config)
      provider-error: anything after the provider may have been
        touched (ambiguous by construction).

    Ordering (P0): the COMPLETE task/configuration validates FIRST;
    the provider factory runs ONLY after every check passes. An
    invalid sandbox/task/config returns config-error with the factory
    provably untouched."""
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
    # Validation complete: ONLY now may the provider be constructed.
    try:
        provider = factory(provider_cfg)
    except Exception as e:
        return {"status": "config-error",
                "reason": _truncate_bytes("factory:%r" % (e,), 256)}
    if not hasattr(provider, "generate"):
        return {"status": "config-error", "reason": "factory-no-model"}
    tape = UsageTape(provider, max_tokens, token_budget)
    if kind == "generate":
        messages = payload.get("messages")
        try:
            msg = tape.generate(messages, max_tokens=max_tokens)
        except Exception as e:
            return {"status": "provider-error",
                    "reason": _truncate_bytes(repr(e), 256)}
        text = getattr(msg, "content", None)
        return {"status": "ok",
                "text": text if isinstance(text, str) else None,
                "usage": tape.totals(), "tool_calls": 0}
    if kind == "extract":
        try:
            from smolagents import CodeAgent
        except ImportError as e:
            return {"status": "config-error",
                    "reason": "smolagents:%r" % (e,)}
        # Task/config already validated above (pre-provider); only
        # construction that cannot touch the provider remains here.
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
        except Exception as e:
            return {"status": "provider-error",
                    "reason": _truncate_bytes(repr(e), 256)}
        finally:
            for meth in ("cleanup", "delete"):
                try:
                    getattr(executor, meth, lambda: None)()
                except Exception:
                    pass
        tool_calls = sum(t.calls for t in wrapped_tools)
        tool_calls += getattr(agent.python_executor, "calls", 0)
        cands = _to_candidates(result, rec_defaults)
        records = [r for t in wrapped_tools for r in t.records]
        return {"status": "ok", "candidates": cands,
                "usage": tape.totals(), "tool_calls": tool_calls,
                "tool_records": records[:CHILD_TOOL_RECORDS_MAX]}
    return {"status": "config-error", "reason": "bad-kind"}


def _clamp_completion(asked):
    try:
        asked = int(asked)
    except (TypeError, ValueError):
        asked = COMPLETION_MAX
    # Downward only: callers shrink the bound, never widen it.
    return max(1, min(asked, COMPLETION_MAX))


def run_gated(kind, node, symbol, cycle_id, epoch, task, provider_cfg,
              provider_factory, sandbox_cfg, budget, governor,
              model_id, log_path, timeout_s, max_tokens_asked=None,
              tool_factory=None, executor_factory=None, steps=None,
              container_name=None):
    """THE invocation gate (parent process). Every provider touch in
    production passes through here, in this order:

    1. validate identities + task shape (clean failures),
    2. price lookup (missing pricing blocks clean),
    3. R15 reservation of the TRUE token bound (clean refusal),
    4. worst-case dollar HOLD against the stage cap (clean refusal),
    5. mark invoked, spawn the worker child, await with hard kill,
    6. settle actuals + exactly one span + hold release (any failure
       HERE is AbortCycle — accounting after a real call never
       downgrades to a blocked result),
    7. ambiguous outcomes (timeout/crash/provider-error/unaccountable
       usage) settle the FULL reservation as UNKNOWN_SPEND, keep the
       hold, poison the R15 row, and AbortCycle (future spend blocks
       until reconcile_unknown).

    kind: "generate" (task={messages, max_tokens_asked?}) or "extract"
    (task={brief, rec_defaults}). Returns the child result payload on
    accounted success: {"text"...} or {"candidates"...}. A malformed
    provider RESULT (not accounting) returns {"blocked": reason} with
    accounting settled — the graph records drop+count, no abort.
    """
    _check_ident("node", node)
    _check_ident("symbol", symbol)
    _check_ident("cycle", cycle_id)
    if type(epoch) is not int or not 0 <= epoch <= 2 ** 31 - 1:
        raise r15.AbortCycle("gate", {"bad-identity": "epoch"})
    if kind not in ("generate", "extract"):
        raise r15.AbortCycle("gate", {"bad-kind": kind})
    if not callable(provider_factory):
        raise ConfigBlocked("provider_factory not callable")
    # Timeout is control-plane input: invalid values block the attempt
    # (never run, never silently become a default).
    if (type(timeout_s) not in (int, float) or
            not timeout_s == timeout_s or
            not 0 < timeout_s <= 3600):
        raise ConfigBlocked("bad-timeout:%r" % (timeout_s,))
    # Model/pricing identity (P0): the priced model_id and the model
    # the provider config names must be the SAME string. A config
    # naming a different model than the reservation prices is a
    # clean refusal BEFORE any reservation — never a billed surprise.
    if not isinstance(provider_cfg, dict):
        raise ConfigBlocked("provider-cfg-shape")
    ok, why = schema_mod.json_safe(provider_cfg)
    if not ok:
        raise ConfigBlocked("provider-cfg:%s" % why)
    if provider_cfg.get("model_id") != model_id:
        raise ConfigBlocked("model-identity-mismatch:%r" %
                            (provider_cfg.get("model_id"),))
    # Single pricing authority: the governor's deployment table. A
    # second table here could diverge from the cap enforcement below
    # (proven by test: $149 spent + $93 worst-case must refuse).
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
        need = _token_need("extract", prompt_bytes, comp, steps)
        tools_needed = steps * TOOLS_PER_STEP_MAX
        messages = None
    if need > r15.TOKENS:
        # A true bound that cannot fit the cycle: refuse BEFORE any
        # spend (fail closed, counted upstream as blocked evidence).
        raise ConfigBlocked("call-bound-exceeds-cycle")

    # Pre-call gates: R15 tokens first, then absolute dollars. Either
    # refusal is CLEAN — the provider has not been touched.
    lease = budget.reserve_call(need, tools_needed)
    lease_id = "spend:%s" % lease["lease_id"]
    try:
        worst = governor.worst_usd(model_id, need)
        governor.reserve_usd(worst, lease_id)
    except Exception:
        try:
            budget.settle_call(lease, 0)
        except r15.AbortCycle:
            pass
        raise
    try:
        governor.mark_invoked(lease_id)
    except Exception:
        try:
            budget.settle_call(lease, 0)
        except r15.AbortCycle:
            pass
        try:
            governor.settle_usd(lease_id)
        except Exception:
            pass
        raise

    if container_name is None:
        container_name = "miro-%s-%s-%d" % (cycle_id, symbol,
                                            lease["seq"])
    if not _valid_container_name(container_name):
        try:
            budget.settle_call(lease, 0)
        except r15.AbortCycle:
            pass
        try:
            governor.settle_usd(lease_id)
        except Exception:
            pass
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
    # Spawn pickles the payload: unpicklable task content must fail
    # HERE (clean, pre-spawn), never as an ambiguous child crash.
    import pickle
    try:
        pickle.dumps(payload)
    except Exception as e:
        try:
            budget.settle_call(lease, 0)
        except r15.AbortCycle:
            pass
        try:
            governor.settle_usd(lease_id)
        except Exception:
            pass
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
        # run_in_process transport failure (not a child envelope):
        # the child may or may not have run — ambiguous by
        # construction, same path as a timeout.
        note = _unknown(budget, governor, log_path, epoch, node,
                        model_id, cycle_id, symbol, lease, lease_id,
                        worst, need, "transport:%r" % (e,),
                        container_name)
        raise r15.AbortCycle(symbol, {"transport-ambiguous": True,
                                      "unknown-spend": worst,
                                      "reap": note})

    status = child.get("status") if isinstance(child, dict) else None
    if status == "config-error":
        # Build-time failure through OUR build path: provider untouched.
        # Settle the reservation at zero, release the hold, no span
        # (nothing was attempted), graph records blocked evidence.
        try:
            budget.settle_call(lease, 0)
        except r15.AbortCycle:
            pass
        try:
            governor.settle_usd(lease_id)
        except Exception:
            pass
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
        # The call happened but its cost is unknowable: keep the FULL
        # reservation as UNKNOWN_SPEND (never settle fiction).
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
        # Post-call tripwire: the bound was violated. Record truth,
        # then abort — reconciliation is audit, never the cap. Every
        # accounting step reports into the abort snapshot: NOTHING
        # here may disappear into a bare pass.
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
            breach["span-or-settle-failed"] = repr(e)
        try:
            budget.invalidate()
        except r15.AbortCycle as e:
            breach["invalidate-failed"] = str(e.snapshot)
        raise r15.AbortCycle(symbol, breach)
    # Accounted success: settle actuals, exactly one span, hold out.
    # ANY failure from here is AbortCycle (P0-9): the call was real.
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
        raise r15.AbortCycle(symbol, {"accounting-failure": repr(e)})
    if kind == "generate":
        text = child.get("text")
        if text is None or not isinstance(text, str):
            # Result failure WITH good accounting: blocked evidence,
            # not an abort (the spend is settled and spanned above).
            return {"blocked": "non-string-output"}
        if len(text) > RESULT_TEXT_MAX_BYTES:
            # Oversize provider text never crosses into state: the
            # spend is accounted; the RESULT is dropped + counted.
            return {"blocked": "result-too-large"}
        return {"text": text, "usage": usage}
    cands = child.get("candidates")
    if not isinstance(cands, list):
        return {"blocked": "non-list-candidates"}
    return {"candidates": cands, "usage": usage,
            "tool_calls": tool_calls,
            "tool_records": child.get("tool_records", [])}


def _span(log_path, epoch, node, model_id, cycle_id, symbol, pt, ct,
          usd, outcome, lease):
    """Exactly one span for an accounted call. usd is explicit:
    ambiguous spans are written by _unknown with the FULL reservation
    (this helper never writes an unknown row, so no $0-unknown trap
    can hide here)."""
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
    """Ambiguous attempt. The spend hold (marked invoked pre-spawn)
    is NEVER released on this path, so the dollars stay conservatively
    counted and future spend stays blocked even if every write below
    fails. Recording is ONE atomic ledger operation
    (record_unknown: span + unknown row + invoked mark); ANY failure
    there raises AbortCycle with an unresolved-spend snapshot — never
    a downgraded blocked result, never a silent pass.

    Zero-price note: when worst == 0.0 (a genuinely free model) there
    are no uncertain dollars: the R15 reservation still settles at the
    full bound and the row is still poisoned, but no unknown rows are
    written (an unknown $0 row is meaningless and rejected) and the
    hold is released — no unreconcilable block, the next fresh cycle
    proceeds.

    Returns the container-reap note (None when reaped cleanly): reap
    failure folds into the abort snapshot, never replaces it."""
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
            # The hold is still invoked (never released here) so the
            # money is counted and has_unreconciled() blocks on the
            # invoked-hold backstop even without the unknown rows.
            try:
                budget.invalidate()
            except r15.AbortCycle:
                pass
            raise r15.AbortCycle(
                symbol, {"unresolved-spend": repr(e),
                         "unknown-spend": worst})
    else:
        # Zero-price ambiguity: no dollars uncertain, nothing to
        # block on — release the hold, keep the R15 poison.
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
    """Post-kill container reclaim, best-effort: the child is already
    dead here, so no live worker can be using the executor. Failure
    is reported via exception message (the caller folds it into the
    abort snapshot) — a leaked container wastes sandbox CPU, it does
    not move money."""
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
