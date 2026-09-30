# 07 — Build Roadmap (the only to-do list, freeze v3)

Tracks run in parallel where marked; gates never get skipped. Paper only
until Phase 5 sign-off. `TODO.md` is the itemized ledger of this doc; the
freeze-v2 ledger is in git history.

## 7.0 Where we are (2026-09-28, verified against the repo)

| Area | State |
|---|---|
| Phase 0 spec | Freeze v2 signed 2026-09-18. **Freeze v3 rebaseline** written 2026-09-28 under operator instruction; approved by the operator in chat 2026-09-29 (sign-off log). |
| Phase 1 collector | Built and soaked (133 cycles); §2.7-equivalent boxes in doc 09 §9.4 open. |
| Phase 2 JEV sidecar | ACCEPTED/FROZEN `50ea369`; contract = "jev" (candidate-bound; one contract across sidecar, evaluator and kernel filter). |
| Phase 2.5 research plane | Six-node graph + five Tier-A adapters + seam built and hosted-green; doc 08 §8.6 exit open. |
| Phase 3 kernel | JEV filter built and gated; P3.5 slices A–G done; **H1 router/runner/broker/journal built and audited (router 209, runner ~1045, broker 126, drills 120) but `transport = nullptr` — no order has ever left the host.** |
| Strategy track | S1 landed (PIT single-stock universe item open); S2 measured NEGATIVE, acceptance open; S3/S4 released; S5 implementation closed, economics open (stub FAIL); S6 released (isolated library); S7-A/B closed; S7-C re-audit #2 fixes at `f0815e7`, closure needs hosted 5/5. |
| G0 | NOT STARTED. No sleeve has passed any economic gate. |

Critical path to paper trading (why the order below):
`A0 harness v2 → A2 T1 A-gate → G0a shadow starts` runs in parallel with
`K1 transport → K2 always-take → K3/K4 settlement + R18/R19 → K5 OTO/MOC
→ K6 candidate ingest → K7 alerts`. G0b starts when both meet: a sleeve
passed its B-gate AND P3.5 closed.

## 7.1 Phase R — Rebaseline (docs only; this change)

- [x] Full critique recorded (git history).
- [x] Docs 00–13 + manifest rewritten for freeze v3; implementation
      records moved verbatim to `appendix/`.
- [x] Operator approved the freeze-v3 text in chat, 2026-09-29 (sign-off log below).

## 7.2 Track A — Alpha (critical path)

- [ ] A0 Research harness v2 (`research/strategy/`): global trial ledger
      (doc 11 §11.0a); `cost_v2` (doc 06 §6.0a); SIP bars+quotes fetcher
      with dataset manifests; pre-registration template + validator;
      statistics module (walk-forward with purge/embargo, CPCV, PBO, DSR,
      MinTRL, stationary-bootstrap CIs, pooled Holm); contamination guard
      (doc 11 §11.0c); benchmark set (doc 12 §12.6); report generator.
- [ ] A1 S2 closure: rerun `baseline_v1` on SIP bars + quotes so the
      primary (spread-eligible) ledger exists; record the result as the
      negative control with the exit/horizon diagnosis (doc 12 §12.7).
      The FX leg is dropped (forex is research-only, doc 01 §1.2).
- [ ] A2 T1 `trend_etf_v1`: pre-registration committed → A-gate report.
- [ ] A3 I1 `intraday_mom_v1`: pre-registration → A-gate (2× cost decisive).
- [ ] A4 E1 `insider_buy_v1`: Form 4 parser + pre-registration → A-gate.
- [ ] A5 T2 `sector_mom_v1`: pre-registration → A-gate.
- [ ] A6 E2 `earnings_reader_v1`: E2-det A-gate on history; E2-ai paired
      forward shadow design (needs P2 reader tier).
- [ ] A7 M1 overlay tested on every sleeve that passed A-gate.
- [ ] A8 S5 re-scoped: the paired always-take vs `jev` test runs on
      the candidate streams of sleeves that passed A-gate, with real JEV
      answers generated only for post-cutoff events. S5 is the gate for
      `filter = jev`, not a G0 blocker.
- [ ] A9 S1 closure: the PIT single-stock S&P-500 universe artifact is not
      freely available; S1 closes with ETF and EDGAR-derived universes and
      the limitation recorded (doc 12 §12.1).

## 7.3 Track K — Kernel P3.5 remainder (parallel with A)

- [ ] K1 P3.5-T transport: decision record (libcurl+TLS in-kernel vs
      `mirotrade` broker gateway) + implementation behind the existing
      seam + fail-closed tests + Alpaca paper smoke (doc 04 5b).
- [ ] K2 Always-take path (doc 04 4b) with equivalence + no-AnswerSet gates.
- [ ] K3 Settlement ledger + Snapshot v2 contract + committed vectors.
- [ ] K4 R18/R19 in `risk/veto.cpp`; allowlist from the stage manifest;
      existing Slice-B verdicts bit-identical.
