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
- [ ] 2.1 [H] Obtain `OPENROUTER_API_KEY`
- [ ] 2.2 [W] Confirm Decisions endpoint shape + exact model revision string; record pinned string into doc 03
- [ ] 2.3 [H/D] Hand-work 20 JEV decision-table cases incl. all four new HOLD rows (veto, disagreement, event window, calibration); attach as Phase-0 evidence

## 3. Venues (doc 01)
- [ ] 3.1 [W] Compare forex broker APIs (paper + live): shortlist 2 with REST + streaming quotes, fee/spread tables
- [ ] 3.2 [W] Compare US-stock paper feeds/brokers: shortlist 2
- [ ] 3.3 [W] Pick session-calendar + earnings-calendar + macro-release calendar sources (free)
- [ ] 3.4 [D] Write chosen broker/paper/calendar names into doc 01

## 4. Research-plane freeze (doc 08)
- [ ] 4.1 [W] Pin exact LangGraph + smolagents + Langfuse versions; verify installability (no code, just version resolution)
- [ ] 4.2 [D] Record versions + checkpoint-store choice + six-node topology + failure defaults
- [ ] 4.3 [D] Write Docker spec (non-root, read-only rootfs, caps, limits, egress allow-list) + import allowlist + OS users/permissions design
- [ ] 4.4 [D] Freeze `features.jsonl` schema + R15 numbers

## 5. Sources classification (doc 09)
- [ ] 5.1 [D] Every source TRIGGER/CONTEXT/NULL, no blanks
- [ ] 5.2 [B/H] Obtain free keys: FRED, NASA FIRMS, (AISStream/TomTom only if used)
- [ ] 5.3 [W] Record EDGAR User-Agent + rate limit + polling cadence
- [ ] 5.4 [D] Per-source TTL, cadence, heartbeat threshold, failure default
- [ ] 5.5 [D] ALFRED-vs-FRED replay decision; Tier D evidence bar + `lessons.jsonl` schema

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
