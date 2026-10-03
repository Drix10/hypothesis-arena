#!/usr/bin/env python3
"""Environment loading: exported variables win over .env, `export KEY=` lines and
unquoted inline comments parse. Hermetic: each case points ROOT at a temp
directory, so the repo .env is never read or written.
Run: python3 collector/tests/test_env_loading.py"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import config  # noqa: E402

fails = 0


def check(name, ok):
    global fails
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        fails += 1


def with_root(module, text, env):
    d = tempfile.mkdtemp()
    with open(os.path.join(d, ".env"), "w", encoding="utf-8") as f:
        f.write(text)
    old_root, old_env = module.ROOT, dict(os.environ)
    module.ROOT = d
    os.environ.clear()
    os.environ.update({k: v for k, v in old_env.items() if k not in config.KEYS})
    os.environ.update(env)
    return d, old_root, old_env


def restore(module, old_root, old_env):
    module.ROOT = old_root
    os.environ.clear()
    os.environ.update(old_env)


d, r, e = with_root(config, "export FRED_API_KEY=abc123 # rotated 2026\n", {})
config._load_dotenv()
check("config-export-and-inline-comment", os.environ.get("FRED_API_KEY") == "abc123")
restore(config, r, e)

d, r, e = with_root(config, 'FRED_API_KEY="has # inside"\n', {})
config._load_dotenv()
check("config-quoted-hash-kept", os.environ.get("FRED_API_KEY") == "has # inside")
restore(config, r, e)

d, r, e = with_root(config, "FRED_API_KEY=file\n", {"FRED_API_KEY": "exported"})
config._load_dotenv()
check("config-export-wins", os.environ.get("FRED_API_KEY") == "exported")
restore(config, r, e)


print("ALL ENV-LOADING CHECKS PASS" if not fails else "ENV-LOADING FAILURES: %d" % fails)
sys.exit(1 if fails else 0)
