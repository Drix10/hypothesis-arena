# 05 — Risk and Determinism (hard rules)

Violation of any numbered rule halts paper trading until human review, and demotes
a live stage (doc 10 §10.2). No auto-override exists by design, and no agent can
reach any of it.

## 5.1 Position and exposure limits (ported from hypothesis-arena)

- R1. Max 3 concurrent positions. Max 2 in the same direction. One open position
  per symbol — a second intent on a held symbol is HOLD until the first closes.
  Exposure math counts filled exposure PLUS pending executable exposure
  (unfilled entry orders reserve budget; a system with 0 filled and $500k
  pending is not at zero exposure). Account inputs are first-class: equity,
  cash, margin used/available, unrealized/realized PnL, open-order notional —
  from the broker adapter (Phase 3), paper-equivalents before that.
  Snapshot-time formulas (K6, frozen before P3.5 coding):
  `pending_notional` = sum of open-order notional (entry + unacked); 
  `reserved_risk` = pending_notional × per-symbol risk fraction;
  `margin_requirement` = broker-reported margin used + pending margin at the
  adapter's stated rate; `available buying power` = equity − margin used −
  pending margin, all in account currency (FX converted at snapshot mid).
  Pending exposure counts toward every cap below.
- R2. Single position ≤ 25% notional/equity. Total exposure ≤ 75% notional/equity.
  (Notional = size × price; equity = account equity at snapshot time. Both frozen
  in the snapshot, never re-read at send. Pending exposure counts toward both.)
- R3. Max 20 trades/day. Max 3 trades/symbol/hour (anti-churn). A "trade" =
a broker-acknowledged fill (not an intent, not an order — unacked orders do not
  consume churn budget, they consume pending-risk budget under R1/R2).
- R4. Symmetric flip-lock: LONG→SHORT→LONG or SHORT→LONG→SHORT completions
  within 1 h on one symbol → force HOLD 2 h on that symbol. A flip completion
  = two filled direction-changing orders; direction is position sign, entries
  into flat do not count.
- R5. Drawdown > 10% from peak → HALT all entries (exits only) until review.
  Peak = max(daily_close_hwm, intraday_hwm), both persisted: daily_close_hwm
  = running maximum of closed-UTC-day equity; intraday_hwm = running maximum
  of snapshot equity observed since the stage/reset epoch. Drawdown is
  evaluated on snapshot equity each cycle — an intraday spike-to-trough
  counts exactly like a close-to-close one.
- R6. Realized volatility > 3× 20-day baseline → halve sizes until review.
  Like-with-like only: both sides are stdev of 1 h log returns (baseline =
  trailing 480 points, current = trailing 24). No cross-horizon comparison.
  Data-age gate (frozen): the latest input bar must fall within the last 2
  EXPECTED hourly bars per the venue session calendar (doc 01) — weekends
  and holidays are excluded BY THE CALENDAR, feed gaps count against the
  budget. A stale R6 input (older than that) makes R6 UNAVAILABLE and entry
  is HOLD: an unknown volatility state cannot be sized, and "halve" of an
  unmeasurable number is not risk control.
- R7. Correlation gate at entry + drift rule after. Entry that would create a
  same-direction pair with Pearson > 0.9 (1 h closes, trailing 30) is HOLD —
  prevention, not cleanup. Insufficient samples, zero variance, or missing
  bars → correlation UNAVAILABLE → entry HOLD (K4: never assume zero
  correlation). Freshness (frozen): the latest close must be within the last
  2 expected hourly bars per the venue calendar AND at least 25 of the last
  30 expected session hours must be present — 30 stale-but-counted points
  are not 30 observations. Coverage is measured over expected session time,
  not over whatever the feed happened to deliver. If drift creates the breach later, remove the position
  maximizing (VaR_reduction / max(sacrificed_unrealized_PnL, epsilon)) with
epsilon = $1: zero-denominator positions rank by VaR_reduction alone;
  negative-PnL positions are eligible (sacrifice = max(PnL, epsilon) keeps
  the ordering total); exact ties break by older position first, then
  lexicographic symbol. If no removal reduces VaR, HOLD new entries and
  escalate instead of churning. Deterministic, computed, logged. Never
  blindly "newest".
  (Phase 3 extends this to factor/beta exposure; the gate stays.)