- [ ] K5 OTO stop-only protection shape + MOC exit sequencing (doc 06 §6.0).
- [ ] K6 `ingest/candidates.cpp` (CID recompute, sleeve approval,
      allowlist, freshness, long-only side policy).
- [ ] K7 Outbound-only alert adapter (doc 06 §6.4).
- [ ] K8 Live journal growth bound (tracked non-blocker becomes a G0b
      box: bounded load, chain continuity preserved).
- [ ] K9 Slice F 24 h feed soak on the real transport.
- [ ] K10 H1 drills re-run against Alpaca paper through the real
      transport (every doc 06 §6.2a row, exits alive).
- [ ] Exit: K1–K7 + K10 green → P3.5 CLOSED (doc 13).

## 7.4 Track P — Research plane (parallel)

- [ ] P1 Reader-tier refactor: `extract` no longer runs a CodeAgent on
      untrusted text; reader tier (no tools/network, capped JSON) +
      deterministic resolver/verifier (doc 08 §8.3).
- [ ] P2 E2 reader skill + schema + verifier, pinned (model, revision,
      cutoff, skill hash).
- [ ] P3 Research factory v1 (doc 08 §8.7): offline, trusted data only,
      trial-ledgered, human-triaged proposals.
- [ ] P4 Remaining doc 08 §8.6 + doc 09 §9.4 boxes (7-day unattended run,
      Langfuse attribution day, p50/p99 per Tier-A source, ALFRED replay).
- [ ] P5 S6 `event_direction_v1` production integration only via the
      doc 11 promotion path (unchanged; not on the critical path).

## 7.5 Track O — Ops, CI, hygiene (parallel, small)

- [ ] O1 CI runs on every push + `workflow_dispatch`; strategy tests
      (`test_baseline`, `test_candidate` with pinned pytest, `test_jev_filter`)
      and `kernel/tests/test_jev_filter.cpp` join CI (S4 governance amendment).
- [ ] O2 Secret scanning: pinned gitleaks job + pre-commit hook.
- [ ] O3 freeze-check v3 alignment: rename doc 02 file to
      `02-strategy-book.md`, manifest v3 keys verified, root/xxd guards.
- [ ] O4 S7-C closure: hosted 5/5 on the head carrying `f0815e7`.
- [ ] O5 S7 closure: G1 venue amendment is this rebaseline (Alpaca,
      one liquid ETF, cash/long-only); capital-aware caps unchanged.
- [ ] O6 [HUMAN] Rotate every credential shared in chat on 2026-09-28
      (OpenRouter, FRED, BEA, Alpaca paper) and re-seed `.env` locally.

## 7.6 Phase 4 — Paper at G0_PAPER

- [ ] G0a shadow: every sleeve that passed A-gate runs on live data with
      harness fills (`cost_v2`), no broker orders, from the day it passes.
      B-gate per sleeve per doc 11 §11.3a.
- [ ] Forward replication ledgers (`ops/sleeve_shadow.py`, doc 11 §11.2a,
      appendix 10): every built sleeve plus controls, registered in the trial
      ledger first, judged paired against benchmarks; research observation
      only until a sleeve passes its A-gate. As of 2026-09-30 none has.
- [ ] G0b broker paper: exactly one champion sleeve through the kernel on
      Alpaca paper (P3.5 closed + sleeve passed B-gate + G0 STAGE file
      signed per doc 10 §10.5).
- [ ] Daily summaries + weekly replay checks running.
- [ ] Every §6.2a outage row drilled on the live paper loop.
- [ ] AI spend within the G0 absolute cap; cost per closed trade reported.
- [ ] 30 clean G0b days, zero R-rule violations, no unplanned human
      intervention; champion tracking within its pre-registered band.
- [ ] Exit: G0 → G1 criteria in doc 10 §10.2 met **and** human sign-off
      recorded below (name + date + manifest hash).

## 7.7 Phase 5 — G1_TINY (explicit decision, not automatic)

- [ ] LIVE JURISDICTION GATE evidence complete (doc 10 §10.1a).
- [ ] Port-on-promotion: champion signal in C++ with cross-language
      vectors (doc 04).
- [ ] Human signs the G1 PROMOTION_MANIFEST with the process stopped.
- [ ] 1 liquid US ETF, R-multiplier 0.25, 1×, cash, daily human review.
- [ ] Realized shortfall tracked against `cost_v2`.
- [ ] Any R-trip → automatic demotion to G0. No negotiation.
- [ ] Exit: doc 10 §10.2 G1 → G2 criteria + human signature.

## 7.8 Phase 6 — G2_SCALED

