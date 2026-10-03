# MiroHedge TODO

This ledger itemizes `plan/07-build-roadmap.md`. It holds open work only;
finished boxes and their evidence live in git history. Each item is named
for what it does; the matching doc 07 section is in the heading.

Legend: `[BLOCKED]` waits on another item; `[HUMAN]` needs the operator.
One item is one commit theme (AGENTS.md rule 7). An item is checked only
with evidence (commit and test output, or a report path).

## Current state (verified 2026-10-03)

- Plan: freeze v4 (docs 00-14): the epistemic engine, four sleeves (Link
  Momentum, Filing Change, Event Ripple, ETF Trend), India and US
  constraint sets, `val_v2`; freeze-check PASS.
- Kernel: JEV filter and kernel build slices A-G and H1 done (libcurl paper
  transport, WebSocket stream, R18/R19 for the India set, candidate ingest,
  `g0_paper_loop`, kill inputs, high-water marks, early-close calendar,
  torn-journal recovery). Live smoke PASS on Alpaca paper. The remaining
  kernel steps are parked.
- Engine: collector, six-node research graph, five Tier-A adapters and the
  source seam built. Link graph, events and ripple reasoning not built.
- Harness: India set only (trial ledger, `cost_v2`, statistics, prereg
  validator, benchmarks, report generators).
- Sleeves: the five earlier sleeves are retired and their forward ledgers
  stopped (2026-10-03). The forward ledger runs the passive core with the
  cash and SPY benchmarks. G0 sign-off file signed 2026-09-29. Paper trading
  through the kernel not started; live ordering not authorized.

## Operator actions

- [ ] [HUMAN] Commit the freeze v4 manifest (protected path).
- [ ] [HUMAN] Paste the updated CI workflow (protected path) that drops the
      retired tests and adds `test_deploy_check.py`.
- [ ] [HUMAN] Restart the paper run so `start.sh` launches the trimmed
      forward ledger.

## Alpha (doc 07 §7.2, critical path)

- [ ] **Shorts in the harness**: short side and margin ledger, `cost_v3`,
      `constraint_set` and `contamination_class` in the prereg validator,
      $25,000 whole-share book, spanning test + FF5/momentum diagnostics,
      placebo-graph tool.
  - [x] `cost_v3` (`research/strategy/costs_v3.py`: square-root impact,
        borrow, margin interest, short dividends) and the spanning test
        (`stats.spanning_alpha`), tested in `test_costs_v3` and `test_stats`.
  - [ ] Short positions and the margin ledger in the backtester;
        `constraint_set` / `contamination_class` in the prereg validator;
        whole-share $25,000 book; placebo-graph tool.
  - [ ] Verify on Alpaca docs and the paper account: shorting on paper,
        `shortable`/`easy_to_borrow` flags, fractional shorts, paper balance
        setting.
- [ ] **ETF Trend test** (`etf_trend_ls_v1`): prereg (`seen-window`) and
      backtest gate.
- [ ] **EDGAR corpus**: 10-K/10-Q/8-K full text with manifests, section
      parser, point-in-time CIK/ticker/former-name map, XBRL shares
      outstanding, 13F holdings, Ken French factors.
- [ ] **Link graph**: bitemporal store; customer/supplier patterns +
      precision audit (200 labeled filings, ≥ 0.9); text peers; common
      ownership.
- [ ] **Link Momentum test, filings variant** (`link_momentum_v1`): prereg
      and backtest gate with edge validation.
- [ ] **News co-mentions**: GDELT GKG pipeline with measured resolution
      rate; news and intraday variant preregs and backtest gates.
- [ ] **Filing Change test** (`filing_change_v1`): prereg and backtest
      gate.
- [ ] **Event pipeline** on history; Event Ripple rules
      (`event_ripple_rules_v1`) prereg and backtest gate.
- [ ] **Engine reasoning**: router, retrieval, brain, verifier, f3; Event
      Ripple (`event_ripple_v1`) prereg; forward shadow on post-cutoff
      events [BLOCKED on reader tier, model pins].
- [ ] **LLM link extraction** (`link_momentum_llm_v1`): precision audit,
      paired test [BLOCKED on reader tier].
- [ ] **X corroboration test** (`x_corroboration_v1`): official-API
      adapter, bot filter, corroboration flag, prereg with power analysis;
      forward on Event Ripple rules candidates [BLOCKED on the event
      pipeline + paid-data approval of the $50/month X budget].
- [ ] **Checkpoint 1**: apply doc 07 §7.1; record the decision in the
      sign-off log.
- [ ] **Paid research dataset** [BLOCKED on the doc 09 §9.1b trigger].
- Parked until Checkpoint 1: the `baseline_v1` rerun on SIP bars and
  quotes; the JEV filter paired test.

## Engine plumbing (doc 07 §7.3)

- [ ] **Reader tier**: capability-free calls, capped JSON, span verifier,
      anonymization; graph g1 → g2 with a manifest bump.
- [ ] **Model pins**: reader, router, brain, verifier with knowledge
      cutoffs; post-cutoff bake-off per role.
- [ ] **Research factory** v1 (`mirofactory`, no network in generated code,
      trial-ledgered, ≤ 3 cards/week).
- [ ] **Engine done-boxes**: the remaining doc 08 §8.8 and doc 09 §9.4
      boxes.

## Kernel (doc 07 §7.4; parked until Checkpoint 1, only paper-loop-breaking defects are fixed)

- [ ] **MOC smoke test**: MOC fill and reconcile with a held position
      (`kernel/broker/live_drill.cpp`, during a session).
- [ ] **Stop-before-close fix**: Alpaca rejects MOC and market sells while
      an OTO stop is live (observed 2026-09-29), so the router cancels the
      stop, confirms, then closes; mock drill before the live-paper drills.
- [ ] **24-hour soak** on the real transport [HUMAN host]. Mock soak PASS.
- [ ] **Live-paper drills**: every doc 06 §6.2a row on live paper, plus the
      rows that need other planes (feed gap, settlement mismatch, journal
      chain break, sign-off chain). Mock-venue rows PASS.
- [ ] **Kernel short selling**: the US-set account path (doc 13 §13.8)
      [BLOCKED on a Checkpoint 1 pass]; the `execution_max` pin in
      freeze-check and the manifest change together [HUMAN, protected
      paths].
- [ ] Kernel build closed (MOC smoke test, stop-before-close fix and
      live-paper drills green).

## Phase 4 - G0 paper (doc 07 §7.5)

The paper run starts with `bash ops/deploy/start.sh ~/g2` (see
`ops/deploy/README.md`).

- [ ] Shadow testing for every backtest gate passer under its constraint
      set; shadow gate per sleeve.
- [ ] Netting router, built with the stop-before-close fix once two sleeves
      share an account.
- [ ] Paper orders: one champion through the kernel [BLOCKED on the kernel
      build + a shadow gate pass + kernel short selling for a US-set
      champion].
- [ ] Daily summary, weekly replay, §6.2a drills on the live loop.
- [ ] 30 clean paper-trading days + doc 10 §10.2 G0→G1 criteria +
      sign-off.

## Phase 5+ - live stages (not authorized)

- [ ] Jurisdiction evidence bundle for the constraint set (doc 10 §10.1a).
- [ ] Port-on-promotion: champion signal in C++ + cross-language vectors.
- [ ] G1 manifest (India set: 1 liquid ETF, R × 0.25; US set: half the
      names at 50% of target gross).
- [ ] G2 / G3 per doc 07 §7.7-7.8.
- [ ] Outside capital per doc 10 §10.6 (not authorized).
