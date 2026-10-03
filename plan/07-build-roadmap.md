# 07 - Build Roadmap (the only to-do list)

Tracks run in parallel where marked; gates are never skipped. Paper only
until Phase 5 sign-off. `TODO.md` is the itemized ledger of this doc.
Finished work lives in git history, not here. Steps are named for what they
do; nothing on this page is referred to by a code number.

## 7.0 Where we are (verified 2026-10-03)

| Area | State |
|---|---|
| Plan | Freeze v4: the epistemic engine, four sleeves (Link Momentum, Filing Change, Event Ripple, ETF Trend), India and US constraint sets, validation `val_v2`. |
| Kernel | JEV filter built and gated (one candidate-bound contract, `contract = "jev"`). Kernel build slices A-G and H1 done: libcurl paper transport, WebSocket stream, R18/R19 for the India set, candidate ingest, `g0_paper_loop`, kill inputs, early-close calendar. Live smoke passed on Alpaca paper. The remaining kernel steps are parked (§7.4). |
| Engine | Collector built and soaked; six-node research graph, five Tier-A adapters and the source seam built and hosted-green. Link graph, event pipeline and ripple reasoning not built. |
| Strategy harness | Trial ledger, `cost_v2`, settlement simulation, statistics (walk-forward, CPCV, PBO, DSR, MinTRL, bootstrap, HAC, pooled Holm), pre-registration validator, contamination guard, benchmarks, report generators. India set only. |
| Sleeves | The five earlier India-set sleeves failed their backtest gates and are retired; their forward ledgers stopped on 2026-10-03 (doc 02 §2.5). The forward ledger runs the passive core and its benchmarks. No champion. |
| G0 | G0 sign-off file signed 2026-09-29. The paper loop runs the passive core as a plumbing test. Paper trading through the kernel has not started. |

Critical path:

```
Shorts in the harness ─→ ETF Trend test ───────────────────────────────┐
EDGAR corpus ─→ Link graph ─→ Link Momentum test (filings) ─────────────┤
News co-mentions ─→ Link Momentum tests (news, intraday) ───────────────┼─→ Checkpoint 1 ─→ shadow gate + kernel short selling
Filing Change test ─────────────────────────────────────────────────────┤
Event pipeline ─→ Event Ripple rules test ──────────────────────────────┘
Reader tier + model pins ─→ Engine reasoning (router, brain, verifier) ─→ Event Ripple forward shadow
                         └→ LLM link extraction (extraction class)
```

## 7.1 Decision rules at Checkpoint 1 (after the ETF Trend, Link Momentum, Filing Change and Event Ripple rules backtest gates)

1. **One or more passes:** the best passer (pre-registered primary metric;
   ties go to the simpler sleeve) starts its shadow gate at $25,000 under the
   US set. Kernel short selling unblocks.
2. **None passes, and a sleeve meets the paid-data trigger** (doc 09
   §9.1b): buy the paid dataset for that sleeve only, run its frozen spec
   once on the extended history, then apply rule 1 or 3.
3. **None passes, failures are economic:** recorded negative result. The
   book stays the passive core. Event Ripple continues in forward shadow on
   its own clock; further search comes only from research-factory cards
   that name a new information set.

Event Ripple is judged separately, at its own power-based minimum (doc 11
§11.3b: on the order of 1,000 resolved candidates per arm after the brain's
cutoff + 30 days, about a year of forward shadow).

Trial budget before Checkpoint 1: at most 12 new ledger trials (planned:
ETF Trend 2, Link Momentum 3, Filing Change 2, Event Ripple rules 1, Link
Momentum LLM variant 1). Exceeding it needs an operator-approved entry in
the sign-off log.

## 7.2 Track A - Alpha (critical path)