- [ ] Universe-cap versioned change if multi-sleeve live is justified.
- [ ] Checkpoint store moved to Postgres; challengers in shadow.
- [ ] The 20% AI-spend ratio test active and passing for 30 days.
- [ ] ≤ 3 symbols, R-multiplier 0.5, weekly review.
- [ ] Exit: doc 10 §10.2 G2 → G3 criteria (60 days, ≥ 100 closed trades,
      max DD < 5%) + human signature.

## 7.9 Phase 7 — G3_FULL

- [ ] Full stage limits per doc 05.
- [ ] 30 consecutive days with zero *required* human intervention (weekly
      review continues as post-hoc inspection); every intervention that
      did occur logged with its cause.
- [ ] Ongoing: weekly sleeve review, promotion gate for any change.

## 7.10 History (closed phases, kept for the record)

- Phase 0 — spec frozen at freeze v2 (signed `2dc8cbd`, reconciled
  `50d88a7`); X removed from production v1; JEV v3 semantics frozen
  (4 questions; now the single candidate-bound `contract = "jev"`).
- Phase 1 — P1.1 freeze-check, P1.2 collector, P1.3 TRIGGER/CONTEXT
  tagging, P1.4 soak (133 cycles, shortened on evidence), P1.5 ctx reader.
- Phase 2 — JEV sidecar accepted/frozen `50ea369`.
- Phase 3 — JEV filter (confidence quarantined); P3.5 slices A–G; H1 built
  (doc 13).
- Strategy Validation Track S1–S7 — see §7.0 and the archive ledger.

## Distraction firewall (read when tempted)

- HFT / sub-second news trading? → Doc 01 §1.4. Needs a legal entity, DMA,
  paid feeds, colocation. Not this fund.
- Forex, shorting, margin, options, leveraged ETFs live? → Illegal or
  out of scope for the operator (doc 01 §1.2). Research shadow only.
- New venue? → After Phase 5, one paragraph in doc 01, jurisdiction gate.
- Paid data? → Core stays free. A paid source is a doc 09 amendment with a
  measured incremental-edge case, funded from G2+ profit only.
- New indicator / sleeve tweak? → New pre-registration, counted in the
  trial ledger. One in, one out.
- Fine-tuning models? → Shadow only, never with live capital in v1.
- New JEV question? → Version bump + fresh hand-worked cases.
- "Just one manual trade"? → No. The journal is the trader now.
- "One more hardening round"? → Doc 06 AUDIT STOP RULE + alpha-first.
- New agent framework? → Doc 08 §8.2 ranking; reopen only with a
  measured reason.
- "The bot is doing well, raise the stage early"? → Criteria are
  necessary, never sufficient; the manifest is signed with the process
  stopped.
- "Skip the controls, they're obviously worse"? → Then they cost nothing
  to run, and they are the only thing that can prove the AI is adding
  value.

## Sign-off log

Each entry: phase or stage, name, date, manifest/attest hash, window judged.

Approvals are given by the operator in chat. The agent records each one here
(what, date, "approved in chat") and never asks the operator to edit or sign a
document. The STAGE file is separate: only `scripts/sign-stage.sh` writes it
(doc 10 §10.1).

Promotion sign-off template (copy per promotion; all lines required):

```
PROMOTION: <G0→G1 | G1→G2 | G2→G3 | sleeve <id> to champion | filter jev on <sleeve>>
DECIDED BY: <operator, approved in chat>   DATE: <ISO8601>   WINDOW JUDGED: <dates>
CRITERIA (doc 10 §10.2 / doc 11 §11.3 — every box true, evidence linked):
  [ ] sleeve gate passed (A-gate + B-gate reports, trial-ledger ids)
  [ ] clean-day count  [ ] zero R-violations  [ ] determinism green
  [ ] beats cash + vol-matched passive + no-AI variant, net, 2× stress
  [ ] transferability: evidence produced under the live constraint set
  [ ] spend in cap (+ ratio if G2+)  [ ] drills (kill/reconcile/isolation)
  [ ] jurisdiction gate evidence attached (G1+)
PROCESS: stopped before signing, swapped after; versions bumped; fresh
  paper window opened (no inherited stage).
MANIFEST HASH: <sha256>
```

- Phase 0 freeze | Drix10 | 2026-09-18 | plan frozen; G0 STAGE + keys at build; Phase 1 unblocked
- Phase 0 freeze v2 signed off. Bucket 1 complete; JEV v3 semantics frozen; X removed from production v1; Phase 1 unblocked. | Drix10 | 2026-09-18
- Freeze v3 rebaseline authorized by operator instruction ("full permission to rewrite plans and code; plan first") | 2026-09-28 | text committed
- Freeze v3 text approved | operator, in chat | 2026-09-29
- Single JEV contract (candidate-bound; v3 sidecar path retired, plain names) | operator, in chat | 2026-09-29
- Sleeve testing program (appendix 10 rev 2: four evidence tracks, forward replication ledgers, long-history track L) | operator, in chat | 2026-09-30
