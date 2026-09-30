# 05 - Risk and Determinism (hard rules, `risk_version: R1-R19+v3`)

Violation of any numbered rule halts paper trading until human review and
demotes a live stage (doc 10 §10.2). No auto-override exists, and no agent
can reach any of these rules.

## 5.1 Position and exposure limits

- R1. Max 5 concurrent positions (= `EXEC_UNIVERSE_MAX`). One open
  position per symbol: a second intent on a held symbol is HOLD until the
  first closes. A same-direction cap applies only to books that may short
  (shadow research books); a long-only book controls concentration through
  R2, R7, and the sleeve/portfolio risk budget. Exposure math counts filled
  exposure plus pending executable exposure (unfilled entries reserve
  budget). Account inputs come from the broker adapter: equity, settled
  cash, unsettled proceeds, open-order notional, realized/unrealized PnL.
  Snapshot-time formulas (K6, frozen): `pending_notional` = sum of
  open-order notional (entry + unacked); `reserved_risk` = pending_notional
  × per-symbol risk fraction. In a cash account `margin_requirement` = 0
  and available buying power = settled cash − pending buy notional (the
  margin formula applies to shadow books only). Pending exposure counts
  toward every cap below.
- R2. Single position ≤ 25% notional/equity. Total exposure ≤ 75%
  notional/equity. (Notional = size × price; equity at snapshot time; both
  frozen in the snapshot, never re-read at send. Pending counts toward
  both.) The 75% cap also keeps a cash buffer for T+1 settlement timing.
- R3. Max 20 trades/day. Max 3 trades/symbol/hour (anti-churn). A "trade"
  = a broker-acknowledged fill.
- R4. Symmetric flip-lock: LONG→SHORT→LONG or SHORT→LONG→SHORT completions
  within 1 h on one symbol → force HOLD 2 h on that symbol. (Inert in a
  long-only book; kept for shadow books.)
- R5. Drawdown > 10% from peak → HALT all entries (exits only) until
  review. Peak = max(daily_close_hwm, intraday_hwm), both persisted;
  evaluated on snapshot equity each cycle. Sleeve and book volatility
  targets (doc 02 M1) are set so a 10% drawdown is a tail event, not a
  routine one.
- R6. Realized volatility > 3× 20-day baseline → halve sizes until review.
  Both sides are stdev of 1 h log returns (baseline = trailing 480 points,
  current = trailing 24). Data-age gate (frozen): the
  latest input bar must fall within the last 2 EXPECTED hourly bars per
  the venue session calendar (doc 01). Weekends and holidays are
  excluded by the calendar; feed gaps count against the budget. A stale R6
  input makes R6 UNAVAILABLE and entry is HOLD.
- R7. Correlation gate at entry, drift rule after. An entry that would
  create a same-direction pair with Pearson > 0.9 (1 h closes, trailing 30)
  is HOLD. Insufficient samples, zero variance, or missing bars →
  correlation UNAVAILABLE → entry HOLD (zero correlation is never assumed).
  Freshness (frozen): the latest close must be within the last 2 expected
  hourly bars per the venue calendar AND
  at least 25 of the last 30 expected session hours must be present.
  If drift creates the breach later, remove the position maximizing
  (VaR_reduction / max(sacrificed_unrealized_PnL, epsilon)) with
  epsilon = $1; ties → older position, then lexicographic symbol. If no
  removal reduces VaR, HOLD new entries and escalate.
- R8. `max` budget requires the doc 03 §3.3 max-gate or downgrade. Applies
  only when a sleeve's filter policy is `jev`; the always-take path sizes
  at base budget only (no 2×R without a gate that can grant it).
- R9. Sessions, broker rules, and corporate plumbing are hard vetoes via
  the `broker_compliance_policy` adapter table (broker, account type,
  effective date, day-trade/short/session/settlement rules; regulation
  changes are data updates). No entries outside 09:30–16:00
  America/New_York (exchange calendar); no extended-hours orders in v1.
  Day-trade counting: the FINRA pattern-day-trader framework was
  eliminated by SEC approval on 2026-04-14 (effective 2026-06-04; broker
  implementation deadline 2027-10-20). It is a table row with effective
  dates, not a code path; cash accounts are governed by R18. Shorts: live
  HOLD always (R19); shadow books require shortable + borrow + SSR +
  margin checks. Corporate actions (splits, dividends, ticker changes,
  mergers, halts) normalize BEFORE the feature engine; until the
  adjustment layer exists, any symbol with a pending corporate event is
  untradeable. Before any live stage: the LIVE JURISDICTION GATE (doc 10
  §10.1a).
- R18. **Settled-cash rule (cash account).** Every buy must be funded by
  settled cash net of pending buys; a lot bought with unsettled proceeds
  may not be sold before those proceeds settle (good-faith rule); no buy
  whose payment depends on selling the same security (free-riding).
  Settlement dates come from the exchange calendar (T+1 for US equities).
  Violations HOLD the order. *Owner:* `exec/` settlement ledger.
  *Default:* HOLD.
