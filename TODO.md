# MiroHedge TODO — freeze v3 ("alpha-first rebaseline", 2026-09-28)

This ledger itemizes `plan/07-build-roadmap.md`. The freeze-v2 ledger is in
`TODO-ARCHIVE-2026-09-28.md`; read it for history, never append to it.

Legend: `[HUMAN]` needs the operator · `[BLOCKED]` waits on another box.
Each box names its doc 07 id; one box is one commit theme (AGENTS.md rule 7).
A box is checked only with evidence (commit and test output, or a report path).

## Current state (verified 2026-09-29)

- Plan: freeze v3 written (docs 00–13, manifest, `plan/appendix/`, critique in
  `plan/reviews/`); freeze-check PASS.
- Kernel: P3.1/P3.2/P3.3 FROZEN; P3.5 A-G done; H1 built; R18/R19 veto arms, candidate validator and escaped alerts landed (K4/K6/K7/K11). `transport = nullptr`: no order is ever sent. P3.5 OPEN.
- Strategy: `baseline_v1` negative (S2, doc 12 12.7). T1 `trend_etf_v1` ran through the harness on SIP daily bars 2016-2026: FAIL on the 2023-09..2026-08 holdout (A2). S3/S4/S6 released; S5 economics open.
- S7-C: CLOSED (hosted CI green on the PR head, all six jobs).
- G0: NOT STARTED. Live ordering: NOT AUTHORIZED.

## Phase R — rebaseline (docs)

- [x] R1 Critique recorded: `plan/reviews/2026-09-28-v3-rebaseline-critique.md`.
- [x] R2 Docs 00–13 + manifest rewritten; §6.1b, §8.4 internals, X archive
      moved verbatim to `plan/appendix/`; freeze-check PASS.
- [x] R3 TODO archived + rebuilt; AGENTS/README/ARCHITECTURE aligned.
- [ ] R4 [HUMAN] Sign the freeze-v3 text (doc 07 sign-off log).

## Track O — ops, CI, hygiene (small, do first)

- [ ] O6 [HUMAN] Rotate every credential shared in chat on 2026-09-28
      (OpenRouter, FRED, BEA, Alpaca paper); re-seed local `.env` only.
- [x] O4 (hosted run 36470824852 on e833976, all 6 jobs green: kernel, kernel-sanitizer, evidence, plane, stdlib, secrets) S7-C closure: hosted CI green on the head carrying `f0815e7`.
- [x] O1 (local: test_baseline, test_jev_v4, test_v4 32/32 green; hosted run pending O4) CI: run on every push + `workflow_dispatch`; add `test_baseline`,
      `test_candidate` (pytest pinned in a strategy requirements file),
      `test_jev_v4`, and `kernel/tests/test_v4.cpp` (doc 03 locked decision).
- [x] O2 (`.gitleaks.toml`, `scripts/pre-commit-secrets.sh`, CI job `secrets`; full history clean over all 558 commits; one false positive in the pre-rename sandbox compose path, now allowlisted) Secret scanning: gitleaks pinned by SHA-256 as a CI job + a
      pre-commit hook (pattern from `anthropics/financial-services`).
- [x] O3 (freeze-check PASS 189 checks as non-root; kernel gate PASS) freeze-check v3 alignment: rename `plan/02-twitter-alpha-system.md`
      → `plan/02-strategy-book.md`; verify manifest v3 keys
      (`plan_freeze`, `strategy_book_version`, `live_constraints`, …);
      `xxd` fallback; `kernel/build.sh` refuses to run as root (chmod-000 checks would be false green).
- [x] O5 (freeze v3 is the venue amendment; S7 closed on O4) S7 closure: G1 venue amendment = freeze v3 (Alpaca, one liquid
      ETF, cash/long-only); capital-aware caps unchanged → close S7 after O4.
- [ ] O7 Findings in frozen collector code (an edit needs a doc-backed exception, AGENTS rule 8; fixes are small): `collector/jev.py api_key()` reads `.env` before the exported variable while `config.py` documents the opposite (a rotated exported key is ignored); `config.py` keeps inline `# comments` in values and ignores `export KEY=` lines; `jev.py:1078` and `collect.py:246` do not close `HTTPError`; confirm the 8 MB call-log rotation in `jev.py:1124` loses no spend evidence.

