# 07 - Build Roadmap (the only to-do list)

Tracks run in parallel where marked; gates are never skipped. Paper only
until Phase 5 sign-off. `TODO.md` is the itemized ledger of this doc.
Finished work lives in git history, not here.

## 7.0 Where we are (verified 2026-10-02)

| Area | State |
|---|---|
| Plan | Freeze v4: the epistemic engine, ripple sleeves L1-L4, constraint sets C1/C2, validation `val_v2`. |
| Kernel | JEV filter built and gated (one candidate-bound contract, `contract = "jev"`). P3.5 slices A-G and H1 built: libcurl paper transport, WebSocket stream, R18/R19 (C1), candidate ingest, `g0_paper_loop`, kill inputs, early-close calendar. Live smoke passed on Alpaca paper. Remaining K boxes parked (§7.4). |
| Collector + plane | Collector built and soaked; six-node research graph, five Tier-A adapters and the source seam built and hosted-green. |
| Strategy harness | Trial ledger, `cost_v2`, settlement simulation, statistics (walk-forward, CPCV, PBO, DSR, MinTRL, bootstrap, HAC, pooled Holm), pre-registration validator, contamination guard, benchmarks, report generators. C1 only. |
| Sleeves | Five C1 sleeves failed their A-gates and run as forward ledgers (doc 02 §2.5). No champion. |
| G0 | G0-STAGE signed 2026-09-29. The paper loop runs the passive core as a plumbing test. G0b not started. |

Critical path:

```
A10 C2 harness ─→ A11 L4 ─────────────────────────────┐
A12 EDGAR corpus ─→ A13 MLG v0 ─→ A14 L1 V0 ───────────┤
A15 GDELT co-mentions ─→ L1 V1/V2 ─────────────────────┼─→ A-CP1 ─→ B-gate + K-C2
A16 L2 ────────────────────────────────────────────────┤
A17 events + ripple_det_v1 ────────────────────────────┘
P1/P2 reader tier ─→ A18 engine g3 (router, brain, verifier) ─→ L3 forward shadow
                  └→ A19 L1-ai (class B link extraction)
```

## 7.1 Decision rules at A-CP1 (after the L4, L1, L2 and twin A-gates)

1. **One or more passes:** the best passer (pre-registered primary metric;
   ties go to the simpler sleeve) starts its B-gate in G0a shadow at
   $25,000 under C2. K-C2 unblocks.
2. **None passes, and a sleeve meets the D2 trigger** (doc 09 §9.1b): buy
   D2 for that sleeve only, run its frozen spec once on the extended
   history, then apply rule 1 or 3.
3. **None passes, failures are economic:** recorded negative result. The
   book stays the passive core. L3 continues in forward shadow on its own
   clock; further search comes only from research-factory cards that name
   a new information set.

L3 is judged separately, at its own power-based minimum (doc 11 §11.3b:
on the order of 1,000 resolved candidates per arm after the brain's
cutoff + 30 days, about a year of forward shadow).

Trial budget before A-CP1: at most 12 new ledger trials (planned: L4 2,
L1 3, L2 2, `ripple_det_v1` 1, L1-ai 1). Exceeding it needs an
operator-approved entry in the sign-off log.

## 7.2 Track A - Alpha (critical path)

- [ ] A10 C2 harness (`research/strategy/`): short side and margin ledger
      (Reg T, maintenance, borrow, no short rebate, short dividends, margin
      interest), `cost_v3` (doc 14 §14.10), `constraint_set` and
      `contamination_class` in the pre-registration validator, $25,000 book
      with whole-share rounding, spanning test + FF5/momentum diagnostics in
      the A-gate report (`val_v2`), placebo-graph tool (doc 14 §14.7).
      Verify against Alpaca docs and the paper account: shorting on paper,
      `shortable`/`easy_to_borrow` flags, fractional shorts, paper balance
      setting.
- [ ] A11 L4 `tsmom_ls_v1`: pre-registration (`seen-window` label) and
      A-gate.
- [ ] A12 EDGAR corpus (D1): 10-K/10-Q/8-K full text with manifests,
      section parser, point-in-time CIK/ticker/former-name map, XBRL shares
      outstanding, 13F holdings, Ken French factors.
