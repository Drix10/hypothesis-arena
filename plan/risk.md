# Risk rules and determinism

A violation of any rule halts paper trading until human review and demotes a
live stage (`stages.md`). No automatic override exists and no agent can reach
any of these rules.

Rules apply per constraint set (`vision.md`). Where a rule has an India-set
value and a US-set value, the stage's constraint set selects it. The kernel
implements the India set; the US-set rows land with kernel short selling
(`roadmap.md`).

| Rule | India set (cash, long only) | US set (margin, long and short) |
|---|---|---|
| `max_positions` | at most 5 | the strategy's registered count, at most 50 |
| `position_size` | at most 25% of equity | long at most 10%, short at most 5% of equity |
| `total_exposure` | at most 75% of equity | gross at most 150%; net inside the strategy's band (default ±10% at rebalance, ±20% hard) |
| `daily_fills` | at most 20 | at most 20, except a registered rebalance session: at most 3 × the strategy's position count |
| `flip_lock` | inert | active |
| `account_rule` | settled cash | margin buffer |
| `allowlist` | long common stock and ETFs | adds short sales of the same |
| `short_controls` | not applicable | active |

## Position and exposure limits

- **`max_positions`.** Concurrent positions per the table. One open position
  per symbol: a second intent on a held symbol is HOLD until the first closes.
  A long-only book controls concentration through `position_size`,
  `correlation` and the strategy risk budget; a US-set book also through the
  net band. Exposure math counts filled exposure plus pending executable
  exposure, so unfilled entries reserve budget. Account inputs come from the
  broker adapter: equity, settled cash, unsettled proceeds, open-order
  notional, realized and unrealized PnL. Snapshot formulas: `pending_notional`
  is the sum of open-order notional (entry plus unacknowledged);
  `reserved_risk` is `pending_notional` × the per-symbol risk fraction. In an
  India-set account `margin_requirement` is 0 and available buying power is
  settled cash minus pending buy notional; in a US-set account buying power and
  `margin_requirement` come from the broker's margin data and the account rule.
  Pending exposure counts toward every cap below.
- **`position_size` and `total_exposure`.** Limits per the table. Notional is
  size × price, absolute for shorts; equity is taken at snapshot time. Both
  are fixed in the snapshot and never re-read at send. Pending counts. The
  India-set 75% cap also keeps a cash buffer for T+1 settlement timing. A
  US-set book drifts between rebalances (stop-outs, price moves): past the hard
  net band, new entries HOLD and the larger leg is trimmed proportionally by
  exits only; stopped-out slots stay empty until the next rebalance.
- **`daily_fills`.** Fills per day per the table (a full 40-name rebalance
  needs up to 80 orders plus stop replacements, about a third of that for a
  monthly tranche, so US-set rebalance sessions carry their own registered cap; partial fills count once per order). At most
  3 trades per symbol per hour (anti-churn). A trade is a broker-acknowledged
  fill.
- **`flip_lock`.** LONG to SHORT to LONG, or SHORT to LONG to SHORT, completed
  within 1 hour on one symbol forces HOLD for 2 hours on that symbol. Inert in
  an India-set book.
- **`drawdown`.** More than 10% below peak halts all entries (exits only)
  until review. Peak is the larger of the daily-close and intraday high-water
  marks, both persisted, evaluated on snapshot equity each cycle. Strategy
  volatility targets (`math.md`) are set so a 10% drawdown is a tail event.
- **`volatility`.** Realized volatility above 3× the 20-day baseline halves
  sizes until review. Both sides are the standard deviation of 1-hour log
  returns (baseline is the trailing 480 points, current the trailing 24).
  Data-age gate: the latest input bar must fall within the last 2 expected
  hourly bars per the venue session calendar. Weekends and holidays are
  excluded by the calendar; feed gaps count against the budget. A stale input
  makes the rule unavailable and entry is HOLD.
- **`correlation`.** A gate at entry and a drift rule afterward. An entry that
  would create a same-direction pair with Pearson above 0.9 (1-hour closes,
  trailing 30) is HOLD. Insufficient samples, zero variance or missing bars
  make correlation unavailable and the entry HOLD; zero correlation is never
  assumed. Freshness: the latest close must be within the last 2 expected
  hourly bars per the venue calendar and at least 25 of the last 30 expected
  session hours must be present. If drift creates the breach later, remove the
  position maximizing `VaR_reduction / max(sacrificed_unrealized_PnL, epsilon)`
  with `epsilon = $1`; ties go to the older position, then lexicographic
  symbol. If no removal reduces VaR, HOLD new entries and escalate.
