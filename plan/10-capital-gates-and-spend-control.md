# 10 — Capital Gates, Kill Switches, and Spend Control

Full autonomy is granted *inside a box*. This doc defines the box: which stage the
system is in, what that stage permits, who may change it (a human, always), how it
is shut down, and how much it may spend on AI to earn what it earns.

The system is autonomous in **research, decision, and execution**. It is never
autonomous in **capital escalation**.

## 10.1 The stage file (the box), v2: signed manifests (locked 2026-09-18)

A hash is not a signature — anyone holding the file can recompute it. v2
separates the human act from the runtime state:

- `PROMOTION_MANIFEST` (human-owned, human-written, process stopped):
  immutable once signed. The runtime NEVER modifies promotion material.
- `STAGE_STATE` (process-owned, append-only): runtime `DEMOTION_EVENT`
  records. Demotion appends, journals, alerts; it never
  from_stage, to_stage, intended_capital_usd, allocated_capital_usd,
  policy_version, plan_hash, approved_at, evidence_hash, signer_id, plus an
  Ed25519 `signature` over all of it. The process verifies (valid signature,
  known signer key, correct plan version, correct prior stage, sane capital)
  and then — and only then — advances.
- `effective_stage` = last verified promotion − automatic `STAGE_STATE`
  demotion events`. No shared
  ownership, no direct human edits to runtime files, no process writes to
  manifests.
- Legacy `STAGE` single-file format (§10.1 as frozen in Phase 0 v1) remains the
  G0 bootstrap only: `capital_usd: 0`, GENESIS chain, alerts.jsonl. First
  promotion out of G0 moves to manifests.

G1 capital semantics (locked): `intended_capital_usd` (the full size this
operation targets), `allocated_capital_usd` (actually deposited at the stage),
`current_equity_usd` (live, from the adapter). "≤2% of intended capital" is
computed from the manifest's intended number — mechanically enforceable, no
interpretation.

Risk-capital basis (G2, locked): every percentage cap (R1/R2 exposure,
drawdown, VaR) is computed against `risk_capital = min(intended_capital_usd,
allocated_capital_usd, current_equity_usd)` at snapshot time. A live account
holding less than intended capital gets proportionally less risk — the
conservative minimum, frozen, no discretion.

LIVE JURISDICTION GATE (before any G1 promotion, locked): operator
jurisdiction, broker authorization in that jurisdiction, instrument legality
(forex venue vs local law), funding route, tax/reporting treatment — all
checked, logged, and attached to the manifest as `evidence_hash`. "Broker has
an API" is not "this deployment is legal."

One file, `STAGE`, read at startup and re-read at every cycle boundary:

```
stage:        G0_PAPER | G1_TINY | G2_SCALED | G3_FULL
approved_by:  <human name>
approved_at:  <ISO8601>
capital_usd:  <number>
attest_hash:  <sha256 of "stage|approved_by|approved_at|capital_usd|prev_attest"
              (pipe-delimited, exact field order; genesis prev_attest = "GENESIS")>
