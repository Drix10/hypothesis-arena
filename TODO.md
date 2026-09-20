# MiroHedge Phase 0 TODO (freeze v2, 2026-09-18: Bucket-1 repairs, X out of v1, JEV v3)

Legend: `[B]` needs real-browser control (X login, JS pages, portals) · `[W]` normal web search · `[H]` human action · `[D]` doc edit in `plan/`

## 0. Housekeeping
- [x] 0.1 Plan docs frozen-consistent (00-11 + README), pushed to main
- [x] 0.2 DONE 2026-09-18: Phase 0 closed at freeze v2 (Drix10 sign-off, doc 07 log); Phase 1/P1.1 unblocked

## 1. X-Lists research (HISTORY — X out of v1 production per doc 02 §2.6; kept for the record)
- [x] 1.1 DONE 2026-09-18: recovered 55-ID folders table from old MVP config; ~46 Scobleizer AI/tech lists, all live
- [x] 1.2 DONE 2026-09-18: no reusable public macro list IDs exist; TRIGGER coverage = 6-account roster, all verified live
- [x] 1.3 DONE 2026-09-18: 55/55 live, 0 dead, all active; evidence in sign-off log
- [ ] 1.4 DEFERRED to Phase-1 soak: top posters recorded empirically by the sidecar, not by hand
- [x] 1.5 DONE 2026-09-18: self-hosted twikit-rss selected (MIT, list+user endpoints, no X API key); credential placement = Phase-1 item
- [x] 1.6 DONE 2026-09-18, REVISED per user: finance-first universe in 02 §2.4 — 9 finance TRIGGER lists + 6-account roster + 13 market-moving AI/tech CONTEXT; ~40 non-moving IDs dropped from polling (on record in history)
- [x] 1.7 SUPERSEDED 2026-09-18: self-hosted transport has no third-party mirror to fall short; TRIGGER = account roster, throttled only by X frontend rate limits (Phase-1 soak measures)

## 2. Decision-layer proof (doc 03)
- [x] 2.1 DONE 2026-09-18/20: OPENROUTER_API_KEY obtained in env (local, never committed); Phase-0 verification green at `1730acc`.
- [x] 2.2 DONE: Decisions endpoint `POST /api/alpha/decisions` confirmed; revision `typesafe/jev-1.13-20260917`, provider `TypeSafe` pinned into doc 03. (Historical; Phase 2 subsequently accepted/frozen at `50ea369`.)
- [x] 2.3 DONE, RE-RUN 2026-09-18 (freeze v2): 20 v2 cases green under v3 table + 8 new v3 semantic cases (21–28) in doc 03 §3.7

## 3. Venues (doc 01)
- [x] 3.1 DONE 2026-09-18: OANDA v20 practice primary, FXCM demo fallback (REST + streaming, free demo, same shape as live)
- [x] 3.2 DONE 2026-09-18: Alpaca paper primary (free, live-price sim, REST + WS, resettable, no deposit)
- [x] 3.3 DONE 2026-09-18: exchange/broker calendars (fail-closed) + FRED/ALFRED + Fed/ECB pages + EDGAR-derived earnings; all free
- [x] 3.4 DONE 2026-09-18: venue names LOCKED in doc 01 ([HUMAN] ACCEPTED)

## 4. Research-plane freeze (doc 08)
- [x] 4.1 DONE 2026-09-18 ([HUMAN] ACCEPTED): langgraph==1.1.6, smolagents==1.26.0, langfuse==4.15.4 (self-hosted); installability verified at build
- [x] 4.2 DONE 2026-09-18 ([HUMAN] ACCEPTED): versions in 08 locked decisions; six-node topology + failure defaults already in 08 §8.3; checkpoint store SQLite(G0/G1)->Postgres(G2+) unchanged
- [x] 4.3 DONE 2026-09-18: exact import allowlist + 3-user OS design (mirotrade/miroresearch/mirohuman) locked in 08 §8.2
- [x] 4.4 DONE 2026-09-18, CORRECTED (reconciliation): features.jsonl schema f2 (§8.5) + R15 table (§8.4) confirmed frozen, no changes needed

## 5. Sources classification (doc 09)
- [x] 5.1 DONE 2026-09-18: Tier tables + finance-first X universe (doc 02 §2.4) leave no blanks; every source has class + failure default
- [ ] 5.2 [HUMAN] Obtain free keys: FRED (signup, 1 key), NASA FIRMS (email token); AISStream/TomTom only if used — say which you want
- [x] 5.3 DONE 2026-09-18: EDGAR UA + 10 req/s ceiling locked in 09 §9.2
- [x] 5.4 DONE 2026-09-18: §9.3 heartbeat (>3x cadence = stale) + per-tier failure defaults in §9.1 table; calendar fail-closed
- [x] 5.5 DONE 2026-09-18: ALFRED vintages for replay (locked in 01); Tier D bar + lessons.jsonl already in 09 §9.1/§9.4

