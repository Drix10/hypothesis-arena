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
- [ ] 2.1 [HUMAN] Obtain `OPENROUTER_API_KEY` — nothing in 2.2 can run without it
- [ ] 2.2 [BLOCKED] 2026-09-18: needs OPENROUTER_API_KEY in env (human skipped); then confirm Decisions endpoint + pin exact revision into doc 03
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
- [ ] P1.4 SOAKING: loop gated on MIRO_CONTACT (MISSING_REQUIRED_CONFIG exit 2). Still needs: real contact value on the soak host + 7-day host for --loop. Secrets contract DONE: .env.example + config/README.md + collector/config.py; history/tree audited clean; no OPENROUTER or other unused credentials introduced.
- [x] P1.4 acceptance automation DONE 2026-09-18: `soak_check.py` (6/6 objective checks: edgar-403, heartbeat vocab, replay determinism, future leakage, SQLite integrity, boundary) + `pregrade.py` (day-1: 40/40 auto_genuine, 0 ambiguous → zero human reviews needed today). Human work reduced to `data/soak/human-queue.jsonl` only. Both wired into soak daily cycle. No rules_v1 change.
- [ ] P1.4 7-day soak + noise grade (<10% off-topic)
- [ ] P1.5 Stub `ctx/` reader consumes bundle schema (§2.7 exit)
- [ ] Later: 10. Phase 2 JEV sidecar (v3 + Ed25519) → 11. Phase 2.5 research plane (bundle model, sandbox image) → 12. Phase 3 C++ core (adapters, protection, FSM) → 13. Phase 4 paper loop G0 → 14-16. G1/G2/G3 gates

## A. Agent orientation files (Phase-0, new)
- [x] A.1 DONE 2026-09-18: ARCHITECTURE.md (8 questions, MiroHedge-mapped) at root
- [x] A.2 DONE 2026-09-18: AGENTS.md session rules (read ARCH+00, TODO discipline, no secrets, fail closed) at root
- [x] A.3 DONE 2026-09-18: pi harness loads AGENTS.md every turn (human-confirmed)
