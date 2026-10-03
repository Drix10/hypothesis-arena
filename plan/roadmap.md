# Roadmap

The only document that says what to do and when. Tracks run in parallel where
marked; gates are never skipped. Everything stays on paper until the tiny stage
is signed. `TODO.md` is the itemized checklist for this doc. Finished work lives
in git history, not here.

## Where we are

| Area | State |
|---|---|
| Plan | Four strategies (Link Momentum, Filing Change, Event Ripple, ETF Trend), the engine, the India and US constraint sets. |
| Kernel | Built through the router and journal: libcurl paper transport, WebSocket stream, India-set account rule and allowlist, candidate ingest, `paper_loop`, kill inputs, early-close calendar, torn-journal recovery. Live smoke passed on Alpaca paper. Remaining kernel steps are parked (Kernel track). |
| Engine | Collector built and soaked. A six-node research graph, five Tier A adapters and the source seam are built. The link graph, event pipeline and ripple reasoning are not built. |
| Harness | Trial ledger, India-set cost model, settlement simulation, statistics (walk-forward, CPCV, PBO, DSR, MinTRL, bootstrap, HAC, pooled Holm), pre-registration validator, contamination guard, benchmarks and report generators. India set only. |
| Strategies | Earlier strategies failed their backtest gates and were retired. The forward ledger runs the passive core and its benchmarks. No champion. |
| Paper | The paper loop runs the passive core as a plumbing test. Paper trading a strategy through the kernel has not started. |

Critical path:

```
Shorts in the harness -> ETF Trend test ------------------------------+
EDGAR corpus -> Link graph -> Link Momentum test (filings) ------------+
News co-mentions -> Link Momentum tests (news, intraday) --------------+--> Go/no-go review
Filing Change test ----------------------------------------------------+      -> shadow gate
Event pipeline -> Event Ripple rules test -----------------------------+      -> kernel short selling
Reader tier + model pins -> Engine reasoning -> Event Ripple forward shadow
                         \-> Link Momentum model variant (extraction class)
```

## Go/no-go review

After the ETF Trend, Link Momentum, Filing Change and Event Ripple rules backtest
gates:

1. **One or more passes.** The best passer (by the pre-registered primary metric;
   ties go to the simpler strategy) starts its shadow gate at the registered
   paper book size under the US set. Kernel short selling unblocks.
2. **None passes, and a strategy meets the paid-data trigger**
   (`data.md`, Paid data). Buy the paid dataset for that strategy only, run its
   fixed spec once on the extended history, then apply rule 1 or 3.
3. **None passes and the failures are economic** (`validation.md`, Strategy
   gates; an underpowered result follows rule 2). Record a negative result. The
   book stays the passive core, plus ETF Trend if it passed. Event Ripple
   continues in forward shadow on its own clock, and further search comes only
   from research-factory cards that name a new information set.

Event Ripple is judged separately, at its own power-based minimum
(`validation.md`, Model component gate): on the order of 1,000 resolved
candidates per arm after the brain's cutoff plus 30 days, about a year of forward
shadow.

Trial budget before the review: at most 12 new ledger trials (planned: ETF Trend
2, Link Momentum 3, Filing Change 2, Event Ripple rules 1, Link Momentum model
variant 1). Exceeding it needs an operator-approved entry in the approvals log.

## Research track (critical path)

- [ ] **Shorts in the harness** (`research/strategy/`): the short side and margin
      ledger (Reg T, maintenance, borrow, no short rebate, short dividends,
      margin interest), the cost model's short terms (`math.md`), `constraint_set`
      and `contamination_class` in the pre-registration validator, a whole-share
      book at the registered size, monthly tranches, a borrow stress grid, the
      spanning test and Fama-French plus momentum diagnostics and per-decade
      alpha in the backtest gate report, and the placebo-graph tool (`math.md`).
      Verify against Alpaca's docs and the paper account: shorting
      on paper, the `shortable` and `easy_to_borrow` flags, fractional shorts and
      the paper balance setting.
- [ ] **ETF Trend test** (`etf_trend`): pre-registration (`seen-window` label) and
      backtest gate.
- [ ] **EDGAR corpus** (free data): 10-K, 10-Q and 8-K full text with manifests,
      a section parser, a point-in-time CIK, ticker and former-name map, XBRL
      shares outstanding, 13F holdings and Ken French factors.
- [ ] **Link graph** (`engine.md`): a bitemporal store; deterministic
      supply-chain patterns with a precision audit (200 labeled filings, at least
      0.9); text peers; common ownership.
