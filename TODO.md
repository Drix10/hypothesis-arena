# MiroHedge TODO

This ledger itemizes `plan/07-build-roadmap.md`. History lives in git.

Legend: `[BLOCKED]` waits on another box.
Each box names its doc 07 id; one box is one commit theme (AGENTS.md rule 7).
A box is checked only with evidence (commit and test output, or a report path).

## Current state (verified 2026-09-30)

- Plan: frozen (docs 00-13, manifest, `plan/appendix/`); freeze-check PASS.
- Kernel: JEV filter built and gated; P3.5 slices A-G done; H1 built with the libcurl paper transport (live smoke PASS on Alpaca paper), WS stream, R18/R19, candidate ingest, `g0_paper_loop`, early-close calendar and torn-journal-line recovery. P3.5 is open: live-paper drills (K10), the 24 h soak (K9) and stop-cancel-before-close (K5).
- Paper run: `g2` with the passive core; the operator is running the 24 h soak (K9). Forward ledgers, JEV twins and the long-history harness are built (Track F/L); the long-history study has not run on real data.
- Strategy: `baseline_v1` negative (S2, doc 12 §12.7). T1, T2, I1, E1 and E2-det all failed their A-gate on the frozen holdout (A2-A6); no sleeve is a champion candidate. S3/S4/S6 released; S5 economics open.
- Ops: O6 credential rotation done; S7-C closed (hosted CI green, all six jobs).
- G0b: not started. Live ordering: not authorized.

## Phase R - rebaseline (docs)

- [x] R1 Critique recorded (in git history).
- [x] R2 Docs 00-13 + manifest rewritten; §6.1b, §8.4 internals, X archive
      moved verbatim to `plan/appendix/`; freeze-check PASS.
- [x] R3 TODO archived + rebuilt; AGENTS/README/ARCHITECTURE aligned.
- [x] R4 Operator approval of the plan text (doc 07 sign-off log, 2026-09-29).

## Track O - ops, CI, hygiene (small, do first)

- [x] O6 Rotate every credential shared in chat on 2026-09-28
      (OpenRouter, FRED, BEA, Alpaca paper); re-seed local `.env` only.
      Done; operator confirmed in chat 2026-09-30.
- [x] O4 S7-C closure: hosted CI green, all 6 jobs (run 36470824852).
- [x] O1 CI: run on every push + `workflow_dispatch`; add `test_baseline`,
      `test_candidate` (pytest pinned in a strategy requirements file),
      `test_jev_filter`, and `kernel/tests/test_jev_filter.cpp` (doc 03 locked decision).
- [x] O2 Secret scanning (`.gitleaks.toml`, `scripts/pre-commit-secrets.sh`, CI job `secrets`; history clean):
      gitleaks pinned by SHA-256, as a CI job and a pre-commit hook.
- [x] O3 freeze-check alignment: verify manifest keys
      (`plan_freeze`, `strategy_book_version`, `live_constraints`, …);
      `xxd` fallback; `kernel/build.sh` refuses to run as root (chmod-000 checks would be false green).
- [x] O5 S7 closure: G1 venue amendment (Alpaca, one liquid
      ETF, cash/long-only); capital-aware caps unchanged → close S7 after O4.
- [x] O7 Frozen collector findings, fixed under the exception record `plan/appendix/09-collector-o7-exception.md`.
  - Done: exported `OPENROUTER_API_KEY` now wins over `.env` (a rotated key takes effect).
  - Done: `config.py` handles `export KEY=` and unquoted inline comments; `HTTPError` responses are closed (`collector/tests/test_o7.py`, in CI).
  - Decision: the 8 MiB call-log rotation loses no spend evidence, because spend accounting reads the per-day ledgers.

## Track A - alpha (critical path)

