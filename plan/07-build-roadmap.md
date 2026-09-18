# 07 — Build Roadmap (the only to-do list)

Phases run in order. No phase starts until the previous one's exit criteria are
met and checked off here. Paper capital only until phase 5 sign-off.

## Phase 0 — Freeze the spec (this folder)

- [ ] Verify every X list ID in doc 02 §2.4 resolves. Mark dead ones.
- [ ] Decide collector transport (X API vs RSS mirror). Write it into doc 02 §2.5.
- [ ] Hand-work 20 JEV decision-table cases for doc 03 §3.6.
- [ ] Get `OPENROUTER_API_KEY` + confirm Decisions endpoint access.
- [ ] Exit: all boxes in phases updated, no TBDs outside "tune later" items.

## Phase 1 — Signal sidecar (doc 02)

- [ ] Collector → `signals.jsonl` + SQLite index + dedupe.
- [ ] 7-day soak + noise grade (<10% off-topic).
- [ ] Stub context reader consumes the schema.
- [ ] Exit: §2.6 boxes checked.

## Phase 2 — JEV sidecar (doc 03)

- [ ] `jev.py`: stdin state → batched call → stdout answers + log row.
- [ ] Cache + failure paths (timeout/500/malformed → HOLD).
- [ ] 20 hand-worked cases green; 7-day paper answer distribution sane.
- [ ] Exit: §3.6 boxes checked.

## Phase 3 — C++ core (docs 04–06)

- [ ] `core` + `risk/veto.cpp` first (pure logic, unit-tested vs docs 03/05).
- [ ] `feed` + 24 h soak + kill/reconnect drill.
- [ ] `ctx` + hash-stability test (10k identical → 1 hash).
- [ ] `exec` + `journal` + kill-switch + reconcile drills.
- [ ] Exit: §4.5, §6.5 drill boxes checked.

## Phase 4 — Paper loop (everything together)

- [ ] Full loop paper-trading, WEEX testnet/sandbox if available else shadow.
- [ ] Daily summaries + weekly replay checks running.
- [ ] 30 clean days, zero R-rule violations.
- [ ] Exit: human sign-off recorded in this file (name + date).

## Phase 5 — Live gate (explicit decision, not automatic)

- [ ] Tiny size, 1 symbol, R-rules at 50% (halved limits), daily human review.
- [ ] Any R-trip → back to phase 4. No negotiation.
- [ ] Exit: 30 live days green → scale sizes per doc 05 only.

## Distraction firewall (read when tempted)

- New exchange? → Phase 5 done first. Then one paragraph in doc 01.
- New indicator? → Must displace an old one (one in, one out) + backtest note.
- Fine-tuning models? → Phase 5. Shadow only. Never with live capital in v1.
- UI/dashboard? → Logs suffice until phase 5 exit.
- "Just one manual trade"? → No. The journal is the trader now.

Sign-off log:
- (empty — first entry closes phase 0)
