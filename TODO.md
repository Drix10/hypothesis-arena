# MiroHedge TODO — freeze v3 ("alpha-first rebaseline", 2026-09-28)

This ledger itemizes `plan/07-build-roadmap.md`. The freeze-v2 ledger
(Phases 0–3, Rounds 1–9, S1–S7, every addendum) is preserved byte-for-byte
in `TODO-ARCHIVE-2026-09-28.md` — read it for history, never append to it.

Legend: `[HUMAN]` needs the operator · `[BLOCKED]` waits on another box ·
each box names its doc 07 id. One box = one commit theme (AGENTS.md rule 7).
A box is checked only with evidence (commit + test output / report path).

## Current state (verified 2026-09-28)

- Plan: freeze v3 written (docs 00–13, manifest, `plan/appendix/`,
  critique in `plan/reviews/`); freeze-check PASS.
- Kernel: P3.1/P3.2/P3.3 FROZEN; P3.5 A–G done; H1 built (router 209,
  runner ~1045, broker 126, drills 120) — `transport = nullptr`, no order
  ever sent. P3.5 OPEN.
- Strategy: `baseline_v1` negative (S2 diagnostic Sharpe −1.09; diagnosed
  in doc 12 §12.7); S3/S4/S6 released; S5 economics open (stub FAIL).
- S7-C: re-audit #2 fixes landed at `f0815e7` (durable provider gate,
  ratio-chain liveness, tier-journal window) + bookkeeping `bd253fd`;
  full local battery green; **hosted 5/5 on that head still required**.
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
- [ ] O4 S7-C closure: hosted 5/5 (kernel, kernel-sanitizer, evidence,
      plane, stdlib) on the head carrying `f0815e7` (open a PR or push to
      `main` — CI does not run on feature-branch pushes; see O1).
- [x] O1 (local: test_baseline, test_jev_v4, test_v4 32/32 green; hosted run pending O4) CI: run on every push + `workflow_dispatch`; add `test_baseline`,
      `test_candidate` (pin pytest in a strategy requirements file),
      `test_jev_v4`, and `kernel/tests/test_v4.cpp` (plan amendment = doc 03
      locked decision, freeze v3).
- [x] O2 (`.gitleaks.toml`, `scripts/pre-commit-secrets.sh`, CI job `secrets`; full history clean, 55 commits) Secret scanning: gitleaks pinned by SHA-256 as a CI job + a
      pre-commit hook (pattern from `anthropics/financial-services`).
- [x] O3 (freeze-check PASS 189 checks as non-root; kernel gate PASS) freeze-check v3 alignment: rename `plan/02-twitter-alpha-system.md`
      → `plan/02-strategy-book.md`; verify manifest v3 keys
      (`plan_freeze`, `strategy_book_version`, `live_constraints`, …);
      `xxd` fallback; `kernel/build.sh` refuses to run as root (chmod-000 checks would be false green).
- [ ] O5 S7 closure: G1 venue amendment = freeze v3 (Alpaca, one liquid
      ETF, cash/long-only); capital-aware caps unchanged → close S7 after O4.

## Track A — alpha (critical path)

- [ ] A0 Research harness v2 (`research/strategy/`):
  - [x] A0.1 (`research/strategy/ledger.py`, 9 tests) Trial ledger (append-only, hash-chained, off-host checkpoint;
        every run writes a row incl. failures) — doc 11 §11.0a.
  - [ ] A0.2 SIP data fetcher (daily + minute bars, quotes, `feed=sip`,
        ≥15-min-delayed end) with dataset manifests — doc 09 §9.1a.
  - [x] A0.3 (`costs_v2.py`, 7 tests) `cost_v2` (paper_fill_v1 + SIP NBBO + SEC/TAF fees +
        participation caps + dividends) — doc 06 §6.0a.
  - [x] A0.4 (`settlement.py`, 4 tests; wired into the portfolio engine in A0.7) Settlement simulation (T+1, GFV/free-riding) + long-only
        cash constraint set in the backtester — doc 11 §11.0d.
  - [x] A0.5 (`research/strategy/stats.py`, 16 tests; CPCV/PBO/DSR/MinTRL/HAC/bootstrap/Holm) Statistics: purged/embargoed walk-forward, CPCV, PBO, DSR
        (N from ledger), MinTRL, stationary bootstrap, HAC Sharpe, pooled
        Holm — fixture-tested — doc 11 §11.0b.
  - [ ] A0.6 Pre-registration template + validator; contamination guard
        (LLM windows must start after cutoff + 30 d) — doc 11 §11.0c.
  - [ ] A0.7 Benchmark set (cash, vol-matched passive, 60/40, no-AI
        variant, baseline_v1 reproduction) — doc 12 §12.6.
  - [ ] A0.8 A-gate / B-gate report generators — doc 11 §11.3a.
- [ ] A1 S2 closure: `baseline_v1` rerun on SIP bars + quotes; primary
      ledger populated; negative result + diagnosis recorded; FX leg dropped.
- [ ] A2 T1 `trend_etf_v1`: pre-registration committed → A-gate report.
- [ ] A3 I1 `intraday_mom_v1`: pre-registration → A-gate (2× cost decisive).
- [ ] A4 E1 `insider_buy_v1`: Form 4 parser (codes, roles, 10b5-1 flag,
      routine-trader filter) + pre-registration → A-gate.
- [ ] A5 T2 `sector_mom_v1`: pre-registration → A-gate.
- [ ] A6 E2 `earnings_reader_v1`: E2-det A-gate; E2-ai paired forward
      design [BLOCKED on P2].
- [ ] A7 M1 vol-target overlay tested on every A-gate survivor.
- [ ] A8 S5 re-scoped as the `jev_v4` filter gate on surviving sleeves'
      candidate streams, post-cutoff answers only (not a G0 blocker).
- [ ] A9 S1 closure with ETF/EDGAR universes; PIT S&P-500 limitation recorded.

## Track K — kernel P3.5 remainder (parallel with A)

- [ ] K1 P3.5-T transport: decision record (libcurl+TLS vs `mirotrade`
      gateway) → implementation behind the seam → fault-injection suite →
      Alpaca paper smoke (submit/protect/query/cancel/reconcile/MOC, 429).
- [ ] K2 Always-take path (filter policy `none`), bit-identical where the
      filter passes; cannot read an AnswerSet (compile/grep gate).
- [ ] K3 Snapshot v2 + settlement ledger + committed vectors (v1 vectors
      still verified).
- [ ] K4 R18 settled-cash + R19 allowlist in `risk/veto.cpp`; allowlist +
      approved sleeves from the stage manifest; Slice-B verdicts unchanged.
- [ ] K5 OTO stop-only protection + MOC sequencing (stop-fills-first and
      MOC-reject drills).
- [ ] K6 `ingest/candidates.cpp`: CID recompute, sleeve approval,
      allowlist, freshness, long-only side policy, adversarial vectors.
- [ ] K7 Outbound-only alert adapter (no inbound, no commands, redacted).
- [ ] K8 Live journal growth bound (bounded load, chain continuity kept).
- [ ] K9 Slice F 24 h soak on the real transport [BLOCKED on K1].
- [ ] K10 H1 drills on the real transport, every doc 06 §6.2a row
      [BLOCKED on K1].
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
