# MiroHedge Phase 0 TODO (0 to done)

Legend: `[B]` needs real-browser control (X login, JS pages, portals) · `[W]` normal web search · `[H]` human action · `[D]` doc edit in `plan/`

## 0. Housekeeping
- [x] 0.1 Plan docs frozen-consistent (00-11 + README), pushed to main
- [ ] 0.2 This TODO tracked to zero; every box below checked or explicitly deferred with reason

## 1. X-Lists research (our lists are AI/tech mostly)
- [x] 1.1 DONE 2026-09-18: recovered 55-ID folders table from old MVP config; ~46 Scobleizer AI/tech lists, all live
- [x] 1.2 DONE 2026-09-18: no reusable public macro list IDs exist; TRIGGER coverage = 6-account roster, all verified live
- [x] 1.3 DONE 2026-09-18: 55/55 live, 0 dead, all active; evidence in sign-off log
- [ ] 1.4 [B/W] For each live list: note top 10 recurring posters (keywords, not handles, for the doc table)
- [x] 1.5 DONE 2026-09-18: self-hosted twikit-rss selected (MIT, list+user endpoints, no X API key); credential placement = Phase-1 item
- [x] 1.6 DONE 2026-09-18, REVISED per user: finance-first universe in 02 §2.4 — 9 finance TRIGGER lists + 6-account roster + 13 market-moving AI/tech CONTEXT; ~40 non-moving IDs dropped from polling (on record in history)
- [x] 1.7 SUPERSEDED 2026-09-18: self-hosted transport has no third-party mirror to fall short; TRIGGER = account roster, throttled only by X frontend rate limits (Phase-1 soak measures)

## 2. Decision-layer proof (doc 03)
- [ ] 2.1 [HUMAN] Obtain `OPENROUTER_API_KEY` — nothing in 2.2 can run without it
- [ ] 2.2 [BLOCKED] 2026-09-18: needs OPENROUTER_API_KEY in env (human skipped); then confirm Decisions endpoint + pin exact revision into doc 03
- [x] 2.3 DONE 2026-09-18: 20 hand-worked cases in doc 03 §3.7 (all HOLD rows + boundaries 17-20); §3.6 box checked

## 3. Venues (doc 01)
- [x] 3.1 DONE 2026-09-18: OANDA v20 practice primary, FXCM demo fallback (REST + streaming, free demo, same shape as live)
- [x] 3.2 DONE 2026-09-18: Alpaca paper primary (free, live-price sim, REST + WS, resettable, no deposit)
- [x] 3.3 DONE 2026-09-18: exchange/broker calendars (fail-closed) + FRED/ALFRED + Fed/ECB pages + EDGAR-derived earnings; all free
- [x] 3.4 DONE 2026-09-18: venue names LOCKED in doc 01 ([HUMAN] ACCEPTED)

## 4. Research-plane freeze (doc 08)
- [x] 4.1 DONE 2026-09-18 ([HUMAN] ACCEPTED): langgraph==1.1.6, smolagents==1.26.0, langfuse==4.15.4 (self-hosted); installability verified at build
- [x] 4.2 DONE 2026-09-18 ([HUMAN] ACCEPTED): versions in 08 locked decisions; six-node topology + failure defaults already in 08 §8.3; checkpoint store SQLite(G0/G1)->Postgres(G2+) unchanged
- [x] 4.3 DONE 2026-09-18: exact import allowlist + 3-user OS design (mirotrade/miroresearch/mirohuman) locked in 08 §8.2
- [x] 4.4 DONE 2026-09-18: features.jsonl schema f1 (§8.5) + R15 table (§8.4) confirmed frozen, no changes needed

## 5. Sources classification (doc 09)
- [x] 5.1 DONE 2026-09-18: Tier tables + finance-first X universe (doc 02 §2.4) leave no blanks; every source has class + failure default
- [ ] 5.2 [HUMAN] Obtain free keys: FRED (signup, 1 key), NASA FIRMS (email token); AISStream/TomTom only if used — say which you want
- [x] 5.3 DONE 2026-09-18: EDGAR UA + 10 req/s ceiling locked in 09 §9.2
- [x] 5.4 DONE 2026-09-18: §9.3 heartbeat (>3x cadence = stale) + per-tier failure defaults in §9.1 table; calendar fail-closed
- [x] 5.5 DONE 2026-09-18: ALFRED vintages for replay (locked in 01); Tier D bar + lessons.jsonl already in 09 §9.1/§9.4

## 6. Capital / kill / spend (doc 10)
- [ ] 6.1 [D] Freeze STAGE format + attestation chain; create and sign G0 file
- [ ] 6.2 [D] Freeze stage table numbers, promotion criteria, demotion triggers
- [ ] 6.3 [D] Freeze SOFT/MEDIUM/HARD triggers; freeze spend caps + 20% ratio + 60/80/100% tiers + anti-flap window

## 7. Calibration + risk constants (docs 11, 05)
- [ ] 7.1 [D] Freeze resolution rules, base-rate baseline, non-LLM baseline, promotion template
- [ ] 7.2 [D] R10-R17 as literal numbers; confirm R1-R9 unchanged

## 8. Freeze sign-off (doc 07)
- [ ] 8.1 [D] Zero TBDs outside "tune later"; all boxes above checked
- [ ] 8.2 [H] Human sign-off logged in doc 07; Phase 1 (signal sidecar) unblocked

## 9+. Build phases (not started; tracked here only)
- [ ] 9. Phase 1 signal sidecar → 10. Phase 2 JEV sidecar → 11. Phase 2.5 research plane → 12. Phase 3 C++ core → 13. Phase 4 paper loop G0 → 14-16. G1/G2/G3 gates

## A. Agent orientation files (Phase-0, new)
- [x] A.1 DONE 2026-09-18: ARCHITECTURE.md (8 questions, MiroHedge-mapped) at root
- [x] A.2 DONE 2026-09-18: AGENTS.md session rules (read ARCH+00, TODO discipline, no secrets, fail closed) at root
- [x] A.3 DONE 2026-09-18: pi harness loads AGENTS.md every turn (human-confirmed)
