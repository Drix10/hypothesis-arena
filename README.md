# MiroHedge

A paper-trading system for US stocks and ETFs: a deterministic C++ risk and execution kernel, a Python research engine and backtest harness, and pre-registered strategy testing. Alpaca paper only. No real money is involved.

## What this is

The bet: news about one company reaches its suppliers, customers, peers and co-mentioned firms days to months late, and an engine that reads filings and global news can map those links and trade the ripple. The kernel today runs a cash account, long only, 1×, on allowlisted symbols; the research target is a US margin account that may short (see [`plan/vision.md`](./plan/vision.md)). The process rule is simple: a strategy places orders only after it passes a backtest registered before it was run, then a forward test, then a human signs off. Most strategies will not get through, and that is expected.

The parts:

- a C++17 kernel that decides HOLD, BUY or SELL-to-close, sizes the position, and manages orders and stops;
- risk rules written as code constants ([`plan/risk.md`](./plan/risk.md));
- a hash-chained order journal, written before every order;
- a Python research harness: walk-forward and purged cross-validation, deflated Sharpe, probability of backtest overfitting, Holm correction and a transaction-cost model;
- data adapters for SEC EDGAR, FRED, Treasury, BLS and BEA;
- an engine that builds a link graph and verifies model reasoning before it becomes a typed feature ([`plan/engine.md`](./plan/engine.md)).

Trading systems mostly fail in the surrounding code, not the strategy: a backtest re-run until one variant looks good, a stop that disappears on a partial fill, a model that "predicts" an event it saw in training, a short paper run called a success on a Sharpe ratio it cannot support. This repo is built around catching those.

## Status

The plumbing works. No strategy is live, even on paper, and none has passed a gate.

The plan centers on four strategies, tested in order: ETF Trend (long-short), Link Momentum (connected-firm momentum), Filing Change, and Event Ripple (a language model reasons about where an event ripples, judged against its rule-based twin). They are in [`plan/strategies.md`](./plan/strategies.md); the build order is [`plan/roadmap.md`](./plan/roadmap.md).

| Area | State |
|---|---|
| Kernel, router, journal, broker transport | built; the full C++ gate and the sanitizer build pass |
| Partial-fill protection, repair retry, restart redrive | built and tested |
| Account kill inputs (3% daily loss, 15% drawdown latch) | built and tested |
| Early-close calendar, torn-journal-line recovery | built and tested |
| Paper loop on Alpaca paper | runs the passive core; live drills still need an open US session |
| Forward ledgers, benchmarks, evaluator | built; run the passive core and its benchmarks |
| Engine source seam and research graph | built; link graph, events and ripple reasoning not built |
| Shorts in the harness and the kernel | not built (the first step of the plan) |
| Any capital stage | not authorized |

[`TODO.md`](./TODO.md) has the itemized checklist.

## How a decision is made

```
 public data (SEC, FRED, Treasury, BLS, BEA) + Alpaca market data
                     |
   strategy code  ->  candidate: symbol, side, stop, exit rule
                     |
   C++ kernel: logged snapshot -> risk rules -> position size
                     |
   HOLD, or BUY / SELL-to-close with a resting stop
                     |
   journal row first -> then the order (Alpaca paper) -> reconcile
```

- Text from research or a model never touches an order. Research writes typed facts; thesis text goes to a human-only digest.
- HOLD is the default. Stale data, a broken rule, unsettled cash, an unapproved strategy or conflicting evidence all give HOLD.
- Decisions replay: the same logged snapshot and candidate give the same decision.

Not high-frequency, not crypto, no leverage, no shorting in the kernel yet.

## Running the paper loop