- [x] A0 Research harness v2 (`research/strategy/`):
  - [x] A0.1 Trial ledger (append-only, hash-chained, off-host checkpoint;
        every run writes a row incl. failures) - doc 11 §11.0a.
  - [x] A0.2 SIP data fetcher (daily + minute bars, quotes, `feed=sip`,
        ≥15-min-delayed end) with dataset manifests - doc 09 §9.1a.
  - [x] A0.3 `cost_v2` (paper_fill_v1 + SIP NBBO + SEC/TAF fees +
        participation caps + dividends) - doc 06 §6.0a.
  - [x] A0.4 Settlement simulation (T+1, GFV/free-riding) + long-only
        cash constraint set in the backtester - doc 11 §11.0d.
  - [x] A0.5 Statistics: purged/embargoed walk-forward, CPCV, PBO, DSR
        (N from ledger), MinTRL, stationary bootstrap, HAC Sharpe, pooled
        Holm - fixture-tested - doc 11 §11.0b.
  - [x] A0.6 Pre-registration template + validator; contamination guard
        (LLM windows must start after cutoff + 30 d) - doc 11 §11.0c.
  - [x] A0.7 Benchmark set (cash, vol-matched passive, 60/40, no-AI
        variant, baseline_v1 reproduction) - doc 12 §12.6.
  - [x] A0.8 A-gate / B-gate report generators - doc 11 §11.3a.
- [ ] A1 S2 closure:
  - [x] Negative result + diagnosis recorded (doc 12 §12.7).
  - [ ] `baseline_v1` rerun on SIP bars + quotes; primary ledger populated; FX leg dropped.
- [x] A2 T1 `trend_etf_v1`: A-gate run on SIP daily bars 2016-01-04..2026-08-31 (free-feed history limit), holdout 2023-09-01..2026-08-31. Result: FAIL for both variants (excess-over-cash CI lower bound <= 0; ma10 also below the vol-matched 60/40). Ledger N=4 (two engine versions, both disclosed), reports in `research/reports/`. T1 is not a champion candidate; the statistical power of a 3-year holdout on one sleeve is the binding limit.
- [x] A3 I1 `intraday_mom_v1` (SPY; buy the 15:30 bar open, sell the 16:00 close after an up first half hour; pos and top_tercile; pre-registered 2026-09-29).
  - Result: A-gate FAIL for both variants. Holdout excess Sharpe -2.49 / -2.73 against 1.35 for the passive 60/40; modeled cost $43.5k / $29.5k at 2 bps spread.
  - Method: half-day sessions are dropped by a volume rule. Ledger N=19.
  - Decision: a re-test at measured NBBO spreads would be a new pre-registration.
- [x] A4 E1 `insider_buy_v1`: Form 4 pipeline (SEC bulk sets 2013-2026Q1, opportunistic filter, 5-slot 21-session sleeve, tiered spreads) and A-gate run: FAIL for all three variants (tierA/tierB/cluster). Best holdout excess Sharpe 0.83 (tierA) vs passive 1.35, max drawdown 27%, modeled cost $146k over the sample; participation cap breached at tierA; 7.9% of events had no price data (delisted / ticker changes) which alone voids the run under the 5% rule. Ledger N=12 (incl. 3 crashed trials from a cash-accrual bug, disclosed). Report `research/reports/e1_insider_buy_v1_a_gate.json`. Follow-up if revisited: ticker-history mapping to recover the 8% and a lower-turnover exit.
- [x] A5 T2 `sector_mom_v1` (top 3 of 10 SPDR sectors; mom12_1 and mom6_0; pre-registered 2026-09-29).
  - Result: A-gate FAIL for both variants. Holdout excess Sharpe 0.68 / 0.27 against 1.35 for the passive 60/40; CI lower bound <= 0, DSR and MinTRL fail. Ledger N=17.
- [x] A6 E2-det `earnings_reader_v1` (deterministic SUE drift, SEC financial-statement sets, 3 variants) A-gate run: FAIL for all variants (holdout excess Sharpe -0.34 / +0.28 / -0.20 vs passive 1.33; costs $71k-$137k over the sample; 6.3% of events lack prices). Ledger N=15. Report `research/reports/e2det_pead_v1_a_gate.json`.
- [ ] A6b E2-ai paired forward design [BLOCKED on P2].
- [ ] A7 M1 vol-target overlay tested on every A-gate survivor. [BLOCKED: no sleeve has passed an A-gate as of 2026-09-30; nothing to test]
- [x] JEV unified to one candidate-bound contract (2026-09-29): sidecar,
      shadow logger, `jev_filter.py` and `kernel/jev_filter.hpp` share one
      artifact; 32 vectors agree in Python and C++.
