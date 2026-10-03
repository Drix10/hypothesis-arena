# Stages, kill switches and spend control

The limits the system runs inside: which stage it is in, what that stage
permits, what the operator may lawfully trade, who may change any of it (a
human, always), how the system is shut down, and how much it may spend on
models.

The system is autonomous in research, decisions and execution. It is never
autonomous in raising capital exposure.

## Stage files

A hash is not a signature: anyone holding a file can recompute it. The human
act and the runtime state are therefore separate objects.

- **`PROMOTION_MANIFEST`** (human-owned, written with the process stopped,
  immutable once signed). Fields: `from_stage`, `to_stage`,
  `intended_capital_usd`, `allocated_capital_usd`, `policy_version`,
  `plan_hash`, `approved_at`, `evidence_hash`, `signer_id`, `approved_strategies`
  (strategy id and version), `constraint_set` (india or us),
  `instrument_allowlist`, `jurisdiction_evidence_hash` (from the tiny stage on),
  plus an Ed25519 `signature` over all of it. The process verifies the
  signature, the signer key, the plan version, the prior stage and sane capital,
  and only then advances. The runtime never modifies promotion material.
- **`STAGE_STATE`** (process-owned, append-only): runtime `DEMOTION_EVENT`
  records. A demotion appends, journals and alerts; it never edits a manifest.
- `effective_stage` is the last verified promotion minus automatic
  `STAGE_STATE` demotions. No shared ownership, no human edits to runtime
  files, no process writes to manifests.
- **Paper bootstrap.** A single-file `STAGE` format starts the paper stage; the
  first promotion out of paper moves to manifests:

```
stage:        PAPER
approved_by:  <human name>
approved_at:  <ISO8601>
capital_usd:  0
attest_hash:  <sha256 of "stage|approved_by|approved_at|capital_usd|prev_attest",
              pipe-delimited, exact field order; the first prev_attest is "GENESIS">
```

  Only `scripts/sign-stage.sh` writes this file. At build, set `stage: PAPER` and
  `capital_usd: 0`, fill `approved_by` and `approved_at`, compute `attest_hash`
  with `printf '%s' "PAPER|<name>|<iso8601>|0|GENESIS" | sha256sum`, place the
  file where the kernel reads it, and log the signing in `roadmap.md`. Until the
  file exists and verifies, nothing starts: there is no default stage.
- A chain that does not verify means the system starts in the paper stage,
  alerts and refuses live orders. Corruption fails toward paper.
- **Capital semantics:** `intended_capital_usd` is the full target size,
  `allocated_capital_usd` is what is actually deposited and
  `current_equity_usd` is live. "At most 2% of intended capital" is computed from
  the manifest. From the scaled stage on, every percentage cap uses
  `risk_capital = min(intended, allocated, current_equity)` at snapshot time.
- Alerts mean: append to `alerts.jsonl`, a non-zero exit where the process
  stops, and the outbound-only alert adapter (`execution.md`). Unattended
  operation, paper trading included, is blocked until that adapter exists.
- The research plane, the factory and the strategy engine cannot read or write
  the stage files.
- No code path raises a stage. Promotion is a human signing a manifest while
  the system is down.

## Jurisdiction check (required before the tiny stage)

A broker API does not make a deployment legal. Before any promotion to the tiny
stage the operator attaches, as `jurisdiction_evidence_hash`, a signed evidence
bundle for the constraint set the manifest names (`vision.md`).

**India set (India-resident):**

1. Operator residency and the funding route (RBI LRS, USD 250,000 per
   financial year), with bank confirmation that the remittance purpose code is
   overseas portfolio investment.
2. Written confirmation from a qualified professional (an Indian chartered
   accountant or FEMA counsel) that the allowlist is permissible: US-listed
   common stock and ETFs, long only, cash account, no margin, no short selling,
   no forex, no options or futures, no leveraged or inverse products (LRS
   prohibits remitting for margin trading and for trading foreign exchange
   abroad).