- R8. `max` budget requires the doc 03 §3.3 max-gate or downgrade. No exceptions.
- R9. Sessions, broker rules, and corporate plumbing are hard vetoes, via a
  `broker_compliance_policy` adapter (broker, account type, effective date,
  margin/day-trade/short/session rules — effective-date-aware, so regulation
  changes are data updates, not rewrites; internal risk stays stricter than
  the external rule regardless). No stock entries outside 09:30–16:00
  America/New_York (IANA, exchange calendar); no forex entries when the venue
  feed is closed; PDT-style day-trade counting runs locally before every stock
  entry under whatever rule is currently effective. Shorts: HOLD unless
  shortable == true with valid borrow/locate, acceptable borrow cost, clean
  SSR state, and sufficient margin — part of the pre-trade contract from G2
  (G1 is forex-only). Corporate actions: splits, dividends, ticker changes,
  mergers, halts normalize BEFORE the feature engine (adjustment layer, Phase 3
  implements; until then any symbol with a pending corporate event is
  untradeable), and positions reconcile across symbol events per the §5.4 FSM.
  Before any live stage (G1+): the LIVE JURISDICTION GATE — operator
  jurisdiction, broker authorization, instrument legality, funding route,
  tax/reporting — all checked and logged. "Broker has an API" is not
  "this deployment is legal."

## 5.1a Measurement definitions (without these the rules are slogans)

- Peak (R5): max(daily_close_hwm, intraday_hwm), both persisted.
  daily_close_hwm = running maximum of closed-UTC-day equity;
  intraday_hwm = running maximum of snapshot equity since stage/reset epoch.
  Drawdown = peak − current equity, evaluated on snapshot equity each cycle.
- Volatility baseline (R6): stdev of 1 h log returns over trailing 480 points
  (~20 days); current = trailing 24 points. Persisted; recomputed at 00:00 UTC.
  Asset-class coherent (K3): fixed bar COUNT with no synthetic bars — FX 24/5
  and US equities 6.5 h/day both count actual 1 h bars; missing hours (halts,
  holidays, feed gaps) are skipped, never zero-filled; spans therefore differ
  by calendar and that is recorded, not normalized away.
- Correlation (R7): Pearson on 1 h closes, trailing 30 points, per open-pair.
  Computed in `ctx/`, breach flag lands in `state.risk_flags`.
- VaR (`latent_risk` question + `risk_flags.var_breach`): parametric 95% on trailing 24 h
  1 h returns, position-weighted; breach = portfolio VaR > 5% equity. VaR is
  necessary but not sufficient: the engine also carries historical expected
  shortfall plus precomputed stress scenarios (gap, correlation shock,
  liquidity stress). C++ consumes bounded precomputed values — no stochastic
  model runs in the hot path.
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
  `enter` or `latent_risk` is worse than the base-rate baseline by more than a 0.02
  margin, **and** the window holds ≥20 realized outcomes of the resolving class,
  entries halt and the stage demotes (doc 11 §11.1). Below that sample size the
  check reports insufficient-sample rather than pass/fail — a bare "any amount
  worse" test on a rare-event question like `latent_risk` would trip on noise, not on
  an actual failure. *Owner:* calibration harness + hot path. *Default:* entries
  off, exits live.
- **R14. Conflicting conclusions never size up.** `disagreement == true` → HOLD.
  Two TRIGGER features pointing opposite ways on one symbol → HOLD. There is no
  averaging, no tie-break toward action. *Owner:* `risk/`. *Default:* HOLD.
- **R15. Runaway research caps.** Per cycle: ≤40 LLM calls, ≤120 tool calls,
  ≤250k tokens, ≤8 min wall clock, ≤25 graph depth. Two counters, no
  contradiction: 3 consecutive aborts on one symbol → that symbol's research
  pauses; a majority of watchlist symbols aborting in the same window → the
  plane degrades/pauses. *Owner:* orchestrator + supervisor, independently.
  *Default:* abort the cycle, publish nothing (last complete bundle stands),
  never retry within the interval.