- **`sessions_and_compliance`.** Sessions, broker rules and corporate actions
  are hard vetoes through the `broker_compliance_policy` table (broker,
  account type, effective date, day-trade, short, session and settlement
  rules; regulation changes are data updates). No entries outside 09:30-16:00
  America/New_York by the exchange calendar; no extended-hours orders. Day
  trading: the FINRA pattern-day-trader rule was eliminated by SEC approval on
  2026-04-14 (effective 2026-06-04) and Alpaca has removed PDT restrictions and
  the `daytrade_count` fields (by 2026-07-06) in favor of an intraday margin
  framework. It is a table row with effective dates, not a code path, and the
  adapter must not depend on the removed fields. Shorts are HOLD under the
  India set and pass `short_controls` under the US set. Corporate actions
  (splits, dividends, ticker changes, mergers, halts) normalize before the
  feature engine; until the adjustment layer exists, any symbol with a pending
  corporate event is untradeable. Before any live stage the jurisdiction check
  in `stages.md` applies.
- **`account_rule`.**
  India set (settled cash): every buy is funded by settled cash net of pending
  buys; a lot bought with unsettled proceeds may not be sold before those
  proceeds settle (good-faith rule); no buy whose payment depends on selling
  the same security (free-riding). Settlement dates come from the exchange
  calendar (T+1 for US equities).
  US set (margin buffer): every order is checked against Reg T initial margin
  (50%; 150% deposit on a short sale) and the broker's maintenance
  requirements from `broker_compliance_policy` (Alpaca: longs 30% above $6;
  shorts the greater of $5 a share or 30% at $5 and above). After the order,
  equity must stay above 2× the maintenance requirement. Below that buffer, or
  on any broker margin call: a MEDIUM kill, entries HOLD, and gross cut to half
  the strategy target by closing positions. Margin interest, borrow fees and
  short dividends are booked in the account ledger. Violations HOLD the order.
  *Owner:* the account ledger in `exec/`. *Default:* HOLD.
- **`allowlist`.** Live orders only for instruments on the signed allowlist
  attached to the stage manifest: US-listed common stock and ETFs, long only
  under the India set and long and short under the US set; never options,
  futures, FX spot or CFD, leveraged or inverse products, or crypto. Anything
  else is HOLD at candidate admission and again at the veto. Paper books that
  count as promotion evidence obey the same allowlist. *Owner:* the stage
  manifest and `broker_compliance_policy`. *Default:* HOLD.
- **`short_controls` (US set).** A short entry requires the broker's
  `shortable` and `easy_to_borrow` flags at order time; hard-to-borrow names
  are HOLD. No short while the symbol is under the Rule 201 short-sale
  restriction, has a pending corporate event, or has a pending merger or tender
  offer in EDGAR (8-K items 1.01 and 2.01, SC TO, DEFM14A), because a target's
  price can gap up through any stop. Crowding filter: no short where the latest
  FINRA short interest exceeds 20% of float or 10 days to cover. Every short
  carries a broker-native GTC buy-stop (`exit_link` or `exit_event`). A recall,
  a change to hard-to-borrow, or a buy-in notice closes the position
  (BUY-to-cover) at the next session. *Owner:* `exec/` and
  `broker_compliance_policy`. *Default:* HOLD.

## Measurement definitions

- **Peak:** the larger of the daily-close and intraday high-water marks, both
  persisted.
- **Volatility baseline:** the standard deviation of 1-hour log returns over
  the trailing 480 points; current is the trailing 24. Recomputed at 00:00 UTC.
  The bar count is fixed, no synthetic bars, and missing hours are skipped,
  never zero-filled.
- **Correlation:** Pearson on 1-hour closes, trailing 30 points, per pair.
  Computed in the context module, with the breach flag in `state.risk_flags`.
- **VaR** (`risk_flags.var_breach`): parametric 95% on trailing 24-hour 1-hour
  returns, position-weighted; a breach is portfolio VaR above 5% of equity. The
  engine also carries historical expected shortfall and precomputed stress
  scenarios (gap, correlation shock, liquidity stress); the kernel consumes
  bounded precomputed values, with no stochastic model on the hot path.
