# MiroHedge TODO

This ledger itemizes `plan/07-build-roadmap.md`. It holds open work only;
finished boxes and their evidence live in git history.

Legend: `[BLOCKED]` waits on another box; `[HUMAN]` needs the operator.
Each box names its doc 07 id; one box is one commit theme (AGENTS.md rule 7).
A box is checked only with evidence (commit and test output, or a report path).

## Current state (verified 2026-10-02)

- Plan: freeze v4 (docs 00-14): the epistemic engine, sleeves L1-L4,
  constraint sets C1/C2, `val_v2`; freeze-check PASS.
- Kernel: JEV filter, P3.5 slices A-G and H1 built (libcurl paper
  transport, WebSocket stream, R18/R19 for C1, candidate ingest,
  `g0_paper_loop`, kill inputs, HWM persistence, early-close calendar,
  torn-journal recovery). Live smoke PASS on Alpaca paper. The rest is
  parked (Track K).
- Engine: collector, six-node research graph, five Tier-A adapters and the
  source seam built. Link graph, events and ripple reasoning not built.
- Harness: C1 only (trial ledger, `cost_v2`, statistics, prereg validator,
  benchmarks, report generators).
- Sleeves: the five C1 sleeves failed their A-gates and run as forward
  ledgers; no champion. G0-STAGE signed 2026-09-29; the paper loop runs
  the passive core as a plumbing test. G0b not started; live ordering not
  authorized.

## Plan approval

- [ ] [HUMAN] Approve the freeze v4 plan text in chat; record it in the
      doc 07 sign-off log.
- [ ] [HUMAN] Apply the freeze v4 manifest copy to
      `plan/system-manifest.yaml` (protected path).

## Track A - alpha (critical path, doc 07 §7.2)

- [ ] A10 C2 harness: short side and margin ledger, `cost_v3`,
      `constraint_set` and `contamination_class` in the prereg validator,
      $25,000 whole-share book, spanning test + FF5/momentum diagnostics
      (`val_v2`), placebo-graph tool.
  - [ ] Verify on Alpaca docs and the paper account: shorting on paper,
        `shortable`/`easy_to_borrow` flags, fractional shorts, paper balance
        setting.
- [ ] A11 L4 `tsmom_ls_v1`: prereg (`seen-window`) and A-gate.
- [ ] A12 EDGAR corpus: 10-K/10-Q/8-K full text with manifests, section
      parser, point-in-time CIK/ticker/former-name map, XBRL shares
      outstanding, 13F holdings, Ken French factors.
- [ ] A13 MLG v0: bitemporal store; `sc` patterns + precision audit (200
      labeled filings, ≥ 0.9); `tx` text peers; `ow` common ownership.
- [ ] A14 L1 `link_momentum_v1` V0: prereg and A-gate with edge validation.
- [ ] A15 GDELT GKG co-mentions with measured resolution rate; L1 V1 and V2
      preregs and A-gates.
- [ ] A16 L2 `text_change_v1`: prereg and A-gate.
- [ ] A17 Event pipeline on history; `ripple_det_v1` prereg and A-gate.
- [ ] A18 Engine g3 (router, retrieval, brain, verifier, f3); L3 prereg;
      forward shadow on post-cutoff events [BLOCKED on P1, P2].
- [ ] A19 L1-ai class B link extraction, precision audit, paired test
      [BLOCKED on P1].
- [ ] A20 `xcorr_v1` X corroboration test: official-API adapter, bot
      filter, corroboration flag, prereg with power analysis; forward on
      `ripple_det_v1` candidates [BLOCKED on A17 + D2 approval of the
      $50/month X budget].
- [ ] A-CP1 Apply doc 07 §7.1; record the decision in the sign-off log.
- [ ] D2 paid research dataset [BLOCKED on the doc 09 §9.1b trigger].
- Parked until A-CP1: A1 `baseline_v1` SIP rerun; A8 `jev` filter paired
  test (shadow logger and twins built, live provider run open); A9 S1
  closure with ETF/EDGAR universes.

## Track P - engine plumbing (doc 07 §7.3)

- [ ] P1 Reader tier: capability-free calls, capped JSON, span verifier,
      anonymization; graph g1 → g2 with manifest bump.
- [ ] P2 Role pins (reader, router, brain, verifier) with knowledge
      cutoffs; post-cutoff bake-off per role.
- [ ] P3 Research factory v1 (`mirofactory`, no network in generated code,
      trial-ledgered, ≤ 3 cards/week).
- [ ] P4 Remaining doc 08 §8.8 and doc 09 §9.4 boxes.

## Track L - long-history replication

- [ ] [HUMAN] Run `python3 ops/long_history_fetch.py` on a networked host,
      then `python3 ops/long_history_run.py` (one-shot per data vintage;
      each rule opens its own trial).

## Track K - kernel (parked until A-CP1; only paper-loop-breaking defects are fixed)

- [ ] K1 MOC fill and reconcile smoke with a held position
      (`kernel/broker/live_drill.cpp`, during a session).
- [ ] K5 Stop-cancel-before-close: Alpaca rejects MOC and market sells
      while an OTO stop is live (observed 2026-09-29), so the router
      cancels the stop, confirms, then closes; mock drill before K10.
- [ ] K9 24 h soak on the real transport [HUMAN host]. Mock soak PASS.
- [ ] K10 Every doc 06 §6.2a row on live paper, plus the rows that need
      other planes (feed gap, settlement mismatch, journal chain break,
      stage chain). Mock-venue rows PASS.
- [ ] K-C2 C2 account path (doc 13 §13.8) [BLOCKED on an A-CP1 pass];
      the `execution_max` pin in freeze-check and the manifest change
      together [HUMAN, protected paths].
- [ ] K-exit P3.5 closed (K1, K5, K10 green).

## Phase 4 - G0_PAPER

The paper run starts with `bash ops/deploy/start.sh ~/g2` (see
`ops/deploy/README.md`).

- [ ] G0a Shadow for every A-gate passer under its constraint set; B-gate
      per sleeve.
- [ ] Netting router, built with the K5 exit sequence once two sleeves
      share an account.
- [ ] G0b Broker paper: one champion through the kernel [BLOCKED on
      K-exit + a B-gate pass + K-C2 for a C2 champion].
- [ ] G0-ops Daily summary, weekly replay, §6.2a drills on the live loop.
- [ ] G0-exit 30 clean G0b days + doc 10 §10.2 G0→G1 criteria + sign-off.

## Phase 5+ - live stages (not authorized)

- [ ] G1-J Jurisdiction evidence bundle for the constraint set (doc 10
      §10.1a).
- [ ] G1-P Port-on-promotion: champion signal in C++ + cross-language
      vectors.
- [ ] G1 G1_TINY manifest (C1: 1 liquid ETF, R × 0.25; C2: half the names at
      50% of target gross).
- [ ] G2 / G3 per doc 07 §7.7-7.8.
- [ ] Outside capital per doc 10 §10.6 (not authorized).
