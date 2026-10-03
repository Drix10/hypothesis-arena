# TODO

The itemized checklist for `plan/roadmap.md`. It holds open work only;
finished items and their evidence live in git history. One item is one commit
theme (AGENTS.md rule 7). An item is checked only with evidence (a commit and
test output, or a report path).

## Current state

- Plan: rewritten with plain names (`plan/README.md`). Four strategies, the
  engine, the India and US constraint sets.
- Kernel: built through the router and journal (libcurl paper transport,
  WebSocket stream, India-set account rule and allowlist, candidate ingest,
  `paper_loop`, kill inputs, high-water marks, early-close calendar, torn-journal
  recovery). Live smoke passed on Alpaca paper. The remaining kernel steps are
  parked.
- Engine: collector, six-node research graph, five Tier A adapters and the
  source seam built. Link graph, events and ripple reasoning not built.
- Harness: India set only (trial ledger, cost model, statistics, prereg
  validator, benchmarks, report generators).
- Strategies: the earlier ones are retired. The forward ledger runs the passive
  core with the cash and SPY benchmarks. Paper trading through the kernel has not
  started; live ordering is not authorized.
- The paper loop is a plumbing test of the order path with the passive core. It
  is not a strategy run and is not ready to produce evidence; most of the
  critical path below has to exist first.

## Codebase cleanup

Done: the plan docs, the Python code (`research/`, `collector/`, `ops/`), the
trial ledger reset, the retired strategies, preregistrations and reports, and the
kernel's model filter, calibration rule, old stage codes and old candidate
field names.

Open:

- [ ] Rewrite `kernel/risk/` and `kernel/exec/` to `plan/risk.md`: the veto still
      has a three-position cap, forex branches (`AssetClass::FOREX`) and
      per-stage leverage tiers that the plan does not have; `exit_trend` still
      uses a GTC bracket where `plan/execution.md` says OTO stop-only; the rule
      names in the code are still numbers (`kernel/AGENTS.md` maps them).
- [ ] The paper stage `STAGE` file must be re-signed with
      `scripts/sign-stage.sh` (the stage value is now `PAPER`) before the paper
      loop starts again, on a new directory.

## Research (critical path)

- [ ] **Data coverage probe:** 300 firms with 10-Ks filed 2016-2018; the share
      with Alpaca SIP bars through their last trading day, and the share with a
      point-in-time CIK to ticker map (`plan/data.md`). Below 95% on either
      triggers paid data now.
- [ ] **Shorts in the harness:** short side and margin ledger, the cost model's
      short terms, `constraint_set` and `contamination_class` in the prereg
      validator, a $25,000 whole-share book, the spanning test with Fama-French
      and momentum diagnostics, and the placebo-graph tool.
  - [x] The cost model's short terms (`research/strategy/costs.py`: square-root
        impact, borrow, margin interest, short dividends) and the spanning test
        (`stats.spanning_alpha`), tested in `test_costs` and `test_stats`.
  - [ ] Short positions and the margin ledger in the backtester;
        `constraint_set` and `contamination_class` in the prereg validator;
        the whole-share $25,000 book; the placebo-graph tool.
  - [ ] Verify on Alpaca's docs and the paper account: shorting on paper, the
        `shortable` and `easy_to_borrow` flags, fractional shorts, the paper
        balance setting.
- [ ] **ETF Trend test** (`etf_trend`): prereg (`seen-window`) and backtest gate.
- [ ] **EDGAR corpus:** 10-K, 10-Q and 8-K full text with manifests, a section
      parser, a point-in-time CIK, ticker and former-name map, XBRL shares
      outstanding, 13F holdings and Ken French factors.
- [ ] **Link graph:** a bitemporal store; customer and supplier patterns with a
      precision audit (200 labeled filings, at least 0.9); text peers; common
      ownership.
- [ ] **Link Momentum test, filings variant** (`link_momentum`): prereg and
      backtest gate with edge validation.
- [ ] **News co-mentions:** the GDELT GKG pipeline with a measured resolution
      rate; news and intraday variant preregs and backtest gates.
- [ ] **Filing Change test** (`filing_change`): prereg and backtest gate.
- [ ] **Event pipeline** on history; Event Ripple rules (`event_ripple_rules`)
      prereg and backtest gate.
- [ ] **Engine reasoning:** router, retrieval, brain, verifier and the
      `ripple_hypothesis` feature; the Event Ripple prereg; forward shadow on
      post-cutoff events (needs the reader tier and model pins).
- [ ] **Link Momentum model variant** (`link_momentum_llm`): precision audit and
      paired test (needs the reader tier).
- [ ] **X corroboration test** (`x_corroboration`): official-API adapter, bot
      filter, corroboration flag, prereg with power analysis; forward on Event
      Ripple rules candidates (needs the event pipeline and approval of the $50 a
      month X budget).
- [ ] **Go/no-go review:** apply `plan/roadmap.md` and record the decision in the
      approvals log.
- [ ] **Paid research dataset** (only on the paid-data trigger).

## Engine plumbing

- [ ] **Reader tier:** capability-free calls, capped JSON, span verifier,
      anonymization; the research graph gains the reader nodes.
- [ ] **Model pins:** reader, router, brain and verifier with knowledge cutoffs;
      a post-cutoff bake-off per role.
- [ ] **Research factory** (no network in generated code, trial-ledgered, at most
      3 cards a week).
- [ ] **Engine done-boxes:** the remaining items in `plan/engine.md` and
      `plan/data.md`.

## Kernel (parked until the go/no-go review; only defects that break the paper loop are fixed)

- [ ] **MOC smoke test:** a MOC fill and reconcile with a held position
      (`kernel/broker/live_drill.cpp`, during a session).
- [ ] **Stop-before-close fix:** Alpaca rejects MOC and market sells while an
      OTO stop is live (observed 2026-09-29), so the router cancels the stop,
      confirms, then closes; mock drill before the live-paper drills.
- [ ] **24-hour soak** on the real transport, on a host that stays up. The mock
      soak passes.
- [ ] **Live-paper drills:** every outage playbook row on live paper, plus the
      rows that need other planes (feed gap, settlement mismatch, journal chain
      break, stage-file verification). Mock-venue rows pass.
- [ ] **Kernel short selling:** the US-set account path (`plan/kernel.md`), after
      a passing review; the execution-maximum pin in the manifest and
      `scripts/check-manifest.sh` changes with it.
- [ ] Kernel build closed (MOC smoke test, stop-before-close fix and live-paper
      drills green).

## Paper stage

The paper run starts with `bash ops/deploy/start.sh ~/g2` (see
`ops/deploy/README.md`).

- [ ] Shadow testing for every backtest-gate passer under its constraint set;
      the shadow gate per strategy.
- [ ] Netting router, built with the stop-before-close fix once two strategies
      share an account.
- [ ] Paper orders: one champion through the kernel (needs the kernel build, a
      shadow gate pass, and kernel short selling for a US-set champion).
- [ ] Daily summary, weekly replay and the outage drills on the live loop.
- [ ] 30 clean paper-trading days, the paper-to-tiny criteria in
      `plan/stages.md` and the sign-off.

## Later stages (not authorized)

- [ ] Jurisdiction evidence bundle for the constraint set.
- [ ] Port on promotion: the champion signal in C++ with cross-language vectors.
- [ ] Tiny-stage manifest (India set: 1 liquid ETF, risk multiplier 0.25; US set:
      half the names at 50% of target gross).
- [ ] Scaled and full stages per `plan/roadmap.md`.
- [ ] Outside capital per `plan/stages.md` (not authorized).