- R19. **Jurisdiction instrument allowlist.** Live orders only for
  instruments on the signed allowlist attached to the stage manifest
  (default: US-listed common stock and ETFs; long only; no margin, short,
  options, futures, FX spot/CFD, leveraged/inverse products). Anything
  else is HOLD at candidate admission and again at veto. Paper books that
  count as promotion evidence obey the same allowlist.
  *Owner:* stage manifest + `broker_compliance_policy`. *Default:* HOLD.

## 5.1a Measurement definitions

- Peak (R5): max(daily_close_hwm, intraday_hwm), both persisted.
- Volatility baseline (R6): stdev of 1 h log returns over trailing 480
  points; current = trailing 24. Recomputed at 00:00 UTC. Fixed bar COUNT,
  no synthetic bars; missing hours skipped, never zero-filled.
- Correlation (R7): Pearson on 1 h closes, trailing 30 points, per pair.
  Computed in `ctx/`, breach flag in `state.risk_flags`.
- VaR (`risk_flags.var_breach`): parametric 95% on trailing 24 h 1 h
  returns, position-weighted; breach = portfolio VaR > 5% equity. The
  engine also carries historical expected shortfall and precomputed stress
  scenarios (gap, correlation shock, liquidity stress); C++ consumes
  bounded precomputed values, with no stochastic model on the hot path.
- Sizing is risk-budget based everywhere (doc 03 §3.3 hierarchy; sleeve
  slot weights in doc 02 are caps inside that hierarchy). Conviction never
  authorizes size.

## 5.1b Autonomy rules (R10–R17, hard)

- **R10. AI spend circuit breaker.** Projected 30-day AI spend is evaluated
  hourly against the stage cap (doc 10 §10.4). ≥60% → trim, ≥80% → cheap +
  SOFT kill, ≥100% → MEDIUM kill + demote. *Default:* throttle research,
  never exits; JEV only affects sleeves that configured it.
- **R11. Research-plane isolation.** The research plane writes
  `features.jsonl` and nothing else in the trading tree. Separate OS user;
  no broker credentials; no write to journal, `HALT`, stage chain, or
  `candidates.jsonl`. *Default:* permission failure = absent = HOLD.
- **R12. No lookahead, structurally.** Every feature carries
  `observed_at_ns` and `ingested_at_ns`; `ctx/` drops anything observed
  after the snapshot or past its TTL. Features without a source-published
  timestamp are permanently CONTEXT-capped. *Default:* drop. (Model-memory
  lookahead is governed by doc 11 §11.0c, not by R12.)
- **R13. Calibration floor, noise-gated.** For a sleeve with
  `filter = jev`: if trailing-200 Brier for `enter` or `latent_risk` is
  worse than base rate by more than 0.02 AND ≥ 20 realized outcomes of the
  resolving class exist, that sleeve's entries halt and the stage demotes
  (doc 11). Below the sample floor: `insufficient`, not gated.
- **R14. Conflicting conclusions never size up.** `disagreement == true`
  (opposite TRIGGER effects on one symbol) → HOLD. No averaging, no
  tie-break toward action.
- **R15. Runaway research caps.** Per cycle: ≤40 LLM calls, ≤120 tool calls,
  ≤250k tokens, ≤8 min wall clock, ≤25 graph depth. 3 consecutive aborts
  on one symbol pause that symbol; majority-of-watchlist aborts pause the
  plane. *Default:* abort, publish nothing, no retry within the interval.
- **R16. Kill-switch hierarchy.** SOFT / MEDIUM / HARD per doc 10 §10.3.
  No agent can invoke or override any level. Exits, stops, and reconcile
  survive all three.
- **R17. No automatic capital escalation.** No code path raises a stage.
  Promotion is a human signing a `PROMOTION_MANIFEST` with the process
  stopped (doc 10 §10.1). Demotion is automatic and cannot be vetoed.
  *Default:* G0_PAPER.

## 5.1c Incremental risk DAG (frozen shape)

Portfolio risk is a dependency DAG:

- L0: frozen inputs (the `RiskSnapshot`: positions, pending orders,
  equity/settled cash/PnL, ctx-derived flags, kill level, stage,
  allowlist).
- L1: derived-once measurements (K6 formulas, exposure sums with pending,
  drawdown vs HWMs, vol ratio, correlations, VaR/stress, churn and flip
  state, settlement availability).