- [ ] A8 S5 re-scoped as the `jev` filter gate on surviving sleeves'
      candidate streams, post-cutoff answers only (not a G0 blocker).
      Shadow logger built 2026-09-29 (`ops/jev_shadow.py`, `test_jev_shadow`,
      one candidate-bound contract, log-only); a live provider run and enough candidates are still open.
- [ ] A9 S1 closure with ETF/EDGAR universes; PIT S&P-500 limitation recorded.

## Track L - long-history replication (parallel with A)

- [x] L1 `l1_long_history_v1` harness (2026-09-30): T1/T2 rules on French daily
      industry portfolios (1926+), sub-period and post-publication decay
      (`research/strategy/long_history.py`, `ops/long_history_fetch.py`,
      `ops/long_history_run.py`, prereg `research/prereg/l1_long_history_v1.json`,
      `test_long_history`, in CI). Not run on real data.
  - [HUMAN] `python3 ops/long_history_fetch.py` from a networked host (the sandbox
    cannot download), then `python3 ops/long_history_run.py`; the run is
    one-shot per data vintage, nothing may be tuned after it.
  - Decision (operator, AGENTS rule 11): L1 runs count toward the global trial N.
    `ops/long_history_run.py` opens one trial per rule before computing and
    closes each after, one run per data vintage (`--force` opens new trials);
    `--custom-csv` runs open their own trials. Smoke runs (`--boot`) use a
    temp ledger or `--no-ledger`, never the real one.

## Track K - kernel P3.5 remainder (parallel with A)

- [ ] K1 P3.5-T transport: decision record (libcurl+TLS vs `mirotrade`
      gateway) → implementation behind the seam → fault-injection suite →
      Alpaca paper smoke (submit/protect/query/cancel/reconcile/MOC, 429).
  - Done (2026-09-29): libcurl decision, `broker/http_curl.cpp`, `--paper` flag; live smoke PASS on Alpaca paper; real-reply fixture test; adapter body cap 8 KiB and legs rule fixed against the live shape.
  - Done: fault-injection suite over the real transport against a loopback mock (31 checks: 429/401/403/422/5xx, reset, hang, redirect, oversize, truncated, trickle, header hygiene).
  - Done: WebSocket trade_updates client (libcurl transport, own RFC 6455 framing because the system libcurl has no ws support; verified against the real paper stream and 11 loopback fault checks) feeds the runner's SSE seam.
  - Open: MOC fill/reconcile smoke with a held position, run by `kernel/broker/live_drill.cpp` once the session is open.
- [x] K2 Always-take path (filter policy `none`), bit-identical where the
      filter passes; cannot read an AnswerSet (compile/grep gate).
  - Done: `exec/decide.cpp` = the no-filter path; candidate gate + sizing (doc 03 3.3, `risk/sizing.cpp`) + veto -> OrderIntent; grep gate against AnswerSet.
  - Done: `FilterPolicy` on the risk snapshot: `none` ignores the disagreement and calibration inputs, `jev` keeps them, and the two are field-identical where the filter passes; 5 veto checks.
  - Decision: `Decide` always runs `none`.
- [x] K3 Snapshot v2 + settlement ledger + committed vectors (v1 vectors
      still verified).
  - Done: `runner/settle.cpp` T+1 unsettled-proceeds book; `runner/account.cpp` strict broker account/positions parser with a real-reply fixture.
  - Done: Snapshot v2 settlement section: canonical bytes identical to v1 when the section is clear; vectors `snapshot_v2_*` cross-checked against an independent Python encoding; 10k-stable hash.
  - Done: the loop keeps the book in `settle.log` with estimated proceeds (see K13); exchange holidays in `ops/deploy/session_calendar.json`.
- [x] K4 R18 settled-cash + R19 allowlist in `risk/veto.cpp`; allowlist +
      approved sleeves from the stage manifest; Slice-B verdicts unchanged.
  - Done: veto R18/R19 arms, opt-in `v3_constraints`; veto checks 177/177, full gate PASS, old verdicts identical.
  - Done: the approved.json loader (K12) and the settle book feed (K13) supply the manifest and ledger inputs.