- **Sizing** is risk-budget based everywhere (below); the strategy slot weights
  in `strategies.md` are caps inside that hierarchy.

## Sizing

Risk sizes positions, not notional percentages: two equal notionals with
different stop distances are different trades.

1. Risk budget: 25 bp of equity per trade.
2. Stop distance from the strategy's exit rule: `notional = budget / stop_distance`.
3. Liquidity cap from the spread and impact estimate.
4. Portfolio caps: `total_exposure`, the marginal-risk gate and pending risk.
5. Stage multiplier (`stages.md`), applied last, before the exposure re-check.
6. Round to valid broker units (the adapter declares minima and steps).

Size is the minimum over steps 2-6. There is no elevated budget: a model
output never raises size.

## Autonomy rules

- **`ai_spend`.** Projected 30-day model spend is evaluated hourly against the
  stage cap (`stages.md`). At 60% trim, at 80% switch to cheap models and a
  SOFT kill, at 100% a MEDIUM kill and demotion. *Default:* throttle research,
  never exits.
- **`research_isolation`.** The research plane writes `features.jsonl` and
  nothing else in the trading tree. It is a separate OS user with no broker
  credentials and no write to the journal, `HALT`, stage files or
  `candidates.jsonl`. *Default:* a permission failure means absent means HOLD.
- **`no_lookahead`.** Every feature carries `observed_at_ns` and
  `ingested_at_ns`; the kernel drops anything observed after the snapshot or
  past its TTL. Features without a source-published timestamp are permanently
  CONTEXT-capped. *Default:* drop. Model-memory lookahead is governed by
  `validation.md`, not by this rule.
- **`conflicts_never_size_up`.** Opposite trigger effects on one symbol give
  HOLD. No averaging and no tie-break toward action.
- **`research_caps`.** Per cycle: at most 40 model calls, 120 tool calls, 250k
  tokens, 8 minutes of wall clock and graph depth 25. Three consecutive aborts
  on one symbol pause that symbol; aborts across a majority of the watchlist
  pause the plane. *Default:* abort, publish nothing, no retry within the
  interval.
- **`kill_switches`.** SOFT, MEDIUM and HARD per `stages.md`. No agent can
  invoke or override any level. Exits, stops and reconcile survive all three.
- **`no_auto_promotion`.** No code path raises a stage. Promotion is a human
  signing a promotion manifest with the process stopped. Demotion is automatic
  and cannot be vetoed. *Default:* the paper stage.

## Incremental risk graph

Portfolio risk is a dependency graph in four layers:

- Layer 0: frozen inputs (the `RiskSnapshot`: positions, pending orders,
  equity, settled cash, PnL, context-derived flags, kill level, stage,
  allowlist).
- Layer 1: measurements derived once (snapshot formulas, exposure sums with
  pending, drawdown against the high-water marks, volatility ratio,
  correlations, VaR and stress, churn and flip state, settlement availability).
