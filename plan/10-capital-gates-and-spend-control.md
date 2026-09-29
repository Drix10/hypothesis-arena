# 10 — Capital Gates, Kill Switches, and Spend Control (freeze v3)

Full autonomy is granted *inside a box*. This doc defines the box: which
stage the system is in, what that stage permits, what the operator may
legally trade, who may change any of it (a human, always), how it is shut
down, and how much it may spend on AI to earn what it earns.

The system is autonomous in **research, decision, and execution**. It is
never autonomous in **capital escalation**. Freeze v3 changes are marked.

## 10.1 The stage chain (the box): signed manifests (locked 2026-09-18, text repaired v3)

A hash is not a signature — anyone holding a file can recompute it. The
human act and the runtime state are therefore separate objects:

- **`PROMOTION_MANIFEST`** (human-owned, written with the process stopped,
  immutable once signed). Fields: `from_stage`, `to_stage`,
  `intended_capital_usd`, `allocated_capital_usd`, `policy_version`,
  `plan_hash`, `approved_at`, `evidence_hash`, `signer_id`, (v3)
  `approved_sleeves` (sleeve id + version + filter policy),
  (v3) `instrument_allowlist` (R19), (v3) `jurisdiction_evidence_hash`
  (§10.1a, G1+), plus an Ed25519 `signature` over all of it. The process
  verifies (valid signature, known signer key, correct plan version,
  correct prior stage, sane capital) and only then advances. The runtime
  NEVER modifies promotion material.
- **`STAGE_STATE`** (process-owned, append-only): runtime
  `DEMOTION_EVENT` records. A demotion appends, journals, and alerts; it
  never edits a manifest.
- `effective_stage` = last verified promotion − automatic `STAGE_STATE`
  demotions. No shared ownership, no human edits to runtime files, no
  process writes to manifests.
- **G0 bootstrap** (legacy single-file `STAGE`, freeze v1 format) is used
  only to start G0; the first promotion out of G0 moves to manifests:

```
stage:        G0_PAPER
approved_by:  <human name>
approved_at:  <ISO8601>
capital_usd:  0
attest_hash:  <sha256 of "stage|approved_by|approved_at|capital_usd|prev_attest"
              (pipe-delimited, exact field order; genesis prev_attest = "GENESIS")>
```

- A chain that does not verify → the system starts in **G0_PAPER**,
  alerts, and refuses live orders. Corruption fails toward paper.
- Capital semantics (locked): `intended_capital_usd` (full target size),
  `allocated_capital_usd` (actually deposited), `current_equity_usd`
  (live). "≤ 2% of intended capital" is computed from the manifest.
  Risk-capital basis (G2+): every percentage cap uses
  `risk_capital = min(intended, allocated, current_equity)` at snapshot.
- Alerts mean: append to `alerts.jsonl` + non-zero exit where the process
  stops + (v3) the outbound-only alert adapter (doc 06 §6.4). Unattended
  operation (G0b included) is BLOCKED until that adapter exists; chat
  gateways remain banned (doc 01).
- The research plane, factory, and sleeve engine cannot read or write the
  stage chain (R11).
- **R17:** no code path raises a stage. Promotion is a human signing a
  manifest while the system is down.

## 10.1a LIVE JURISDICTION GATE (v3 expansion; required before G1)

"Broker has an API" is not "this deployment is legal." Before any G1
promotion the operator attaches, as `jurisdiction_evidence_hash`, a signed
evidence bundle containing at least:

1. Operator residency and the funding route (RBI LRS, USD 250,000 per
   financial year), with bank confirmation that the remittance purpose
   code is overseas portfolio investment.
2. Written confirmation from a qualified professional (Indian chartered
   accountant or FEMA counsel) that the instrument allowlist is
   permissible: US-listed common stock and ETFs, long only, **cash
   account, no margin, no short selling**, no forex spot/CFD/margin FX, no
   options/futures, no leveraged or inverse products (LRS prohibits
   remitting for margin trading and for trading foreign exchange abroad).
   Currency ETFs and any product beyond the default list need their own
   explicit line in that confirmation before they may enter the allowlist.