- [ ] A13 MLG v0 (doc 08 §8.2): bitemporal store; `sc` deterministic
      patterns with precision audit (200 labeled filings, ≥ 0.9); `tx`
      text peers; `ow` common ownership.
- [ ] A14 L1 `link_momentum_v1` V0: pre-registration and A-gate with the
      edge-validation report.
- [ ] A15 GDELT GKG co-mention pipeline with measured entity-resolution
      rate; L1 V1 and V2 pre-registrations and A-gates.
- [ ] A16 L2 `text_change_v1`: pre-registration and A-gate.
- [ ] A17 Event pipeline (doc 08 §8.3) on history; `ripple_det_v1`
      pre-registration and A-gate.
- [ ] A18 Engine g3 (doc 08 §8.4): router, hybrid retrieval, brain,
      verifier, f3 schema; L3 `ripple_event_v1` pre-registration; forward
      shadow starts on post-cutoff events [needs P1, P2].
- [ ] A19 L1-ai: reader-tier link extraction (class B), precision audit,
      paired test against V1 [needs P1].
- [ ] A20 `xcorr_v1` X corroboration test (doc 09 §9.1c): official-API
      adapter, bot filter, corroboration flag, pre-registration with power
      analysis; forward on `ripple_det_v1` candidates [BLOCKED on A17 and a
      D2 approval of the $50/month X budget].
- [ ] A-CP1 Apply §7.1 and record the decision in the sign-off log.
- [ ] D2 paid research dataset [BLOCKED on the doc 09 §9.1b trigger].
- Parked until A-CP1 (none changes whether the fund makes money first):
  A1 `baseline_v1` SIP rerun; A8 the `jev` filter paired test on
  surviving candidate streams; A9 S1 closure.

## 7.3 Track P - Engine plumbing (now feeds A18/A19)

- [ ] P1 Reader tier: capability-free model calls, capped JSON, span
      verifier, anonymization (doc 08 §8.2a, §8.5).
- [ ] P2 Role pins (reader, router, brain, verifier) with knowledge
      cutoffs; post-cutoff bake-off per role (doc 08 §8.10).
- [ ] P3 Research factory v1 (doc 08 §8.9).
- [ ] P4 Remaining doc 08 §8.8 and doc 09 §9.4 boxes.

## 7.4 Track K - Kernel (parked until A-CP1; only defects that break the paper loop are fixed)

- [ ] K1 MOC fill and reconcile smoke with a held position.
- [ ] K5 stop-cancel-before-close router change + mock drill.
- [ ] K9 24 h soak on the real transport.
- [ ] K10 doc 06 §6.2a drills on live paper.
- [ ] K-C2 C2 account path in the kernel (doc 13 §13.8) [BLOCKED on an
      A-CP1 pass].
- [ ] Exit: K1, K5, K10 green → P3.5 closed.

## 7.5 Phase 4 - G0_PAPER

- [ ] G0a shadow: every A-gate passer runs on live data with harness fills
      under its constraint set, on the forward-ledger machinery extended
      for C2 (doc 11 §11.2a); B-gate per doc 11 §11.3a.
- [ ] Forward ledgers (appendix 10) keep running for the retired sleeves;
      research observation only.
- [ ] G0b broker paper: one champion through the kernel (P3.5 closed +
      B-gate passed + K-C2 if the champion is C2).
- [ ] Daily summaries + weekly replay checks running.
- [ ] Every §6.2a outage row drilled on the live paper loop.
- [ ] AI spend within the G0 cap; cost per closed trade reported.
- [ ] 30 clean G0b days, zero R-rule violations, no unplanned human
      intervention; champion tracking within its band.
- [ ] Exit: doc 10 §10.2 G0 → G1 criteria + human sign-off below.

## 7.6 Phase 5 - G1_TINY (explicit decision, not automatic)

- [ ] Jurisdiction gate evidence for the constraint set (doc 10 §10.1a).
- [ ] Port-on-promotion: champion signal in C++ with cross-language
      vectors (doc 04).
- [ ] Human signs the G1 PROMOTION_MANIFEST with the process stopped.
- [ ] C1: 1 liquid US ETF, R × 0.25. C2: half the names at 50% of target
      gross. Daily human review.
- [ ] Realized shortfall tracked against the cost model.
- [ ] Any R-trip → automatic demotion to G0.
- [ ] Exit: doc 10 §10.2 G1 → G2 criteria + human signature.

