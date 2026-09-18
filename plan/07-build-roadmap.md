# 07 — Build Roadmap (the only to-do list)

Phases run in order. No phase starts until the previous one's exit criteria are
met and checked off here. Paper capital only until phase 5 sign-off.

## Phase 0 — Freeze the spec (this folder)

Nothing downstream builds on a moving number. Every box below is a decision that
must exist on paper before a line of code.

**Signal feed (doc 02)**
- [ ] Verify every X list ID in doc 02 §2.4 resolves. Mark dead ones.
- [ ] Every X list classified TRIGGER vs CONTEXT (doc 02 §2.4 table complete).
- [ ] Confirm RSS/mirror coverage for the TRIGGER lists (no X API of any kind per doc 02 §2.5); record the reduced list set here if mirrors fall short.

**Decision layer (doc 03)**
- [ ] Hand-work 20 JEV decision-table cases, including the four new HOLD rows
      (disagreement, event window, calibration, veto).
- [ ] Get `OPENROUTER_API_KEY`, confirm the Decisions endpoint and the exact model
      string (`typesafe/jev-1.13` or `jev-latest`), and pin it in doc 03.
- [ ] `question_set_version = v2` pinned; slow-key fields (incl. `disagreement`,
      feature-count bucket) frozen.
- [ ] Freeze the JEV state schema, including feature caps (16 in payload, 64 in
      snapshot) and the absent-vs-neutral representation.

**Research plane (doc 08)**
- [ ] Framework stack confirmed installable and pinned: LangGraph + smolagents +
      self-hosted Langfuse, exact versions recorded.
- [ ] Checkpoint store decided per stage (SQLite for G0/G1, Postgres from G2).
- [ ] Agent topology frozen: the six nodes, their outputs, their failure defaults.
- [ ] R15 caps frozen (LLM calls, tool calls, tokens, wall clock, depth).
- [ ] Sandbox decided (Docker) and the smolagents import allowlist written down.
- [ ] OS-level isolation designed: users, groups, file permissions, which
      credentials live where.
- [ ] `features.jsonl` schema (doc 08 §8.5) frozen.

**Data sources (doc 09)**
- [ ] Every source classified TRIGGER / CONTEXT / NULL. No blanks.
- [ ] Free keys obtained where needed (FRED, FIRMS, AISStream, TomTom if used).
- [ ] EDGAR User-Agent string and rate limit recorded; polling cadence decided.
- [ ] Per-source TTL, cadence, heartbeat threshold, and failure default written in.
- [ ] Point-in-time macro decided: ALFRED vintages for anything replayed.
- [ ] Tier D evidence bar written down; `lessons.jsonl` schema frozen.

**Capital, kill switches, spend (doc 10)**
- [ ] `STAGE` file format + attestation chain frozen; G0 file created and signed.
- [ ] Stage table numbers frozen (capital, symbols, R-multiplier, daily loss caps).
- [ ] Promotion criteria and automatic demotion triggers agreed and written in.
- [ ] Kill-switch levels (SOFT/MEDIUM/HARD) and their triggers frozen.
- [ ] Spend caps frozen: absolute per stage, 20% ratio test from G2, tier
      thresholds (60/80/100%), anti-flap window.
- [ ] Out-of-band alert channel chosen and tested.

**Calibration and promotion (doc 11)**
- [ ] Resolution rules per question frozen (horizons, counterfactual HOLD scoring).
- [ ] Base-rate baseline definition + R13 threshold frozen.
- [ ] Non-LLM baseline strategy specified — it is a permanent fixture.
- [ ] Promotion gate criteria written into the sign-off log template.

**Risk and venue (docs 01, 05)**
- [ ] Freeze: sizing % (doc 05 §5.1a), VaR/corr/vol methods, paper fill model.
- [ ] R10–R17 reviewed as code constants; owners named for each.
- [ ] Venue + data decided and written into doc 01: forex broker/paper + US equities
      broker/paper, feed protocol (WS or poll), session hours table, calendar source
      (macro + earnings). No code before names exist on paper.
- [ ] Exit: all boxes in phases updated, no TBDs outside "tune later" items.

## Phase 1 — Signal sidecar (doc 02)

- [ ] Collector → `signals.jsonl` + SQLite index + dedupe.
- [ ] 7-day soak + noise grade (<10% off-topic).
- [ ] Stub context reader consumes the schema.
- [ ] Exit: §2.6 boxes checked.

## Phase 2 — JEV sidecar (doc 03)

- [ ] `jev.py`: stdin state → batched call → stdout answers + log row.
- [ ] Cache + failure paths (timeout/500/malformed → HOLD).
- [ ] 20 hand-worked cases green; replay of 200 recorded/synthetic states sane.
- [ ] Exit: §3.6 boxes checked.

## Phase 2.5 — Research plane (docs 08, 09)

Built before the C++ core needs it, proven standalone, and never on the critical
path for a trade.

- [ ] LangGraph graph with the six nodes; SQLite checkpointing; resume-after-kill
      proven at a random node with no duplicate features.