- [ ] **Link Momentum test, filings variant** (`link_momentum`): pre-registration
      and backtest gate with the edge-validation report.
- [ ] **News co-mentions:** a GDELT GKG co-mention pipeline with a measured
      entity-resolution rate; pre-registrations and backtest gates for the news
      and intraday variants.
- [ ] **Filing Change test** (`filing_change`): pre-registration and backtest
      gate.
- [ ] **Event pipeline** (`engine.md`) on history; Event Ripple rules
      (`event_ripple_rules`) pre-registration and backtest gate.
- [ ] **Engine reasoning** (`engine.md`): router, hybrid retrieval, brain,
      verifier and the `ripple_hypothesis` feature; the Event Ripple
      pre-registration; forward shadow starts on post-cutoff events (needs the
      reader tier and model pins).
- [ ] **Link Momentum model variant** (`link_momentum_llm`, extraction class):
      precision audit and paired test against the news variant (needs the reader
      tier).
- [ ] **X corroboration test** (`x_corroboration`, `data.md`): official-API
      adapter, bot filter, corroboration flag, pre-registration with power
      analysis; forward on Event Ripple rules candidates (needs the event
      pipeline and approval of the $50 a month X budget).
- [ ] **Go/no-go review:** apply the rules above and record the decision in the
      approvals log.
- [ ] **Paid research dataset** (only on the paid-data trigger).

## Engine plumbing track

Feeds engine reasoning and the Link Momentum model variant.

- [ ] **Reader tier:** capability-free model calls, capped JSON, span verifier,
      anonymization (`engine.md`).
- [ ] **Model pins:** reader, router, brain and verifier pinned with knowledge
      cutoffs; a post-cutoff bake-off per role.
- [ ] **Research factory** (`engine.md`).
- [ ] **Engine done-boxes:** the remaining items in `engine.md` and `data.md`.

## Kernel track

Parked until the review; only defects that break the paper loop are fixed.

- [ ] **MOC smoke test:** a MOC fill and reconcile with a held position.
- [ ] **Stop-before-close fix:** the router cancels a live stop before a close,
      plus a mock drill.
- [ ] **24-hour soak** on the real transport.
- [ ] **Live-paper drills:** every outage playbook row (`execution.md`) on live
      paper.
- [ ] **Kernel short selling:** the US-set account path (`kernel.md`), after a
      passing review.
- [ ] Exit: the MOC smoke test, the stop-before-close fix and the live-paper
      drills are green, which closes the kernel build.

## Codebase cleanup

- [ ] Rewrite `kernel/risk` and `kernel/exec` to `risk.md` and `execution.md`: the
      veto still carries forex branches, a three-position cap and per-stage
      leverage tiers, and the rule names in the code are numbers.

## Paper stage

- [ ] Shadow testing: every backtest-gate passer runs on live data with harness
      fills under its constraint set, on the forward-ledger machinery extended for
      the US set; shadow gate per `validation.md`.
- [ ] Paper orders: one champion through the kernel (kernel build closed, shadow
      gate passed, and kernel short selling if the champion runs under the US set).
- [ ] Netting router, built with the stop-before-close fix once two strategies
      share an account.
- [ ] Daily summaries and weekly replay checks running.
- [ ] Every outage playbook row drilled on the live paper loop.
- [ ] Model spend within the paper cap; cost per closed trade reported.
- [ ] 30 clean paper-trading days, zero rule violations, no unplanned human
      intervention, champion tracking within its band.
- [ ] Exit: the paper-to-tiny criteria in `stages.md` and a human sign-off.

## Tiny stage (an explicit decision, never automatic)

- [ ] Jurisdiction evidence for the constraint set (`stages.md`).
- [ ] Port on promotion: the champion signal in C++ with cross-language vectors
      (`kernel.md`).
- [ ] The human signs the tiny-stage promotion manifest with the process stopped.
- [ ] India set: 1 liquid US ETF, risk multiplier 0.25. US set: half the names at
      50% of target gross. Daily human review.
- [ ] Realized shortfall tracked against the cost model.
- [ ] Any rule trip demotes automatically to paper.
- [ ] Exit: the tiny-to-scaled criteria in `stages.md` and a human signature.

## Scaled stage

- [ ] A universe-cap change and a netting router, if several live strategies are
      justified.
- [ ] Checkpoint store moved to Postgres; challengers in shadow.
- [ ] The 20% model-spend ratio test active and passing for 30 days.
- [ ] Exit: the scaled-to-full criteria in `stages.md` (60 days, at least 100
      closed trades, maximum drawdown below 5%) and a human signature.