3. Broker account evidence: Alpaca international account opened for the
   operator's country, **cash** account type confirmed, USD funding route.
4. Tax/reporting treatment recorded: US dividend withholding (W-8BEN on
   file), Indian TCS on LRS remittances and its credit, foreign-asset and
   foreign-income reporting in the Indian return, record-keeping for
   capital gains in INR.
5. The `broker_compliance_policy` table rows for the account (settlement,
   good-faith/free-riding, day-trade rules at their effective dates,
   including the 2026 PDT repeal) reviewed and signed.

The gate is re-checked before every promotion and whenever a rule's
effective date passes. This plan summarizes public sources; it is not
legal advice.

## 10.2 Stage table (locked, v3)

`R-multiplier` scales only stage exposure/position/sizing/trade-count
limits; it never scales safety thresholds (correlation > .9, drawdown >
10%, vol > 3×, flip lock, R15 limits, freshness windows, security bounds)
and never scales the rules — R1–R19 always apply.

| | G0_PAPER | G1_TINY | G2_SCALED | G3_FULL |
|---|---|---|---|---|
| Capital | paper only | ≤ 2% of intended capital | ≤ 25% | 100% |
| Sleeves in kernel | 1 champion (+ all others in G0a shadow) | 1 promoted sleeve | ≤ 2 (after universe-cap change) | per G3 manifest |
| Symbols | ≤ 5 (kernel cap) | **1 liquid US ETF** | ≤ 3 | ≤ 5 |
| R-multiplier | 1.0 | **0.25** | 0.5 | 1.0 |
| Max daily loss | n/a | 1% of stage capital | 1.5% | 2% |
| Max position | per R2 | R2 × 0.25 | R2 × 0.5 | R2 |
| Leverage / account | cash-account constraint set, 1× (v3) | 1×, cash, long only | 1×, cash, long only | 1×, cash, long only |
| Human review | weekly | **daily** | weekly | weekly |
| Research plane | full | full | full | full |

Day-boundary rule (locked): every "daily" limit uses the UTC calendar day;
settlement dates use the exchange calendar (R18).

**G1 symbol choice (v3, replaces the freeze-v2 forex rule):** the single
G1 symbol is a highly liquid US ETF (SPY/QQQ/IWM-class spreads and
volume) traded by the promoted sleeve. The freeze-v2 rule required a
forex major because of the $25k pattern-day-trader constraint; both
premises are gone — forex is not a legal live target for the operator
(§10.1a), and the PDT framework was eliminated (SEC approval 2026-04-14;
cash accounts were never governed by it). A sleeve whose champion
universe has several symbols goes live at G1 on its single most liquid
symbol, with the promotion evidence recomputed for that restriction.

### Promotion criteria (necessary, never sufficient)

Every box must be true **and** a human must then sign. Meeting the
criteria grants the *right to ask*, nothing more.

**G0 → G1** — the champion sleeve passed A-gate and B-gate (doc 11
§11.3a) and its evidence is transferable (produced under the live
constraint set); 30 consecutive clean G0b days; zero R-rule violations;
replay determinism green every week (D1); tracking within the sleeve's
pre-registered band; AI spend within the G0 cap; kill-switch, reconcile,
settlement, and isolation drills passed; port-on-promotion vectors green
(doc 04); jurisdiction gate complete (§10.1a); if the sleeve uses
`filter = jev`, JEV calibration ≥ base rate over ≥ 200 decisions.

**G1 → G2** — 30 consecutive live days at G1; zero R-rule violations;
realized implementation shortfall within 1.5× `cost_v2`; live-vs-shadow
divergence within the S3 band; AI-spend ratio computed daily in SHADOW
(G1 has no ratio cap to enforce) with 30 days of computed-passing
readings; calibration still ≥ baseline where applicable.

**G2 → G3** — 60 consecutive live days at G2; the above sustained; max
drawdown < 5% over the window; ≥ 100 closed trades.

### Automatic demotion (no human needed, and no human can veto it)