## Track A — alpha (critical path)

- [ ] A0 Research harness v2 (`research/strategy/`):
  - [x] A0.1 (`research/strategy/ledger.py`, 9 tests) Trial ledger (append-only, hash-chained, off-host checkpoint;
        every run writes a row incl. failures) — doc 11 §11.0a.
  - [x] A0.2 (`sip_fetch.py`, 7 tests; mocked transport, 15-min delay refused, manifest w/o credentials; live fetch needs a run with keys) SIP data fetcher (daily + minute bars, quotes, `feed=sip`,
        ≥15-min-delayed end) with dataset manifests — doc 09 §9.1a.
  - [x] A0.3 (`costs_v2.py`, 7 tests) `cost_v2` (paper_fill_v1 + SIP NBBO + SEC/TAF fees +
        participation caps + dividends) — doc 06 §6.0a.
  - [x] A0.4 (`settlement.py`, 4 tests; wired into the portfolio engine in A0.7) Settlement simulation (T+1, GFV/free-riding) + long-only
        cash constraint set in the backtester — doc 11 §11.0d.
  - [x] A0.5 (`research/strategy/stats.py`, 16 tests; CPCV/PBO/DSR/MinTRL/HAC/bootstrap/Holm) Statistics: purged/embargoed walk-forward, CPCV, PBO, DSR
        (N from ledger), MinTRL, stationary bootstrap, HAC Sharpe, pooled
        Holm — fixture-tested — doc 11 §11.0b.
  - [x] A0.6 (`research/strategy/prereg.py`, 5 tests; cutoff+30d guard, fail-closed schema, canonical hash) Pre-registration template + validator; contamination guard
        (LLM windows must start after cutoff + 30 d) — doc 11 §11.0c.
  - [x] A0.7 (`portfolio.py` + `benchmarks.py`, 6 tests; baseline_v1 reproduction + no-AI pairing are per-run ledgered runs, done in A1/A8) Benchmark set (cash, vol-matched passive, 60/40, no-AI
        variant, baseline_v1 reproduction) — doc 12 §12.6.
  - [x] A0.8 (`research/strategy/gates.py`, 5 tests; fail-closed, missing evidence fails) A-gate / B-gate report generators — doc 11 §11.3a.
- [ ] A1 S2 closure: `baseline_v1` rerun on SIP bars + quotes; primary
      ledger populated; negative result + diagnosis recorded; FX leg dropped.
- [x] A2 T1 `trend_etf_v1`: A-gate run on SIP daily bars 2016-01-04..2026-08-31 (free-feed history limit), holdout 2023-09-01..2026-08-31. Result: FAIL for both variants (excess-over-cash CI lower bound <= 0; ma10 also below the vol-matched 60/40). Ledger N=4 (two engine versions, both disclosed), reports in `research/reports/`. T1 is not a champion candidate; the statistical power of a 3-year holdout on one sleeve is the binding limit.
- [x] A3 I1 `intraday_mom_v1` (SPY, buy the 15:30 bar open and sell the 16:00 close after an up first half hour; pos and top_tercile, pre-registered 2026-09-29): A-gate FAIL for both variants (holdout excess Sharpe -2.49 / -2.73 against 1.35 for the passive 60/40; modeled cost $43.5k / $29.5k at 2 bps spread); half-day sessions are dropped by a volume rule; ledger N=19. A re-test at measured NBBO spreads would be a new pre-registration.
- [x] A4 E1 `insider_buy_v1`: Form 4 pipeline (SEC bulk sets 2013-2026Q1, opportunistic filter, 5-slot 21-session sleeve, tiered spreads) and A-gate run: FAIL for all three variants (tierA/tierB/cluster). Best holdout excess Sharpe 0.83 (tierA) vs passive 1.35, max drawdown 27%, modeled cost $146k over the sample; participation cap breached at tierA; 7.9% of events had no price data (delisted / ticker changes) which alone voids the run under the 5% rule. Ledger N=12 (incl. 3 crashed trials from a cash-accrual bug, disclosed). Report `research/reports/e1_insider_buy_v1_a_gate.json`. Follow-up if revisited: ticker-history mapping to recover the 8% and a lower-turnover exit.
- [x] A5 T2 `sector_mom_v1` (top 3 of 10 SPDR sectors, mom12_1 and mom6_0, pre-registered 2026-09-29): A-gate FAIL for both variants (holdout excess Sharpe 0.68 / 0.27 against 1.35 for the passive 60/40; CI lower bound <= 0, DSR and MinTRL fail); ledger N=17.
- [ ] A6 E2 `earnings_reader_v1`: E2-det (deterministic SUE drift, SEC financial-statement sets, 3 variants) A-gate run: FAIL for all variants (holdout excess Sharpe -0.34 / +0.28 / -0.20 vs passive 1.33; costs $71k-$137k over the sample; 6.3% of events lack prices). Ledger N=15. Report `research/reports/e2det_pead_v1_a_gate.json`. E2-ai paired forward design [BLOCKED on P2]; no reason to build it while the deterministic baseline is negative.
- [ ] A7 M1 vol-target overlay tested on every A-gate survivor.
- [ ] A8 S5 re-scoped as the `jev_v4` filter gate on surviving sleeves'
      candidate streams, post-cutoff answers only (not a G0 blocker).
