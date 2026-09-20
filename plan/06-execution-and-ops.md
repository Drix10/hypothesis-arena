# 06 — Execution and Ops

## 6.1 Order lifecycle (locked, v2: broker-native protection)

Local C++ stops are the active controller, never the disaster protection. A
position the broker cannot protect on its own is a position the process cannot
survive losing — so protection is established broker-side first:

```
intent (risk PASS) → re-check HALT file → journal row → send entry +
  protective SL/TP through a broker-specific protected mode (E1: entry is
  permitted ONLY through an order mode whose adapter implementation
  positively establishes the entry↔protection relationship — OANDA
  stopLossOnFill/takeProfitOnFill; Alpaca bracket legs with adapter-proven
  semantics). Each adapter proves: entry ack, protection ack, partial-fill
  behavior, cancel/replace behavior, double-trigger behavior — including
  fast-market edge behavior. "Atomic" is the requirement (no naked entry),
  not a cross-broker primitive claim. → ack/timeout → query once:
   filled + protection acked → journal fill → PROTECTED → track
   filled, protection missing → PROTECTIVE_ORDER_MISSING: establish now or
     flatten immediately; never hold naked awaiting a retry loop
   partial (0% < filled < 100%) → journal partial with filled qty →
     protection covers filled qty ONLY → cancel remainder → confirm
     cancelled → journal cancel. Protection never covers unfilled qty;
     a partial never becomes PROTECTED on the full intended size.
   nothing         → cancel → confirm cancelled → journal cancel
   cancel failed   → UNKNOWN_EXECUTION (never "filled"): freeze new orders
     for the symbol, query broker, reconcile per §5.4 S2, preserve or
     establish protection first
 → exit (stop, TP, calendar time_exit, or flip rule below) → journal + reflection row
```

- Durable order state machine (survives restarts): intent_id + client order ID
  + send_attempt + broker_ack_state persisted before send. After any crash the
  process reconciles ack state with the broker BEFORE issuing anything new —
  a restart must never double-send what the dead process already sent.
- Client order ID = typed intent fingerprint + broker/account namespace +
  persisted intent_id, hashed: `hex(sha256(broker ‖ account ‖ context_hash ‖
  symbol ‖ side ‖ intent_id))`, truncated only if the broker requires it —
  one intent, one ID, no attempt counter, no delimiter ambiguity, no
  cross-account collision. (An `attempt` field in the hash was a
  duplicate-order bug: every retry would mint a fresh ID and double-fill.
  Retries reuse the ID.)
- One send attempt + one status query. No martingale re-sends.
- Stops are attached at entry or the entry is rejected. exit_profile_v1
  (doc 03 §3.3): fixed stop + fixed 2R take-profit + mandatory calendar
  time_exit (E4): time_exit = actual exchange close − frozen exit buffer
  (30 min default), from the validated IANA/exchange calendar — never a
  hard-coded 15:55 ET, which is wrong on early closes.
  Stop floor 0.1% ⇒ min TP 0.2% (20bp), which must EXCEED all-in modeled
  cost + safety margin under the frozen cost stress — 20bp clears
  fees/slippage only if the cost model says so, never by construction.
  Entry requires: expected gross edge > all-in modeled cost + margin.
- Journal-before-order is absolute for NORMAL entries. Emergency exits carry
  an explicit exception: if the journal write fails mid-emergency, execute
  first, then append through the durable emergency-exit buffer — a delayed
  exit is worse than a delayed row, and the row still lands. (This supersedes
  any "no exceptions" wording: the exception is this paragraph.)
- Discretionary exit is REMOVED from live actuation (E3): `enter.noul < 0.3`
  twice is logged and researched, but never market-exits a position. Live
  exits are: stop, TP, time_exit, deterministic risk/kill exit, broker
  reconciliation logic. Exits never depend on JEV — the hard stop/TP always
  stand regardless; stale/missing JEV never forces, and never blocks, an exit.
- Feed stale > 30 s → entries forbidden (veto). Exits go via REST if WS is down.
- Stage multiplier (doc 10 §10.2) is applied to the computed size **after** the
  conviction table and before the R2 check. An order that is legal at G3 and
  illegal at G1 is rejected at G1, with the stage named in the HOLD reason.

## 6.2 Reflection (after every closed trade)

Row appended: entry context_hash, exit context_hash, PnL, slippage vs intent,
regime, edge_family pick, conviction, what JEV got right/wrong (auto fields only —
no LLM prose in v1). Weekly human review aggregates: per-family hit rate,
per-regime PnL, threshold sensitivity. Threshold changes come from this review,
never from gut feel.

## 6.2a Outage playbook (the unattended cases)

The system runs with nobody watching, so every outage needs a default that is safe
without a human. In all of them: **exits, stops, TP, and reconcile keep working.**

