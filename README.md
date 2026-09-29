<div align="center">
  <br />

  # MiroHedge

  **An AI-assisted systematic fund that has to earn its edge before it trades, and proves every decision was made correctly.**

  *AI researches, extracts facts, and writes research code. Deterministic strategy sleeves propose trades. A C++ kernel applies hard risk rules, sizes, and executes US equities/ETFs — long only, cash account — on paper first. Every step is logged, replayable, and signed.*

  [![C++](https://img.shields.io/badge/C++-17+-blue?logo=cplusplus)](https://isocpp.org/)
  [![Python](https://img.shields.io/badge/Python-research_+_sleeves-yellow?logo=python)](./research/)
  [![Plan](https://img.shields.io/badge/plan-freeze_v3-7B2CBF)](./plan/00-INDEX.md)
  [![Stage](https://img.shields.io/badge/Capital-G0_PAPER_only-00D4AA)](./plan/10-capital-gates-and-spend-control.md)

  **Status (2026-09-29): plan freeze v3 · paper loop and Alpaca paper transport built and read-only verified · five sleeves measured, none passed the economic gate · no STAGE signed, G0 not started · paper only.**

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
| C++ kernel | P3.1/P3.2/P3.3 frozen; P3.5 A–G done; H1 router/runner/broker/journal built; R18/R19 veto rules, candidate validator, libcurl paper transport, decision loop, OTO/MOC adapter shapes, journal size bound; fault-injection and loop drills pass against a loopback mock |
| Research harness | Trial ledger, `cost_v2`, T+1 settlement, portfolio engine, statistics standard, A/B gates, pre-registration validator, SIP fetcher with manifests: built, tested, on hosted CI |
| Strategy track | `baseline_v1`, T1 trend, E1 insider purchases and E2-det earnings drift, T2 sector momentum and I1 intraday momentum all failed the A-gate on SIP/SEC data (ledger N=19); the AI earnings reader is not run |
| Paper loop | NOT STARTED. G0a shadow starts when a sleeve passes its backtest gate; G0b broker paper when P3.5 closes |

### Progress

Roadmap checklist (`TODO.md`): 30 of 57 boxes done. The open kernel box K1 is largely built; `TODO.md` lists what remains.

| Track | Done | Open |
|---|---|---|
| Rebaseline (docs) | 3 | 1 (human signature) |
| Ops, CI, hygiene | 6 | 1 (credential rotation) |
| Alpha (harness + sleeves) | 12 | 6 (sleeves that failed are recorded, the rest untested) |
| Kernel P3.5 remainder | 9 | 5 (live MOC smoke, OTO/MOC live-venue check, 24 h soak, live-venue drills, exit gate) |
| Research plane | 0 | 5 |
| Paper trading (G0) | 0 | 5 |
| Live stages (not authorized) | 0 | 4 |

Critical path to paper trading: the loop and transport exist and are
verified read-only against the paper account; what remains is the human
STAGE sign-off and a sleeve that passes its A-gate (none has). The loop can
run the non-alpha core sleeve for operations validation (`ops/deploy/`).

### Quality snapshot

- Hosted CI runs six jobs on every push: C++ gates, sanitizer build, plane
  suite, evidence suites, collector suites, secret scan over full history.
- Independent reviews reproduced and fixed real defects: a rotation bug
  that left portfolios in cash, a fail-open Sharpe gate that scored T-bill
  yield as skill, a non-atomic ledger check, unescaped alert lines, an
  overflow in the R18 sum.
- Known gaps: no sleeve passes its gate (`plan/reviews/2026-09-29-alpha-results.md`);
  one free price source with ten years of history; the runner is 4.4k lines
  in one file; order flow has been exercised against the paper venue by a
  smoke test, not yet by the loop (needs the human STAGE).

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
bash scripts/freeze-check.sh          # must print FREEZE-CHECK: PASS
python3 collector/tests/test_pipeline.py
cd kernel && bash build.sh            # C++ gates (run as a non-root user)
```

## Repo map

```
plan/           # the spec. 00-INDEX first; appendix/ = frozen implementation records; reviews/ = history
collector/      # Python: signal collection, classification, ctx reader, JEV sidecar
kernel/         # C++: validator, typed state, decision table, veto, ingest, kill, router, runner, broker
research/       # plane/ (graph+spend), sources/ (adapters+gates), strategy/ (harness, sleeves), tests/
scripts/        # freeze-check.sh (repo fingerprint), pre-commit-secrets.sh, sign-stage.sh
ops/            # alert relay, paper-loop deployment (ops/deploy/README.md)
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
