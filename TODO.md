# TODO

The itemized checklist for `plan/roadmap.md`. It holds open work only;
finished items and their evidence live in git history. One item is one commit
theme (AGENTS.md rule 7). An item is checked only with evidence (a commit and
test output, or a report path).

## Current state

- Plan: one strategy, the Connected Drift Book (`connected_drift`): a long-short
  US equity composite of link propagation, section-level Filing Change and
  opportunistic insider buys, scaled by the ETF Trend state. Other ideas are
  parked research cards. Book size and data tier are stage settings: paper is a
  $100,000 book on free data.
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
- Event data: Form 4 reader with the routine-trade classifier, issuer symbol
  lookups, SEC financial-statement fetcher. No 10-K, 10-Q or 8-K corpus,
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

1. Text-change signal, customer and supplier extractor and the opportunistic
   flag: the three missing components.
2. Composite builder and the ETF Trend scaler on the US margin ledger.
3. The `connected_drift` pre-registration; the first output is the component
   correlation matrix. A clear economic failure (`plan/validation.md`,
   Outcomes) stops new single-stock search.
4. Everything parked only after the deterministic test has shown signal.

## Human queue

Only a human can do these: protected paths, signing, accounts and pushes. An
agent run never touches them. Signing the paper stage file is under Codebase
cleanup.

- [ ] Add each new suite to the research gate in `ci.yml` and to the gates in
      `CONTEXT_MANIFEST.json` as the runs land (`review_paths` lets an agent draft
      the `ci.yml` line as a pull request; the manifest gate line stays yours).
- [ ] Push `main` when ready: all work since `789851f` is local only.
- [ ] Register `connected_drift` in the trial ledger once the live data checks
      below pass (`plan/validation.md`); the values are approved.
- [ ] Customer coverage by year: with network and `MIRO_CONTACT` exported, run
      `python3 research/strategy/customer_coverage_probe.py`; it writes
      `research/reports/customer_coverage.json`. If `collapsed` is true,
      `connected_drift` is registered without edge (a) (`plan/data.md`).
- [ ] One live check, run from a normal shell: fetch one Ken French zip and one
      real 10-K through `french_factors.fetch` and `edgar_filings`, and look at
      units, headers and the section parser's output (see Unverified claims).

## Unverified claims

Facts an agent or a session asserted that nobody has checked.

- `french_factors.fetch` has never reached the real site. The two file names
  match the data library page; the percent units and the file layout still need
  one live fetch before a gate relies on it.
- `last_trade` windows: Rule 12d2-2(d)(1) makes a delisting effective 10 days
  after the Form 25 (checked); the 8-K Item 2.01 and Form 15 windows are
  working assumptions.
- `filing_sections` (the last heading at a line start wins) and `form13f` have
  only seen fixtures; the 200-filing precision audit and one live information
  table are the check.
- `edgar_filings` lists only `filings.recent` of a submissions JSON, so filings in
  the SEC's older-history files are missed (the window starts in 2007); it also
  requires a `Content-Length` header, which a live response may not carry. Both
  need one live fetch to settle. `end_events` already reads the older-file shape.
- `ticker_observations.former_name_observations` takes the first 8-K on or after
  a name change as `known_at`, a conservative heuristic, not a dated fact.
- Modules under `research/sources/` import each other as `sources.x` in their
  tests, while `research/strategy/` uses `research.strategy.x`; one module can be
  loaded twice under two names. `universe.py` (wave 4) is told to settle which.
- `text_peers.text_peer_edges` compares every pair and sorts inside the cosine:
  fine for fixtures, too slow for a few thousand 10-Ks. Needs a sparse inverted
  index before it runs on a real cohort.
- `backtest.run_backtest` needs SPY and IEF bars for the 60/40 benchmark
  (`plan/validation.md`, Controls), whether or not the strategy trades them; the
  ETF Trend universe has VTI, not SPY, so the bar loader must add SPY. It has run
  only on synthetic bars.
- On this machine `python` is 3.13 and `python3` is 3.11. Under 3.13 the engine
  suites (`test_engine`, `test_hardening`, `test_seam_graph`) fail on unclosed
  SQLite connections with `PYTHONWARNINGS=error`, also on the commit before this
  work; the QA gate runs `python3` and passes them. Pin the interpreter in CI and
  decide whether the engine should close its connections.
- Parallel pipeline runs each execute the whole QA suite, and six at once on
  this Windows machine caused timeouts and `os.replace` races that failed rounds
  without any code fault. Keep a wave to about three runs, or merge by hand after
  checking the reviewer verdicts and a serial gate run.
- `gdelt_gkg` column positions (V2Themes 8, V2Organizations 14) follow the GKG 2.1
  layout and its fixtures; no real GKG file has been read.