## 6. Capital / kill / spend (doc 10)
- [x] 6.1 DONE 2026-09-18: STAGE format + chain frozen in text (pipe-delimited hash, GENESIS, G0 capital 0, alert = alerts.jsonl); [HUMAN] create + sign the G0 file at build per §10.5 steps
- [x] 6.2 DONE 2026-09-18: stage numbers, promotion criteria (necessary-never-sufficient), demotion table, UTC-day rule — all frozen in §10.2
- [x] 6.3 DONE 2026-09-18: SOFT/MEDIUM/HARD (§10.3) + caps/ratio/tiers/anti-flap (§10.4) frozen; §10.5 drills stay build-time boxes

## 7. Calibration + risk constants (docs 11, 05)
- [x] 7.1 DONE 2026-09-18: resolution table (§11.1), base-rate + R13 (§11.1), non-LLM baseline (§11.3), promotion sign-off template (07 log)
- [x] 7.2 DONE 2026-09-18: R1–R9 literals + §5.1a methods + paper fill rule (06 Locked) frozen; R10–R17 as constants; owners = ARCHITECTURE §2/§7

## 8. Freeze sign-off (doc 07)
- [x] 8.1 DONE 2026-09-18 (freeze v2): zero TBDs outside "tune later"; opens = 1.4 deferred, 2.1/2.2 BLOCKED (not needed for Phase 1), 5.2 human-side (not needed for Phase 1 start), 6.1 build-time human step
- [x] 8.2 DONE 2026-09-18: Drix10 signed Phase 0 freeze v2 in doc 07 log — "Bucket 1 complete; JEV v3 semantics frozen; X removed from production v1; Phase 1 unblocked"; Phase 1/P1.1 may begin on human start