- [ ] **Data coverage probe** (first, about a day): on a random sample of
      300 firms that filed a 10-K in 2016-2018, measure (a) how many have
      Alpaca SIP daily bars through their last trading day, including
      firms since delisted or renamed, and (b) how many map from CIK to the
      ticker they traded under at each date (doc 09 §9.1a mapping rule).
      If either falls below 95%, the single-stock sleeves meet the
      paid-data trigger now, before the link graph is built.
- [ ] **Shorts in the harness** (`research/strategy/`): short side and
      margin ledger (Reg T, maintenance, borrow, no short rebate, short
      dividends, margin interest), `cost_v3` (doc 14 §14.10),
      `constraint_set` and `contamination_class` in the pre-registration
      validator, $25,000 book with whole-share rounding, spanning test +
      FF5/momentum diagnostics in the backtest gate report (`val_v2`),
      placebo-graph tool (doc 14 §14.7). Verify against Alpaca docs and the
      paper account: shorting on paper, `shortable`/`easy_to_borrow` flags,
      fractional shorts, paper balance setting.
- [ ] **ETF Trend test** (`etf_trend_ls_v1`): pre-registration
      (`seen-window` label) and backtest gate.
- [ ] **EDGAR corpus** (free data): 10-K/10-Q/8-K full text with manifests,
      section parser, point-in-time CIK/ticker/former-name map, XBRL shares
      outstanding, 13F holdings, Ken French factors.
- [ ] **Link graph** (doc 08 §8.2): bitemporal store; `sc` deterministic
      patterns with precision audit (200 labeled filings, ≥ 0.9); `tx` text
      peers; `ow` common ownership.
- [ ] **Link Momentum test, filings variant** (`link_momentum_v1`):
      pre-registration and backtest gate with the edge-validation report.
- [ ] **News co-mentions**: GDELT GKG co-mention pipeline with measured
      entity-resolution rate; pre-registrations and backtest gates for the
      Link Momentum news and intraday variants.
- [ ] **Filing Change test** (`filing_change_v1`): pre-registration and
      backtest gate.
- [ ] **Event pipeline** (doc 08 §8.3) on history; Event Ripple rules
      (`event_ripple_rules_v1`) pre-registration and backtest gate.
- [ ] **Engine reasoning** (doc 08 §8.4): router, hybrid retrieval, brain,
      verifier, f3 schema; Event Ripple (`event_ripple_v1`)
      pre-registration; forward shadow starts on post-cutoff events [needs
      the reader tier and model pins].
- [ ] **LLM link extraction**: the Link Momentum LLM variant
      (`link_momentum_llm_v1`, extraction class), precision audit, paired
      test against the news variant [needs the reader tier].
- [ ] **X corroboration test** (`x_corroboration_v1`, doc 09 §9.1c):
      official-API adapter, bot filter, corroboration flag,
      pre-registration with power analysis; forward on Event Ripple rules
      candidates [BLOCKED on the event pipeline and a paid-data approval of
      the $50/month X budget].
- [ ] **Checkpoint 1**: apply §7.1 and record the decision in the sign-off
      log.
- [ ] **Paid research dataset** [BLOCKED on the doc 09 §9.1b trigger].
- Parked until Checkpoint 1 (none changes whether the fund makes money
  first): the `baseline_v1` rerun on SIP bars and quotes; the JEV filter
  paired test, which needs a surviving candidate stream.

## 7.3 Track P - Engine plumbing (feeds engine reasoning and LLM link extraction)

- [ ] **Reader tier**: capability-free model calls, capped JSON, span
      verifier, anonymization (doc 08 §8.2a, §8.5).
- [ ] **Model pins**: reader, router, brain and verifier pinned with
      knowledge cutoffs; post-cutoff bake-off per role (doc 08 §8.10).
- [ ] **Research factory** v1 (doc 08 §8.9).
- [ ] **Engine done-boxes**: the remaining doc 08 §8.8 and doc 09 §9.4
      boxes.

## 7.4 Track K - Kernel (parked until Checkpoint 1; only defects that break the paper loop are fixed)

