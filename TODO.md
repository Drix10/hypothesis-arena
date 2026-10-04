# TODO

The itemized checklist for `plan/roadmap.md`. It holds open work only;
finished items and their evidence live in git history. One item is one commit
theme (AGENTS.md rule 7). An item is checked only with evidence (a commit and
test output, or a report path).

## Current state

- Plan: four strategies (ETF Trend, Link Momentum, Filing Change, Event Ripple),
  two research cards, the engine, the India and US constraint sets. Book size and
  data tier are stage settings: paper is a $100,000 book on free data.
- Evidence: none. No preregistration, no backtest report, an empty trial ledger.
  No strategy has passed a gate.
- Harness: trial ledger, cost model with short terms, statistics (walk-forward,
  CPCV, PBO, DSR, MinTRL, bootstrap, HAC, spanning test), prereg validator,
  settlement simulation, short positions and a margin ledger, benchmarks, gate
  reports. No decay monitors, no tranche portfolio.
- Data coverage: measured (`research/strategy/coverage_probe.py`,
  `research/reports/coverage_probe.json`). At a $500M cover public float, 97.3%
  of 300 random 2016-2018 10-K filers map to a ticker with gap-free SIP bars; the
  95% interval is about 94.8-98.6%, so no paid data yet. For 11% of them the
  bars end before the filing-based end.
- Event data: Form 4 reader with the routine-trade classifier, SUE from SEC
  statement sets, SEC financial-statement fetcher. No 10-K, 10-Q or 8-K corpus,
  no 13F parser, no point-in-time ticker map, no link graph, no event pipeline.
- Engine: collector, six-node research graph, five Tier A adapters and the source
  seam. No reader tier, router, brain or verifier.
- Kernel: built through the router and journal (libcurl paper transport,
  WebSocket stream, India-set account rule and allowlist, candidate ingest,
  `paper_loop`, kill inputs, early-close calendar, torn-journal recovery). Live
  smoke passed on Alpaca paper. The remaining kernel steps are parked.
- Paper: the loop runs the passive core as a plumbing test of the order path.
  It is not a strategy run and produces no evidence. Live ordering is not
  authorized.

## Next, in order

1. Shorts in the harness: every US-set test needs it.
2. ETF Trend test: the cheapest full pass through the harness.
3. EDGAR corpus, then the deterministic link graph (text peers, 13F ownership).
4. Link Momentum filings variant: prereg and backtest gate. This is the test the
   fund's single-stock thesis stands on; a clear economic failure
   (`plan/validation.md`, Outcomes) stops new single-stock search.
5. Everything else only after a deterministic test has shown signal.

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

- [ ] **Shorts in the harness:** short side and margin ledger, the cost model's
      short terms, `constraint_set` and `contamination_class` in the prereg
      validator, a whole-share book at the registered size, monthly tranches, the
      spanning test with Fama-French, momentum and per-decade diagnostics, the
      borrow stress grid and the placebo-graph tool.
  - [x] The cost model's short terms (`research/strategy/costs.py`: square-root
        impact, borrow, margin interest, short dividends) and the spanning test
        (`stats.spanning_alpha`), tested in `test_costs` and `test_stats`.
  - [x] Short positions and the margin ledger in the backtester
        (`research/strategy/margin.py`, `portfolio.run(margin=...)`), tested in
        `test_portfolio`.
  - [x] The margin ledger's buffer rule (`MarginTerms.buffer`,
        `portfolio._run_margin`): orders that leave equity at or below 2×
        maintenance are shrunk, a book at or below it is cut to half the last
        target and entries HOLD until restored, tested in `test_portfolio`.
  - [x] `constraint_set` and `contamination_class` in the prereg validator.
  - [x] The whole-share book at the registered size ($100,000 for paper) and the
        monthly-tranche portfolio (a 3-month hold, one third re-ranked a month).
  - [x] Borrow stress grid of 0.5%, 2% and 5% a year in the cost model (the code
        has one flat stress rate).
  - [ ] Gate report additions: net alpha per decade, the Fama-French plus
        momentum alpha, the correlation with each promoted strategy and the
        effective number of independent signals (`plan/strategies.md`, Breadth).
  - [ ] The placebo-graph tool (`plan/math.md`, Edge validation).
  - [ ] Verify on Alpaca's docs and the paper account: shorting on paper, the
        `shortable` and `easy_to_borrow` flags, fractional shorts, the paper
        balance setting.
- [ ] **ETF Trend test** (`etf_trend`): prereg (`seen-window`) and backtest gate.
- [ ] **EDGAR corpus:** 10-K, 10-Q and 8-K full text with manifests, a section
      parser, a point-in-time CIK, ticker and former-name map, XBRL shares
      outstanding and a 13F holdings parser. The financial statement sets, the
      Form 4 reader and the Ken French factors (`research/sources/french_factors.py`)
      exist.
  - [ ] A last-trading-day source for delisted firms (the coverage probe leaves
        11% of eligible firms with an unverified end), so delisting returns
        (`plan/math.md`, Point-in-time discipline) rest on a dated event.
  - [ ] Add `test_coverage_probe` to the research gate in `ci.yml` and
        `CONTEXT_MANIFEST.json` (protected paths; a human commits them).
- [ ] **Link graph:** a bitemporal store; text peers and common ownership first
      (deterministic, dense); customer and supplier patterns with a precision
      audit (200 labeled filings, at least 0.9), knowing that 10-K disclosure
      covers only large customers.
- [ ] **Link Momentum test, filings variant** (`link_momentum`): prereg (3-month
      hold in monthly tranches, at least 15 names a side at 150% gross, window
      from 2007) and backtest gate with edge validation. The free feed gives
      about ten years, so expect the paid-data trigger for pre-2016 prices.
- [ ] **Insider opportunistic buys card:** write the prereg for operator approval
      (entry from day 2, deterministic class); `research/strategy/form4.py`
      already classifies routine trades.
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

Starts only for a deterministic test that has shown signal.

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
- [ ] Decay monitors: rolling 24-month spanning alpha and a one-sided CUSUM on
      monthly net returns (`plan/math.md`), kill-only.
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