3. Broker account evidence: an Alpaca international account opened for the
   operator's country, cash account type confirmed, USD funding route.
4. Tax and reporting treatment: US dividend withholding (W-8BEN), Indian TCS on
   LRS remittances and its credit, foreign-asset and foreign-income reporting in
   the Indian return, and capital-gains records in INR.
5. The `broker_compliance_policy` rows for the account (settlement,
   good-faith and free-riding rules, day-trade rules at their effective dates)
   reviewed and signed.

**US set (US-resident):**

1. Operator US residency and tax status (resident alien or citizen; W-9 with the
   broker), and any visa or employer trading restriction, confirmed in writing
   by a qualified US tax or securities professional.
2. Indian residency status after the move (FEMA and income tax) and the
   treatment of assets held abroad, confirmed by an Indian chartered accountant
   or FEMA counsel.
3. Broker account evidence: a US margin account approved for short selling,
   with the margin agreement and the broker's maintenance requirements on file.
4. The `broker_compliance_policy` rows (Reg T, maintenance, Rule 201, borrow and
   buy-in handling, day-trade rules at their effective dates) reviewed and
   signed.
5. Written professional confirmation of the US-set allowlist (`risk.md`).

The check is repeated before every promotion and whenever a rule's effective
date passes. This plan summarizes public sources and is not legal advice.

## Stage table

The risk multiplier scales only stage exposure, position, sizing and
trade-count limits. It never scales safety thresholds (correlation above 0.9,
drawdown above 10%, volatility above 3×, flip lock, research caps, freshness
windows, security bounds) and never scales the rules in `risk.md`, which always
apply.

| | Paper | Tiny | Scaled | Full |
|---|---|---|---|---|
| Capital (India set) | paper only | at most 2% of intended capital | at most 25% | 100% |
| Capital (US set) | paper only | first funded account | full account | full account |
| Gross (US set) | per `risk.md` | 50% of the strategy's target gross, half the names | 75% | 100% |
| Strategies in kernel | 1 champion (all others in shadow) | 1 promoted strategy | at most 2 (after the universe-cap change) | per the full-stage manifest |
| Symbols | per `risk.md` | India set: 1 liquid US ETF; US set: the strategy's universe | India set: at most 3; US set: per `risk.md` | per `risk.md` |
| Risk multiplier | 1.0 | 0.25 | 0.5 | 1.0 |
| Max daily loss | n/a | 1% of stage capital | 1.5% | 2% |
| Max position | per `risk.md` | limit × 0.25 | limit × 0.5 | limit |
| Human review | weekly | daily | weekly | weekly |
| Engine | full | full | full | full |

Every "daily" limit uses the UTC calendar day; settlement dates use the
exchange calendar.

**Tiny stage, India set:** the single symbol is a highly liquid US ETF
(SPY, QQQ or IWM class) traded by the promoted strategy; a strategy with several
symbols goes live on its most liquid one, with the evidence recomputed for that
restriction.

**Tiny stage, US set:** at a small first capital, 2% of capital cannot
hold a cross-sectional book and one ETF cannot express a long-short strategy, so
the US set scales risk by gross exposure instead of capital. Scaling gross alone
would shrink each name below a tradable whole-share size (one share must stay at
most 25% of the per-name target, `math.md`), so the tiny stage runs at 50% of
target gross
with half the registered names a side (the most extreme signals), keeping the
per-name size of the full book. The promotion evidence is recomputed for that
restricted book before the stage is signed.

### Promotion criteria

Necessary, never sufficient. Every criterion must be met and a human must then
sign. Meeting the criteria grants the right to ask, nothing more.

