# Environment / secrets contract

Process environment is the only configuration source. Python reads
`os.environ` via `collector/config.py`; there is no dotenv loader
(stdlib only), no secret defaults, no tracked values.

## Variables

| Variable | Required now | Used by | Kind | If absent |
|---|---|---|---|---|
| `MIRO_CONTACT` | P1.4 soak | EDGAR collector (`collect.py` UA) | Sensitive config (not a key, still not source code) | `MISSING_REQUIRED_CONFIG`, collector exits 2 before any HTTP |
| `FRED_API_KEY` | Optional | FRED collector | Secret | `SKIPPED_CONFIG` heartbeat, never a failure |

`OPENROUTER_API_KEY`, Gemini/Anthropic/broker keys: **do not exist in P1.4.**
Do not add a credential until a committed code path consumes it. Every secret
needs an owner, a consumer, a scope, and a lifecycle before it is introduced.

## Layouts

Developer machine:

```text
hypothesis-arena/
  .env            # REAL VALUES, gitignored, never committed
  .env.example    # safe template, committed
```

Load locally with `set -a; source .env; set +a`.

Soak host (7-day process, no interactive shell): environment file with
restricted permissions (e.g. `/etc/hypothesis-arena/soak.env`, mode 600),
referenced by the service manager (`EnvironmentFile=` under systemd).
Values live in the process environment, never in the repo or tracked config.

## Startup states

- `CONFIG_OK` — all required present; optional ones reported individually.
- `MISSING_REQUIRED_CONFIG` — fail fast, exit non-zero, no polling attempted.
- `SKIPPED_OPTIONAL_CONFIG` — per-source heartbeat state, not an error.