| Failure | Detection | Automatic response | Human needed? |
|---|---|---|---|
| Feed gap / WS down | sequence gap, stale > 30 s | Entries vetoed; exits via REST; reconnect with backoff (S1) | Only if > 5 min |
| Broker outage | auth/API failure | Entries stop; exit attempts via REST; unresolvable drift → HARD kill (S9) | Yes, at HARD |
| JEV / LLM provider outage | timeout, 5xx, malformed | 1 retry → HOLD; S5 streak → SOFT kill | At S5 alert |
| Research plane down or stale | no fresh `features.jsonl` past TTL | Features **absent**; entries needing a TRIGGER feature HOLD (S6) | If > 6 h |
| Runaway research loop | R15 state-machine response (doc 08 §8.4 — per-symbol pause, systemic plane pause only on majority-in-window) | At pause |
| Conflicting agent conclusions | `disagreement=true` | HOLD (R14). Never averaged, never resolved by a tiebreak toward action | No |
| Spend spike | hourly projection | Tier 1 → 2 → 3 (R10), ending in MEDIUM kill + demote | At tier 3 |
| Calibration decay | trailing-200 Brier vs baseline | Entries halt, demote (R13) | Yes |
| Journal chain break | daily verify | HARD kill, forensics before restart | Yes |
| `STAGE` chain unverifiable | startup / cycle boundary | Fall back to G0_PAPER, alert | Yes |

The pattern behind every row: **new risk stops, old risk stays managed, and the
system fails toward paper.**

## 6.3 Daily ops rhythm (paper phase)

| Time (UTC) | Action |
|---|---|
| 00:00 | Roll journal files, verify hash chain, snapshot equity |
| Continuous | Feed + cycles; alerts on R5/S3/S5 |
| Every 15 min | Position reconcile (S2) |
| Hourly | AI spend projection + tier evaluation (R10); spend counter journaled |
| 08:00 | Human-readable daily summary (script-generated, no LLM): trades, PnL, holds by reason, JEV error count, **AI spend + 30-day projection + tier, cost per closed trade, spend/profit ratio (G2+), trailing-200 Brier vs baseline, features ingested/rejected, research cycles aborted, current stage** |
| Weekly | Calibration curves by regime; challenger scoreboard; `lessons.jsonl` review; ≤3 research proposals triaged (doc 11) |
| 23:55 | Replay sample (D1 check), back up journal + signals DB |

## 6.4 Monitoring (minimum viable, no dashboard v1)

- Liveness: heartbeat file touched every cycle in session; stale > 120 s in session
  → alert. Off-session silence is expected.
- Alerts (stdout + log + optional webhook): HALT triggers, reconcile drift,
  JEV error streak, feed gap > 5 min, any R-rule trip.
- Kill switch: `HALT` file in working dir → entries stop within 1 cycle.
  Deleting it does NOT resume (requires restart + flag). Deliberate friction.
  This is the SOFT level; MEDIUM and HARD are defined in doc 10 §10.3 and are
  drilled monthly.
- Because nobody is watching, alerts must reach a human out of band (webhook /
  push). An alert written only to a log file is not an alert in an unattended
  system. At minimum: HARD kill, stage demotion, R13, and spend tier 3.
- Autonomy metric: every human intervention is logged with its cause. The list of
  causes is the roadmap for what to automate next.

## 6.5 What "done" means

- [ ] Kill-switch drill passes (HALT → no entries in ≤1 cycle, exits unaffected).
- [ ] Reconcile drill passes (forced drift detected + synced + logged).
- [ ] Daily summary script runs from journal alone (no live system needed).
- [ ] Paper fill model frozen: BUY at mid + one full spread adverse, SELL at
  mid − one full spread adverse (min 1bp adverse move), full size,
  flagged `simulated` with exact side semantics (no partials in paper — without this, paper PnL is fiction).
- [ ] Journal retention 90 days local + daily backup; redaction verified by grep
  (no keys/tokens, signal texts ≤280 chars).
- [ ] 30 clean paper days with zero R-rule violations.
- [ ] Every row of the §6.2a outage table drilled at least once, with exits proven
      alive in each.
- [ ] Out-of-band alerting proven (a real notification arrives on a HARD kill).

## Locked decisions

- Journal-before-order for normal entries (emergency-exit exception above).
  No row = no send for entries, no exceptions beyond that paragraph.
- Exits never depend on JEV freshness, thesis freshness, or WS health
  (hard stop/TP local; REST fallback). Only entries may wait on data.
- Resume-from-HALT is manual. Always. So is every stage promotion (doc 10).
- Every outage default stops new risk and keeps old risk managed.
- Paper fill rule (LOCKED 2026-09-18): BUY at mid + one full spread adverse,
  SELL at mid − one full spread adverse (min 1bp), full size, flagged
  `simulated`, no partials in paper. Without
  this, paper PnL is fiction; G1→G2 compares live slippage against exactly
  this model (doc 10 §10.2).