- The coverage probe's 11% unverified end is a bar-data statement, not a
  confirmed delisting rate.

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
  - [x] Borrow stress grid of 0.5%, 2% and 5% a year in the cost model
        (`costs.BORROW_STRESS_GRID`).
  - [x] Gate report additions (`gates.breadth`): net alpha per decade, the
        Fama-French plus momentum alpha, the correlation with each promoted
        strategy and the effective number of independent signals. The factor
        alpha's t-statistic ignores the loadings' estimation error (`lean:`).
  - [x] The placebo-graph tool (`plan/math.md`, Edge validation).
  - [ ] Verify on Alpaca's docs and the paper account: shorting on paper, the
        `shortable` and `easy_to_borrow` flags, fractional shorts, the paper
        balance setting.
        Probe built (`research/sandbox/alpaca_short_probe.py`); a human runs it
        on the paper account outside regular hours, with `ALPACA_KEY_ID` and
        `ALPACA_SECRET` exported from the secret store: `python3
        research/sandbox/alpaca_short_probe.py --out research/reports/alpaca_short.json`.
        Waits on a human confirming the second (fractional) order is wanted.
- [ ] **ETF Trend scaler:** the signal (`strategy/etf_trend.py`), the runner
      (`strategy/backtest.py`) and the bar loader (`strategy/bar_loader.py`) are
      built on synthetic data. Left: a continuous, rate-capped exposure input to
      the harness on the US margin ledger, and real SIP datasets on disk.
      Human: build the symbols file in two passes (needs reference.json):
      `python3 research/strategy/build_universe.py --filers <form.idx> --as-of <date>`,
      fetch `research/data/universe_candidates.txt` with the command below, then
      build again; a symbol without current bars is excluded and counted.
      Human: fetch the datasets once with `ALPACA_KEY_ID` and `ALPACA_SECRET` exported:
      `python3 research/strategy/fetch_universe_bars.py <symbols file> --yes`
      (omit `--yes` for the request estimate; rerun to resume or refresh). Then
      run once the datasets are on disk (`research/data/`, layout in
      `read_dataset` of `strategy/run_connected_drift.py`): dry run
      `python3 research/strategy/run_connected_drift.py`, which prints coverage,
      the component correlation matrix and the effective signal count with no
      trial; registration only after that, with `--register --margin-rate <broker
      debit rate>`.
- [ ] **EDGAR corpus:** 10-K, 10-Q and 8-K full-text fetch with manifests, and
      the collectors that feed the pure modules below. Built and tested on
      fixtures only: `filing_sections`, `ticker_map`, `shares_outstanding`,
      `form13f`, `last_trade` and `french_factors` (`research/sources/`), plus the
      financial statement sets and the Form 4 reader.
  - [ ] A real-filing precision check of `filing_sections` (the last heading at a
        line start wins, so a late cross-reference can win) and of `form13f` on a
        live information table. Built (`research/strategy/real_filing_probe.py`);
        waits on a human run with network:
        `MIRO_CONTACT=<contact> python3 research/strategy/real_filing_probe.py`,
        which writes `research/reports/real_filing_probe.json`.
  - [ ] Observation collectors for `ticker_map` (cover-page symbols, symbol-change
        corporate actions, Form 4 issuer symbols, former names) and event
        collectors for `last_trade` (Form 25, Form 15, 8-K items), so delisting
        returns (`plan/math.md`, Point-in-time discipline) rest on a dated event;
        the coverage probe leaves 11% of eligible firms with an unverified end.
- [ ] **Link graph:** a bitemporal store; text peers and common ownership first
      (deterministic, dense); customer and supplier patterns with a precision
      audit (200 labeled filings, at least 0.9), knowing that 10-K disclosure
      covers only large customers.
- [x] **Text-change, customer and supplier extractor, opportunistic flag,
      composite builder and the `connected_drift` pre-registration draft:** built
      on fixtures, with a synthetic chain test (`test_connected_drift_chain`).
      Waits on: the operator's answers to the draft's `open_questions`, an EDGAR
      coverage check by year for the customer extractor, and real data. The first
      backtest output is the component correlation matrix and effective signal
      count; the runner `strategy/run_connected_drift.py` (tested on fixtures in
      `test_run_connected_drift`) prints them with the same dry-run command, then
      registers with `--register --margin-rate <rate>`, which refuses on a
      touched holdout, missing or stale data or an unapproved prereg. The book
      is built: score-proportional sizing, 6% single-name cap, 0.3 beta cap,
      10% volatility target and 20% no-trade band (`composite.py`, `Book`), with
      market cap and beta read point in time from `reference.json`. Waits on the
      real datasets it reads (bars, link store, filing scores, Form 4 events,
      reference with dated market cap and beta, and veto data). The four older
      drafts under `research/prereg/` are removed in the cleanup.
- [ ] **News co-mentions:** `sources/gdelt_gkg.py` parses GKG 2.1, resolves
      names by exact match and reports the resolution rate, on fixtures only.
      Left: a daily GKG downloader, a legal-name and former-name table, a
      measured resolution rate on real files, news edges into the link store,
      and the news variant (a later registration, `plan/strategies.md`).
- Parked (`plan/roadmap.md`, Parked), not built before the review: Event
  Ripple and its event pipeline, engine reasoning, the Link Momentum model
  variant and the X corroboration test.
- [ ] **Go/no-go review:** apply `plan/roadmap.md` and record the decision in the
      approvals log.
- [ ] **Paid research dataset** (only on the paid-data trigger).

## Engine plumbing

Parked with the model-involved items above; starts only after the deterministic
test has shown signal.

- [ ] **Reader tier, model pins, research factory:** see `plan/engine.md`.
- [ ] **Engine done-boxes:** the remaining items in `plan/engine.md` and
      `plan/data.md` that the link graph and the research datasets need.

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
