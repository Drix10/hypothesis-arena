#!/usr/bin/env python3
"""Environment/secrets contract. Loads the repo-root `.env` automatically
(stdlib parser below), then reads the process environment — real exported
variables always win over `.env` values.

  REQUIRED  MIRO_CONTACT   SEC fair-access identification in the EDGAR UA.
                           Missing -> MISSING_REQUIRED_CONFIG, fail fast.
  OPTIONAL  FRED_API_KEY   FRED collector. Missing -> SKIPPED_CONFIG heartbeat,
                           never a failure.

`.env` lives at the repo root, is gitignored, and is never committed.
`.env.example` is the only committed template. Nothing else is read:
OPENROUTER/Gemini/broker keys do not exist in P1.4 and must not be added
until a code path actually consumes them.
"""
import os

REQUIRED = {
    "MIRO_CONTACT": "SEC fair-access identification (EDGAR User-Agent)",
}
OPTIONAL = {
    "FRED_API_KEY": "FRED collector; absent means SKIPPED_CONFIG, not failure",
}
KEYS = tuple(list(REQUIRED) + list(OPTIONAL))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_dotenv():
    """Minimal .env parser: KEY=VALUE lines, # comments, single/double
    quotes stripped. Only fills keys missing from the real environment."""
    path = os.path.join(ROOT, ".env")
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return
    with fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k not in KEYS or k in os.environ:
                continue
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            os.environ[k] = v


def load():
    _load_dotenv()
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
