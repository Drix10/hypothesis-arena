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

## Human queue

Only a human can do these: protected paths, signing, accounts and pushes. An
agent run never touches them. Signing the paper stage file is under Codebase
cleanup.

- [ ] Add the new research suites to the research gate in `ci.yml` and to the
      gates in `CONTEXT_MANIFEST.json` (protected paths): `test_coverage_probe`,
      `test_tranches`, `test_french_factors`, `test_placebo`, `test_ticker_map`,
      `test_shares_outstanding`, `test_form13f`, `test_last_trade`,
      `test_filing_sections`, and every suite the next runs add. The agent-flow
      QA gate runs only the suites listed there, so the pipeline does not run
      these until then.
- [ ] Add the `.gitleaks.toml` allowlist line the CI secrets job needs.
- [ ] Set `review_paths` in `CONTEXT_MANIFEST.json` (agent-flow 1.2.3) so an agent
      can add a test line to `ci.yml` as a draft pull request instead of
      stopping; keep the kernel risk, exec, broker and kill paths, the stage
      files and the manifest protected.
- [ ] Push `main` when ready: all work since `789851f` is local only.
- [ ] Answer the `open_questions` in each draft pre-registration under
      `research/prereg/` (ETF list, evaluation length, split count and the like),
      then approve it in chat. Nothing is registered in the trial ledger or run
      before that (`plan/validation.md`).
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
- [ ] **ETF Trend test** (`etf_trend`): prereg (`seen-window`) and backtest gate.
      Built: the draft `research/prereg/etf_trend.json`, the signal
      (`strategy/etf_trend.py`) and the runner (`strategy/backtest.py`), all on
      synthetic data, the bar loader (`strategy/bar_loader.py`, reads `sip_fetch`
      datasets and names SPY and IEF for the benchmark) and an end-to-end chain
      test (`test_etf_trend_chain`). Waits on the operator's answers to the
      draft's `open_questions` and on real SIP datasets fetched to disk.
- [ ] **EDGAR corpus:** 10-K, 10-Q and 8-K full-text fetch with manifests, and
      the collectors that feed the pure modules below. Built and tested on
      fixtures only: `filing_sections`, `ticker_map`, `shares_outstanding`,
      `form13f`, `last_trade` and `french_factors` (`research/sources/`), plus the
      financial statement sets and the Form 4 reader.
  - [ ] A real-filing precision check of `filing_sections` (the last heading at a
        line start wins, so a late cross-reference can win) and of `form13f` on a
        live information table.
  - [ ] Observation collectors for `ticker_map` (cover-page symbols, symbol-change
        corporate actions, Form 4 issuer symbols, former names) and event
        collectors for `last_trade` (Form 25, Form 15, 8-K items), so delisting
        returns (`plan/math.md`, Point-in-time discipline) rest on a dated event;
        the coverage probe leaves 11% of eligible firms with an unverified end.
- [ ] **Link graph:** a bitemporal store; text peers and common ownership first
      (deterministic, dense); customer and supplier patterns with a precision
      audit (200 labeled filings, at least 0.9), knowing that 10-K disclosure
      covers only large customers.
- [ ] **Link Momentum test, filings variant** (`link_momentum`): the draft
      `research/prereg/link_momentum.json` (edges a, b and d, 3-month hold in
      monthly tranches, 150% gross) waits on the operator's answers; then the
      backtest gate with edge validation. It cannot run until edge (a), the
      customer and supplier extractor, exists (Link graph). The free feed gives
      about ten years, so expect the paid-data trigger for pre-2016 prices.
- [ ] **Insider opportunistic buys card:** the draft
      `research/prereg/insider_opportunistic.json` waits on the operator's
      answers (holding period, sizing, cluster rule); `research/strategy/form4.py`
      already classifies routine trades. Then the backtest gate.
- [ ] **News co-mentions:** `sources/gdelt_gkg.py` parses GKG 2.1, resolves
      names by exact match and reports the resolution rate, on fixtures only.
      Left: a daily GKG downloader, a legal-name and former-name table, a
      measured resolution rate on real files, news edges into the link store,
      and the news and intraday variant preregs and backtest gates.
- [ ] **Filing Change test** (`filing_change`): the draft
      `research/prereg/filing_change.json` waits on the operator's answers; the
      text-change signal (`plan/math.md`, Text change) is not built; then the
      backtest gate.
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
