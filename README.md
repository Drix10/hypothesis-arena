# MiroHedge

Paper-trading system for US stocks and ETFs, with a deterministic C++ risk and execution kernel, a Python backtesting harness, and pre-registered strategy testing. Alpaca paper only. No real money is involved.

[![CI](https://img.shields.io/github/actions/workflow/status/Drix10/hypothesis-arena/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/Drix10/hypothesis-arena/actions/workflows/ci.yml)
![Stage](https://img.shields.io/badge/stage-G0%20paper%20only-blue?style=flat-square)
![Kernel](https://img.shields.io/badge/kernel-C%2B%2B17-00599C?style=flat-square&logo=cplusplus&logoColor=white)
![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white)

## What this is

The fund's bet: news about one company reaches its suppliers, customers, peers and co-mentioned firms days to months late, and an engine that reads filings and global news can map those links and trade the ripple. Today the kernel runs a cash account, long only, 1x, allowlisted symbols; the research target is a US margin account that may short (see [`plan/00`](./plan/00-INDEX.md)). The process rule is simple: a strategy only gets to place orders after it passes a backtest that was registered before it was run, then a forward test, then a human signs off. Most strategies will not get through, and that is expected.

The parts:

- a C++17 kernel that decides HOLD, BUY or SELL-to-close, sizes the position, and manages orders and stops;
- risk rules R1 to R20, written as code constants (the kernel implements R1 to R19; R20, the short-sale rules, comes with kernel short selling);
- a hash-chained order journal, written before every order;
- a Python research harness: walk-forward and purged cross-validation, deflated Sharpe, probability of backtest overfitting, Holm correction, transaction-cost model;
- data adapters for SEC EDGAR, FRED, Treasury, BLS and BEA;
- an optional LLM filter (JEV) that can veto candidates. It is only admitted on a strategy that passes its gate, after 200 decisions + 100 closed simulated trades with calibration at or above base rate, and it stays only if the filtered results beat "take everything" after paying for itself, on post-cutoff data.

Trading systems mostly fail in the surrounding code, not the strategy: a backtest re-run until one variant looks good, a stop that disappears on a partial fill, a model that "predicts" an event it saw in training, a short paper run called a success on a Sharpe ratio it cannot support. This repo is built around catching those.

## Status (2026-10-03)

The plumbing works. The first five strategies failed and are retired; the new
plan is designed and not yet built.

| Earlier strategy (retired) | Result on its frozen holdout |
|---|---|
| ETF trend, long or cash | Sharpe about equal to passive with a smaller drawdown; fails excess over cash, DSR and minimum track record |
| Sector momentum | same pattern, weaker |
| Intraday momentum (SPY, late day) | negative net Sharpe, still negative at 2x cost |
| Insider purchases (Form 4) | below passive, 27% drawdown, 7.9% of events had no price |
| Post-earnings drift | no drift in tradable names |

The plan now centers on the epistemic engine ([`plan/08`](./plan/08-epistemic-engine.md)): a Market Link Graph built from SEC filings, GDELT news co-mentions and 13F ownership, an event pipeline, and an LLM that reasons about where each event ripples, checked by an independent verifier. Four sleeves ([`plan/02`](./plan/02-strategy-book.md)) are tested in order: ETF Trend (long-short), Link Momentum (connected-firm momentum), Filing Change, and Event Ripple (LLM ripple reasoning, judged against its rule-based twin). The math is in [`plan/14`](./plan/14-market-link-mathematics.md); the build order is [`plan/07`](./plan/07-build-roadmap.md).

| Area | State |
|---|---|
| Kernel, router, journal, broker transport | built, full C++ gate and sanitizer build pass |
| Partial-fill protection, repair retry, restart redrive | built and tested |
| Account kill inputs (3% daily loss, 15% drawdown latch) | built and tested |
| Early-close calendar, torn-journal-line recovery | built and tested |
| Paper loop on Alpaca paper | runs the passive core; live drills still need an open US session |
| Forward ledgers, benchmarks, evaluator | built; run the passive core and its benchmarks |
| Engine source seam and research graph | built; link graph, events and ripple reasoning not built |
| Shorts in the harness and the kernel | not built (first step of the plan) |
| Any capital stage | not authorized |

`TODO.md` has the itemized checklist. Doc status words: FROZEN-DESIGN (spec locked, not built), IMPLEMENTED (code exists), VERIFIED (acceptance tests pass).

## How a decision is made

```
 public data (SEC, FRED, Treasury, BLS, BEA) + Alpaca market data
                     |
   strategy code  ->  candidate: symbol, side, stop, exit rule
                     |
   optional JEV filter (kept only if it beats "take every candidate")
                     |
   C++ kernel: logged snapshot -> risk rules R1-R20 -> position size
                     |
   HOLD, or BUY / SELL-to-close with a resting stop
                     |
   journal row first -> then the order (Alpaca paper) -> reconcile
```

- Text from research or an LLM never touches an order. Research writes typed facts; thesis text goes to a human-only digest.
- HOLD is the default. Stale data, a broken rule, unsettled cash, an unapproved strategy or conflicting evidence all give HOLD.
- Decisions replay: the same logged snapshot and candidate give the same decision.

Not HFT, not crypto, no leverage, no shorting.

## Running it

From the repo root, in WSL (Ubuntu 24.04), before the US open:

```bash
git pull
bash ops/deploy/start.sh ~/g2        # builds, asks for the STAGE phrase once, waits for the open, starts everything
python3 ops/monitor.py ~/g2          # live view; Ctrl+C closes the view only
bash ops/deploy/start.sh stop        # stops everything
```

`start.sh` builds a copy of the kernel on ext4 and runs its tests, refuses to start if the account already holds positions (unless `ALLOW_POSITIONS=1`), emits the day's candidates once the market is open, starts the loop, and starts the forward ledgers in the background. Restarts and troubleshooting are in [`ops/deploy/README.md`](./ops/deploy/README.md).

## Setup and checks

```bash
cp .env.example .env                                   # fill in locally; keys never go in git, logs or chat
python3 -m pip install -r research/requirements.txt    # Python 3.11+
bash scripts/freeze-check.sh                           # must print FREEZE-CHECK: PASS
cd kernel && WITH_CURL=1 bash build.sh                 # full C++ gate, run as a non-root user
python3 research/tests/test_engine.py                   # each research/tests and collector/tests file runs standalone
```

| Key in `.env` | Used for |
|---|---|
| `ALPACA_KEY_ID`, `ALPACA_SECRET` | the paper loop and market data |
| `OPENROUTER_API_KEY` | JEV shadow and twins (optional, real spend under a cap) |
| `FRED_API_KEY` | the macro-lite ledger and FRED sources (optional) |

## Testing the strategies

A short paper run cannot prove a strategy. At 95% confidence a Sharpe of 1.0 needs about 2.7 years of forward data, 0.75 needs 4.8, and 0.5 needs 10.8. So every sleeve is judged first on history (the backtest gate, over its whole evaluation window), then forward in shadow (the shadow gate), and any AI component is judged against the same sleeve without it. The rules are in [`plan/11`](./plan/11-calibration-and-self-improvement.md).

Rules:

- Register every test in the trial ledger before results exist. The corrections take their trial count from it.
- Judge forward ledgers as paired differences against a benchmark ledger, which removes market beta.
- Keep unrelated hypotheses in separate Holm families.
- Fixed weights, no bandits, no stopping early because it looks good.
- Holdouts that were already looked at stay burned.

| Sessions | State | Meaning |
|---|---|---|
| under 60 | `WARMUP` | plumbing and fidelity only |
| 60 or more | `CONTINUE` | keep running |
| 126 or more | `KILL-FUTILE` | even the best case is below the benchmark |
| 504 or more | `ELIGIBLE-FOR-REVIEW` | only if the corrected p is under 0.05; a human may then review, and nothing is promoted automatically |

`python3 ops/forward_ledgers.py <dir> --verify` replays from fresh data and must reproduce every logged row. A mismatch means look-ahead or revised data.

## Layout

```
plan/        the spec. Start at 00-INDEX. appendix/ holds frozen records; reviews/ is history
kernel/      C++ core: JEV filter, risk veto, sizing, router, runner, paper loop, broker transport
research/    engine/ (the epistemic engine), strategy/ (backtest harness and event data),
             sources/ (data adapters), sandbox/, prereg/, ledger/, reports/, tests/
collector/   Python signal collection and the JEV sidecar
ops/         run tooling: deploy/start.sh, monitor, candidate emitter, forward ledgers,
             evaluator, trial registration, alert relay
scripts/     freeze-check.sh, pre-commit-secrets.sh, sign-stage.sh
data/        local only, gitignored
```

| Component | Where | Role |
|---|---|---|
| Kernel loop | `kernel/runner/paper_loop*.cpp` | reads candidates and the account every 60 s, decides, orders, reconciles |
| Order router | `kernel/exec/router.cpp` | state machine for entry, cancel, repair and exit; keeps stops on |
| Veto engine | `kernel/risk/veto.cpp` | the R-rules as code |
| Journal | `kernel/log/journal.cpp` | hash-chained, written before the order |
| Engine | `research/engine/` | source seam, research graph, spend governor, feature emit |
| Candidate emitter | `ops/emit_candidates.py` | passive-core candidates from market bars |
| Forward ledgers | `ops/forward_ledgers.py` | virtual books on the same engine and cost model |
| Evaluator | `ops/forward_eval.py` | paired stats, Holm, checkpoint state |
| Trial registration | `ops/forward_register.py` | registers each forward ledger in the trial ledger |
| Monitor | `ops/monitor.py` | one terminal view of all of it |

## What is enforced

| Guarantee | How | Checked by |
|---|---|---|
| No order without a prior journal row | kernel ordering | tests and drills |
| No code path promotes a capital stage | none exists | freeze-check |
| Entries hold after a daily loss above 3%; a 15% drawdown latches the kernel kill | paper loop kill inputs | unit tests (not yet end to end on a live venue) |
| Longs keep a stop; a missing stop raises an alert | router and `unprotected-position` alert | unit and drill tests |
| Forward ledgers cannot be rewritten | hash chain per ledger, `--verify` replay | tests |

## Known limits

- A months-long paper run proves the plumbing, not alpha.
- Exits do not cancel resting stops first. Alpaca refuses to sell shares held by open orders, so there is no automated month-end exit yet (finding stop-before-close fix). Any long-or-cash strategy needs this first.
- The 15% drawdown latch uses the kernel's MEDIUM kill, which also flattens positions when the venue is open.
- A repair that still fails after three tries flattens the position.
- Paper fills flatter live results (no queue, no dividends), most for single-stock and intraday strategies.
- Several new pieces have never run against live data: the EDGAR, FRED, OpenRouter and Ken French pulls, and `paper_loop_main.cpp`, which is only built on the operator's machine and in CI.
- PEAD has no forward data source for its registered signal, so it stays retired.

## Security

- Secrets never go in the repo, a log, a prompt or a chat. `scripts/pre-commit-secrets.sh` and `.gitleaks.toml` guard commits.
- The loop directory lives on ext4 with a lock; a second loop refuses to start.
- Research code cannot touch the journal, HALT, the stage chain, candidates or broker keys.
- The STAGE file is written only by `scripts/sign-stage.sh`; the agent never signs it.
- LLM evidence only counts after the model's knowledge cutoff plus 30 days.

## Rules

- No code path promotes a capital stage. Demotion is automatic; promotion is a person, in chat, with evidence.
- Risk limits R1 to R20 are code constants. Changing one needs a doc edit, a version bump and a fresh paper window.
- The kernel enforces a cash account, long only, 1x, allowlisted US stocks and ETFs (India set). Research targets a US margin account, long and short (US set), which is not in force until the doc 05 §5.6 risk amendment is adopted.
- A journal row is written before every order.
- Every backtest goes through the trial ledger.
- Version-marked identifiers pinned by hashes or ledgers (`baseline_v1`, `cost_v2`, `exit_*_v1`, and so on) are never renamed.

Details: [`plan/05`](./plan/05-risk-and-determinism.md), [`plan/10`](./plan/10-capital-gates-and-spend-control.md), [`plan/11`](./plan/11-calibration-and-self-improvement.md).

## Docs

`plan/` is the spec; code implements it and does not invent behaviour. Docs 08 to 11 never weaken a rule in docs 01 to 07.

| Read | For |
|---|---|
| [`plan/00-INDEX.md`](./plan/00-INDEX.md) | where to start |
| [`plan/appendix/10-sleeve-integration-plan.md`](./plan/appendix/10-sleeve-integration-plan.md) | the testing program |
| [`plan/appendix/11-sleeve-evidence-review.md`](./plan/appendix/11-sleeve-evidence-review.md) | what the literature says about each strategy |
| [`plan/reviews/2026-09-29-alpha-results.md`](./plan/reviews/2026-09-29-alpha-results.md) | the five gate results |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | components and data flow |
| [`ops/deploy/README.md`](./ops/deploy/README.md) | run, restart, stop, troubleshoot |
| [`TODO.md`](./TODO.md) | the checklist |

The `arena` branch holds an archived crypto bot from an earlier hackathon.

## Contributing

Read [`AGENTS.md`](./AGENTS.md) first: no code without a plan box, every backtest through the harness, no secrets in the repo. CI runs the collector and research suites, the full C++ gate, the sanitizer build and `freeze-check`.

## License

No license chosen yet; all rights reserved by the repository owner.
