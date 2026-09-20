# 07 — Build Roadmap (the only to-do list)

Phases run in order. No phase starts until the previous one's exit criteria are
met and checked off here. Paper capital only until phase 5 sign-off.

## Phase 0 — Freeze the spec (this folder)

Nothing downstream builds on a moving number. Every box below is a decision that
must exist on paper before a line of code.

**Signal feed (doc 02)**
- [x] Verify every X list ID in doc 02 §2.4 resolves. Mark dead ones.
      (2026-09-18: 55/55 live + 10 finance/AI lists found via Lists search,
      finance-first universe locked, no swaps.)
- [x] Every X list classified TRIGGER vs CONTEXT (doc 02 §2.4 complete).
- [x] RSS/mirror coverage confirmed: self-hosted twikit-rss (MIT, no X API);
      X-credential placement is a Phase-1 item.

**Decision layer (doc 03)**
- [x] 20 hand-worked cases in §3.7 (all HOLD rows + boundaries).
- [x] `OPENROUTER_API_KEY` in local `.env` (2026-09-20); Decisions endpoint
      verified reachable + auth ok + exact revision `typesafe/jev-1.13-20260917`
      + provider `TypeSafe` pinned (doc 03 intro, manifest, freeze-check).
      Key material never enters the repo.
- [x] `question_set_version = v3` pinned (freeze v2: enter / edge_family /
      conviction / latent_risk); slow-key fields (incl. `disagreement`,
      feature-count bucket) frozen (doc 03 §3.5).
- [x] JEV state schema frozen: feature caps (16 payload / 64 snapshot) +
      absent-vs-neutral (doc 03 §3.4).

**Research plane (doc 08)**
- [x] Stack pinned (human-accepted 2026-09-18): langgraph==1.1.6,
      smolagents==1.26.0, self-hosted Langfuse 4.15.4; installability at build.
- [x] Checkpoint store per stage: SQLite (G0/G1), Postgres (G2+).
- [x] Topology frozen: six nodes, outputs, failure defaults (§8.3).
- [x] R15 caps frozen (§8.4).
- [x] Sandbox (Docker, §8.2 container spec) + exact import allowlist locked.
- [x] OS isolation designed: mirotrade / miroresearch / mirohuman (§8.2).
- [x] `features.jsonl` schema f2 frozen (§8.5).

**Data sources (doc 09)**
- [x] Every source classified TRIGGER / CONTEXT / NULL. No blanks.
- [ ] Free keys obtained (FRED, FIRMS — human, when convenient; no
      AISStream/TomTom in v1).
- [x] EDGAR UA + 10 req/s ceiling recorded (§9.2).
- [x] Per-source TTL, cadence, heartbeat (>3× = stale), failure default (§§9.1–9.3).
- [x] ALFRED vintages for anything replayed (locked in doc 01).
- [x] Tier D evidence bar + `lessons.jsonl` (§9.1, §9.4).

**Capital, kill switches, spend (doc 10)**
- [x] `STAGE` format + attestation chain frozen (pipe-delimited hash, GENESIS,
      G0 capital 0, alerts = alerts.jsonl); G0 file creation + signature is
      human at build (§10.5 steps).
- [x] Stage table numbers frozen (capital, symbols, R-multiplier, daily loss caps).
- [x] Promotion criteria (necessary, never sufficient) + automatic demotion
      triggers written in (§10.2).
- [x] Kill-switch levels (SOFT/MEDIUM/HARD) and triggers frozen (§10.3).
- [x] Spend caps frozen: absolute per stage, 20% ratio test from G2, tier
      thresholds (60/80/100%), anti-flap window (§10.4).
- [x] Alert channel: `alerts.jsonl` + exit status; no messaging integrations
      in v1 (locked in doc 10 §10.1).

**Calibration and promotion (doc 11)**
- [x] Resolution rules per question frozen (horizons, counterfactual HOLD scoring).
- [x] Base-rate baseline definition + R13 threshold frozen.
- [x] Non-LLM baseline specified: indicators + regime + risk table, no JEV,
      no research plane (doc 11 §11.3).
- [x] Promotion gate criteria written into the sign-off log template below.