- L2: rule predicates (R1–R19 and every threshold test; no rule reads
  another rule's verdict).
- L3: one `VetoVerdict` (frozen precedence, all co-causes in reasons_all)
  + `BuildEngineInputs`.

Invariants: deterministic, no RNG, no clock reads, allocation-free on the
execution path, integer money. Slice B (`EvaluateVeto`, 153+ suite) is
functionally correct; any refactor or extension (R18/R19, always-take)
must reproduce every existing verdict bit-identically before landing.

## 5.2 Leverage / stop table (locked)

- Live (G1+): 1×, cash account, long only, every stage. No margin.
- Shadow research books may simulate shorting or leverage only when
  labeled non-promotable research; they never feed a promotion.
- Every order intent carries broker-native protection or it is rejected by
  `risk/veto.cpp`. Exit profiles are versioned per sleeve:
  `exit_profile_v1` (1.5×ATR(14) stop floored at 0.1%, TP 2R, calendar
  time_exit; `baseline_v1` only, diagnosed as horizon-mismatched in
  doc 12), `exit_trend_v1`, `exit_intraday_v1`, `exit_event_v1` (doc 02).
  Profile variants are pre-registered and shadow-tested, never live-tuned.

## 5.3 Determinism contract

- D1. Same `context_hash` + same candidate + same filter answers (if any)
  → same decision. Replay checks this weekly on sampled rows.
- D2. No RNG in the decision path. Tie-breaks use fixed documented orders.
- D3. Model/prompt/skill versions are pinned per deployment and logged per
  row; mid-session updates are forbidden. Runtime self-modification of
  prompts, tools, or skills is forbidden.
- D4. Portfolio state is snapshotted at decision time; execution-time drift
  only narrows (re-check at send; shrink-or-hold, never grow).
- D5. Research non-determinism is contained: replay uses logged
  `features.jsonl` and `candidates.jsonl`, never a re-run of agents or
  the sleeve engine; the sleeve engine is separately replay-tested from
  its logged inputs.
- D6. Canonical numbers: hashed numeric fields serialize as scaled
  integers / fixed-point decimals, never language float formatting.
- D7. One clock discipline: NTP-disciplined wall clock (UTC) for
  timestamps, monotonic for durations. Skew over threshold → entries HOLD
  (S11).

## 5.4 Self-correction (automatic, logged)

- S1. Feed gap → resync, mark decisions `gap=true` until whole.
- S2. Position reconcile every 15 min vs broker (broker = source of truth
  for execution state): MATCHED, LOCAL_PENDING, BROKER_PENDING (adopt +
  alert), BROKER_ONLY (adopt under stops, alert, symbol HOLD), LOCAL_ONLY
  (unprotected: re-establish or flatten, alert), PARTIAL (no new risk
  until resolved), PROTECTIVE_ORDER_MISSING (establish or flatten, never
  naked). Per-symbol drift > 1% with no pending orders → adopt + alert;
  with pending → defer 30 s. The settlement ledger reconciles with the
  broker's cash/settled balances each cycle; mismatch = entries HOLD.
- S3. Backtest/shadow/live divergence: a sleeve whose realized results
  diverge from its own backtest distribution beyond the pre-registered
  tracking bound (default: > 30% over 100 trades, or outside the 95%
  band of simulated paths for low-frequency sleeves) → auto-pause entries.
- S4. Scheduler watchdog: no housekeeping cycle > 60 s in session →
  restart feed, reconcile before resuming. Off-session silence is normal.
- S5. JEV error streak (5 consecutive failures) → entries paused for
  sleeves configured with `jev`; always-take sleeves unaffected; alert.
- S6. Research-plane outage: features past TTL → absent → entries that
  require a TRIGGER feature HOLD. Cached features are never extended.
- S7. Feature or candidate rejection rate > 5% over an hour → alert;
  > 25% → treat the emitting source/sleeve as failed and disable it.
- S8. Provider/LLM outage: research degrades to harvest-only; entries
  needing research context HOLD. Outage is `research_available=false` /
  `jev_available=false`, never `disagreement=true`.
- S9. Broker outage: entries stop; exits attempt REST; unresolvable drift
  → HARD kill rather than trading blind.
- S10. Spend-counter loss → assume the highest tier reached in the last
  24 h until rebuilt. Unknown spend is treated as high spend.
- S11. Clock skew over threshold → entries HOLD; exits and reconcile go on.

Degraded modes (locked; a mode only narrows autonomy, never widens it;
transitions are journaled):
- `FULL` - everything live.
- `DEGRADED_RESEARCH` - research plane down; sleeves that need no research
  input continue; research-dependent sleeves HOLD entries.
- `ENTRY_HALT` - entries off, management on (e.g. JEV down for a
  `jev` sleeve, R-trip, SOFT kill).
- `EXIT_ONLY` - only exits, stops, reconcile.
- `HARD_STOP` - doc 10 HARD sequence.
- `BASELINE_ONLY` (shadow) - controls keep computing offline for
  comparison and never place orders.

## 5.5 Audit

- Every decision row: ts_ns, context_hash, candidate CID + sleeve id,
  features hash, filter answers (if any), disagreement flag, calibration
  snapshot, stage, spend tier, settlement state, veto verdict, order
  intent or HOLD reason, chained hash. Append-only, daily backup.
- Hash chains detect accidents, not attackers: every 1000 decisions the
  journal head is Ed25519-signed and the checkpoint stored off-host.
- Weekly: verify the hash chain and replay 100 sampled rows.

## Locked decisions

- Rules R1–R19, the stop rules, and the §5.1a definitions are code
  constants.
- Agents cannot read, write, or influence any rule in this document.
- Absent data is never treated as neutral data, anywhere in the system.
- Live = 1×, cash account, long only, allowlisted instruments (R18/R19).
- Any limit change = doc edit + version bump + fresh paper window.