- [ ] K5 OTO stop-only protection + MOC sequencing (stop-fills-first and
      MOC-reject drills).
  - Done: `ProtectedOrder.protection = OTO_STOP` + `gtc`, strict one-leg stop proof, stop-only repair order, `CloseAtClose` (time_in_force cls).
  - Done: `exec/moc_plan` sequencing with the stop-fills-first, MOC-reject, cutoff-missed and unknown-state drills (14 checks); live paper smoke accepts the OTO order with its stop leg and a cls order.
  - Done: wiring: `exit_intraday_v1` and `exit_event_v1` candidates become OTO stop-only orders (event is GTC); `exit_trend_v1` and `exit_profile_v1` stay bracket; unknown profiles are held; 5 decide checks and 6 loop checks over the real transport.
  - Live finding (2026-09-29 15:33 UTC): Alpaca rejects both MOC and market sells while an OTO stop is live (moc_sell transport_ok=0, market_sell transport_ok=0 with stop.protected=1). Exit logic must cancel the stop first, then close. Router change and mock drill needed before K10.
- [x] K6 `ingest/candidates.cpp`: CID recompute, sleeve approval,
      allowlist, freshness, long-only side policy, adversarial vectors.
- [x] K7 `ops/alert_relay.py` (needs ALERT_WEBHOOK_URL at deploy): outbound-only alert adapter (no inbound, no commands, redacted).
- [x] K8 Live journal growth bound.
  - Done: `JournalLoad` refuses past `JournalCap()` = 64 MiB and the runner halts as for a corrupt file; the daily roll alerts at half the cap.
  - Decision: rows are ~250 bytes, so a year of G3 order rates is far below the cap; rotation with a chain anchor stays a follow-up if the cap ever binds.
- [ ] K9 Slice F 24 h soak on the real transport.
  - Done: compressed mock soak (`kernel/tests/soak_mock.py`, 150 ticks, random venue faults and candidates) PASS; RSS flat at 13.7 MB, 4 descriptors, 78 decisions, 16 orders, journal chain intact.
  - Open: the 24 h run on a persistent host against paper [HUMAN host].
- [ ] K10 H1 drills on the real transport, every doc 06 §6.2a row.
  - Done: against the loopback mock through `g0_paper_loop` (18 checks, `kernel/tests/e2e_mock_venue.py`): broker outage, rate limit (entry dropped and journaled, next candidate placed), order endpoint down, recovery places once, restart and replayed line never duplicate an order, HALT keeps exits alive and holds entries, bad credentials.
  - Open: the same rows on live paper, and the rows that need other planes (feed gap, settlement mismatch, journal chain break, stage chain).
- [x] K11 Found in K7: `runner/store.cpp Alert()` did not JSON-escape `code`/`detail`, so a quote or backslash produced an invalid alerts.jsonl line that the relay skipped and counted (the alert was lost). Add an escape helper and test.
  - Done: `Alert()` escapes and bounds code/detail, ASCII-only; tested in test_runner.
- [x] K12 Wire R18/R19 from the stage manifest.
  - Done: `Decide` always sets `v3_constraints`; the `approved.json` loader carries the sleeve windows and allowlist.
  - Done: the loop refuses to start without both and without a human STAGE.
- [x] K13 Loop glue for G0b: `PaperLoop` (account, positions, working orders -> candidates -> Decide -> SubmitIntent -> Cycle).
  - Done: R6/R7 from live hourly bars, ET calendar, offsets and a decisions.jsonl audit; churn counters from `submitted.log`; oversize-line and file-rotation recovery.
  - Done: working buy orders count as exposure and reserved cash (`inflight.log` supplies the reference price; an order the loop did not place halts entries); a working sell blocks a second exit; fractional positions are held as dust and never traded.
  - Done: exit proceeds are booked before the order is sent, keyed by cid and estimated from the live mark +1% (broker cash reconciles the rest next session).
  - Decision: no MOC or timed exits for the passive core (its exits are explicit SELL candidates during the session); early-close days (13:00 ET) are listed in `early_close_YYYY` arrays of the calendar and honored by the data-age gate; a torn final journal line is trimmed on recovery (bytes kept in `journal.jsonl.torn`, MEDIUM alert `journal-torn-tail`); `ops/deploy/session_calendar.json` covers 2026-2028.
  - Open: STAGE signature and approved.json (G0-STAGE) remain.