**Risk and venue (docs 01, 05)**
- [x] Frozen: sizing % + VaR/corr/vol methods (doc 05 §5.1a), paper fill model
      (doc 06 Locked decisions).
- [x] R10–R17 reviewed as code constants; owners = module table in
      ARCHITECTURE.md §2/§7.
- [x] Venue + data locked in doc 01 (human-accepted 2026-09-18): OANDA v20
      practice + Alpaca paper, WS + 15-min REST reconcile, free calendars.
- [ ] Exit: all boxes in phases updated, no TBDs outside "tune later" items.

## Phase 1 — Signal sidecar, non-X sources (docs 02/09, freeze v2)

X is out of the production path (doc 02 §2.6). The collector covers broker
market data, SEC/EDGAR, FRED/ALFRED, Treasury/BLS/BEA, Fed/ECB
official feeds, and earnings/calendar data — each with its §9 poller, TTL,
heartbeat, and failure default.

- [ ] P1.1 `scripts/freeze-check.sh` FIRST — verifies the repo against
      `plan/system-manifest.yaml` as the single source of truth (no version
      literals duplicated in the script; it reads the manifest and the docs):
      KNOWN-BY-FREEZE must match exactly — `question_set_version = v3`,
      `feature_schema_version = f2`, `risk_version`, strategy/exit/research
      versions, R1–R17 presence, 4 questions, stage names, venues.
      BUILD-TIME-REQUIRED allowed as explicit placeholders until their phase —
      `jev_provider` (until Phase 2 key), `research_models` (until research-plane
      build), G0 bootstrap file (human, at build). INTENTIONALLY-DEFERRED
      stays literal — `plan_hash` (generated by the freeze procedure itself),
      live-venue fields (until their G-manifests). Any other TBD/placeholder
      anywhere in plan/ or the script = P1.1 fails.
- [ ] P1.2 Collector: EDGAR + FRED/ALFRED + official macro feeds + calendars
      → `signals.jsonl` + SQLite index + dedupe (schema per §2.3, pollers/TTL/
      heartbeats per doc 09).
- [ ] P1.3 TRIGGER/CONTEXT tagging at classify step (deterministic rules_v1, doc 09).
- [x] P1.4 CLOSED 2026-09-20 at observed ~33h / 133 cycles (shortened from 7d on evidence; see collector/SOAK_REPORT.md + SOAK_MANIFEST.json). 0x403, 7/7 acceptance, 0% pre-grade noise.
- [ ] P1.5 Stub `ctx/` reader consumes the bundle schema; validates the
      boundary law (§2.7: prose rows quarantined, never consumed).
- [ ] Exit: §2.7 boxes checked.

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
- [ ] Deposit-and-walk-away verified: 30 consecutive days with zero *required*
      human intervention (weekly review continues as post-hoc inspection — the
      system must not depend on it; REQUIRED-LIVE vs POST-HOC per §10.3-linked
      rule: only hard kill, capital escalation, and strategy promotion may
      ever require a human).
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

Promotion sign-off template (copy per promotion; all lines required):

```
PROMOTION: <G0→G1 | G1→G2 | G2→G3 | challenger <id> to live>
DECIDED BY: <human name>   DATE: <ISO8601>   WINDOW JUDGED: <dates>
CRITERIA (doc 10 §10.2 or doc 11 §11.3 — every box true, evidence linked):
  [ ] clean-day count  [ ] zero R-violations  [ ] determinism green
  [ ] calibration ≥ baseline (Brier, n≥200)  [ ] spend in cap (+ ratio if G2+)
  [ ] drills passed (kill / reconcile / isolation)  [ ] non-LLM baseline beaten
PROCESS: stopped before signing, swapped after; question_set_version bumped;
  fresh paper window opened (no inherited stage).
STAGE ATTEST HASH: <sha256>
```

- (empty — first entry closes phase 0)
- Phase 0 freeze | Drix10 | 2026-09-18 | plan frozen; G0 STAGE + keys at build; Phase 1 unblocked
- Phase 0 freeze v2 signed off. Bucket 1 complete; JEV v3 semantics frozen; X removed from production v1; Phase 1 unblocked. | Drix10 | 2026-09-18
