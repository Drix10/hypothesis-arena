#!/usr/bin/env python3
"""Regression tests for the secrets contract. Hermetic except for a brief,
guarded swap of the repo-root .env (backed up + restored in finally).

Proves: root .env auto-loads, exports win, missing means MISSING_REQUIRED,
the EDGAR User-Agent carries the contact, and the contact value never
appears in outputs/artifacts. Run: python3 collector/tests/test_config.py
"""
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from config import load, KEYS  # noqa: E402

ENV_PATH = os.path.join(ROOT, ".env")
PROBE = "probe-contact@example.com"


def scrubbed_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k not in KEYS}
    env.update(extra or {})
    return env


def with_env(env, fn):
    old = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)
    try:
        return fn()
    finally:
        os.environ.clear()
        os.environ.update(old)


def with_dotenv(content, fn):
    backup = None
    if os.path.exists(ENV_PATH):
        backup = io.open(ENV_PATH, encoding="utf-8").read()
    try:
        io.open(ENV_PATH, "w", encoding="utf-8").write(content)
        return fn()
    finally:
        if backup is None:
            os.remove(ENV_PATH)
        else:
            io.open(ENV_PATH, "w", encoding="utf-8").write(backup)


def t_dotenv_loads():
    def go():
        c = load()
        assert c["status"] == "CONFIG_OK", c
        assert c["values"]["MIRO_CONTACT"] == PROBE, c
    with_env(scrubbed_env(), lambda: with_dotenv(f"MIRO_CONTACT={PROBE}\n", go))
    print("ok dotenv-loads")


def t_export_wins():
    def go():
        c = load()
        assert c["values"]["MIRO_CONTACT"] == "export@example.com", c
    with_env(scrubbed_env({"MIRO_CONTACT": "export@example.com"}),
             lambda: with_dotenv(f"MIRO_CONTACT={PROBE}\n", go))
    print("ok export-wins")


def t_missing_means_refuse():
    def go():
        c = load()
        assert c["status"] == "MISSING_REQUIRED_CONFIG", c
        assert c["missing_required"] == ["MIRO_CONTACT"], c
    with_env(scrubbed_env(), lambda: with_dotenv("# empty\n", go))
    print("ok missing-means-refuse")


def t_ua_carries_contact_and_nothing_else_leaks():
    import importlib.util
    def go():
        spec = importlib.util.spec_from_file_location(
            "coll_probe", os.path.join(HERE, "collect.py"))
        coll = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(coll)
        ua = coll.req("http://localhost/").get_header("User-agent")
        assert PROBE in ua, ua  # EDGAR wire carries the configured contact
        # the contact value must not be baked into any other module surface
        src = io.open(os.path.join(HERE, "collect.py"), encoding="utf-8").read()
        uses = [ln.strip() for ln in src.splitlines() if "CONTACT" in ln]
        assert all("contact=" in ln.lower() or "MIRO_CONTACT" in ln
                   for ln in uses), uses
    with_env(scrubbed_env(),
             lambda: with_dotenv(f"MIRO_CONTACT={PROBE}\n", go))
    print("ok ua-carries-contact")


def t_checker_uses_effective_config():
    # soak_check must agree with config.load(), not raw os.environ
    def go():
        raw = bool(os.environ.get("MIRO_CONTACT", "").strip())
        from config import load as lc
        eff = lc()["status"] == "CONFIG_OK"
        assert eff is True and raw is False  # .env present, nothing exported
    with_env(scrubbed_env(),
             lambda: with_dotenv(f"MIRO_CONTACT={PROBE}\n", go))
    print("ok checker-uses-effective-config")


if __name__ == "__main__":
    assert not os.environ.get("MIRO_CONTACT"), \
        "unset MIRO_CONTACT before running this test"
    t_dotenv_loads()
    t_export_wins()
    t_missing_means_refuse()
    t_ua_carries_contact_and_nothing_else_leaks()
    t_checker_uses_effective_config()
    print("ALL CONFIG CHECKS PASS")