- Layer 2: rule predicates (every rule and threshold test; no rule reads
  another rule's verdict).
- Layer 3: one `VetoVerdict` (fixed precedence, all co-causes in
  `reasons_all`) plus the sizing inputs.

Invariants: deterministic, no RNG, no clock reads, allocation-free on the
execution path, integer money. Any refactor or extension (US-set rules, new
rules) must reproduce every existing verdict bit-identically before landing.

## Leverage and stops

- India set: 1×, cash account, long only. US set: margin account, gross at
  most 150%, shorts under `short_controls`. No other leverage in any set.
- Research books may simulate instruments outside the target set only when
  labeled non-promotable research; they never feed a promotion.
- Flatten (`stages.md`, Kill switches) means SELL-to-close longs and, under the
  US set, BUY-to-cover shorts. Exits and covers are never blocked.
- Every order intent carries broker-native protection or the veto rejects it.
  Exit rules are named per strategy: `exit_link`, `exit_event` and `exit_trend`
  (`strategies.md`). Short positions carry buy-stops. Exit variants are
  pre-registered and shadow-tested, never live-tuned.

## Determinism

- The same `context_hash`, candidate and feature set give the same decision.
  Replay checks this weekly on sampled rows.
- No RNG in the decision path. Tie-breaks use fixed documented orders.
- Model, prompt and skill versions are pinned per deployment and logged per
  row; mid-session updates are forbidden. Runtime self-modification of
  prompts, tools or skills is forbidden.
- Portfolio state is snapshotted at decision time. Execution-time drift only
  narrows: re-check at send, shrink or hold, never grow.
- Research non-determinism is contained: replay uses logged `features.jsonl`
  and `candidates.jsonl`, never a re-run of agents or the strategy engine, and
  the strategy engine is separately replay-tested from its logged inputs.
- Hashed numeric fields serialize as scaled integers or fixed-point decimals,
  never language float formatting.
- One clock discipline: an NTP-disciplined wall clock (UTC) for timestamps and
  a monotonic clock for durations. Skew over the threshold makes entries HOLD.

## Self-correction (automatic, logged)

- **Feed gap:** resync, and mark decisions `gap=true` until whole.
- **Position reconcile every 15 minutes against the broker** (the broker is the
  source of truth for execution state):
  - `MATCHED`;
  - `LOCAL_PENDING`;
  - `BROKER_PENDING`: adopt and alert;
  - `BROKER_ONLY`: adopt under stops, alert, and HOLD the symbol;
  - `LOCAL_ONLY` (unprotected): re-establish protection or flatten, and alert;
  - `PARTIAL`: no new risk until resolved;
  - `PROTECTIVE_ORDER_MISSING`: establish protection or flatten, never naked.
  Per-symbol drift above 1% with no pending orders adopts and alerts; with
  pending orders it defers 30 seconds. The settlement ledger reconciles with the
  broker's cash and settled balances each cycle; a mismatch makes entries HOLD.
- **Divergence:** a strategy whose realized results diverge from its own
  backtest distribution beyond the pre-registered tracking bound (default more
  than 30% over 100 trades, or outside the 95% band of simulated paths for
  low-frequency strategies) auto-pauses entries.
- **Scheduler watchdog:** no housekeeping cycle longer than 60 seconds in
  session; otherwise restart the feed and reconcile before resuming.
  Off-session silence is normal.
- **Research outage:** features past TTL are absent, so entries that require a
  trigger feature HOLD. Cached features are never extended.
- **Rejection rate:** feature or candidate rejections above 5% over an hour
  alert; above 25% the emitting source or strategy is treated as failed and
  disabled.
- **Provider outage:** research degrades to harvest-only and entries needing
  research context HOLD. An outage is `research_available=false`, never a
  conflict.
- **Broker outage:** entries stop and exits attempt REST; unresolvable drift
  goes to a HARD kill rather than trading blind.
- **Spend-counter loss:** assume the highest tier reached in the last 24 hours
  until rebuilt. Unknown spend is treated as high spend.
- **Clock skew over the threshold:** entries HOLD; exits and reconcile go on.

Degraded modes only narrow autonomy, never widen it, and every transition is
journaled:

- `FULL`: everything live.
- `DEGRADED_RESEARCH`: the research plane is down; strategies that need no
  research input continue and research-dependent strategies HOLD entries.
- `ENTRY_HALT`: entries off, management on (for example after a rule trip or a
  SOFT kill).
- `EXIT_ONLY`: only exits, stops and reconcile.
- `HARD_STOP`: the HARD sequence in `stages.md`.
- `SHADOW_ONLY`: controls keep computing offline for comparison and never place
  orders.

## Audit

- Every decision row carries `ts_ns`, `context_hash`, candidate id and strategy
  id, features hash, conflict flag, stage, spend tier, settlement state, veto
  verdict, and the order intent or HOLD reason, with a chained hash.
  Append-only, with a daily backup.
- Hash chains detect accidents, not attackers. Every 1000 decisions the
  journal head is Ed25519-signed and the checkpoint stored off-host.
- Weekly: verify the hash chain and replay 100 sampled rows.

## Decisions

- The rules above, the exit rules and the measurement definitions are code
  constants.
- Agents cannot read, write or influence any rule in this document.
- Absent data is never treated as neutral data, anywhere in the system.
- Live scope is the manifest's constraint set: the India set is 1×, cash, long
  only; the US set is margin, long and short, gross at most 150%, easy-to-borrow
  shorts.
- Any limit change is a doc edit and a fresh paper window.