- **R16. Kill-switch hierarchy.** SOFT / MEDIUM / HARD per doc 10 §10.3. No agent
  can invoke or override any level. Exits, stops, TP, and reconcile survive all
  three. *Owner:* `kill/`. *Default:* the higher level wins.
- **R17. No automatic capital escalation.** No code path raises a stage. Promotion
  is a human editing the stage chain with the process stopped (terminology:
  `PROMOTION_MANIFEST` + `STAGE_STATE`, doc 10 §10.1 — other docs' bare
  "`STAGE`" means this chain; the legacy single `STAGE` file is the G0
  bootstrap only). Demotion is automatic and cannot be vetoed. *Owner:* `STAGE` chain + human. *Default:* G0_PAPER.

## 5.1c Incremental risk DAG (frozen shape)

Per the gap analysis, portfolio risk is a dependency DAG, not a flat
checklist. Layers (each layer reads only the layers below it):

- L0 frozen inputs: the `RiskSnapshot` as frozen at snapshot time
  (positions, pending orders, equity/margin/PnL, ctx-derived flags:
  R6 vol state, R7 corr flags, VaR/stress values, session/short/corp
  flags, calibration-gate inputs, event phase, kill level, stage).
- L1 derived-once MEASUREMENTS (no predicates, no breach flags — every
  threshold test lives in L2): K6 formulas (pending_notional,
  reserved_risk, margin_requirement, buying_power), exposure sums with
  pending (total, same-side), drawdown measurement vs persisted HWMs,
  volatility ratio (current vs baseline), correlation coefficients,
  VaR and stress-scenario values, churn counters (R3), flip timing state
  (R4), deterministic drift candidate (R7 directive inputs). Each L1
  quantity is computed ONCE per evaluation and shared by reference —
  never recomputed inconsistently by two rules.
- L2 rule nodes (predicates): R1–R17 + session/short/corp/event checks +
  every threshold test (R5 trip, R6 trip/halve, R7 breach, VaR breach,
  stress breach, calibration-gate breach, exposure-cap breach). Each node
  reads L0 fields and L1 quantities only; no node reads another rule
  node's verdict (no rule-to-rule edges — verdicts combine only at L3).
- L3 verdict: one `VetoVerdict` (frozen precedence order, all co-causes
  preserved in reasons_all) + `BuildEngineInputs` fill onto the frozen
  P3.3 table inputs.

DAG invariants (load-bearing for every future slice): deterministic
(same snapshot → same verdict, no RNG, no clock reads); allocation-free
on the execution path (fixed storage verdict, stack derivations);
integer-exact money math. Slice B status (frozen, do not reopen): the
current `EvaluateVeto` computes small helpers per rule and is
functionally correct as proven by its 153+ suite — the DAG section is
the contract that any future refactor or H1 integration must satisfy,
proven by bit-identical verdicts on that suite before landing. No Slice
B behavior change is authorized by this section.

## 5.2 Leverage / stop table (locked)

v1 caps: forex ≤ 5×, US stocks ≤ 2× (1× on cash account — Reg T, no exceptions).
Higher leverage unlocks only after a phase-5 review + doc edit, never silently.

Stops are `exit_profile_v1` (doc 03 §3.3): 1.5 × ATR(14), floored at 0.1% of
price, TP 2R, mandatory time_exit — one frozen profile for both asset classes
(a fixed-% stop built for crypto would never trigger on EURUSD and would bleed
on TSLA). Profile variants are shadow-tested, never live-tuned. Every order
intent carries a stop or it is rejected by the deterministic risk veto (`risk/veto.cpp`).

## 5.3 Determinism contract

- D1. Same `context_hash` + same question version → same answers (cache) → same
  decision. Replay test proves it weekly on sampled rows.
- D2. No RNG in decision path. Tie-breaks by fixed edge_family order (execution last, others alphabetical).
- D3. Model/prompt versions pinned per deployment; logged per row; mid-session
  updates forbidden. This extends to every agent prompt, tool definition, and
  graph topology in doc 08. **Runtime self-modification of prompts, tools, or
  skills is forbidden** — it breaks replay by construction, which is why
  self-improving agent frameworks are banned from the host (doc 01, doc 08 §8.2).
