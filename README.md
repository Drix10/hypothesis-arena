<div align="center">
  <br />

  # MiroHedge

  **An AI-assisted trading system that tries to earn edge from free public information, then proves every decision was made correctly.**

  *Research agents read the world. A calibrated model answers 4 questions. A deterministic C++ core applies risk rules and trades forex + US stocks on paper. Every step is logged, replayable, and signed.*

  [![C++](https://img.shields.io/badge/C++-17+-blue?logo=cplusplus)](https://isocpp.org/)
  [![Python](https://img.shields.io/badge/Python-collector_+_sidecar-yellow?logo=python)](./collector/)
  [![JEV](https://img.shields.io/badge/JEV-v3_calibrated-7B2CBF)](./plan/03-jev-decision-layer.md)
  [![Stage](https://img.shields.io/badge/Capital-G0_PAPER_only-00D4AA)](./plan/10-capital-gates-and-spend-control.md)

  **Status: P3.1 ACCEPTED (+ amended/re-signed) · P3.2 FROZEN · P3.3 ACCEPTED · P3.4 = quarantine · P3.5 ACTIVE (A–C DONE, D NOT AUTHORIZED, E IMPLEMENTED pending audit acceptance, F+ OPEN). Paper only. No live capital.**

</div>

---

## What is this project trying to do?

Beat a plain statistical trading baseline, net of all costs, using free public data plus AI judgment, and **prove it** with logs instead of backtest stories.

The bet, in one paragraph: public information (SEC filings, macro releases, calendars, market structure) contains real but diffuse trading signal. AI agents are good at reading that diffuse information; they are bad at sizing positions, managing risk, and knowing when they are wrong. So MiroHedge splits the job: AI reads and suggests, a calibrated gatekeeper scores, and deterministic C++ code makes every money decision under hard risk rules. If the AI layer cannot beat the dumb baseline after subtracting its own API bills, the AI layer gets deleted, not tuned.

What it is NOT: not HFT (one decision per symbol per minute), not crypto (forex majors + US stocks only), not autonomous with money (a human signs every capital increase; code physically cannot promote itself).

## How it works (the 60-second version)

Each cycle, per symbol:

```
free public data  --->  typed features (no prose, no scores, just facts)
                                |
broker quotes  --->  frozen snapshot (SHA-256 hashed)
                                |
                   +------------v-------------+
                   | JEV answers 4 questions: |
                   | enter? what family?      |
                   | what conviction?         |
                   | hidden risk?             |
                   +------------+-------------+
                                |
                   deterministic table + risk rules R1-R17
                                |
                   HOLD (mostly) or BUY/SELL + size + stop
                                |
                   journal row first, then the order (or paper log)
```

Three principles that shape everything:

1. **Prose never touches money.** Research writes structured facts (`features.jsonl`). Thesis text and opinions stay in a separate digest for humans. The design isolates the trading core from prose by OS users rather than convention; the isolation gate's implementation/test proof has passed and its deployment evidence is accepted + hardened (see DEPLOYMENT_EVIDENCE.md Box 1). Remaining Phase-D work is credentials, operational Tier-A wiring, and the 7-day elapsed proof — not the isolation mechanism.
2. **HOLD is the default.** Dead model, stale data, breached rule, conflicting signals, event blackout, thin calibration evidence: all of these produce HOLD, never a shrug-and-trade.
3. **Everything replays.** Same logged snapshot + same logged answer = same decision, bit for bit, even if the AI provider disappears tomorrow. Answers are Ed25519-signed for authenticity, and state binding, epoch monotonicity, freshness, plus deterministic validation are what make a forged or replayed log useless.

## Where the project stands

| Piece | State |
|---|---|
| Spec (`plan/`, 13 docs) | Frozen, human-signed |
| Signal collector (`collector/`: poll, classify, soak, ctx) | Built, tested, pipeline green |
| JEV sidecar (`collector/jev.py`: 4 questions, spend-capped, signed answers) | Accepted/frozen |
| C++ kernel (`kernel/`: validator, state, decision table) | P3.1 + P3.2 frozen, **P3.3 accepted** |
| Risk/sizing/execution (P3.5) | ACTIVE: veto + ingest slices landed and build-gated; Slice E (STAGE verify) IMPLEMENTED pending audit acceptance; D NOT AUTHORIZED; sizing/execution not started |
| Research plane, paper loop (G0) | PARTIAL: 6-node graph + spend/ledger control plane built, 255-test battery green; deployment evidence ACCEPTED + hardened. Status words — PROVEN (probe/evidence proves the tested capability) vs WIRED (a production caller consumes it) vs EXECUTION-READY (H1 order lifecycle exists + drilled): Tier-A sources PROVEN (EDGAR/FRED/BEA/Alpaca-read/earnings-gate); production poller/consumer wiring + H1 execution OPEN, so the loop is NOT execution-ready. OANDA practice BLOCKED (India ineligible) — alt-FX venue research, no signup. 7-day proof OPEN (see TODO.md Phase-D gate) |

Paper only until 30 clean days plus a human signature. No exceptions.
Promotion of anything (model, stage) needs 200 decisions + 100 closed
simulated trades, a beaten non-LLM baseline, and a human signature.

Status words used in this repo: FROZEN-DESIGN (spec locked, not built) ·
IMPLEMENTED (code exists) · VERIFIED (acceptance green).

## Quick start

```bash
git clone https://github.com/Drix10/hypothesis-arena.git
cd hypothesis-arena

bash scripts/freeze-check.sh          # must print FREEZE-CHECK: PASS
python3 collector/tests/test_pipeline.py    # 28 checks, all must pass
python3 collector/collect.py          # poll sources -> data/signals/<day>.jsonl

cd kernel && bash build.sh            # C++ gates: 102 + 37 + 78 checks, 20k fuzz
```

Contact for SEC user-agent: `MIRO_CONTACT` env. FRED key: `FRED_API_KEY` env (skipped cleanly without).

## Repo map

```
plan/           # the spec. 14 docs + manifest, read 00-INDEX first. Plan wins every argument.
collector/      # Python: signal collection, classification, ctx reader, JEV sidecar; tests in tests/
kernel/         # C++: boundary validator, typed state, decision table, veto, ingest; tests in tests/
research-plane/ # plane/ (graph+spend), sources/ (probes+gates), tests/ (255 battery), sandbox/ (deployment evidence), lessons/
research/       # HISTORICAL memos (P1.5 reconciliation record). Read-only.
scripts/        # freeze-check.sh (repo fingerprint), ops scripts
data/           # local only, gitignored. Signals, soak evidence, journals live here.
.env / .env.example  # canonical config + template (sole loader: collector/config.py)
TODO.md         # the live checklist. Done means checked here, not just in chat.
ARCHITECTURE.md # exhaustive codebase guide (this repo as it exists)
AGENTS.md       # session rules the agent harness follows
```

## Rules that are never bent

- No code path promotes a capital stage. Demotion is automatic.
- Risk limits R1-R17 are code constants. Change = doc edit + version bump + fresh paper window.
- Journal row before order. Always.
- Research cannot touch journal, HALT, STAGE, or broker keys.
- Paper-only until clean days plus human sign-off.

Details live in [`plan/05-risk-and-determinism.md`](./plan/05-risk-and-determinism.md) and [`plan/10-capital-gates-and-spend-control.md`](./plan/10-capital-gates-and-spend-control.md).

## Branches

| Branch | What lives here |
|---|---|
| **`main`** (you are here) | MiroHedge fund: spec, collector, kernel |
| **`arena`** | Hypothesis Arena: crypto trading bot, WEEX Hackathon 2026 submission (archived lineage) |

`stock` and `weex` are legacy lineage. New fund work happens on `main`.

## Plan docs (read in order)

```
00-INDEX  map of the spec + one-way trust rule
01-vision-and-scope / 02-signal-sidecar + X history / 03-JEV decision layer
04-C++ core / 05-risk R1-R17 / 06-execution / 07-build roadmap (the to-do list)
08-research plane / 09-free data / 10-capital + kills + spend / 11-calibration
12-statistical baseline (the champion the AI must beat) / 13-C++ kernel build
system-manifest.yaml — canonical build fingerprint code verifies against
```

> `plan/` is the spec. Docs 08-11 never weaken a rule in 01-07.
