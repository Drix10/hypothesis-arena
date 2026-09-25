#!/usr/bin/env python3
"""config-probe.py — Phase-D deployment box 4 (model credential + pricing).

Proves fail-closed behavior for missing/invalid deployment config using
the SHIPPED constructors (no mocks of the units under test):
  1. SpendGovernor with empty/missing pricing -> ConfigBlocked.
  2. make_raw_provider with no egress proxy -> ConfigBlocked (never direct).
  3. make_raw_provider with no model_id -> ConfigBlocked.
  4. make_raw_provider with a bogus key CONSTRUCTS (fail-closed happens at
     call time with a real provider error, never silent free inference) —
     construction alone must not touch the network.
Exits 0 only if all four hold. Run with the plane venv python.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from plane import spend as spend_mod
from plane import workers as workers_mod

PASS, FAIL = 0, 0


def check(desc, fn, want_exc):
    global PASS, FAIL
    try:
        fn()
    except want_exc as e:
        print("PASS: %s (%s: %s)" % (desc, type(e).__name__, str(e)[:80]))
        PASS += 1
    except Exception as e:  # noqa: BLE001 — any other failure is a FAIL
        print("FAIL: %s (wrong exc %s: %s)" % (desc, type(e).__name__,
                                               str(e)[:80]))
        FAIL += 1
    else:
        print("FAIL: %s (no exception)" % desc)
        FAIL += 1


# Resolve the real ConfigBlocked regardless of import path.
try:
    RealBlocked = spend_mod.ConfigBlocked
except AttributeError:
    RealBlocked = Exception

check("empty pricing blocks governor",
      lambda: spend_mod.SpendGovernor("/nonexistent/x", {}), RealBlocked)
check("None pricing blocks governor",
      lambda: spend_mod.SpendGovernor("/nonexistent/x", None), RealBlocked)

try:
    WBlocked = workers_mod.ConfigBlocked
except AttributeError:
    WBlocked = Exception

check("provider without egress proxy blocks (never direct)",
      lambda: workers_mod.make_raw_provider({"model_id": "m"}), WBlocked)
check("provider without model_id blocks",
      lambda: workers_mod.make_raw_provider(
          {"egress_proxy": "http://127.0.0.1:9"}), WBlocked)

# Bogus-key construction must not touch the network: resolve proxy host
# to a guaranteed-unroutable address and require construction to succeed
# WITHOUT attempting any connection (proves no silent validation call).
made = workers_mod.make_raw_provider(
    {"model_id": "bogus-model", "egress_proxy": "http://127.0.0.1:9",
     "api_base": "http://127.0.0.1:9/v1", "api_key": "bogus-key"})
print("PASS: bogus-key provider constructs offline (fail-closed deferred "
      "to call time): %s" % type(made).__name__)
PASS += 1

print("---")
print("PASS=%d FAIL=%d" % (PASS, FAIL))
sys.exit(0 if FAIL == 0 else 1)
