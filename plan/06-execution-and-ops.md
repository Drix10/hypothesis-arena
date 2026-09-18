# 06 — Execution and Ops

## 6.1 Order lifecycle (locked)

```
intent (risk PASS) → re-check HALT file → journal row → send (idempotent ID)
 → ack/timeout → query once:
   filled          → journal fill → attach stop+TP → track
   partial         → journal partial → attach stop+TP on filled qty →
                       cancel remainder → journal cancel
   nothing         → cancel → confirm cancelled → journal cancel
   cancel failed   → treat as filled (reconcile at next S2) → alert
 → exit (stop, TP, or flip rule below) → journal + reflection row
```

- Client order ID = `hex(sha256(context_hash ‖ symbol ‖ side))[:24]` — one intent,
  one ID, no attempt counter. (An `attempt` field in the hash was a duplicate-order
  bug: every retry would mint a fresh ID and double-fill. Retries reuse the ID.)
- One send attempt + one status query. No martingale re-sends.
- Stops are attached at entry or the entry is rejected. No trailing in v1 — fixed
  stop + fixed take-profit at 2× stop distance (2R). Stop floor 0.1% ⇒ min TP
  0.2% (20bp), which clears fees/slippage by construction.
- Discretionary exit: each open position is re-evaluated per cycle with the same
  `enter` question; `enter.noul < 0.3` on two consecutive cycles → market exit.
  Uses cached answers only — stale/missing JEV never forces an exit; the hard
  stop/TP always stand regardless.
- Feed stale > 30 s → entries forbidden (veto). Exits go via REST if WS is down.

## 6.2 Reflection (after every closed trade)

Row appended: entry context_hash, exit context_hash, PnL, slippage vs intent,
regime, analyst pick, conviction, what JEV got right/wrong (auto fields only —
no LLM prose in v1). Weekly human review aggregates: per-analyst hit rate,
per-regime PnL, threshold sensitivity. Threshold changes come from this review,
never from gut feel.

## 6.3 Daily ops rhythm (paper phase)

| Time (UTC) | Action |
|---|---|
| 00:00 | Roll journal files, verify hash chain, snapshot equity |
| Continuous | Feed + cycles; alerts on R5/S3/S5 |
| Every 15 min | Position reconcile (S2) |
| 08:00 | Human-readable daily summary (script-generated, no LLM): trades, PnL, holds by reason, JEV error count |
| 23:55 | Replay sample (D1 check), back up journal + signals DB |

## 6.4 Monitoring (minimum viable, no dashboard v1)

- Liveness: heartbeat file touched every cycle in session; stale > 120 s in session
  → alert. Off-session silence is expected.
- Alerts (stdout + log + optional webhook): HALT triggers, reconcile drift,
  JEV error streak, feed gap > 5 min, any R-rule trip.
- Kill switch: `HALT` file in working dir → entries stop within 1 cycle.
  Deleting it does NOT resume (requires restart + flag). Deliberate friction.

## 6.5 What "done" means

- [ ] Kill-switch drill passes (HALT → no entries in ≤1 cycle, exits unaffected).
- [ ] Reconcile drill passes (forced drift detected + synced + logged).
- [ ] Daily summary script runs from journal alone (no live system needed).
- [ ] Paper fill model frozen: fill at mid + one spread adverse (min 1bp), full size,
  flagged `simulated` (no partials in paper — without this, paper PnL is fiction).
- [ ] Journal retention 90 days local + daily backup; redaction verified by grep
  (no keys/tokens, signal texts ≤280 chars).
- [ ] 30 clean paper days with zero R-rule violations.

## Locked decisions

- Journal-before-order. No row = no send, no exceptions.
- Exits never depend on JEV freshness, thesis freshness, or WS health
  (hard stop/TP local; REST fallback). Only entries may wait on data.
- Resume-from-HALT is manual. Always.
