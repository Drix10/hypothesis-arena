<div align="center">
  <br />

  # MiroHedge

  **An AI-assisted systematic fund that has to earn its edge before it trades, and proves every decision was made correctly.**

  *AI researches, extracts facts, and writes research code. Deterministic strategy sleeves propose trades. A C++ kernel applies hard risk rules, sizes, and executes US equities/ETFs — long only, cash account — on paper first. Every step is logged, replayable, and signed.*

  [![C++](https://img.shields.io/badge/C++-17+-blue?logo=cplusplus)](https://isocpp.org/)
  [![Python](https://img.shields.io/badge/Python-research_+_sleeves-yellow?logo=python)](./research/)
  [![Plan](https://img.shields.io/badge/plan-freeze_v3-7B2CBF)](./plan/00-INDEX.md)
  [![Stage](https://img.shields.io/badge/Capital-G0_PAPER_only-00D4AA)](./plan/10-capital-gates-and-spend-control.md)

  **Status (2026-09-28): plan freeze v3 "alpha-first rebaseline" · kernel P3.1–P3.3 frozen · P3.5 H1 built, transport not wired · no sleeve has passed an economic gate yet · G0 NOT STARTED · paper only.**

</div>

---

## What is this project trying to do?

Run a small systematic fund whose strategies are proven net of every cost
before they touch money, with AI used where evidence says it helps:

1. **Research factory** — agents propose hypotheses, write
   pre-registrations and backtest code on trusted local data; every trial
   is logged and statistically gated before a human sees it.
2. **Typed extraction** — a capability-free reader tier turns SEC filings
   into verified facts.
3. **Optional calibrated filter (JEV)** — admitted only if it beats
   "take every candidate" on the same candidates, net of its own cost.

What it is NOT: not HFT (strategies run on minutes-to-months horizons; the
fast C++ core buys determinism and reliable exits, not latency alpha), not
crypto, not leveraged, not short-selling, and not autonomous with money (a
human signs every capital increase; code physically cannot promote itself).
The live scope is what the operator may legally trade from India under
RBI LRS: US-listed stocks and ETFs, cash account, long only.

## How it works

```
free primary data (SEC EDGAR, FRED/ALFRED, Treasury/BLS/BEA, calendars)
      │                               SIP market history (signals, costs)
      ▼                                         │
research plane → typed features ─┐              ▼
                                 ├──► deterministic strategy sleeve → candidate (c1)
                                 │                                        │
                                 │            optional JEV v4 filter ◄────┤
                                 ▼                                        ▼
                        frozen snapshot (SHA-256) ──► C++ risk rules R1–R19, sizing
                                                               │
                                           HOLD (mostly) or BUY / SELL-to-close + stop
                                                               │
                                          journal row first, then the order (paper)
```

Three principles:

1. **Prose never touches money.** Research writes structured facts; thesis
   text stays in a human-only digest. Isolation is by OS users.
2. **HOLD is the default.** Stale data, breached rule, unsettled cash,
   unapproved sleeve, conflicting evidence: all HOLD.
3. **Everything replays.** Same logged snapshot + candidate (+ answer) =
   same decision, bit for bit.

## Where the project stands

| Piece | State |
|---|---|
| Spec (`plan/`, 13 docs + manifest) | Freeze v3 written 2026-09-28 (critique: `plan/reviews/`); human signature pending |
| Collector + Tier-A adapters (EDGAR/FRED/Treasury/BLS/BEA) | Built, tested, hosted-green; live p50/p99 evidence open |
| JEV sidecar | v3 accepted/frozen; v4 candidate-bound released; now an optional filter |
| C++ kernel | P3.1/P3.2/P3.3 frozen; P3.5 A–G done; H1 router/runner/broker/journal built — **transport not wired** |
| Strategy track | `baseline_v1` measured negative (S2, diagnosed); new sleeve book (trend, sector momentum, intraday momentum, insider purchases, earnings reader) awaiting pre-registration |
| Paper loop | NOT STARTED. G0a shadow starts when a sleeve passes its backtest gate; G0b broker paper when P3.5 closes |

Paper only until a sleeve passes its gates, 30 clean broker-paper days,
and a human signature. Promotion of anything (sleeve, filter, stage) needs
ledgered, cost-inclusive, transferable evidence; a JEV filter additionally
needs 200 decisions + 100 closed simulated trades and calibration at or
above base rate.

Status words used in this repo: FROZEN-DESIGN (spec locked, not built) ·
IMPLEMENTED (code exists) · VERIFIED (acceptance green).

## Quick start

```bash
git clone https://github.com/Drix10/hypothesis-arena.git
cd hypothesis-arena
cp .env.example .env                  # fill locally; never commit, never paste keys anywhere
bash scripts/freeze-check.sh          # must print FREEZE-CHECK: PASS (needs xxd)
python3 collector/tests/test_pipeline.py
cd kernel && bash build.sh            # C++ gates (run as a non-root user)
```

## Repo map

```
plan/           # the spec. 00-INDEX first; appendix/ = frozen implementation records; reviews/ = history
collector/      # Python: signal collection, classification, ctx reader, JEV sidecar
kernel/         # C++: validator, typed state, decision table, veto, ingest, kill, router, runner, broker
research/       # plane/ (graph+spend), sources/ (adapters+gates), strategy/ (harness, sleeves), tests/
scripts/        # freeze-check.sh (repo fingerprint)
data/           # local only, gitignored
TODO.md         # the live checklist (freeze v3); TODO-ARCHIVE-2026-09-28.md = full history
ARCHITECTURE.md # codebase guide
AGENTS.md       # session rules
```

## Rules that are never bent

- No code path promotes a capital stage. Demotion is automatic.
- Risk limits R1–R19 are code constants. Change = doc edit + version bump + fresh paper window.
- Live = cash account, long only, 1×, allowlisted US stocks/ETFs.
- Journal row before order. Always.
- Research cannot touch journal, HALT, the stage chain, candidates, or broker keys.
- Every backtest is ledgered; LLM evidence counts only after the model's knowledge cutoff.
- Secrets never enter the repo, a log, a prompt, or a chat.

Details: [`plan/05`](./plan/05-risk-and-determinism.md), [`plan/10`](./plan/10-capital-gates-and-spend-control.md), [`plan/11`](./plan/11-calibration-and-self-improvement.md).

## Branches

| Branch | What lives here |
|---|---|
| **`main`** | MiroHedge fund: spec, collector, kernel, research |
| **`arena`** | Hypothesis Arena: crypto trading bot, WEEX Hackathon 2026 submission (archived lineage) |

## Plan docs (read in order)

```
00-INDEX  map, global locked decisions
01 vision + scope + jurisdiction + latency tiers / 02 strategy book
03 JEV (optional filter) / 04 C++ core / 05 risk R1-R19 / 06 execution + costs + ops
07 roadmap (the to-do list) / 08 research plane + factory / 09 free data
10 capital + jurisdiction gate + kills + spend / 11 validation + promotion
12 controls + benchmarks / 13 C++ kernel build
system-manifest.yaml — build fingerprint code verifies against
```

> `plan/` is the spec. Docs 08–11 never weaken a rule in 01–07.
