"""D2 sandboxed extraction workers (doc 08 sec. 8.2, stdlib + smolagents).

Frozen worker model: smolagents CodeAgent with executor_type="docker"
(non-root, read-only rootfs, dropped capabilities, CPU/RAM limits,
egress limited to the allowlisted endpoints via sandbox proxy).
The import allowlist is LOCKED (doc 08 §8.2) and enforced twice:
container image build AND a pre-flight source scan of generated code
(defense in depth; the firewall/proxy remains the real boundary).

No model key configured -> explicit ConfigBlocked, never a fake answer.
LocalPythonExecutor is forbidden (known escapes) and never referenced.
"""
import re

# Locked import allowlist (doc 08 §8.2, exact — nothing else imports).
ALLOWLIST = {"json", "re", "datetime", "urllib", "xml", "html", "math",
             "statistics", "collections", "itertools", "hashlib",
             "base64", "requests", "bs4", "lxml", "pydantic", "pandas",
             "feedparser"}
FORBIDDEN = {"subprocess", "os", "sys", "socket", "pickle", "yaml",
             "shutil", "pathlib", "open"}

_IMPORT_RE = re.compile(r"^\s*(?:import|from)\s+([a-zA-Z0-9_\.]+)",
                        re.MULTILINE)


class ConfigBlocked(Exception):
    pass


def scan_imports(code):
    """Pre-flight scan: every top-level import must be allowlisted and
    none may be forbidden. Returns (ok, offending_name_or_None)."""
    for m in _IMPORT_RE.finditer(code):
        top = m.group(1).split(".")[0]
        if top in FORBIDDEN or top not in ALLOWLIST:
            return False, top
    return True, None


def make_extract_worker(model_cfg=None, docker_image=None):
    """Build the extract CodeAgent. model_cfg None -> ConfigBlocked on
    first use (explicit blocker; the graph treats it as drop+count)."""
    if not model_cfg or not model_cfg.get("model_id"):
        def blocked(rec, budget):
            raise ConfigBlocked("research model key not configured")
        return blocked

    def run(rec, budget):
        try:
            from smolagents import CodeAgent, DockerExecutor  # noqa
        except ImportError as e:
            raise ConfigBlocked("smolagents unavailable: %s" % e)
        # The agent receives tool FUNCTIONS (fetchers/parser/validator),
        # never general HTTP: egress stays inside the allowlist even if
        # generated code is adversarial (proxy denies the rest).
        raise ConfigBlocked("live worker wiring needs docker image: %s" %
                            (docker_image or "unpinned"))
    return run


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
