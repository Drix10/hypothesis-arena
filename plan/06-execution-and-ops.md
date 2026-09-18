# 06 — Execution and Ops

## 6.1 Order lifecycle (locked)

```
intent (risk PASS) → journal row → send (idempotent ID) → ack/timeout
 → timeout: query once → filled? journal fill : cancel + journal
 → fill → attach stop → track → exit (signal or stop) → journal + reflection row
```

- Client order ID = `hex(sha256(context_hash ‖ symbol ‖ side ‖ attempt))[:24]`.
  Retry reuses the same ID. No duplicate orders from retries. Ever.
- One send attempt + one status query. No martingale re-sends.
- Stops are attached at entry or the entry is rejected. Trailing only tightens.

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

- Liveness: heartbeat file touched every cycle; stale > 120 s → alert.
- Alerts (stdout + log + optional webhook): HALT triggers, reconcile drift,
  JEV error streak, feed gap > 5 min, any R-rule trip.
- Kill switch: `HALT` file in working dir → entries stop within 1 cycle.
  Deleting it does NOT resume (requires restart + flag). Deliberate friction.

## 6.5 What "done" means

- [ ] Kill-switch drill passes (HALT → no entries in ≤1 cycle, exits unaffected).
- [ ] Reconcile drill passes (forced drift detected + synced + logged).
- [ ] Daily summary script runs from journal alone (no live system needed).
- [ ] 30 clean paper days with zero R-rule violations.

## Locked decisions

- Journal-before-order. No row = no send, no exceptions.
- Exits never depend on JEV, network, or thesis freshness.
- Resume-from-HALT is manual. Always.
