# 05 — Risk and Determinism (hard rules)

Violation of any numbered rule halts paper trading until human review, and demotes
a live stage (doc 10 §10.2). No auto-override exists by design, and no agent can
reach any of it.

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

## 5.1b Autonomy rules (R10–R17, hard — added for the agentic research plane)

These exist because the system now runs unattended with processes that can spend
money and generate work. Each has an owner, a failure mode, and a default-safe
behavior.

- **R10. AI spend circuit breaker.** Projected 30-day AI spend is evaluated hourly
  against the stage cap (doc 10 §10.4). ≥60% → trim, ≥80% → cheap + SOFT kill,
  ≥100% → MEDIUM kill + demote. *Owner:* hot path. *Default:* throttle research,
  never JEV.
- **R11. Research-plane isolation.** The research plane writes `features.jsonl`
  and nothing else in the trading tree. Separate OS user; no broker credentials;
  no write to journal, `HALT`, or `STAGE`. *Owner:* OS permissions. *Default:*
  a permission failure means no features, which means absent, which means HOLD.
- **R12. No lookahead, structurally.** Every feature carries `observed_at_ns` and
  `ingested_at_ns`. `ctx/` drops anything observed after the snapshot or past its
  TTL. Features without a source-published timestamp are permanently CONTEXT-capped.
  *Owner:* `ingest/`. *Default:* drop.
- **R13. Calibration floor, noise-gated.** If trailing-200-decision Brier for
  `enter` or `veto` is worse than the base-rate baseline by more than a 0.02
  margin, **and** the window holds ≥20 realized outcomes of the resolving class,
  entries halt and the stage demotes (doc 11 §11.1). Below that sample size the
  check reports insufficient-sample rather than pass/fail — a bare "any amount
  worse" test on a rare-event question like `veto` would trip on noise, not on
  an actual failure. *Owner:* calibration harness + hot path. *Default:* entries
  off, exits live.
- **R14. Conflicting conclusions never size up.** `disagreement == true` → HOLD.
  Two TRIGGER features pointing opposite ways on one symbol → HOLD. There is no
  averaging, no tie-break toward action. *Owner:* `risk/`. *Default:* HOLD.
- **R15. Runaway research caps.** Per cycle: ≤40 LLM calls, ≤120 tool calls,
  ≤250k tokens, ≤8 min wall clock, ≤25 graph depth. Three consecutive aborts pause
  the plane. *Owner:* orchestrator + supervisor, independently. *Default:* abort
  the cycle, keep partial features, never retry within the interval.
- **R16. Kill-switch hierarchy.** SOFT / MEDIUM / HARD per doc 10 §10.3. No agent
  can invoke or override any level. Exits, stops, TP, and reconcile survive all
  three. *Owner:* `kill/`. *Default:* the higher level wins.
- **R17. No automatic capital escalation.** No code path raises a stage. Promotion
  is a human editing `STAGE` with the process stopped. Demotion is automatic and
  cannot be vetoed. *Owner:* `STAGE` chain + human. *Default:* G0_PAPER.

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
  updates forbidden. This extends to every agent prompt, tool definition, and
  graph topology in doc 08. **Runtime self-modification of prompts, tools, or
  skills is forbidden** — it breaks replay by construction, which is why
  self-improving agent frameworks are banned from the host (doc 01, doc 08 §8.2).
- D4. Portfolio state snapshotted at decision time; execution-time drift only
  narrows (re-check limits at send; shrink-or-hold, never grow).
- D5. Research non-determinism is contained, not pretended away: agent runs are
  not reproducible, but their *output* is. Replay uses the logged `features.jsonl`
  rows, never a re-run of the agents. The hash covers the features, so a replay
  that produces a different decision from identical features is a bug and halts.

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
- S6. Research-plane outage: no fresh `features.jsonl` past TTL → features absent
  → `ctx/` reports absent (not neutral) → entries requiring a TRIGGER feature
  HOLD. Exits unaffected. Cached features are never extended past TTL to keep
  trading — that is how a dead feed silently becomes a live opinion.
- S7. Feature rejection rate > 5% over an hour → alert; > 25% → treat the emitting
  source as failed and disable it (doc 09 §9.3).
- S8. Provider/LLM outage (JEV or research models): research degrades to
  harvest-only, thesis and critique go empty, `disagreement` defaults to `true`
  (the safe value), entries requiring research context HOLD.
- S9. Broker outage: entries stop immediately; exits attempt REST; unresolvable
  reconcile drift → HARD kill (doc 10 §10.3) rather than trading blind.
- S10. Spend-counter loss (restart, corrupt file) → assume the highest tier
  reached in the last 24 h until the counter is rebuilt from provider billing.
  Unknown spend is treated as high spend.

## 5.5 Audit

- Every decision row: ts_ns, context_hash, features hash, JEV answers+probs,
  disagreement flag, calibration snapshot, stage, spend tier, veto verdict,
  order intent or HOLD reason, chained hash. Append-only, daily backup.
- Weekly: verify hash chain + replay 100 sampled rows.

## Locked decisions

- Rules R1–R17 + stop rule + §5.1a definitions are code constants, not config.
- Agents cannot read, write, or influence any rule in this document.
- Absent data is never treated as neutral data, anywhere in the system.
- Any limit change = doc edit + version bump + fresh paper window.