## 9+. Build phases
### Phase 1 start checklist (unblocked, non-X sources, no code until human says start)
- [x] P1.1 DONE 2026-09-18: `scripts/freeze-check.sh` 39/39 PASS (human ruling (a): `research_graph_version: g1` declared in doc 08 §8.3; manifest untouched, no version bump, Phase 0 stays closed)
- [x] P1.2 DONE 2026-09-18: core collector complete (`collector/collect.py` stdlib-only, 5 keyless pollers live, session calendar seed); FRED adapter implemented but key-gated (`SKIPPED_CONFIG`, not failure)
- [x] P1.3 FROZEN 2026-09-18: corrective commit (future-check first, canonical effective_at 5-tuple, EDGAR-only amendment contract + unlinked CONTEXT, pinned REF + audit as_of). 19 checks pass; 105-baseline identical (40/42/23). P1.4 may begin.
- [x] P1.4 CLOSED 2026-09-20 (~33h, 133 cycles, 0x403, 7/7 acceptance, 0% pre-grade noise). Evidence frozen (collector/SOAK_MANIFEST.json, 23 files hashed). Report: collector/SOAK_REPORT.md. Shortened 7d->~33h recorded explicitly.
- [x] POST-SOAK LIFECYCLE HARDENING DONE: persisted window.json (restarts never extend), MISSED-cycle semantics (recorded, never backfilled), cwd-independent restart verified, evidence idempotency verified.
- [x] JANE STREET GAP ANALYSIS DONE: research/js-gap-analysis.md (4 satisfied, 3 specified-but-unimplemented, 5 genuinely missing incl. plausibility tier + self-influenced outcome tagging).
- [x] P1.5 DONE: collector/ctx_read.py (f2 bundles, R12/TTL, prose quarantine, heartbeat map, plausibility_v1, lineage) + entity_map.json (entity-v1) + test_ctx.py (16 checks green). Contract fixes pre-coding: canonical_hash in f2 schema + combination rule; conviction nominates/never authorizes 2xR (engine decides); exact plausibility (FROZEN_N=3, pinned map, overnight allowlist); Phase-0 key+endpoint+revision gate.
- [x] P1.5 HARDENING DONE (review-driven): map-sha256 watermarks, entity_ref contradiction, dated-history time-cover, allowlist+hash-format, inference-never-trigger test. 26/26 ctx checks; full suite + freeze green; evidence pristine.
- [x] P1.5 CORRECTION-2 DONE: explicit nominal covers (45m/3h/18h, >=50% span, per-family tests), bundle-vs-feature ownership split + doc round-trip, nested type validation (symbols/timestamps/entity_ref/value shapes, unique hashes). 40+ ctx checks; evidence pristine.
- [x] P1.5 DEFENSIVE-SCHEMA DONE: bool-is-not-int, entity_ref exactly {cik:str}, primitive-first ordering (no TypeError possible), ingested/provenance types, value fail-closed, empty symbols. 55 ctx checks; evidence pristine. P1.5 semantics frozen here.
- [x] P1.5 EXCEPTION-SAFETY DONE: entity_ref/vtype/bundle guards, dated-history shape, JEVAnswerSetV3 contract locked in doc 03 (C++ owns decisions, adapter owns slowness, replay never calls provider). 69 ctx checks; evidence pristine. P1.5 FROZEN. Phase 2 AUTHORIZED (all gates green incl. OpenRouter verification).
- [x] PHASE 2 ACCEPTED/FROZEN at 50ea369 (attempt-counted ceiling, true rolling-30d, invalid-stage fail-closed; 49 checks). Spend interpretation ratified with corrections. Confidence-null omission ratified.
- [x] PHASE 3 STARTED: plan/13-cpp-kernel-build.md.
- [x] P3.2 DONE: committed interop vectors (v1 genuine + v2 stress) + 37-check C++ suite, normal+hardened green; contract frozen in plan/13.2 (signature scope corrected to payload-only); one parser correction (DBL_MAX finite cap) with P3.1 re-verified 102/102. Sidecar untouched. P3.3/P3.4/P3.5 pending.
- [x] P3.1 DONE: kernel boundary validator, 39 checks, sidecar untouched.
- [x] P3.1 CORRECTION DONE: 17 review findings closed (epoch monotonicity, decision-key recompute 0/300 mismatches, universe, confidence quarantine, RFC decode, bounds, dup-keys, timestamps, no-atoll, thread-safe init, repr floats, ed vectors, 96 checks + 20k fuzz normal/hardened). Sidecar byte-identical, P3.2 not started.
- [x] P3.1 X0-FIX DONE: recovered-x==0/sign rejection (y=0/sign=1 valid, y=1/sign=1 invalid, identity round-trip), OpenSSL 3.2 cross-vectors, Ed25519 policy frozen in plan/13, secondaries recorded. 102 checks + 20k fuzz normal/hardened.
- [x] P3.1 ACCEPTED/FROZEN at dcd44d4 (human review: x0 blocker correctly fixed, 102/102 + 20k fuzz normal/hardened, policy frozen, secondaries carried to P3.2/P3.3). NO further P3.1 changes.
- [x] PHASE 2 DONE: collector/jev.py (v3 batch, pinned revision/provider, RFC8032-Ed25519 sign/verify proven vs independent oracle incl. real clamp-bit253 bug found+fixed, research/decision cache, retry-once-HOLD, spend ceiling, zero-network replay). 40+ JEV checks; authority boundary tested (no size/budget fields). Awaiting human diff review.
- [x] NEXT (historical): Phase-0 OpenRouter verification is DONE (`1730acc`); Phase 2 jev.py was authorized on that basis and is now ACCEPTED/FROZEN (`50ea369`). No open verification item remains.
- [ ] POST-SOAK HARDENING (do NOT touch until P1.4 window closes + report signed) | POST-SOAK RESEARCH (same gate): Jane Street public-material gap analysis. Study real-world ML, market-data architecture, replayability, risk computation, battle-testing/chaos, model evaluation. Map concrete lessons onto our architecture; no blind copying, NO code changes. Deliverable: gap analysis (principles already satisfied / specified-but-unimplemented / genuinely missing), prioritized by statistical validity, data integrity, execution correctness, portfolio risk, operational reliability. Tier-1 reads: real-world ML pt1, tested-to-battle-tested, ML overview, market-data teach-in, Datafetcher.: persist explicit observation-window start/end (e.g. data/soak/window.json on first launch; restarts must read, never extend the 7-day deadline); document missed-cycle semantics for interruption during the 15-min wait; verify restart is cwd-independent; verify restart cannot corrupt/duplicate evidence (SQLite PK idempotency, append-only logs). No rules_v1 or active-soak changes. Secrets contract DONE: .env.example (docs in header) + root .env (untracked) + collector/config.py; history/tree audited clean; no OPENROUTER or other unused credentials introduced.
- [x] P1.4 acceptance automation DONE 2026-09-18: `soak_check.py` (6/6 objective checks: edgar-403, heartbeat vocab, replay determinism, future leakage, SQLite integrity, boundary) + `pregrade.py` (day-1: 40/40 auto_genuine, 0 ambiguous → zero human reviews needed today). Human work reduced to `data/soak/human-queue.jsonl` only. Both wired into soak daily cycle. No rules_v1 change.
- [x] P1.4 CLOSED (shortened): ~33h / 133 cycles, 0x403, 7/7 acceptance, 0% pre-grade noise (see collector/SOAK_REPORT.md + SOAK_MANIFEST.json). The original 7-day target was closed on this evidence; NOT a 7-day run.
- [x] P1.5 DONE (stub superseded): `collector/ctx_read.py` (f2, R12/TTL, prose quarantine, entity-v1, FROZEN_N=3, canonical_hash); 69 ctx checks; P1.5 FROZEN.
- [ ] Later: 11. Phase 2.5 research plane (bundle model, sandbox image) → 12. Phase 3 C++ core cont. (P3.2 authorized next, then P3.3/P3.4/P3.5) → 13. Phase 4 paper loop G0 → 14-16. G1/G2/G3 gates. (10. Phase 2 JEV sidecar DONE, accepted/frozen `50ea369`.)

## A. Agent orientation files (Phase-0, new)
- [x] A.1 DONE 2026-09-18: ARCHITECTURE.md (8 questions, MiroHedge-mapped) at root
- [x] A.2 DONE 2026-09-18: AGENTS.md session rules (read ARCH+00, TODO discipline, no secrets, fail closed) at root
- [x] A.3 DONE 2026-09-18: pi harness loads AGENTS.md every turn (human-confirmed)