| Trigger | Action |
|---|---|
| Any R-rule violation | Demote one stage + HALT entries + alert |
| Drawdown > 10% from peak (R5) | Demote to G0_PAPER + flatten via stops + alert |
| Daily loss limit breached | Entries halted for the session; second breach in 5 sessions → demote |
| Calibration below baseline by > 0.02 Brier, ≥ 20-outcome minimum (R13, `jev` sleeves) | Entries halted, demote one stage |
| Determinism/replay failure (D1) | Demote to G0_PAPER immediately |
| Journal hash-chain break | Demote to G0_PAPER, HARD kill, forensics before restart |
| Spend circuit breaker at tier 3 (§10.4) | Entries halted, demote one stage |
| (v3) Broker-reported good-faith / free-riding violation (R18) | HARD-class compliance incident, demote to G0_PAPER, human review |
| (v3) Live order outside the instrument allowlist reaching the broker (R19) | HARD kill, demote to G0_PAPER, forensics |

Demotion is written to `STAGE_STATE` by the process, chained, journaled,
and alerted. Re-promotion is the full human gate again.

## 10.3 Kill-switch hierarchy (R16, locked)

Three levels. Agents can invoke none of them and can override none of them.

| Level | Trigger | Effect | Resume |
|---|---|---|---|
| **SOFT** | `HALT` file; S5 JEV streak; feed stale > 30 s; spend tier 2; research plane paused past TTL | **Entries stop within 1 cycle.** Exits, stops, TP, reconcile all continue normally. Positions are managed, not abandoned. | Manual: remove file **and** restart with flag (doc 06 §6.4 — deleting the file alone does nothing) |
| **MEDIUM** | R5 drawdown; daily loss breach; R-rule violation; calibration breach; spend tier 3 | Entries stop. **Then, conditionally:** if the venue is open and the spread is within the normal band, flatten every open position via market order now. If not (venue closed, spread abnormal, or the flatten order itself fails), do **not** force a bad-condition exit — leave the existing hard stop/TP in place exactly as under normal operation, and re-attempt the flatten every cycle until conditions allow or the position closes on its own stop/TP first. Stage demoted immediately either way. | Human review + stage re-approval |
| **HARD** | Journal chain break; reconcile drift unresolvable; broker auth failure; determinism failure; suspected compromise of the research-plane sandbox | Stop entries → verify broker-native protective orders exist on every open position (re-establish if missing and possible) → attempt flatten/cancel → leave broker-side protection ACTIVE → revoke credentials from the running process → trading process exits non-zero; supervisor does **not** restart it. Never revoke the only credentials that can protect a position before verifying broker-side protection exists. | Human, on the host, after forensics |

Rules that hold at every level:
- **Exits never depend on JEV, the research plane, agents, or WS health**
  (doc 06, locked). A kill switch stops *new risk*; it never strands old risk.
- The kill path is pure C++ in the hot process. It does not call an LLM, does not
  read `features.jsonl`, and does not wait on the network for its decision.
- MEDIUM and HARD are reachable from a physical operator action (file + signal) in
  under 5 seconds, and that path is drilled monthly.
- MEDIUM flatten state machine (frozen, implemented in P3.5): the kill
  switch persists exactly one of `MEDIUM_ACTIVE` (entries stopped, flatten
  not yet achieved), `FLATTEN_PENDING` (flatten ordered, awaiting broker
  ack), `FLATTENED` (broker confirms flat), `PROTECTION_ONLY` (venue or
  conditions never permitted a flatten; stops/TP own the risk). Re-attempts
  fire ONLY from `FLATTEN_PENDING` (no blind re-issue loops); a restart
  reloads the persisted state and reconciles with the broker before acting
  — it never re-sends what the dead process may already have sent. Stage
  demotion is immediate on MEDIUM entry and independent of flatten progress.

## 10.4 AI spend control (R10, locked)

**The rule:** AI spend is an operating cost that must stay far below realized
profit. During paper there is no profit, so the cap is absolute. Once live, it is
both absolute and proportional.

Measured continuously from Langfuse (doc 08) + provider billing, per model, per
node, per cycle. The trading process holds a running spend counter; the counter
is journaled hourly and survives restart.