The paper loop is a plumbing test of the order path. It trades the passive core and nothing else, and it is not evidence for any strategy: `plan/roadmap.md` lists what has to exist before a strategy can run on paper. From the repo root, in WSL (Ubuntu 24.04), before the US open:

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
bash scripts/check-manifest.sh                         # must print CHECK-MANIFEST: PASS
cd kernel && WITH_CURL=1 bash build.sh                 # full C++ gate, run as a non-root user
python3 research/tests/test_engine.py                  # each research/tests and collector/tests file runs standalone
```

| Key in `.env` | Used for |
|---|---|
| `ALPACA_KEY_ID`, `ALPACA_SECRET` | the paper loop and market data |
| `OPENROUTER_API_KEY` | research model calls (optional, real spend under a cap) |
| `FRED_API_KEY` | FRED sources (optional) |

## Testing the strategies

A short paper run cannot prove a strategy. At 95% confidence a Sharpe of 1.0 needs about 2.7 years of forward data, 0.75 needs 4.8, and 0.5 needs 10.8. So every strategy is judged first on history (the backtest gate, over its whole evaluation window), then forward in shadow (the shadow gate), and any model component is judged against the same strategy without it. The rules are in [`plan/validation.md`](./plan/validation.md).

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
plan/        the spec. Start at plan/README.md. appendix/ holds binding implementation records
kernel/      C++ core: risk veto, sizing, router, runner, paper loop, broker transport
research/    engine/ (the engine), strategy/ (backtest harness and event data),
             sources/ (data adapters), sandbox/, prereg/, ledger/, reports/, tests/
collector/   Python signal collection
ops/         run tooling: deploy/start.sh, monitor, candidate emitter, forward ledgers,
             evaluator, trial registration, alert relay
scripts/     check-manifest.sh, pre-commit-secrets.sh, sign-stage.sh
data/        local only, gitignored
```

| Component | Where | Role |
|---|---|---|
| Kernel loop | `kernel/runner/paper_loop*.cpp` | reads candidates and the account every 60 s, decides, orders, reconciles |
| Order router | `kernel/exec/router.cpp` | state machine for entry, cancel, repair and exit; keeps stops on |
| Veto engine | `kernel/risk/veto.cpp` | the risk rules as code |
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
| No code path promotes a capital stage | none exists | check-manifest |
| Entries hold after a daily loss above 3%; a 15% drawdown latches the kernel kill | paper loop kill inputs | unit tests (not yet end to end on a live venue) |
| Longs keep a stop; a missing stop raises an alert | router and the `unprotected-position` alert | unit and drill tests |
| Forward ledgers cannot be rewritten | hash chain per ledger, `--verify` replay | tests |

## Known limits

- A months-long paper run proves the plumbing, not alpha.
- Exits do not cancel resting stops first. Alpaca refuses to sell shares held by open orders, so there is no automated month-end exit yet (the stop-before-close fix in `TODO.md`). Any long-or-cash strategy needs this first.
- The 15% drawdown latch uses the kernel's MEDIUM kill, which also flattens positions when the venue is open.
- A repair that still fails after three tries flattens the position.
- Paper fills flatter live results (no queue, no dividends), most for single-stock and intraday strategies.
- Several pieces have never run against live data: the EDGAR, FRED, OpenRouter and Ken French pulls, and `paper_loop_main.cpp`, which is only built on the operator's machine and in CI.

## Security

- Secrets never go in the repo, a log, a prompt or a chat. `scripts/pre-commit-secrets.sh` and `.gitleaks.toml` guard commits.
- The loop directory lives on ext4 with a lock; a second loop refuses to start.
- Research code cannot touch the journal, HALT, the stage files, candidates or broker keys.
- The `STAGE` file is written only by `scripts/sign-stage.sh`; the agent never signs it.
- Model evidence counts only after the model's knowledge cutoff plus 30 days.

## Rules

- No code path promotes a capital stage. Demotion is automatic; promotion is a person, in chat, with evidence.
- The risk rules are code constants. Changing one needs a doc edit and a fresh paper window.
- The kernel enforces a cash account, long only, 1×, allowlisted US stocks and ETFs (the India set). Research targets a US margin account, long and short (the US set), which is not in force until kernel short selling is built.
- A journal row is written before every order.
- Every backtest goes through the trial ledger.

Details: [`plan/risk.md`](./plan/risk.md), [`plan/stages.md`](./plan/stages.md), [`plan/validation.md`](./plan/validation.md).

## Docs

`plan/` is the spec; code implements it and does not invent behavior.

| Read | For |
|---|---|
| [`plan/README.md`](./plan/README.md) | where to start |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | components and data flow |
| [`ops/deploy/README.md`](./ops/deploy/README.md) | run, restart, stop, troubleshoot |
| [`TODO.md`](./TODO.md) | the checklist |

The `arena` branch holds an archived crypto bot from an earlier hackathon.

## Contributing

Read [`AGENTS.md`](./AGENTS.md) first: no code without a plan box, every backtest through the harness, no secrets in the repo. CI runs the collector and research suites, the full C++ gate, the sanitizer build and `check-manifest`.

## License

No license chosen yet; all rights reserved by the repository owner.