- [ ] A9 S1 closure with ETF/EDGAR universes; PIT S&P-500 limitation recorded.

## Track K — kernel P3.5 remainder (parallel with A)

- [ ] K1 (DONE 2026-09-29: libcurl decision, `broker/http_curl.cpp`, `--paper` flag, live smoke PASS on Alpaca paper, real-reply fixture test, adapter body cap 8 KiB and legs rule fixed against the live shape; fault-injection suite over the real transport against a loopback mock (31 checks: 429/401/403/422/5xx, reset, hang, redirect, oversize, truncated, trickle, header hygiene); OPEN: WS trade_updates, MOC fill/reconcile smoke with a held position) P3.5-T transport: decision record (libcurl+TLS vs `mirotrade`
      gateway) → implementation behind the seam → fault-injection suite →
      Alpaca paper smoke (submit/protect/query/cancel/reconcile/MOC, 429).
- [x] K2 (`exec/decide.cpp` = the no-filter path, candidate gate + sizing (doc 03 3.3, `risk/sizing.cpp`) + veto -> OrderIntent, grep gate against AnswerSet; `FilterPolicy` on the risk snapshot: `none` ignores the disagreement and calibration inputs, `jev_v4` keeps them, and the two are field-identical where the filter passes, 5 veto checks; `Decide` always runs `none`) Always-take path (filter policy `none`), bit-identical where the
      filter passes; cannot read an AnswerSet (compile/grep gate).
- [x] K3 (`runner/settle.cpp` T+1 unsettled-proceeds book, `runner/account.cpp` strict broker account/positions parser with a real-reply fixture; Snapshot v2 settlement section: canonical bytes identical to v1 when the section is clear, vectors `snapshot_v2_*` cross-checked against an independent Python encoding, 10k-stable hash; the loop keeps the book in `settle.log` with estimated proceeds (see K13); exchange holidays in `ops/deploy/session_calendar.json`) Snapshot v2 + settlement ledger + committed vectors (v1 vectors
      still verified).
- [x] K4 (veto R18/R19 arms, opt-in `v3_constraints`, veto checks 177/177, full gate PASS, old verdicts identical; the approved.json loader (K12) and the settle book feed (K13) supply the manifest and ledger inputs) R18 settled-cash + R19 allowlist in `risk/veto.cpp`; allowlist +
      approved sleeves from the stage manifest; Slice-B verdicts unchanged.
- [ ] K5 (DONE: `ProtectedOrder.protection = OTO_STOP` + `gtc`, strict one-leg stop proof, stop-only repair order, `CloseAtClose` (time_in_force cls), `exec/moc_plan` sequencing with the stop-fills-first, MOC-reject, cutoff-missed and unknown-state drills (14 checks); live paper smoke accepts the OTO order with its stop leg and a cls order; OPEN: router/loop wiring for OTO sleeves (none has passed a gate), whether Alpaca accepts a sell MOC while a stop reserves the shares (needs a held position in an open session))
      OTO stop-only protection + MOC sequencing (stop-fills-first and
      MOC-reject drills).
- [x] K6 (`ingest/candidates.{hpp,cpp}`, 17 checks, wire record frozen in doc 04 2b; tailer/stage-manifest feed is runner wiring in K1/G0) `ingest/candidates.cpp`: CID recompute, sleeve approval,
      allowlist, freshness, long-only side policy, adversarial vectors.