- D4. Portfolio state snapshotted at decision time; execution-time drift only
  narrows (re-check limits at send; shrink-or-hold, never grow).
- D6. Canonical numbers: every hashed numerical field serializes as scaled
  integers / fixed-point decimal with explicit precision — never language float
  formatting. Floats live inside calculations; hashes see fixed-point.
- D7. One clock discipline: chrony/NTP, skew monitored; wall clock (UTC) for
  timestamps, monotonic clock for elapsed durations. Skew over threshold →
  entries HOLD (S11).
- D5. Research non-determinism is contained, not pretended away: agent runs are
  not reproducible, but their *output* is. Replay uses the logged `features.jsonl`
  rows, never a re-run of the agents. The hash covers the features, so a replay
  that produces a different decision from identical features is a bug and halts.

## 5.4 Self-correction (automatic, logged)

- S1. Feed gap → request/resync, mark decisions `gap=true` until whole.
- S2. Position reconcile every 15 min vs broker; the broker is source of truth
  for execution state, never silently overwritten. States: MATCHED (nothing to
  do), LOCAL_PENDING (awaiting ack), BROKER_PENDING (ack without local row →
  adopt + alert), BROKER_ONLY (broker holds what we do not → adopt as an
  unmanaged position under stops, alert, entries HOLD for the symbol),
  LOCAL_ONLY (we hold what broker lacks → treat as unprotected, re-establish
  or flatten, alert), PARTIAL (split accounting, no new risk until resolved),
  PROTECTIVE_ORDER_MISSING (position without broker-native protection →
  §6 handling: establish or flatten, never leave naked). Per-symbol notional
  drift > 1% with no pending orders → adopt broker state + alert; with pending
  orders → defer 30 s.
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
  harvest-only, thesis and critique go empty, entries requiring research
  context HOLD. Outage is reported as `research_available=false` /
  `jev_available=false` + `provider_health` — NEVER as `disagreement=true`:
  an outage is uncertainty, not evidence conflict, and must not invoke R14
  semantics (S2).
- S9. Broker outage: entries stop immediately; exits attempt REST; unresolvable
  reconcile drift → HARD kill (doc 10 §10.3) rather than trading blind.
- S10. Spend-counter loss (restart, corrupt file) → assume the highest tier
  reached in the last 24 h until the counter is rebuilt from provider billing.
  Unknown spend is treated as high spend.
- S11. Clock skew over threshold → entries HOLD until chrony recovers; exits
  and reconcile continue. Timestamps from an untrusted clock never gate exits.

Degraded strategy modes (locked — HOLD is safe but total, so the system names
its partial states): FULL (everything live), DEGRADED_RESEARCH (plane down —
baseline strategy from doc 12 may continue only if it needs no research input
and no source-dependent rule is armed), BASELINE_ONLY is a SHADOW mode —
the doc-12 baseline keeps computing offline for calibration comparison only
and never places live entries. JEV down means ENTRY_HALT / EXIT_ONLY for
live capital: an unavailable decision gate narrows autonomy, never bypasses
it. Any future autonomous JEV-bypass design needs a deliberate architecture
change and fresh authorization.
(entries off, management on), EXIT_ONLY, HARD_STOP. Mode transitions are
journaled; a mode never widens autonomy, only narrows it.

## 5.5 Audit

- Every decision row: ts_ns, context_hash, features hash, JEV answers+probs,
  disagreement flag, calibration snapshot, stage, spend tier, deterministic veto verdict,
  order intent or HOLD reason, chained hash. Append-only, daily backup.
- Hash chains detect accidents, not attackers: every 1000 decisions the journal
  head is Ed25519-signed and the checkpoint stored off-host where the trading
  process cannot rewrite it. Live backup = local journal + second copy +
  signed checkpoint. A full-file rewrite without the key is detectable; with
  the key it is a human act, logged as one.
- Weekly: verify hash chain + replay 100 sampled rows.

## Locked decisions

- Rules R1–R17 + stop rule + §5.1a definitions are code constants, not config.
- Agents cannot read, write, or influence any rule in this document.
- Absent data is never treated as neutral data, anywhere in the system.
- Any limit change = doc edit + version bump + fresh paper window.
