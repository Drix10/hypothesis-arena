# ARCHITECTURE.md: MiroHedge

Agent-facing build intent. Full detail lives in `plan/`. If this file and
`plan/` disagree, `plan/` wins, then fix this file.

## 1 | What is in the system?

Three inputs, one decision path, journaled execution.

```
Research plane (Python, separate OS user, off hot path)
  harvest -> extract -> fuse -> hypothesize -> critique -> emit
  writes ONLY features.jsonl
        |
        v
C++ core (hot path, per-symbol 60s cycle)
  feed/ -> ingest/ -> ctx/ -> JEV sidecar -> risk/ -> kill/ -> exec/ -> journal/
        |
        v
Broker paper/live (forex majors + US stocks only, doc 01)
```

Sidecars: signal collector (`signals.jsonl`), JEV (`jev.py`), research plane.
Hot path never blocks on prose LLM. Agents never size or send orders.

## 2 | Who is responsible for what?

| Responsibility | Owner | Must not |
|---|---|---|
| Typed features, OSINT, thesis/critique | Research plane (doc 08) | Touch journal, HALT, STAGE, broker keys |
| X-list / newswire material (HISTORICAL ONLY, never production) | Archive (doc 02 §2.6) | Enter v1 production |
| Production signal collection (broker market data + SEC/EDGAR + FRED/macro) | Signal sidecar (docs 02/09) | Score polarity or trade |
| Calibrated answers, exactly 4 v3 questions | JEV sidecar (doc 03) | Size, execute, or read family-fit as success odds |
| Snapshot, decision table, R1-R17, kills | C++ `risk/` + `kill/` (docs 05, 10) | Call LLMs |
| Orders, stops, journal-before-order | C++ `exec/` + `journal/` (doc 06) | Act without a journal row; hold a position lacking broker-acked SL/TP |
| Capital stage | Human-signed `STAGE` file | Any code path that promotes |
| Calibration scoring, challengers | Offline harness (doc 11) | Auto-promote models or stages |

One owner per responsibility. No shared helper that blurs a boundary.

## 3 | Why is it built this way?

- Statistical edge is primary. AI gates and contextualizes. If it cannot beat
  the non-LLM baseline net of cost, remove it, do not tune it (doc 11).
- JEV is the only decision engine. Four v3 questions (enter / edge_family /
  conviction / latent_risk); richness lives in state. Family probabilities are
  fit evidence, never success odds.
- Research is isolated by OS permissions (R11), not convention.
- No X API, no X automation, free data only. Absent is not neutral.
- Human-only capital promotion (R17). Autonomy stops at the stage gate.
- Replay from logged features, never agent re-runs (D5).

Do not simplify these away. They are intentional.

## 4 | What is allowed to touch what?

Allowed: research -> features.jsonl -> ingest/ -> ctx/ -> risk/ -> exec/ ->
journal. Signal sidecar -> signals.jsonl -> research harvest only. JEV sidecar
takes state from ctx and returns answers only. STAGE/HALT written by human or
the C++ kill path only.

Banned: research -> journal/HALT/STAGE/broker credentials. Chat-gateway agents
on the trading host. Hot path -> live prose LLM calls. Any code path that
raises stage. `LocalPythonExecutor` near trading credentials. Selenium,
Playwright, CDP against X. Crypto venues or symbols in v1. Paid data for core
operation.

## 5 | How does data move? (happy path + failure defaults)

1. Broker ticks -> `feed/` ring. Research features -> `ingest/` validates
   (schema, R12 timestamps, TTL). 2. `ctx/` freezes Snapshot + context_hash.
3. JEV sidecar: one batched call or slow-key cache hit -> 4 answers.
4. `risk/`: decision table + R1-R17 + stage multiplier -> BUY/SELL/HOLD + size.
5. `journal/` append-only row BEFORE order. 6. `exec/` sends or paper-logs;
   stops/TP local and always live.

Failures: JEV down -> HOLD (exits live). Features absent/stale -> absent, not
neutral. Spend tier, R13, disagreement, event window -> HOLD or demote.

## 6 | What can never break?

1. Secrets off the research plane and out of git. 2. R1-R17 are code constants;
   change = doc edit + version bump + fresh paper window. 3. Journal before
   order, always. 4. Exits survive kills, outages, dead JEV, paused research.
5. No automatic stage promotion. 6. Pinned `typesafe/jev-1.13`, question_set v3, schema f2 — never floating.
7. Absent data is never neutral. 8. No "just this once" boundary crossing.

## 7 | Where does new code belong?

New free source -> research plane + doc 09 table first. New production list
-> doc 09 + TODO evidence (X lists are HISTORICAL per doc 02 §2.6 — never
resurrect one as production). New risk rule -> doc 05, then `risk/veto.cpp`. New JEV
question -> forbidden without version bump + 20 cases. New agent node/tool ->
doc 08 first, no runtime self-modification. Broker adapter -> `feed/` +
`exec/` only, names already in doc 01. Calibration/challenger -> offline
harness, shadow until human promotes. Ops scripts/tests -> `scripts/`,
`tests/`, never hot-path logic. Second way to do an existing thing -> stop.

## 8 | When does the agent stop and ask?

STOP, name the conflict, show impact, propose the smallest fix that preserves
the rule, if the task would: touch journal/HALT/STAGE from a non-C++ path;
add a venue, asset class, paid data, or browser automation against X; add or
change a JEV question or float the model string; promote a stage in code;
weaken R11, R12, or R17; introduce a new pattern (second bus, shared DB, chat
control, online learning on live path); change R1-R17 without a doc edit.
When unsure: HOLD, refuse, or ask. Never expand autonomy.

## Related files

Spec: `plan/00-INDEX.md` … `plan/12-*.md` + `plan/system-manifest.yaml`. Live checklist: `TODO.md`
(edit on every completed box). Session rules: `AGENTS.md`.
