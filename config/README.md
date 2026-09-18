# Environment / secrets contract

The repo-root `.env` holds real values and is auto-loaded by
`collector/config.py` on every run (stdlib parser, no dependency).
Exported variables always override `.env`. `.env` is gitignored and never
committed; `.env.example` is the only committed template.

## Variables

| Variable | Required now | Used by | Kind | If absent |
|---|---|---|---|---|
| `MIRO_CONTACT` | P1.4 soak | EDGAR collector (`collect.py` UA) | Sensitive config (not a key, still not source code) | `MISSING_REQUIRED_CONFIG`, collector exits 2 before any HTTP |
| `FRED_API_KEY` | Optional | FRED collector | Secret | `SKIPPED_CONFIG` heartbeat, never a failure |

`OPENROUTER_API_KEY`, Gemini/Anthropic/broker keys: **do not exist in P1.4.**
Do not add a credential until a committed code path consumes it. Every secret
needs an owner, a consumer, a scope, and a lifecycle before it is introduced.

## Layouts

Developer and soak machine (same layout, no separate secrets setup):

```text
hypothesis-arena/
  .env            # REAL VALUES, gitignored, never committed
  .env.example    # safe template, committed
```

No `export`, no `source`, no `/etc` file needed: running any collector
entry point from the repo picks up `.env` automatically. (A service
manager with its own env file remains an option if we later decide
to move secrets out of the repo directory; not required now.)

## Startup states

- `CONFIG_OK` — all required present; optional ones reported individually.
- `MISSING_REQUIRED_CONFIG` — fail fast, exit non-zero, no polling attempted.
- `SKIPPED_OPTIONAL_CONFIG` — per-source heartbeat state, not an error.