| Stage | Absolute cap | Ratio cap |
|---|---|---|
| G0_PAPER | **$150 / 30 days** | none (no profit exists — do not compute a ratio against zero) |
| G1_TINY | $150 / 30 days | none (stage capital is too small for a meaningful ratio; absolute cap governs) |
| G2_SCALED | $400 / 30 days | rolling-30d AI spend ≤ **20%** of trailing-90d realized net profit† |
| G3_FULL | $1,000 / 30 days | same 20% test |

Defaults above are Phase-0 freeze values, editable only by doc edit + fresh paper
window (doc 05, locked). Both caps apply; the binding one wins.

† **The ratio is undefined, not automatically failed, when trailing-90d net
profit ≤ $0.** 20% of a loss is a negative number, and testing spend against a
negative cap would make the ratio test fail from the first dollar spent during
any ordinary drawdown — not because AI spend did anything wrong, but because
the denominator went negative. When trailing-90d profit ≤ $0: the ratio test is
**suspended** (not evaluated, not deemed passed or failed), the absolute cap
alone governs, and the daily summary flags `ratio_test: suspended (unprofitable
window)`. This is a visibility flag only — it is not itself a demotion trigger.
A drawdown that is actually a problem is caught by R5 (drawdown halt) or R13
(calibration floor) on its own terms; spend control's job is spend, not
performance, and conflating the two would fire the wrong circuit breaker for
the wrong reason.

### Throttle tiers (automatic, graded, logged)

Evaluated hourly against the *projected* 30-day spend (trailing 7-day run rate
extrapolated), so the brake is applied before the wall, not at it.

| Tier | Condition | Automatic response |
|---|---|---|
| **0 — normal** | projection < 60% of cap | Full research depth |
| **1 — trim** | ≥ 60% | Research cycle interval doubled; `critique` node runs on TRIGGER-class symbols only; NULL-class source extraction suspended |
| **2 — cheap** | ≥ 80% | Non-JEV LLM work switches to the cheapest configured model; `hypothesize` prose capped at 200 chars; watchlist cut to the 2 best-calibrated symbols; **SOFT kill: no new entries** |
| **3 — stop** | ≥ 100%, or ratio test failed 3 consecutive days at G2/G3 | **MEDIUM kill**: entries halted, positions flattened in an orderly way, stage demoted, alert. Exits and reconcile stay live. |

- **JEV is never throttled away.** It is the calibrated decision gate and is cheap
  relative to research; if spend is a problem, the fix is less *research*, not a
  less-calibrated *decision*. Throttling degrades what we know, never whether we
  check.