**Paper to tiny:** the champion passed the backtest gate and the shadow gate
(`validation.md`) and its evidence is transferable (produced under the
manifest's constraint set); 30 consecutive clean paper-trading days; zero rule
violations; replay determinism green every week; tracking within the
strategy's pre-registered band; model spend within the paper cap; kill-switch,
reconcile, settlement and isolation drills passed; port-on-promotion vectors
green (`kernel.md`); the jurisdiction check complete.

**Tiny to scaled:** 30 consecutive live days at the tiny stage; zero rule
violations; realized implementation shortfall within 1.5× the modeled cost;
live-versus-shadow divergence within the tracking band; the model-spend ratio
computed daily in shadow (the tiny stage has no ratio cap to enforce) with 30
days of computed-passing readings.

**Scaled to full:** 60 consecutive live days at the scaled stage; the above
sustained; maximum drawdown below 5% over the window; at least 100 closed
trades.

### Automatic demotion

No human is needed, and no human can veto it.

| Trigger | Action |
|---|---|
| Any rule violation | demote one stage, HALT entries, alert |
| Drawdown above 10% from peak | demote to paper, flatten via stops, alert |
| Daily loss limit breached | entries halted for the session; a second breach in 5 sessions demotes |
| Determinism or replay failure | demote to paper immediately |
| Journal hash-chain break | demote to paper, HARD kill, forensics before restart |
| Spend circuit breaker at tier 3 | entries halted, demote one stage |
| Broker-reported good-faith or free-riding violation (India set) | HARD-class compliance incident, demote to paper, human review |
| Broker margin call or margin buffer breach (US set) | MEDIUM kill, gross cut to half the strategy target, demote one stage |
| Short position the broker marks hard-to-borrow, recalled or bought in | close next session, entries for that symbol HOLD, alert |
| Live order outside the instrument allowlist reaching the broker | HARD kill, demote to paper, forensics |

Demotion is written to `STAGE_STATE` by the process, chained, journaled and
alerted. Re-promotion is the full human gate again.

## Kill switches

Three levels. Agents can invoke none of them and can override none of them.

| Level | Trigger | Effect | Resume |
|---|---|---|---|
| SOFT | `HALT` file; feed stale over 30 s; spend tier 2; research plane paused past TTL | entries stop within 1 cycle; exits, stops, take-profits and reconcile continue normally; positions stay managed | manual: remove the file and restart with the flag (deleting the file alone does nothing) |
| MEDIUM | drawdown rule; daily loss breach; any rule violation; spend tier 3 | entries stop. Then, conditionally: if the venue is open and the spread is within the normal band, flatten every open position via market order now. If not (venue closed, spread abnormal, or the flatten order itself fails), do not force a bad-condition exit: leave the existing hard stop and take-profit in place exactly as under normal operation, and re-attempt the flatten every cycle until conditions allow or the position closes on its own stop or take-profit first. The stage is demoted immediately either way | human review and stage re-approval |
| HARD | journal chain break; unresolvable reconcile drift; broker auth failure; determinism failure; suspected compromise of the research-plane sandbox | stop entries, verify broker-native protective orders exist on every open position (re-establish if missing and possible), attempt flatten and cancel, leave broker-side protection active, revoke credentials from the running process, and exit non-zero; the supervisor does not restart it. Never revoke the only credentials that can protect a position before verifying broker-side protection exists | a human, on the host, after forensics |

Rules that hold at every level:

- **Exits never depend on research, models, agents or WebSocket health.** A kill
  switch stops new risk; it never strands old risk.
- The kill path is pure C++ in the hot process. It does not call a model, does
  not read `features.jsonl` and does not wait on the network for its decision.
- MEDIUM and HARD are reachable by a physical operator action (file and signal)
  in under 5 seconds, and that path is drilled monthly.
- **MEDIUM flatten state machine** (implemented in the kernel): the kill switch
  persists exactly one of `MEDIUM_ACTIVE` (entries stopped, flatten not yet
  achieved), `FLATTEN_PENDING` (flatten ordered, awaiting broker ack),
  `FLATTENED` (the broker confirms flat) or `PROTECTION_ONLY` (venue or
  conditions never permitted a flatten; stops and take-profits own the risk).
  Re-attempts fire only from `FLATTEN_PENDING`, so there are no blind re-issue
  loops; a restart reloads the persisted state and reconciles with the broker
  before acting and never re-sends what the dead process may already have sent.
  Stage demotion is immediate on MEDIUM entry and independent of flatten
  progress.

## Model spend

Model spend is an operating cost that must stay far below realized profit.
During paper trading there is no profit, so the cap is absolute. Once live, it
is both absolute and proportional.

Measured continuously from Langfuse (`engine.md`) and provider billing, per
model, per node and per cycle. The trading process holds a running spend
counter, journaled hourly, that survives restart.

| Stage | Absolute cap | Ratio cap |
|---|---|---|
| Paper | $150 per 30 days | none (no profit exists, and no ratio is computed against zero) |
| Tiny | $150 per 30 days | none (stage capital is too small for a meaningful ratio; the absolute cap governs) |
| Scaled | $400 per 30 days | rolling-30-day model spend at most 20% of trailing-90-day realized net profit |
| Full | $1,000 per 30 days | same 20% test |

Both caps apply and the binding one wins. These defaults change only by a doc
edit and a fresh paper window.

The ratio is undefined, not failed, when trailing-90-day net profit is at most
$0 (20% of a loss is negative, so the test would fail from the first dollar
spent in any drawdown). In that case the ratio test is suspended (not
evaluated, not deemed passed or failed), the absolute cap alone governs, and the
daily summary flags `ratio_test: suspended (unprofitable window)`. This is a
visibility flag only, not a demotion trigger. A drawdown that matters is caught
by the drawdown rule on its own terms; spend control covers spend, not
performance.

### Throttle tiers

Automatic, graded and logged. Evaluated hourly against the projected 30-day
spend (the trailing 7-day run rate extrapolated), so the brake applies before
the cap is reached.

| Tier | Condition | Automatic response |
|---|---|---|
| 0, normal | projection under 60% of cap | full research depth |
| 1, trim | at least 60% | research cycle interval doubled; the critique node runs on trigger-class symbols only; extraction for NULL-class sources suspended |
| 2, cheap | at least 80% | model work switches to the cheapest configured model; hypothesis prose capped at 200 characters; watchlist cut to the 2 best-calibrated symbols; SOFT kill: no new entries |
| 3, stop | at least 100%, or the ratio test failed 3 consecutive days at the scaled or full stage | MEDIUM kill: entries halted, positions flattened in an orderly way, stage demoted, alert. Exits and reconcile stay live |

- Tier changes are journaled with the projection that caused them. A tier falls
  back only after 6 consecutive hours below the lower threshold (anti-flap).
- A provider price change that lifts projected spend past a tier is treated the
  same as usage growth.
- The tier journal and the ratio journal are hash-chained and fail closed:
  consecutive revisions, no future-dated rows beyond a 300-second skew
  allowance, a strictly increasing day sequence for the ratio journal, and the
  tier state anchoring the newest proven row. A forged, reordered or stripped
  history denies rather than weakening the 3-day rule. Only a missing history
  is treated as fresh. The chain and anchor share one state directory, so they
  detect edits and inconsistent crash residue, not a writer able to rewrite both
  consistently (host compromise is outside this control).
- Ordering and the chain are verified over the bounded 64 KiB journal tail
  (about 11 months of chained rows at one row a day). A gap outside the tail
  reads as unevaluated and breaks the streak toward the conservative side.

### Cost accounting

- Every model call is tagged `{stage, cycle_id, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category}`, where category is
  `research` (the plane, throttled by tiers), `experiment` (shadow, challenger
  or factory, with per-experiment budgets) or `observability`. Cost per
  opportunity and per closed trade are reported per category. The 20%-of-profit
  ratio is a capacity governor; experiment spend additionally needs its own
  expected-incremental-edge justification.
- The daily summary reports spend, projection, tier, spend per closed trade
  and, from the scaled stage, the spend-to-profit ratio.
- A strategy that is profitable gross of model cost and unprofitable net of it
  is a losing strategy; the daily summary reports net figures.
- The engine's reader, router, brain and verifier calls are `research`; the
  factory's are `experiment`. Both pass through the same governor, reservation
  and tier logic and both stop at tier 3. The factory also carries a per-card
  budget declared in its pre-registration; a card that exhausts it stops, and the
  exhaustion is recorded in the trial ledger as evidence.

### Reservation mechanism

Changing it needs a doc edit and a fresh paper window. The pre-call order is
fixed: a research-cap token reservation, then a worst-case dollar hold against
the stage cap, and only then provider execution. Either refusal is clean
(nothing ran). Anything ambiguous after execution started settles the full
reservation as `UNKNOWN_SPEND` and blocks future spend until a supervisor
reconciles.

- **Pricing table:** each entry is the maximum per-1k price across input and
  output legs, so the hold prices every possibly-consumed token at that leg, a
  true worst case. Unpriced models never run. `usd = 0.0` always means a
  zero-price model, never unknown.
- **Token bound:** the measured UTF-8 bytes of the exact outbound prompt (an
  upper bound for byte-level BPE providers, since every token spans at least one
  byte; post-call reconciliation trips and aborts if that assumption is
  violated) plus 1500 completion tokens per provider step, clamped into every
  generate call. Agentic runs add the closed-form multi-step growth bound with
  at most 5 steps, tool outputs byte-truncated to 1500 and 4 tool slots reserved
  up front.
- **Holds:** `reserved` (before spawn; auto-released after 600 s, since a
  crashed pre-spawn never billed) then `invoked` (after spawn; never
  auto-released, cleared only by clean settlement or a supervisor reconcile).
  Committed spend is the trailing-30-day ledger plus outstanding holds.
- **Atomic authorization:** the dollar authorization is one SQLite transaction
  (reap expired holds, check unknown and invoked blocks, measure 30 days,
  compare to the cap, insert the hold, all under one lock). No second
  non-atomic cap check exists; concurrent processes serialize on the
  transaction (tested: four $0.60 racers against a $1.00 cap admit exactly one).
- **`UNKNOWN_SPEND`:** a timeout, child crash, provider error after possible
  invocation, or unaccountable usage settles the full token reservation, spans
  the full dollar reservation as unknown (never $0), keeps the hold against the
  cap, poisons the research-cap row and denies all future spend until
  `reconcile_unknown` attests the actuals. An attested actual above the
  reservation is rejected before any mutation. Zero-price ambiguity settles and
  poisons the row with no dollar block.
- **Tier ordering:** research-call admission re-reads the durable tier in the
  same tier-lock section that inserts the dollar hold (tier lock first, ledger
  second, the order every tier evaluation uses). Tier 3, a durable tier above
  the graph's per-node snapshot, or unverifiable tier state refuses before spawn.
- **Model identity:** the priced `model_id` and the provider configuration's
  `model_id` must be the same string before any reservation. Retiring or
  changing a model's pricing entry can never open an unpriced-call path; a
  pricing or configuration change alters the pricing fingerprint and forces an
  immediate fresh tier evaluation.
- **Fail closed:** ledger markers are tri-state (absent, invalid, valid): only
  a missing database with a missing marker mints a fresh ledger. Tier state that
  is missing with history, corrupt, future-dated or non-finite raises and callers
  deny. Kill signals are durable sentinel files, and a write failure fails the
  cycle closed with no publication. All money and control numerics are type-exact
  and finite (a bool is never a number).
- The graph builds only with an explicit stateful governor, the sole pricing
  authority. The tier-2 and tier-3 kill signals are consumed by the kernel's
  kill state machine; the plane signals and never acts on capital. Until the
  trailing-90-day profit feed is wired, every ratio evaluation reports
  suspended.
- The durability, digest, migration and trust rules for the ledger are in
  `appendix/spend-ledger-integrity.md`.

## Path to outside capital (not authorized)

Offering the strategy to ordinary investors is a legal undertaking with its own
gates. Nothing here is built until the operator's own US-set account has a live
record, and every step needs US counsel. This section records the public rules
that shape the path; it is not legal advice.

1. **Own capital (US set, tiny to full).** The track record is the operator's
   own account. Backtests and paper results are "hypothetical performance" under
   the SEC Marketing Rule (Rule 206(4)-1) and cannot be advertised to a general
   retail audience.
2. **Registered investment adviser offering separately managed accounts.** The
   retail route that avoids pooling: each client owns a brokerage account the
   adviser trades. Registration is with the state below $100M of regulatory
   assets and with the SEC above it (Form ADV Parts 1-3, including Form CRS; the
   individual adviser representative typically needs the Series 65). Fees are
   asset-based; performance fees are allowed only for "qualified clients" (from
   2026-06-29: $1.4M under management with the adviser or $2.7M net worth, Rule
   205-3). The adviser is a fiduciary, owes a written compliance program and
   code of ethics, and is responsible for the system's decisions. Alpaca's
   Broker API supports registered advisers; its order allocation and fee
   features must be confirmed at that time.
3. **Pooled private fund.** Section 3(c)(1) (at most 100 beneficial owners) or
   3(c)(7) (qualified purchasers: $5M of investments for individuals), raised
   under Regulation D Rule 506(b) (no general solicitation; up to 35
   non-accredited but sophisticated purchasers) or Rule 506(c) (general
   solicitation allowed; every purchaser verified accredited). Not a retail
   product.
4. **Registered fund (mutual fund or ETF).** The only pooled vehicle open to all
   retail investors; Investment Company Act limits on leverage, borrowing,
   derivatives (Rule 18f-4) and fees apply. A multi-year, multi-million-dollar
   undertaking.

Disclosure rule from day one: every claim about the system's use of AI is true,
specific and documented. The SEC settled "AI washing" charges with two advisers
in March 2024 (Delphia, $225,000; Global Predictions, $175,000) for claiming AI
capabilities they did not have.

## Done when

- Stage-file verification is tested, including a deliberately corrupted file
  (it must land in the paper stage, not live).
- Promotion requires a stopped process and a human signature; a programmatic
  promotion attempt is proven to fail.
- Demotion drill: a forced rule violation in paper triggers automatic demotion,
  journaled and alerted through the outbound adapter.
- SOFT, MEDIUM and HARD drills pass with exits alive under all three; the MEDIUM
  flatten is SELL-to-close for longs and, under the US set, BUY-to-cover for
  shorts.
- The spend counter survives restart and tier transitions are journaled.
- A forced spend spike walks tier 0, 1, 2, 3 with the documented effects.
- The daily summary shows spend, projection, tier and cost per closed trade.
- The manifest carries approved strategies and the allowlist; a candidate from
  an unapproved strategy or for a non-allowlisted symbol is refused.
- The jurisdiction evidence bundle template exists and is signed before the
  tiny stage.

## Decisions

- Four stages (paper, tiny, scaled, full), human-signed manifests, chained. No
  code path promotes. Demotion is automatic and cannot be vetoed.
- Corruption, doubt and failure resolve toward paper.
- Three kill levels; none reachable by an agent; exits never blocked.
- Live scope is the manifest's constraint set (India set: 1×, cash, long only,
  one liquid ETF at the tiny stage; US set: margin, long and short, half the
  names at 50% of target gross at the tiny stage). Jurisdiction evidence for
  that set is signed before the tiny stage.
- Outside capital only through the path above, never by a stage promotion.
- Only manifest-approved strategies may reach the kernel.
- Model spend: an absolute cap always and a ratio cap from the scaled stage;
  both apply. Throttling reduces research, never exits or reconcile. The
  absolute cap is enforced before the call through a per-call reservation, so one
  call cannot overshoot it by learning its cost late; an unknowable bill or an
  ambiguous transport outcome is `UNKNOWN_SPEND` and blocks further spend.
- Spend caps, tier thresholds (60%, 80%, 100%), the hourly cadence, the 6-hour
  anti-flap, the three-distinct-failed-days ratio rule and the exposure limits
  are fixed.