- [x] K7 (`ops/alert_relay.py`, 6 tests; tail+redact+HTTPS POST, no listener, at-least-once; needs ALERT_WEBHOOK_URL at deploy [HUMAN]) Outbound-only alert adapter (no inbound, no commands, redacted).
- [x] K8 (`JournalLoad` refuses past `JournalCap()` = 64 MiB and the runner halts as for a corrupt file; the daily roll alerts at half the cap; rows are ~250 bytes so a year of G3 order rates is far below it; rotation with a chain anchor stays a follow-up if the cap ever binds) Live journal growth bound.
- [ ] K9 Slice F 24 h soak on the real transport. Compressed mock soak (`kernel/tests/soak_mock.py`, 150 ticks, random venue faults and candidates): PASS, RSS flat at 13.7 MB, 4 descriptors, 78 decisions, 16 orders, journal chain intact. OPEN: the 24 h run on a persistent host against paper [HUMAN host].
- [ ] K10 H1 drills on the real transport, every doc 06 §6.2a row. DONE against the loopback mock through `g0_paper_loop` (18 checks, `kernel/tests/e2e_mock_venue.py`): broker outage, rate limit (entry dropped and journaled, next candidate placed), order endpoint down, recovery places once, restart and replayed line never duplicate an order, HALT keeps exits alive and holds entries, bad credentials. OPEN: the same rows on live paper, and the rows that need other planes (feed gap, settlement mismatch, journal chain break, stage chain).
- [x] K11 (Alert() now escapes and bounds code/detail, ASCII-only, tested in test_runner) Found in K7: `runner/store.cpp Alert()` did not JSON-escape `code`/`detail`, so a quote or backslash produced an invalid alerts.jsonl line that the relay skipped and counted (the alert was lost). Add an escape helper and test.
- [x] K12 (`Decide` always sets `v3_constraints`; `approved.json` loader carries the sleeve windows and allowlist; the loop refuses to start without both and without a human STAGE) Wire R18/R19 from the stage manifest
- [x] K13 Loop glue for G0b. `PaperLoop` (account, positions, working orders -> candidates -> Decide -> SubmitIntent -> Cycle) with R6/R7 from live hourly bars, ET calendar, offsets and a decisions.jsonl audit; churn counters from `submitted.log`; oversize-line and file-rotation recovery; working buy orders count as exposure and reserved cash (`inflight.log` supplies the reference price; an order the loop did not place halts entries); a working sell blocks a second exit; fractional positions are held as dust and never traded; exit proceeds are booked before the order is sent, keyed by cid and estimated from the live mark +1% (broker cash reconciles the rest next session). Decisions: no MOC or timed exits for the passive core (its exits are explicit SELL candidates during the session); early-close days are not modeled (the data-age gate only gets stricter); `ops/deploy/session_calendar.json` covers 2026-2028. [HUMAN] STAGE signature and approved.json (G0-STAGE) remain.
- [ ] K-exit P3.5 CLOSED (K1–K7 + K10 green).

## Track P — research plane (parallel)

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

## Phase 4 — G0_PAPER

- [ ] G0a Shadow on live data for every A-gate passer (harness fills,
      `cost_v2`, no broker orders); B-gate per sleeve.
- [ ] G0-STAGE [HUMAN] Sign the G0 bootstrap STAGE file (doc 10 §10.5).
- [ ] G0b Broker paper: one champion sleeve through the kernel on Alpaca
      paper [BLOCKED on K-exit + a B-gate pass + G0-STAGE].
- [ ] G0-ops Daily summary, weekly replay, §6.2a drills on the live loop.
- [ ] G0-exit 30 clean G0b days + doc 10 §10.2 G0→G1 criteria + [HUMAN]
      sign-off.

## Phase 5+ — live stages (not authorized)

- [ ] G1-J [HUMAN] Jurisdiction evidence bundle (doc 10 §10.1a) incl.
      professional written confirmation of the instrument allowlist.
- [ ] G1-P Port-on-promotion: champion signal in C++ + cross-language
      vectors (doc 04).
- [ ] G1 [HUMAN] G1_TINY manifest: 1 liquid US ETF, R×0.25, cash, long only.
- [ ] G2 / G3 per doc 07 §7.8–7.9.