- [ ] **MOC smoke test**: MOC fill and reconcile smoke with a held
      position.
- [ ] **Stop-before-close fix**: the router cancels a live stop before a
      close, plus a mock drill.
- [ ] **24-hour soak** on the real transport.
- [ ] **Live-paper drills**: every doc 06 §6.2a row on live paper.
- [ ] **Kernel short selling**: the US-set account path in the kernel
      (doc 13 §13.8) [BLOCKED on a Checkpoint 1 pass].
- [ ] Exit: MOC smoke test, stop-before-close fix and live-paper drills
      green → kernel build closed.

## 7.5 Phase 4 - G0_PAPER

- [ ] Shadow testing: every backtest gate passer runs on live data with
      harness fills under its constraint set, on the forward-ledger
      machinery extended for the US set (doc 11 §11.2a); shadow gate per
      doc 11 §11.3a.
- [ ] Paper orders: one champion through the kernel (kernel build closed +
      shadow gate passed + kernel short selling if the champion runs under
      the US set).
- [ ] Daily summaries + weekly replay checks running.
- [ ] Every §6.2a outage row drilled on the live paper loop.
- [ ] AI spend within the G0 cap; cost per closed trade reported.
- [ ] 30 clean paper-trading days, zero R-rule violations, no unplanned
      human intervention; champion tracking within its band.
- [ ] Exit: doc 10 §10.2 G0 → G1 criteria + human sign-off below.

## 7.6 Phase 5 - G1_TINY (explicit decision, not automatic)

- [ ] Jurisdiction gate evidence for the constraint set (doc 10 §10.1a).
- [ ] Port-on-promotion: champion signal in C++ with cross-language
      vectors (doc 04).
- [ ] Human signs the G1 PROMOTION_MANIFEST with the process stopped.
- [ ] India set: 1 liquid US ETF, R × 0.25. US set: half the names at 50% of target
      gross. Daily human review.
- [ ] Realized shortfall tracked against the cost model.
- [ ] Any R-trip → automatic demotion to G0.
- [ ] Exit: doc 10 §10.2 G1 → G2 criteria + human signature.

## 7.7 Phase 6 - G2_SCALED

- [ ] Universe-cap and netting-router change if multi-sleeve live is
      justified.
- [ ] Checkpoint store moved to Postgres; challengers in shadow.
- [ ] The 20% AI-spend ratio test active and passing for 30 days.
- [ ] Exit: doc 10 §10.2 G2 → G3 criteria (60 days, ≥ 100 closed trades,
      max DD < 5%) + human signature.

## 7.8 Phase 7 - G3_FULL

- [ ] Full stage limits per doc 05.
- [ ] 30 consecutive days with zero required human intervention; every
      intervention logged with its cause.
- [ ] Ongoing: weekly sleeve review, promotion gate for any change.

## 7.9 Phase 8 - Outside capital (not authorized)

- [ ] Doc 10 §10.6 path, starting no earlier than a live G3 record, with
      US counsel. A plan amendment comes first.

## Distraction firewall

- HFT / sub-second news trading: doc 01 §1.4. Not this fund.
- Options, futures, FX, leveraged/inverse ETFs, crypto: out of scope in
  both constraint sets.
- New venue: not before G2; doc 01 paragraph + jurisdiction gate.
- Paid data: only on the doc 09 §9.1b trigger.
- Social media as a trigger: never alone (doc 09 Tier C).
- A model that sizes, prices or places an order: no. The brain proposes
  typed hypotheses; deterministic code does the rest.
- A sleeve outside doc 02 before Checkpoint 1: no. New ideas are research-factory
  cards.
- New indicator / sleeve tweak: new pre-registration, counted in the trial
  ledger.
- Kernel or ops work before Checkpoint 1: only a defect that breaks the running
  paper loop (doc 06 AUDIT STOP RULE).
