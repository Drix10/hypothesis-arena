#!/usr/bin/env python3
"""O7 regressions (plan/appendix/09): exported variables win over .env in both
readers, `export KEY=` lines and unquoted inline comments parse, and provider
HTTP errors are closed. Hermetic: each case points ROOT at a temp directory,
so the repo .env is never read or written.
Run: python3 collector/tests/test_o7.py"""
import io
import os
import sys
import tempfile
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import config  # noqa: E402
import jev  # noqa: E402

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


d, r, e = with_root(jev, "OPENROUTER_API_KEY=from-file\n", {})
check("jev-reads-dotenv", jev.api_key() == "from-file")
restore(jev, r, e)

d, r, e = with_root(jev, "OPENROUTER_API_KEY=from-file\n",
                    {"OPENROUTER_API_KEY": "rotated"})
check("jev-export-wins-over-dotenv", jev.api_key() == "rotated")
restore(jev, r, e)

d, r, e = with_root(jev, "export OPENROUTER_API_KEY='quoted'\n", {})
check("jev-export-prefix", jev.api_key() == "quoted")
restore(jev, r, e)

d, r, e = with_root(jev, "", {})
check("jev-missing-is-empty", jev.api_key() == "")
restore(jev, r, e)

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


class Closed(urllib.error.HTTPError):
    closed = False

    def close(self):
        Closed.closed = True
        super().close()


def raise_http(*a, **k):
    raise Closed("http://x", 500, "boom", {}, io.BytesIO(b"body"))


real = urllib.request.urlopen
urllib.request.urlopen = raise_http
try:
    got = jev.post({"model": "m"}, "k")
finally:
    urllib.request.urlopen = real
check("jev-http-error-classified-and-closed",
      got == (None, "provider-http-500") and Closed.closed)

print("ALL O7 CHECKS PASS" if not fails else "O7 FAILURES: %d" % fails)
sys.exit(1 if fails else 0)