## Full stage

- [ ] Full stage limits per `risk.md`.
- [ ] 30 consecutive days with zero required human intervention; every
      intervention logged with its cause.
- [ ] Ongoing: weekly strategy review; the promotion gate for any change.

## Outside capital (not authorized)

- [ ] The path in `stages.md`, starting no earlier than a live full-stage record
      and with US counsel. A plan amendment comes first.

## Distraction firewall

- High-frequency or sub-second news trading: not this fund (`vision.md`).
- Options, futures, FX, leveraged or inverse ETFs, crypto: out of scope in both
  constraint sets.
- A new venue: not before the scaled stage; it needs a scope change in
  `vision.md` and the jurisdiction check.
- Paid data: only on the paid-data trigger.
- Social media as a trigger: never alone (`data.md`, Tier C).
- A model that sizes, prices or places an order: no. The brain proposes typed
  hypotheses and deterministic code does the rest.
- A strategy outside `strategies.md` before the review: no. New ideas are
  research-factory cards.
- A new indicator or strategy tweak: a new pre-registration, counted in the trial
  ledger.
- Kernel or ops work before the review: only a defect that breaks the running
  paper loop (`execution.md`, audit stop rule).
- Fine-tuning models: shadow only, never with live capital.
- A manual trade: no. The journal is the trader.
- Raising the stage early: criteria are necessary, never sufficient.
- Skipping the controls or the deterministic twin: never.
- Outside money before the outside-capital path: no.

## Approvals log

The operator gives approvals in chat. The agent records each one here (what,
date, "approved in chat") and never asks the operator to edit or sign a
document. The `STAGE` file is separate: only `scripts/sign-stage.sh` writes it
(`stages.md`).

Promotion sign-off template (copy per promotion; every line is required):

```
PROMOTION: <paper to tiny | tiny to scaled | scaled to full | strategy <id> to champion | model component on <strategy>>
DECIDED BY: <operator, approved in chat>   DATE: <ISO8601>   WINDOW JUDGED: <dates>
CONSTRAINT SET: <India | US>
CRITERIA (stages.md and validation.md; every box true, evidence linked):
  [ ] strategy gate passed (backtest and shadow reports, trial-ledger ids)
  [ ] clean-day count  [ ] zero rule violations  [ ] determinism green
  [ ] beats cash, positive spanning alpha, beats its deterministic twin, net, at 2x cost
  [ ] transferability: evidence produced under the manifest's constraint set
  [ ] spend in cap (and ratio from the scaled stage)  [ ] drills (kill, reconcile, isolation)
  [ ] jurisdiction evidence attached (tiny stage onward)
PROCESS: stopped before signing, swapped after; versions bumped; fresh paper
  window opened (no inherited stage).
MANIFEST HASH: <sha256>
```

- Target constraint set: the US set (margin, long and short, gross capped); paper
  only until the operator is US-resident. Approved in chat, 2026-10-02.
- First live capital expected under $25,000. Approved in chat, 2026-10-02.
- Data: free first, paid research data later on a measured trigger. Approved in
  chat, 2026-10-02.
- Strategy gate form: a spanning test against the reference book. Delegated by the
  operator ("whatever is best according to our goal") and chosen 2026-10-02.
- Kernel and ops hardening stopped; the remaining kernel steps parked until a
  strategy passes its backtest gate. Approved in chat, 2026-10-02.
- Direction: follow the epistemic-arbitrage blueprint (linked-firm ripples, a
  knowledge graph, model ripple reasoning with deterministic execution) and
  write the plan without layered old text. Approved in chat, 2026-10-02.
- X corroboration test with a bot filter. Approved in chat, 2026-10-03.
- Retire the earlier strategies, their forward ledgers and tooling; use plain
  names. Approved in chat, 2026-10-03.
- Rewrite the plan and the code with plain names and no version or freeze history;
  drop the optional model filter and the retired control; reset the trial ledger;
  clean up all comments. Full authority given in chat, 2026-10-03.
- Book size and data tier are stage settings: the paper book is $100,000 and data
  is free until the fund earns or raises; later sizes and data spend are the
  operator's decision. Approved in chat, 2026-10-03.
- Design changes from an outside review, decided by the agent under delegation
  ("you decide the best"): Link Momentum holds 3 months through monthly tranches
  with at least 15 names a side at 150% gross; evaluation window from 2007; a
  stop rule that separates economic failure from underpowered; decade stability
  reported; a borrow stress grid; insider opportunistic buys and forced-seller
  liquidity provision recorded as research cards. Approved in chat, 2026-10-03.