## 7.7 Phase 6 - G2_SCALED

- [ ] Universe-cap and netting-router change if multi-sleeve live is
      justified.
- [ ] Checkpoint store moved to Postgres; challengers in shadow.
- [ ] The 20% AI-spend ratio test active and passing for 30 days.
- [ ] Exit: doc 10 §10.2 G2 → G3 criteria (60 days, ≥ 100 closed trades,
      max DD < 5%) + human signature.

## 7.8 Phase 7 - G3_FULL

- [ ] Full stage limits per doc 05.
- [ ] 30 consecutive days with zero required human intervention; every
      intervention logged with its cause.
- [ ] Ongoing: weekly sleeve review, promotion gate for any change.

## 7.9 Phase 8 - Outside capital (not authorized)

- [ ] Doc 10 §10.6 path, starting no earlier than a live G3 record, with
      US counsel. A plan amendment comes first.

## Distraction firewall

- HFT / sub-second news trading: doc 01 §1.4. Not this fund.
- Options, futures, FX, leveraged/inverse ETFs, crypto: out of scope in
  both constraint sets.
- New venue: not before G2; doc 01 paragraph + jurisdiction gate.
- Paid data: only on the doc 09 §9.1b trigger.
- Social media as a trigger: never alone (doc 09 Tier C).
- A model that sizes, prices or places an order: no. The brain proposes
  typed hypotheses; deterministic code does the rest.
- A sleeve outside doc 02 before A-CP1: no. New ideas are research-factory
  cards.
- New indicator / sleeve tweak: new pre-registration, counted in the trial
  ledger.
- Kernel or ops work before A-CP1: only a defect that breaks the running
  paper loop (doc 06 AUDIT STOP RULE).
- Fine-tuning models: shadow only, never with live capital.
- New JEV question: version bump + fresh hand-worked cases.
- A manual trade: no. The journal is the trader.
- Raising the stage early: criteria are necessary, never sufficient.
- Skipping the controls or the deterministic twin: never.
- Outside money before §7.9: no.

## Sign-off log

Each entry: what, who, date, manifest/attest hash or window where relevant.

Approvals are given by the operator in chat. The agent records each one here
(what, date, "approved in chat") and never asks the operator to edit or sign a
document. The STAGE file is separate: only `scripts/sign-stage.sh` writes it
(doc 10 §10.1).

Promotion sign-off template (copy per promotion; all lines required):

```
PROMOTION: <G0→G1 | G1→G2 | G2→G3 | sleeve <id> to champion | AI component on <sleeve>>
DECIDED BY: <operator, approved in chat>   DATE: <ISO8601>   WINDOW JUDGED: <dates>
CONSTRAINT SET: <C1 | C2>
CRITERIA (doc 10 §10.2 / doc 11 §11.3a-b - every box true, evidence linked):
  [ ] sleeve gate passed (A-gate + B-gate reports, trial-ledger ids)
  [ ] clean-day count  [ ] zero R-violations  [ ] determinism green
  [ ] beats cash + positive spanning alpha + beats its deterministic twin, net, 2× stress
  [ ] transferability: evidence produced under the manifest's constraint set
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
- Kernel and ops hardening stopped; P3.5 remainder parked until a sleeve passes A-CP1 | operator, in chat | 2026-10-02
- Target constraint set C2 (US margin, long and short, gross capped); paper only until the operator is US-resident | operator, in chat | 2026-10-02
- First live capital expected under $25,000 | operator, in chat | 2026-10-02
- Data: free first, paid research data later on a measured trigger | operator, in chat | 2026-10-02
- Sleeve gate form delegated ("whatever is best according to our goal"); chosen: spanning test against the reference book, `val_v2` | operator, in chat | 2026-10-02
- Freeze v4 direction: follow the epistemic-arbitrage blueprint (linked-firm ripples, knowledge graph, LLM ripple reasoning with deterministic execution); rewrite the plan without layered old text | operator, in chat | 2026-10-02
- Freeze v4 plan text approved ("ok for all the changes in the plan docs"); deep re-verification pass ordered | operator, in chat | 2026-10-02
- Appendix-driven edits, `xcorr_v1` X corroboration test with bot filter, and a docs-only commit of freeze v4 ("Go.") | operator, in chat | 2026-10-03