- [ ] smolagents extraction workers inside Docker with a pinned import allowlist.
- [ ] Tier A pollers live (EDGAR, FRED/ALFRED, Treasury/BLS, calendars) with TTLs,
      heartbeats, and measured p50/p99 latency recorded in doc 09.
- [ ] Tier B/C sources ingested as CONTEXT/NULL, measured, and used by nothing.
- [ ] R15 runaway test passes (a stubbed looping tool is caught and aborted).
- [ ] Isolation test passes: research user cannot write journal/`HALT`/`STAGE` and
      cannot read broker credentials.
- [ ] R12 test passes: a future-timestamped feature is dropped.
- [ ] Langfuse shows per-node token and dollar attribution for a full day.
- [ ] `lessons.jsonl` seeded with ≥10 graded entries.
- [ ] Exit: doc 08 §8.6 and doc 09 §9.4 boxes checked.

## Phase 3 — C++ core (docs 04–06)

- [ ] `core` + `risk/veto.cpp` first (pure logic, unit-tested vs docs 03/05/10 —
      R1–R17 and the stage multiplier).
- [ ] `ingest/features.cpp` + rejection tests (schema, R12 timestamps, TTL, counts).
- [ ] `kill/switch.cpp` + SOFT/MEDIUM/HARD drills, exits proven alive in each.
- [ ] `STAGE` chain verification, including the corrupted-file → G0_PAPER test.
- [ ] `feed` + 24 h soak + kill/reconnect drill.
- [ ] `ctx` + hash-stability test (10k identical → 1 hash).
- [ ] `exec` + `journal` + kill-switch + reconcile drills.
- [ ] Exit: §4.5, §6.5 drill boxes checked.

## Phase 4 — Paper loop at G0_PAPER (everything together)

- [ ] Full loop paper-trading on broker paper/sandbox accounts (forex + stocks),
      research plane attached, spend metering live.
- [ ] Daily summaries + weekly replay checks running.
- [ ] Baseline stats frozen for S3 (win rate, per-regime PnL over the paper window).
- [ ] Non-LLM baseline strategy running alongside for comparison (doc 11 §11.3).
- [ ] Calibration harness scoring ≥200 decisions incl. counterfactual HOLDs;
      `enter` and `veto` at or better than base rate.
- [ ] Every §6.2a outage row drilled; exits alive in all of them.
- [ ] AI spend within the G0 absolute cap; cost per closed trade reported.
- [ ] 30 clean days, zero R-rule violations, no unplanned human intervention.
- [ ] Exit: G0 → G1 criteria in doc 10 §10.2 met **and** human sign-off recorded
      below (name + date + `STAGE` attest hash).

## Phase 5 — G1_TINY (explicit decision, not automatic)

- [ ] Human signs `STAGE` into G1_TINY with the process stopped. No code path can
      do this (R17).
- [ ] 1 symbol, R-multiplier 0.25, 1× leverage, daily human review.
- [ ] Realized slippage tracked against the paper fill model.
- [ ] Any R-trip → automatic demotion to G0. No negotiation.
- [ ] Exit: doc 10 §10.2 G1 → G2 criteria met + human signature.

## Phase 6 — G2_SCALED

- [ ] Checkpoint store moved to Postgres; challengers running in shadow (doc 11).
- [ ] The 20% AI-spend ratio test active and passing for 30 days.
- [ ] ≤3 symbols, R-multiplier 0.5, weekly review.
- [ ] Exit: doc 10 §10.2 G2 → G3 criteria met (60 days, ≥100 closed trades,
      max DD < 5%) + human signature.

## Phase 7 — G3_FULL

- [ ] Full stage limits per doc 05 §5.1 and doc 05 §5.2.
- [ ] Deposit-and-walk-away verified: 30 consecutive days with zero required human
      intervention, every intervention that did occur logged with its cause.
- [ ] Ongoing: weekly calibration review, promotion gate for any change.

## Distraction firewall (read when tempted)

- New exchange? → Phase 5 done first. Then one paragraph in doc 01.
- New indicator? → Must displace an old one (one in, one out) + backtest note.
- Fine-tuning models? → Phase 5. Shadow only. Never with live capital in v1.
- UI/dashboard? → Logs suffice until phase 5 exit.
- New JEV question? → version bump + 20 fresh hand-worked cases first (doc 03).
- "Just one manual trade"? → No. The journal is the trader now.
- New agent framework? → Doc 08 §8.2 ranking is the decision. Re-open it only with
  a measured reason, never a release announcement.
- New data source? → Doc 09 table first, as CONTEXT or NULL. Promotion to TRIGGER
  needs measured hit-rate + sign-off (doc 11).
- Agent wants a new tool? → It is a doc edit and a fresh paper window, not a
  runtime capability. Self-modification is banned (D3).
- "The bot is doing well, let's raise the stage early"? → No. The criteria are
  necessary, never sufficient, and the file is signed with the process stopped.
- "Let's skip the non-LLM baseline, it's obviously worse"? → Then it costs nothing
  to run, and it is the only thing that can tell you the AI layer is subtracting
  value.

Sign-off log:

Each entry: phase or stage, name, date, `STAGE` attest hash, and the window judged.

- (empty — first entry closes phase 0)