```

- `attest_hash` chains to the previous attestation and into the journal. A `STAGE`
  file whose chain does not verify → the system starts in **G0_PAPER**, alerts,
  and refuses live orders. Corruption fails toward paper, never toward capital.
- The trading process may **read** `STAGE`. It may **write** only demotions.
  Promotions are written by a human, out of band, with the process stopped.
- `capital_usd` is 0 at G0 (paper — no real capital exists). At G1+ the human
  writes the real stage capital at signing; "2% of intended capital" is defined
  by that number, not by anything the system infers.
- Alerts (every "alert" in this doc and in §§10.2–10.4) mean: append to
  `alerts.jsonl` + non-zero exit status where the process stops. No messaging
  integrations (Telegram/Discord/email) in v1 — those are chat-gateway paths
  and doc 08 bans them from the trading host. Consequence (S1): unattended
  LIVE operation is BLOCKED until an approved external alert adapter exists;
  until then, stdout/log alerts are monitoring aids only, never the
  unattended path. Logging to a file is not an unattended alert.
- The research plane cannot read or write `STAGE` (doc 08 §8.1, R11).
- **R17 (new):** no code path exists that raises a stage. Promotion is a human
  editing a file while the system is down. This is deliberate friction, exactly
  like resume-from-HALT (doc 06 §6.4, locked).

## 10.2 Stage table (locked)

`R-multiplier` scales ONLY stage exposure/position/sizing/trade-count limits
(positions, exposure %, trades/day, sizes). It never scales safety thresholds:
correlation > .9, drawdown > 10%, vol > 3x, the 2-hour flip lock, R15 call
limits, freshness windows, and security bounds are FIXED at every stage unless
explicitly versioned. It never scales the *rules* — R1–R9 always apply.

| | G0_PAPER | G1_TINY | G2_SCALED | G3_FULL |
|---|---|---|---|---|
| Capital | paper only | ≤ 2% of intended capital | ≤ 25% | 100% |
| Symbols | ≤ 5 | **1** | ≤ 3 | ≤ 5 |
| R-multiplier | 1.0 | **0.25** | 0.5 | 1.0 |
| Max daily loss | n/a | 1% of stage capital | 1.5% | 2% |
| Max position | per R2 | R2 × 0.25 | R2 × 0.5 | R2 |
| Leverage | doc 05 §5.2 | forex ≤ 1× (single symbol is forex, see below) | forex ≤ 2×, stocks ≤ 1× | doc 05 §5.2 |
| Human review | weekly | **daily** | weekly | weekly |
| Research plane | full | full | full | full |

Day-boundary rule (locked): every "daily" limit and every "session" count in
this doc and in doc 05 uses the UTC calendar day. No venue-local accounting.

**G1_TINY symbol choice (locked):** the single G1 symbol must be a forex major,
never a US equity. A live account at 2% of intended capital will almost always
sit under the $25k PDT threshold, and R9 caps a sub-$25k margin account at 3
day-trades per 5 sessions — which would throttle the sample size the G1 → G2
promotion criteria need, not the risk (forex has none of this: R9's PDT clause
is equities-only, and forex runs 24/5). Equities re-enter at G2, where ≤3
symbols and a larger likely capital base make the PDT constraint bind less.

### Promotion criteria (necessary, never sufficient)

Every box must be true **and** a human must then sign the file. Meeting the
criteria grants the *right to ask*, nothing more.

**G0 → G1** — 30 consecutive clean paper days; zero R-rule violations; replay
determinism green every week (D1); JEV calibration at or better than the
base-rate baseline over ≥ 200 decisions (doc 11); AI spend within the G0 absolute
cap; kill-switch, reconcile, and isolation drills all passed.

**G1 → G2** — 30 consecutive live days at G1; zero R-rule violations; realized
slippage within 1.5× the paper fill model; live-vs-paper divergence < 30% (S3);
AI-spend ratio computed daily at G1 in SHADOW (readiness display only — G1 has
no ratio cap to enforce); promotion requires 30 days of computed-passing
readings (§10.4); calibration still ≥ baseline.

**G2 → G3** — 60 consecutive live days at G2; the above sustained; max drawdown
< 5% over the window; ≥ 100 closed trades so the statistics mean something.

### Automatic demotion (no human needed, and no human can veto it)

| Trigger | Action |
|---|---|
| Any R-rule violation | Demote one stage + HALT entries + alert |
| Drawdown > 10% from peak (R5) | Demote to G0_PAPER + flatten via stops + alert |
| Daily loss limit breached | Entries halted for the session; second breach in 5 sessions → demote |
| Calibration below baseline by >0.02 Brier, ≥20-outcome minimum met (R13) | Entries halted, demote one stage |
| Determinism/replay failure (D1) | Demote to G0_PAPER immediately |
| Journal hash-chain break | Demote to G0_PAPER, HARD kill, forensics before restart |
| Spend circuit breaker at tier 3 (§10.4) | Entries halted, demote one stage |

Demotion is written to `STAGE` by the process, chained, journaled, and alerted.
Re-promotion is the full human gate again. There is no "temporary" demotion.

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

## 10.5 What "done" means

G0 file creation (human, at build — the one piece of §10.1 no doc edit can do
for you): copy the §10.1 template, set `stage: G0_PAPER`, `capital_usd: 0`,
fill `approved_by`/`approved_at`, compute `attest_hash` with
`printf '%s' "G0_PAPER|<name>|<iso8601>|0|GENESIS" | sha256sum`, place the file
where the process reads it, and log the signing in doc 07. Until that file
exists and verifies, nothing starts — there is no default STAGE.

- [ ] `STAGE` chain verification tested, including a deliberately corrupted file
      (must land in G0_PAPER, not in live).
- [ ] Promotion requires a stopped process + human edit; proven by attempting a
      programmatic promotion and observing it fail.
- [ ] Demotion drill: force an R-rule violation in paper → automatic demotion,
      journaled, alerted.
- [ ] SOFT / MEDIUM / HARD drills each pass, including "exits still work" under
      all three.
- [ ] Spend counter survives process restart; tier transitions journaled.
- [ ] A forced spend spike walks tier 0 → 1 → 2 → 3 with the documented effects.
- [ ] Daily summary shows spend, projection, tier, and cost per closed trade.

## Locked decisions

- Four stages, human-signed, chained. No code path promotes. Demotion is automatic
  and cannot be vetoed.
- Corruption, doubt, and failure all resolve toward paper.
- Three kill levels; none reachable by an agent; exits never blocked by any of them.
- AI spend: absolute cap always; ratio cap from G2. Both apply. Throttling reduces
  research, never decision calibration.
