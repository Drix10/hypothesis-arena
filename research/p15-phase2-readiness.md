# P1.5 + Phase 2 readiness review (reconciliation, no implementation)

Sources reconciled: frozen `plan/` stack, P1.1–P1.4 implementation + evidence,
`research/js-gap-analysis.md`. P1.4 evidence untouched. No Phase 2 code written.

## 1. Already implemented (do not rebuild)

- P1.1 freeze-check 39/39; P1.2 collector; P1.3 classify + hardening + corrective
  (19 tests); P1.4 ~33h/133-cycle evidence frozen with manifest + report.
- Secrets contract (root `.env` auto-load, fail-fast, hygiene check 7/7).
- Soak lifecycle hardening (persisted window, MISSED semantics).
- Doc 03 §3.6 partially done: 28 hand-worked cases green (20 re-run + 8 v3).

## 2. Specified but not implemented (the actual work ahead)

- **P1.5 ctx reader**: consume §8.5 bundles, enforce schema/R12/TTL/bounds,
  quarantine prose rows, map collector heartbeat vocab
  (`ok/EMPTY_SUCCESS/SKIPPED_CONFIG/...`) to state `source_status`
  (`healthy/stale/failed/not_scheduled/unavailable/na`) — mapping defined here:
  `ok`→healthy, `EMPTY_SUCCESS`→healthy, `STALE`→stale, `SOURCE_DOWN`→failed,
  `AUTH_FAILURE`/`RATE_LIMITED`→failed (with reason), `PARSE_FAILURE`→failed,
  `SKIPPED_CONFIG`→not_scheduled. Fixture bundles until Phase 2.5 emits real ones.
- **Phase 2 jev.py**: stdin state → 1 batched call → stdout + log row; Ed25519
  signing as `mirojev`; research_key/decision_key cache; 1 retry then HOLD;
  cost tags; AnswerSet logging (model/revision/provider/question/prompt/state/
  response hashes).
- **Phase 2 verification**: cache + failure-path tests, 200-state replay
  (distribution sane + decision determinism).
- Calibration harness, research plane, C++ core: specified, scheduled later.

## 3. Obsolete / revised (edited in this commit)

- 07 P1.4 "7-day soak" → closed at ~33h on evidence. 07 P1.3 wording
  (classify step, not write time). 02 §2.7 soak box → actual.

## 4. New requirements from the gap analysis (edited in this commit)

- Doc 11 §11.1: `outcome_source` vocabulary
  (EXOGENOUS / SELF_INFLUENCED / UNKNOWN) on every resolved outcome.
- Doc 08 §8.5: plausibility tier (entity binding, frozen-feed, session
  freshness) + `canonical_hash` lineage — both P1.5-enforced.
- Deferred to Phase-2/3 planning (noted, not yet specified): joint-error stress
  case (§3.7 case 29), regime/weighting treatment, evidence half-life.

## 5. Contradictions found: one, resolved above

- Collector heartbeat vocabulary vs state `source_status` vocabulary had no
  defined mapping. Mapped in §2 above; P1.5 must implement exactly this table.
- No other contradictions: spend tiers vs 5000/day ceiling, R-table vs decision
  table, boundary law vs digest design all consistent.

## 6. P1.5 implementation plan + acceptance tests

Build `collector/ctx_read.py` (stdlib only, read-only over classified/ +
fixture bundles):
1. Parse bundle (epoch/bundle_id/watermarks/feature list/BUNDLE_COMMIT);
   reject incomplete bundles (commit=false) entirely.
2. Per-feature: schema f2, bounds, R12 timestamps, TTL, plausibility tier
   (§8.5 new rules), lineage resolution against canonical.db.
3. Prose quarantine test: fixture bundle with smuggled `thesis_text` /
   narrative fields → rejected, counted, never emitted.
4. Heartbeat→source_status mapping table (§2 above), unit-tested all 8 inputs.
5. Emit `ctx_snapshot.json` (test fixture only — NOT features.jsonl; no producer
   exists until Phase 2.5) + rejection counters.
Acceptance: 10+ checks green; rejection rate alert (>5%/h) drilled;
freeze-check still PASS; no P1.4 evidence touched (read-only paths).

## 7. Phase 2 implementation plan (for authorization, not started)

`collector/jev.py` per §3.5 + §2 plan; needs human `OPENROUTER_API_KEY`
(2.1/2.2 still BLOCKED — the critical path). Verification per §3.6 boxes.
No code until authorized.

## 8. Blockers (human)

1. `OPENROUTER_API_KEY` — Phase 2 cannot run without it.
2. Review + authorize: this memo, then P1.5 build, then Phase 2 build.