- Tier changes are journaled with the projection that caused them. A tier can
  fall back only after 6 consecutive hours below the lower threshold (anti-flap).
  The tier journal is a semantic chain, not just syntax: non-legacy rows
  must carry consecutive revs, from/to matching the governor's emission
  rule (first from Tier 0 when the chain start lies inside the bounded
  tail window), snapshot tier equal to its row, and max rev
  exactly equal to the state rev — a forged newer row denies, and rows
  newer than state are never adopted (state-first persist means the
  state always leads). Legacy (rev-less) rows recover only in an
  explicitly legacy deployment (state rev 0, no revisioned rows):
  once revisioned history exists, a rev-less row newer than state is
  forgery and older rev-less rows are audit-only. Row timestamps and
  embedded evaluated_at values beyond the 300 s skew allowance deny.
  The ratio journal must be a strictly increasing day sequence (no
  duplicates, no reordering, no future days): an edited day order
  denies rather than weakening the 3-day rule. Ratio rows are
  hash-chained (each commits to the previous row's digest) and the tier
  state anchors the newest proven row (`ratio_head`, written together
  with the `ratio_day` tripwire): a valid-JSON rewrite of decided
  history (failed -> ok, with or without recomputed digests), a
  head/day mismatch, a stripped head, a legacy-format row inside the
  chain era, or more than ONE row beyond the head (the only legitimate
  crash residue: append landed, state persist did not — adopted and
  persisted before any new append) all deny. The chain and the anchor
  live in the same state directory, so they detect edits and
  inconsistent crash residue, not a writer able to rewrite both
  consistently (host compromise, outside this control). Ordering and the
  chain are verified over the bounded 64 KiB journal tail (≈11 months
  of chained rows at one row/day; a cut tail links from its first
  visible row, still pinned forward to the anchor); streak soundness
  does not depend on ancient order (a gap outside the tail reads as
  unevaluated and breaks the streak toward the conservative side).
- A provider price change that lifts projected spend past a tier acts exactly like
  usage growth. No exception path exists.

### Cost accounting rules

- Every LLM call is tagged `{stage, cycle_id, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category}` where category is one of
  `decision` (JEV — never throttled), `research` (plane — throttled by tiers),
  `experiment` (shadow/challenger — per-experiment budgets, doc 11),
  `observability`. Cost per opportunity and per closed trade are reported per
  category. The 20%-of-profit ratio stays as a capacity governor; experiment
  spend additionally needs its own expected-incremental-edge justification
  (doc 11 registry) — profit unlocks capacity, never blind spending.
- The daily summary (doc 06 §6.3) reports: spend, projection, tier, spend per
  closed trade, and — from G2 — the spend/profit ratio.
- Cost per *decision* and cost per *closed trade* are first-class metrics. A
  strategy that is profitable gross of AI cost and unprofitable net of it is a
  losing strategy, and the daily summary is written to make that impossible to
  miss.

### 10.4.1 Reservation mechanism (frozen — change = doc edit + fresh paper window)

The pre-call order is fixed: R15 token reservation, then worst-case
dollar HOLD against the stage cap, then and only then provider
execution. Either refusal is clean (nothing ran). Anything ambiguous
after execution started settles the FULL reservation as UNKNOWN_SPEND
and blocks future spend until a supervisor reconciles.

- Pricing table semantics: each entry is the MAXIMUM per-1k price
  across input/output legs. The hold prices every possibly-consumed
  token at that leg, so it is a true worst case. Unpriced models
  never run (construction blocks); usd=0.0 always means a zero-price
  model, never unknown.
- Token bound: the measured utf-8 bytes of the exact outbound prompt
  (a true upper bound for byte-level-BPE providers — every token
  spans >= 1 byte; post-call reconciliation tripwires the assumption
  and aborts on violation) plus COMPLETION_MAX = 1500 tokens per
  provider step, clamped downward into every generate call. Agentic
  runs add the closed-form multi-step growth bound with
  AGENT_MAX_STEPS = 5, TOOL_OUT_MAX_BYTES = 1500 (tool outputs are
  byte-truncated, so tool context is truly bounded) and
  TOOLS_PER_STEP_MAX = 4 tool slots reserved up front.
- Holds: `reserved` (pre-spawn; auto-released after 600 s as a crashed
  pre-spawn never billed) → `invoked` (post-spawn; never auto-released
  — only clean settlement or supervisor reconcile clears it).
  Committed spend = trailing-30d ledger + outstanding holds.
  Pre-provider unwind rule: unwinding a reservation before the
  provider was provably touched settles the lease at zero and
  releases the hold; if the unwind itself fails, the cycle aborts
  with a diagnostic snapshot naming both the original and the
  cleanup failure and the conservative reservation is preserved
  (never silently the original error alone).
- UNKNOWN_SPEND: timeout, child crash, provider error after possible
  invocation, or unaccountable usage settles the full token
  reservation, spans the full dollar reservation as unknown (never
  $0), keeps the hold against the cap, poisons the R15 row, and
  denies all future spend until `reconcile_unknown` attests actuals.
  Reconcile rules: an attested actual above the reservation is
  rejected before any mutation; hold-only recovery mints the unknown
  span first so the ledger carries the reconciled dollars (all
  transitions rowcount-verified); a success-path settlement that
  does not land aborts with the hold retained, never a success
  return. The invocation boundary reads its result pipe while the
  child runs (large results stream; the frame read shares the call
  deadline, so a mid-frame stall hits the kill path) and the tier
  evaluation holds one lock across load-compute-persist (no stale
  evaluator can overwrite a restrictive tier; the per-day ratio
  record is inside the same section). Tier-2+ research requires the
  durable signal path: the health hook is telemetry only and can
  never substitute for the signal_dir sentinel. Unreadable authority
  markers, tier state, or ratio history fail closed (only provably
  missing state is fresh; the ratio journal carries a deletion
  tripwire in tier state, and lost history denies instead of
  resetting the 3-day streak). Generated text is byte-capped in the
  child before the IPC envelope; extract cleanup outcome rides the
envelope and the parent reclaims authoritatively. The kill ladder
  begins at the deadline (bounded settle grace for exact labels).
- Projection/tier plumbing: `tier_state.json` (hourly evaluation
  cache + 6-hour anti-flap counter), `tier_journal.jsonl` (every
  transition with its projection), `ratio_journal.jsonl` (daily ratio
  evaluations). The T2 SOFT-kill and T3 MEDIUM-kill signals are
  durable sentinel files plus supervisor-hook events; the trading-side
  kill state machine that consumes them is Slice-D+ work — the plane
  signals, it never acts on capital. Until the trailing-90d profit
  feed is wired, every ratio evaluation reports suspended (the same
  visibility flag as an unprofitable window) and the absolute cap
  alone governs.
- Watchlist-2 ranking input is supervisor-supplied per-symbol
  calibration; absent that feed the cut is deterministic
  alphabetical-first-2 (fewer symbols either way is the control).
  NULL-class suspension binds the frozen Tier-C source set
  (x_lists_tail, launch_library, submarine_cables, aisstream,
  opensky_adsb) plus records explicitly carrying class NULL.

### 10.4.2 Authorization hardening (frozen — change = doc edit + fresh paper window)

Final-audit corrections to the §10.4.1 mechanism (all proven through
the graph → worker → budget → attribution/spend → publish path):

- The dollar authorization is ONE SQLite transaction
  (`reserve_spend_hold`: reap-expired + unknown/invoked block check +
  30d-measure + cap-compare + hold-insert under one lock). No second
  non-atomic cap check exists anywhere; concurrent processes
  serialize on the transaction (proven: four $0.60 racers vs a $1.00
  cap admit exactly one).
- Research-call admission re-reads the DURABLE tier in the same
  tier-lock section that inserts the dollar hold (tier lock first,
  ledger second — the order every tier evaluation uses). The graph's
  per-node tier snapshot is only the plan (model, prose cap,
  watchlist): Tier 3, a durable tier above the snapshot, or
  unverifiable tier state refuses pre-spawn, so a Tier-3 persist
  either precedes an admission (refused) or follows its hold (an
  in-flight call admitted before the stop). Every provider-reaching
  path (hypothesize, critique, LLM extract) passes this gate.
- Model identity: the priced `model_id` and
  `provider_cfg["model_id"]` must be the same string before any
  reservation (a mismatch is a clean pre-reserve refusal).
- Token bound correction: tool growth per prior step is
  TOOLS_PER_STEP_MAX × TOOL_OUT_MAX_BYTES (every slot counts). The
  reserved budget travels into the worker child, whose UsageTape
  refuses before EVERY provider call that cannot fit the remaining
  budget (actual prompt bytes projected per call, including agent
  message objects); the post-call tripwire stays as audit backstop.
- Ledger markers are tri-state (absent/invalid/valid): only
  DB-absent + marker-absent mints fresh; a damaged marker with no DB,
  or any invalid marker with a DB, aborts. Any positive-dollar
  `invoked` hold counts as unresolved unknown spend (crash backstop),
  and `reconcile_unknown` recovers from every point of the ambiguity
  path (complete rows, hold-only, span-only, or loud error on
  nothing). Zero-price ambiguity settles R15 + poisons the row with
  NO dollar block (nothing uncertain) so the next fresh cycle
  proceeds.
- Tier state is fail-closed (missing-with-history, corrupt,
  future-dated, or non-finite states raise; callers deny) and bound
  to stage + pricing fingerprint (a config change forces immediate
  fresh evaluation, never reuse). State + journals persist under ONE
  tier lock with journal-carried snapshots (crash between the two
  recovers from the journal tail). Ratio counts DISTINCT consecutive
  failed UTC days (one counted evaluation per day; ok/suspended days
  break the streak).
- The graph builds only with an explicit stateful governor, which is
  the sole pricing authority (cheapest-model switch and every
  reservation price come from its table). Kill signals are sentinel-
  required (write failure fails the cycle closed with no publication);
  the supervisor hook is supplemental telemetry (failures visible in
  blocked evidence). Manifest rows are strictly validated with
  bounded-tail reads + rotation; the reader falls through
  reader-throwing generations; digest keys detect text conflicts with
  bounded per-path memory. All money/control numerics are type-exact
  and finite (bool is never a number here).

### 10.4.3 Model retirement and spend identity (S7-B, governance)

Spend identity follows model identity (§3.5b): the priced `model_id`
must equal `provider_cfg["model_id"]` before any reservation (frozen
§10.4.2), so retiring, removing, or changing an active model's
pricing entry can never open an unpriced-call path — unpriced models
never run, construction blocks. A pricing/config change alters the
pricing fingerprint and forces immediate fresh tier evaluation, never
reuse of stale tier state (frozen §10.4.2). The runtime governor
pricing table carries no retired flag: the human-owned
deployment/audit record (§3.5b) preserves the retired identity's
historical pricing metadata for audit, while the live governor
selects only currently authorized pricing entries. Historical spend
stays in the trailing-30d ledger (history is never rewritten on
retirement). No caps change here: the stage table above is untouched.

### 10.4.4 Research-factory and reader spend (v3, within the same caps)

No new money. The factory's model calls are category `experiment`, the
reader tier's are category `research`; both pass through the same
governor, reservation, and tier logic as every other research call, and
both stop at Tier 3. The factory additionally carries a per-card budget
declared in its pre-registration; a card that exhausts it stops, and the
exhaustion is recorded in the trial ledger (a failure is evidence too).
JEV (`decision`) spend exists only for sleeves configured with
`filter = jev` and is attributed to that sleeve's cost per trade.

## 10.5 What "done" means

G0 bootstrap (human, at build): copy the §10.1 template, set
`stage: G0_PAPER`, `capital_usd: 0`, fill `approved_by`/`approved_at`,
compute `attest_hash` with
`printf '%s' "G0_PAPER|<name>|<iso8601>|0|GENESIS" | sha256sum`, place the
file where the kernel reads it, and log the signing in doc 07. Until that
file exists and verifies, nothing starts — there is no default stage.

- [ ] Stage-chain verification tested, including a deliberately corrupted
      file (must land in G0_PAPER, not live).
- [ ] Promotion requires a stopped process + human signature; a
      programmatic promotion attempt is proven to fail.
- [ ] Demotion drill: forced R-rule violation in paper → automatic
      demotion, journaled, alerted (outbound adapter).
- [ ] SOFT / MEDIUM / HARD drills pass, exits alive under all three;
      long-only MEDIUM flatten = SELL-to-close only.
- [ ] Spend counter survives restart; tier transitions journaled.
- [ ] A forced spend spike walks tier 0 → 1 → 2 → 3 with the documented
      effects.
- [ ] Daily summary shows spend, projection, tier, cost per closed trade.
- [ ] (v3) Manifest carries approved sleeves + allowlist; a candidate from
      an unapproved sleeve or for a non-allowlisted symbol is refused.
- [ ] (v3) Jurisdiction evidence bundle template exists and is signed
      before G1.

## Locked decisions

- Four stages, human-signed manifests, chained. No code path promotes.
  Demotion is automatic and cannot be vetoed.
- Corruption, doubt, and failure all resolve toward paper.
- Three kill levels; none reachable by an agent; exits never blocked.
- (v3) Live = 1×, cash account, long only, allowlisted instruments, one
  liquid ETF at G1; jurisdiction evidence signed before G1.
- (v3) Only manifest-approved sleeves may reach the kernel.
- AI spend: absolute cap always; ratio cap from G2. Both apply. Throttling
  reduces research, never exits or reconcile. Absolute MEANS absolute
  (frozen, pass-5): the cap is enforced PRE-CALL via a frozen per-call
  reservation, so one call cannot overshoot it by learning its cost late;
  an unknowable bill (unknown-cost) or an ambiguous transport outcome
  (may-have-been-billed) is UNKNOWN_SPEND → HOLD with no answer admitted.
- Spend caps, tier thresholds (60/80/100%), hourly cadence, 6-hour
  anti-flap, the three-distinct-failed-days ratio rule, and R2 are
  unchanged by freeze v3.
