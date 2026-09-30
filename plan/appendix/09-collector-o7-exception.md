# Collector O7 exception (2026-09-29)

The collector (`collector/`) is frozen. This record authorizes one bounded edit
under freeze-v3 O7 and states what it may not touch.

## Findings

1. `collector/jev.py api_key()` read `.env` before the exported
   `OPENROUTER_API_KEY`, the opposite of `collector/config.py` and the
   documented contract. A key rotated in the environment was ignored while the
   old one stayed in `.env`. It also missed `export KEY=` lines.
2. `collector/config.py` kept an unquoted inline comment as part of the value
   and skipped `export KEY=` lines.
3. `jev.post` and `collect.py fetch` left the `HTTPError` response open on the
   error path.
4. Call-log rotation (`jev.py`, 8 MiB): checked, no change needed. Spend
   accounting reads the per-day ledgers under `SPEND_DIR`, never
   `data/jev_calls.jsonl`, so rotating that file drops replay logs only, not
   spend evidence.

## Scope of the edit

Items 1 to 3 only, plus `collector/tests/test_o7.py` (hermetic, temp-dir ROOT,
CI stdlib job). No change to classifier rules (`rules_v1`), request or response
formats, hashes, spend limits, caps, cache keys or any string that
`scripts/freeze-check.sh` pins. AST comparison before and after shows only the
lines above. The classifier and source polling are unchanged.

## Why now

O6 rotates every credential shared in chat. Item 1 would have left the
collector using a stale key after a correct rotation.