- [ ] K-exit P3.5 CLOSED (K1-K7 + K10 green).

## Track P - research plane (parallel)

Deferred by decision (2026-09-29): no sleeve has passed an A-gate, so there is nothing for a reader tier or a research factory to feed, and P1/P2/P4 need Docker workers and a paid LLM budget to verify. Alpha-first rule (AGENTS 9): revisit when a sleeve reaches B-gate or a new data source justifies it.
Order (2026-09-29): the paper run and its results choose which strategies
to keep; this track is then connected to feed those strategies.

- [ ] P1 Reader-tier `extract` (no CodeAgent on untrusted text; capped
      JSON; span verifier); graph g1 → g2 with manifest bump.
- [ ] P2 E2 reader skill + schema + verifier; role pins incl. knowledge
      cutoff; model bake-off per doc 08 §8.8.
- [ ] P3 Research factory v1 (`mirofactory`, no network in generated code,
      trial-ledgered, ≤3 cards/week to human triage).
- [ ] P4 Remaining doc 08 §8.6 + doc 09 §9.4 boxes (7-day unattended run,
      Langfuse attribution day, p50/p99 per Tier-A source, ALFRED replay,
      Form 4 + 8-K EX-99.1 locators).
- [ ] P5 S6 integration only via the doc 11 path (not critical path).

## Phase 4 - G0_PAPER

The paper run is started with `bash ops/deploy/start.sh ~/g2` (see `ops/deploy/README.md`). G0b remains formally gated.

- [ ] G0a Shadow on live data for every A-gate passer (harness fills,
      `cost_v2`, no broker orders); B-gate per sleeve.
  - [x] Shadow ledgers for core, T1, T2 (`ops/sleeve_shadow.py`, started by
        `start.sh`, monitor panel, `--verify` fidelity gate) - plan/appendix/10.
  - [x] Event sleeves E1 and I1 in the shadow ledger (`ops/event_shadow.py`); E2det PEAD not wired (no forward source for its registered signal).
  - [x] Collector background poller (opt-in `WITH_COLLECTOR=1`). [x] macro-lite shadow ledger (`ops/macro_shadow.py`, needs FRED_API_KEY).
  - [x] JEV paired A/B twins per sleeve (`ops/jev_twin.py`, needs OPENROUTER_API_KEY; live run pending).
  - [ ] Netting router: not on the critical path (G0b is one champion; none passed A-gate). Build with the K5 exit sequence when a champion exists.
  - [x] Account kill inputs wired (daily loss 3% entry hold, drawdown 15% latch). [x] per-sleeve limits reported in `sleeves/status.json`.
- [x] G0-STAGE Sign the G0 bootstrap STAGE file (doc 10 §10.5). Signed by the operator 2026-09-29 (`scripts/sign-stage.sh ~/g0`, mode 0600).
- [ ] G0b Broker paper: one champion sleeve through the kernel on Alpaca
      paper [BLOCKED on K-exit + a B-gate pass + G0-STAGE].
- [ ] G0-ops Daily summary, weekly replay, §6.2a drills on the live loop.
- [ ] G0-exit 30 clean G0b days + doc 10 §10.2 G0→G1 criteria + sign-off.

## Phase 5+ - live stages (not authorized)

- [ ] G1-J Jurisdiction evidence bundle (doc 10 §10.1a) incl.
      professional written confirmation of the instrument allowlist.
- [ ] G1-P Port-on-promotion: champion signal in C++ + cross-language
      vectors (doc 04).
- [ ] G1 G1_TINY manifest: 1 liquid US ETF, R×0.25, cash, long only.
- [ ] G2 / G3 per doc 07 §7.8-7.9.
