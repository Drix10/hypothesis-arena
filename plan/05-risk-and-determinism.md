# 05 — Risk and Determinism (hard rules)

Violation of any numbered rule halts paper trading until human review.
No auto-override exists by design.

## 5.1 Position and exposure limits (ported from hypothesis-arena)

- R1. Max 3 concurrent positions. Max 2 in the same direction. One open position
  per symbol — a second intent on a held symbol is HOLD until the first closes.
- R2. Single position ≤ 25% notional/equity. Total exposure ≤ 75% notional/equity.
  (Notional = size × price; equity = account equity at snapshot time. Both frozen
  in the snapshot, never re-read at send.)
- R3. Max 20 trades/day. Max 3 trades/symbol/hour (anti-churn).
- R4. BUY→SELL→BUY on one symbol < 1 h → force HOLD 2 h on that symbol.
- R5. Drawdown > 10% from peak → HALT all entries (exits only) until review.
- R6. Realized volatility > 3× 20-day baseline → halve sizes until review.
- R7. Cross-position correlation > 0.9 same direction → close newest.
- R8. `max` conviction requires §3.3 consensus proof or downgrade. No exceptions.
- R9. Sessions and broker rules are hard vetoes: no stock entries outside 09:30–16:00
  ET; no forex entries when the venue feed is closed (weekends/holidays — the
  `session=closed` flag, not a guess); US margin account under $25k → max 3
  day-trades per 5 sessions (PDT), counted locally before every stock entry.

## 5.1a Measurement definitions (without these the rules are slogans)

- Peak (R5): running maximum of daily-close equity, persisted to disk. Drawdown =
  peak − current equity, evaluated on snapshot equity each cycle.
- Volatility baseline (R6): stdev of daily returns over trailing 20 closes,
  persisted; recomputed at 00:00 UTC. "3× normal" = current 24 h realized stdev
  > 3 × baseline.
- Correlation (R7): Pearson on 1 h closes, trailing 30 points, per open-pair.
  Computed in `ctx/`, breach flag lands in `state.risk_flags`.
- VaR (veto question + `risk_flags.var_breach`): parametric 95% on trailing 24 h
  1 h returns, position-weighted; breach = portfolio VaR > 5% equity.
- Conviction sizes (doc 03 table): lean 5%, strong 10–15%, max up to 25% — all
  % notional/equity. Exposure caps from R2 still apply on top.

## 5.2 Leverage / stop table (locked)

v1 caps: forex ≤ 5×, US stocks ≤ 2× (1× on cash account — Reg T, no exceptions).
Higher leverage unlocks only after a phase-5 review + doc edit, never silently.

Stops are 1.5 × ATR(14) on the entry timeframe, floored at 0.1% of price — one rule
for both asset classes (a fixed-% stop built for crypto would never trigger on
EURUSD and would bleed on TSLA). Take-profit stays 2R (doc 06).
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
- S2. Position reconcile every 15 min vs broker; per-symbol notional drift > 1%
  with no pending orders → sync to broker + alert; with pending orders → defer 30 s.
- S3. Backtest/live divergence > 30% over 100 trades → auto-pause entries.
- S4. Scheduler watchdog: no decision for > 60 s *in session* → restart feed,
  reconcile before resuming. Off-session (US close, forex weekend) the watchdog
  sleeps — silence is normal, not an alert.
- S5. JEV error streak (5 consecutive failures) → entries paused, exits live,
  alert.

## 5.5 Audit

- Every decision row: ts_ns, context_hash, JEV answers+probs, veto verdict,
  order intent or HOLD reason, chained hash. Append-only, daily backup.
- Weekly: verify hash chain + replay 100 sampled rows.

## Locked decisions

- Rules R1–R9 + stop rule + §5.1a definitions are code constants, not config.
- Any limit change = doc edit + version bump + fresh paper window.
