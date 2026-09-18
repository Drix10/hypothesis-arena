# 05 — Risk and Determinism (hard rules)

Violation of any numbered rule halts paper trading until human review.
No auto-override exists by design.

## 5.1 Position and exposure limits (ported from hypothesis-arena)

- R1. Max 3 concurrent positions. Max 2 in the same direction.
- R2. Single position ≤ 25% equity. Total exposure ≤ 75%.
- R3. Max 20 trades/day. Max 3 trades/symbol/hour (anti-churn).
- R4. BUY→SELL→BUY on one symbol < 1 h → force HOLD 2 h on that symbol.
- R5. Drawdown > 10% from peak → HALT all entries (exits only) until review.
- R6. Realized volatility > 3× 20-day baseline → halve sizes until review.
- R7. Cross-position correlation > 0.9 same direction → close newest.
- R8. `max` conviction requires §3.3 consensus proof or downgrade. No exceptions.

## 5.2 Leverage / stop table (locked)

| Leverage | Max exposure/symbol | Required stop |
|---|---|---|
| 1× | 25% | 8% |
| 3× | 15% | 2.5% |
| 5× | 10% | 1.5% |
| >5× | forbidden v1 | — |

Stop distance also capped at 80% of liquidation distance, floored at 0.1%.
Every order intent carries a stop or it is rejected by `veto.cpp`.

## 5.3 Determinism contract

- D1. Same `context_hash` + same question version → same answers (cache) → same
  decision. Replay test proves it weekly on sampled rows.
- D2. No RNG in decision path. Tie-breaks alphabetical (analyst id).
- D3. Model/prompt versions pinned per deployment; logged per row; mid-session
  updates forbidden.
- D4. Portfolio state snapshotted at decision time; execution-time drift only
  narrows (re-check limits at send; shrink-or-hold, never grow).

## 5.4 Self-correction (automatic, logged)

- S1. Feed gap → request/resync, mark decisions `gap=true` until whole.
- S2. Position reconcile every 15 min vs broker; >1% drift with no pending
  orders → sync to broker + alert; with pending orders → defer 30 s.
- S3. Backtest/live divergence > 30% over 100 trades → auto-pause entries.
- S4. Scheduler watchdog: no decision > 60 s in market hours → restart feed,
  reconcile before resuming.
- S5. JEV error streak (5 consecutive failures) → entries paused, exits live,
  alert.

## 5.5 Audit

- Every decision row: ts_ns, context_hash, JEV answers+probs, veto verdict,
  order intent or HOLD reason, chained hash. Append-only, daily backup.
- Weekly: verify hash chain + replay 100 sampled rows.

## Locked decisions

- Rules R1–R8 + leverage table are code constants, not config flags.
- Any limit change = doc edit + version bump + fresh paper window.
