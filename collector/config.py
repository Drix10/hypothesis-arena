#!/usr/bin/env python3
"""Environment/secrets contract. Process environment is the ONLY source:
no .env parsing here (stdlib only), no defaults for required values.

  REQUIRED  MIRO_CONTACT   SEC fair-access identification in the EDGAR UA.
                           Missing -> MISSING_REQUIRED_CONFIG, fail fast.
  OPTIONAL  FRED_API_KEY   FRED collector. Missing -> SKIPPED_CONFIG heartbeat,
                           never a failure.

Nothing else is read. OPENROUTER/Gemini/broker keys do not exist in P1.4
and must not be added until a code path actually consumes them.
"""
import os

REQUIRED = {
    "MIRO_CONTACT": "SEC fair-access identification (EDGAR User-Agent)",
}
OPTIONAL = {
    "FRED_API_KEY": "FRED collector; absent means SKIPPED_CONFIG, not failure",
}


def load():
    values, missing, skipped = {}, [], []
    for k in REQUIRED:
        v = os.environ.get(k, "").strip()
        if v:
            values[k] = v
        else:
            missing.append(k)
    for k in OPTIONAL:
        v = os.environ.get(k, "").strip()
        if v:
            values[k] = v
        else:
            skipped.append(k)
    status = "MISSING_REQUIRED_CONFIG" if missing else "CONFIG_OK"
    return {"values": values, "missing_required": missing,
            "skipped_optional": skipped, "status": status}