- Fine-tuning models: shadow only, never with live capital.
- New JEV question: version bump + fresh hand-worked cases.
- A manual trade: no. The journal is the trader.
- Raising the stage early: criteria are necessary, never sufficient.
- Skipping the controls or the deterministic twin: never.
- Outside money before §7.9: no.

## Sign-off log

Each entry: what, who, date, manifest/attest hash or window where relevant.

Approvals are given by the operator in chat. The agent records each one here
(what, date, "approved in chat") and never asks the operator to edit or sign a
document. The STAGE file is separate: only `scripts/sign-stage.sh` writes it
(doc 10 §10.1).

Promotion sign-off template (copy per promotion; all lines required):

```
PROMOTION: <G0→G1 | G1→G2 | G2→G3 | sleeve <id> to champion | AI component on <sleeve>>
DECIDED BY: <operator, approved in chat>   DATE: <ISO8601>   WINDOW JUDGED: <dates>
CONSTRAINT SET: <India | US>
CRITERIA (doc 10 §10.2 / doc 11 §11.3a-b - every box true, evidence linked):
  [ ] sleeve gate passed (A-gate + B-gate reports, trial-ledger ids)
  [ ] clean-day count  [ ] zero R-violations  [ ] determinism green
  [ ] beats cash + positive spanning alpha + beats its deterministic twin, net, 2× stress
  [ ] transferability: evidence produced under the manifest's constraint set
  [ ] spend in cap (+ ratio if G2+)  [ ] drills (kill/reconcile/isolation)
  [ ] jurisdiction gate evidence attached (G1+)
PROCESS: stopped before signing, swapped after; versions bumped; fresh
  paper window opened (no inherited stage).
MANIFEST HASH: <sha256>
```

- Phase 0 freeze | Drix10 | 2026-09-18 | plan frozen; G0 STAGE + keys at build; Phase 1 unblocked
- Phase 0 freeze v2 signed off. Bucket 1 complete; JEV v3 semantics frozen; X removed from production v1; Phase 1 unblocked. | Drix10 | 2026-09-18
- Freeze v3 rebaseline authorized by operator instruction ("full permission to rewrite plans and code; plan first") | 2026-09-28 | text committed
- Freeze v3 text approved | operator, in chat | 2026-09-29
- Single JEV contract (candidate-bound; v3 sidecar path retired, plain names) | operator, in chat | 2026-09-29
- Sleeve testing program (appendix 10 rev 2: four evidence tracks, forward replication ledgers, long-history track L) | operator, in chat | 2026-09-30
- Kernel and ops hardening stopped; P3.5 remainder parked until a sleeve passes A-CP1 | operator, in chat | 2026-10-02
- Target constraint set C2 (US margin, long and short, gross capped); paper only until the operator is US-resident | operator, in chat | 2026-10-02
- First live capital expected under $25,000 | operator, in chat | 2026-10-02
- Data: free first, paid research data later on a measured trigger | operator, in chat | 2026-10-02
- Sleeve gate form delegated ("whatever is best according to our goal"); chosen: spanning test against the reference book, `val_v2` | operator, in chat | 2026-10-02
- Freeze v4 direction: follow the epistemic-arbitrage blueprint (linked-firm ripples, knowledge graph, LLM ripple reasoning with deterministic execution); rewrite the plan without layered old text | operator, in chat | 2026-10-02
- Freeze v4 plan text approved ("ok for all the changes in the plan docs"); deep re-verification pass ordered | operator, in chat | 2026-10-02
- Appendix-driven edits, `xcorr_v1` X corroboration test with bot filter, and a docs-only commit of freeze v4 ("Go.") | operator, in chat | 2026-10-03
- Retire the abandoned sleeves, their forward ledgers and tooling; rename steps, sleeves, constraint sets and files to plain names ("clean up all stuff, also work on all the naming") | operator, in chat | 2026-10-03
