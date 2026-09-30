<div align="center">

# MiroHedge

**Algorithmic trading system with a deterministic C++ risk engine, Alpaca paper trading and pre-registered backtesting.**

*Systematic US stock and ETF strategies (trend following, momentum, insider, earnings drift), walk-forward validation with deflated Sharpe and multiple-testing control, an optional LLM trade filter, and a rule that nothing touches money until it beats the boring alternative net of every cost.*

[![CI](https://img.shields.io/github/actions/workflow/status/Drix10/hypothesis-arena/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/Drix10/hypothesis-arena/actions/workflows/ci.yml)
![Stage](https://img.shields.io/badge/stage-G0%20paper%20only-blue?style=flat-square)
![Capital](https://img.shields.io/badge/capital-none%20live-brightgreen?style=flat-square)
![Kernel](https://img.shields.io/badge/kernel-C%2B%2B17-00599C?style=flat-square&logo=cplusplus&logoColor=white)
![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white)

</div>

**MiroHedge** is a research-first **quantitative trading system** for US stocks and ETFs: a cash account, long only, 1x, allowlisted symbols, **paper trading on Alpaca** only. It combines a **C++17 execution and risk kernel**, a **Python backtesting and strategy-research harness**, and a forward-testing program for every strategy it has built. It is built around one rule: **a strategy earns the right to place an order by passing a pre-registered backtest gate, then a forward test, then a human sign-off**, and the system is designed to say "no" far more often than "yes".

Under the hood: hash-chained order journal, risk rules R1-R19, bracket and stop-loss protection, walk-forward and purged cross-validation, deflated Sharpe ratio (DSR), probability of backtest overfitting (PBO), Holm multiple-testing correction, transaction-cost modelling, SEC EDGAR / FRED / Treasury / BLS / BEA data adapters, and an LLM filter (JEV) that is kept only if it improves results after its own cost.

Trading systems fail quietly. The strategy is usually not the problem. What goes wrong is everything around it:

- a backtest that was quietly re-run until one variant looked good;
- a stop that silently disappears when an order is partly filled;
- an AI model that "knew" the answer because the event was in its training data;
- a 3-month paper run declared a success on a Sharpe ratio it cannot statistically support.

MiroHedge is the layer that catches these:

| | What it does | How it is enforced |
|---|---|---|
| 🧱 **Deterministic kernel** | A C++ core turns a logged snapshot and a candidate into HOLD, BUY or SELL-to-close with a size and a stop. Same input, same decision, bit for bit. | Replay tests, sanitizer build, fault drills against a mock venue |
| 🛑 **Risk rules R1–R19** | Concentration, loss caps, volatility trips, unsettled cash, stale data, unapproved strategy: any breach is a HOLD. Limits are code constants. | Veto engine in the kernel; a change needs a doc edit, a version bump and a fresh paper window |
| 🧾 **Journal first** | A hash-chained journal row is written before every order. Editing or deleting a row is detectable. | Chain verified on start, on every cycle and by the monitor |
| 🛡️ **Protected positions** | Every long carries a resting stop. Partial fills are re-protected, repairs retry, restarts resume, and an `unprotected-position` alert fires if a stop is missing. | Router state machine, runner tests, monitor `NO STOP` flag |
| 🧪 **Pre-registered research** | Every backtest is registered in a global trial ledger *before* results exist. Multiple-testing corrections take their count from that ledger only. | `research/strategy/` harness, hash-chained `research/ledger/` |
| 📊 **Forward evaluation** | Every built strategy and its benchmarks run as virtual ledgers on live data, judged only as paired differences against a benchmark, with pooled Holm correction and kill-only checkpoints. | `ops/sleeve_shadow.py`, `ops/sleeve_eval.py`, `plan/appendix/10` |
| 🤖 **AI as a filter, not a trader** | The JEV LLM filter may veto candidates. It is admitted only on a strategy that passes its gate, after 200 decisions + 100 closed simulated trades with calibration at or above base rate, and it stays only if the filtered policy beats "take everything" after its own cost, on post-cutoff data. | Paired twin ledgers, spend caps, one candidate-bound contract |
| 🔭 **One live view** | Kernel, orders, positions, stops, every strategy ledger and every evaluation state in one terminal view. | `python3 ops/monitor.py <dir>` |

Nothing here can promote a capital stage. Demotion is automatic; promotion is a human, in chat, with evidence.

---

## Where things stand

**Honest status, 2026-09-30.** The plumbing is built and green. The strategies are not good enough yet.

| Strategy | Type | A-gate on the frozen holdout | What that means |
|---|---|---|---|
| **T1** trend, ETFs | monthly, long-or-cash | ❌ near miss | Sharpe about equal to passive with a smaller drawdown; fails excess-over-cash, DSR, minimum track record |
| **T2** sector momentum | monthly, top-3 | ❌ near miss | same pattern, weaker |
| **I1** intraday momentum | SPY, late day | ❌ clear | negative net Sharpe, negative at 2x cost |
| **E1** insider purchases | Form 4, 21-session hold | ❌ clear | below passive, 27% drawdown, 7.9% of events unpriced |
| **E2** post-earnings drift | SEC datasets | ❌ clear | no drift in tradable names |
| **Passive core** (VTI/IEF) | buy and hold | n/a | the plumbing test; it is a benchmark, not a sleeve |

So: **no strategy is a promotion candidate**, and the paper run exercises the execution stack with the passive core. The other strategies keep running as log-only forward ledgers (below) to find out whether their failure persists on data nobody has looked at, and a long-history study asks whether the published effects still exist at all.

| Area | State |
|---|---|
| Kernel, router, journal, broker transport | ✅ built; full C++ gate and sanitizer build green |
| Partial-fill protection, repair retry, restart redrive | ✅ built and tested (this cycle) |
| Account kill inputs (3% daily loss, 15% drawdown latch) | ✅ built and tested |
| Paper loop on real Alpaca paper | 🟡 runs; live drills still need an open US session |
| Forward ledgers, benchmarks, evaluator | ✅ built; not yet run on live data |
| JEV paired twins, macro-lite, event sleeves | ✅ built; need API keys, not yet run live |
| Long-history study (Track L) | ✅ built; awaiting its one real run |
| Netting router, exit-past-stops sequence | ⏸️ deliberately not built (no champion needs it) |
| Any capital stage | 🚫 not authorized |

`TODO.md` is the itemized checklist. Status words in the docs: FROZEN-DESIGN (spec locked, not built), IMPLEMENTED (code exists), VERIFIED (acceptance green).

---

## How a trade is decided

```
 free public data (SEC, FRED, Treasury, BLS, BEA)  +  Alpaca SIP market data
                          │
        strategy sleeve (deterministic code) ──▶ candidate: symbol, side, stop, exit rule
                          │
        optional JEV filter  ── kept only if it beats "take every candidate" ──┐
                          │                                                    │
        C++ kernel: frozen snapshot ─▶ risk rules R1-R19 ─▶ position size      │ log-only twin
                          │                                                    │ ledger
          HOLD   or   BUY / SELL-to-close with a resting stop  ◀───────────────┘
                          │
        journal row first ─▶ then the order (Alpaca paper) ─▶ reconcile
```

1. **Prose never touches money.** Research writes typed facts; thesis text goes to a human-only digest.
2. **HOLD is the default.** Stale data, a breached rule, unsettled cash, an unapproved strategy or conflicting evidence all produce HOLD.
3. **Everything replays.** The same logged snapshot and candidate give the same decision.

Not HFT, not crypto, not leveraged, no short selling. The fast core buys determinism and reliable exits, not a latency edge.

---

## 30 seconds

You are at the keyboard before the US open. From the repo root, in WSL (Ubuntu 24.04):

```bash
git pull
bash ops/deploy/start.sh ~/g2        # build, sign the STAGE phrase once, wait for the open, start everything
python3 ops/monitor.py ~/g2          # live view; Ctrl+C closes the view only, the run continues
```

`start.sh` builds a copy of the kernel on ext4 and gates it, refuses to start if the account already holds positions (unless `ALLOW_POSITIONS=1`), emits the day's candidates only once the market is open, starts the loop, and launches the forward ledgers in the background. The monitor then shows, on one screen:

```
 MiroHedge G0 paper monitor        loop · candidates · decisions
 ORDER JOURNAL    chain intact     ALPACA PAPER (live)   positions · stop ok / NO STOP
 JEV SHADOW       verdicts         SLEEVE SHADOW LEDGERS  equity · return · kill-limit flag · EVAL state
```

Stop everything with `bash ops/deploy/start.sh stop`. Restarts, manual commands and troubleshooting: [`ops/deploy/README.md`](./ops/deploy/README.md).

---

## Install and check

```bash
cp .env.example .env                                   # fill locally; keys never go in git, a log or a chat
python3 -m pip install -r research/requirements.txt    # Python 3.11+
bash scripts/freeze-check.sh                           # must print FREEZE-CHECK: PASS
cd kernel && WITH_CURL=1 bash build.sh                 # full C++ gate, as a non-root user
python3 research/tests/test_plane.py                   # every research/tests/test_*.py and collector/tests/test_*.py runs standalone
```

| Key in `.env` | Needed for |
|---|---|
| `ALPACA_KEY_ID`, `ALPACA_SECRET` | the paper loop and market data |
| `OPENROUTER_API_KEY` | JEV shadow and the paired twins (optional, real spend under a cap) |
| `FRED_API_KEY` | the macro-lite ledger and FRED sources (optional) |

---

## The testing program

The built strategies cannot be proven by a short paper run: at 95% confidence a Sharpe of 1.0 needs about 2.7 years of forward data, 0.75 needs 4.8, and 0.5 needs 10.8. So the program uses four evidence tracks that never mix. Full protocol: [`plan/appendix/10`](./plan/appendix/10-sleeve-integration-plan.md); evidence base: [`plan/appendix/11`](./plan/appendix/11-sleeve-evidence-review.md).

```
                ┌─ Track L  long history (decades)   French industry data 1926+, post-publication decay
 built          ├─ Track F  forward ledgers          every sleeve + benchmarks, virtual, from 2026-09-30
 strategies ───▶├─ Track J  JEV paired twins         filtered vs unfiltered on identical post-cutoff candidates
                └─ Track R  real orders              passive core only, judged on operations not Sharpe
```

| Rule | Why |
|---|---|
| Register in the trial ledger **before** results | the count of everything tried feeds every correction |
| Judge only **paired differences** against a benchmark ledger | removes market beta; the most powerful test available |
| One **pooled Holm** correction over all forward ledgers | twelve ledgers is twelve chances to be fooled |
| Fixed weights, no bandits, no stopping early for success | short samples lock in noise |
| The burned holdouts stay burned | only data after 2026-09-01 is new information |

| Sessions | State | What it can do |
|---|---|---|
| under 60 | `WARMUP` | plumbing and fidelity only |
| 60 or more | `CONTINUE` | keeps running |
| 126 or more | `KILL-FUTILE` | when even the best case is below the benchmark |
| 504 or more | `ELIGIBLE-FOR-REVIEW` | only with corrected p under 0.05; a human *may* review, never a promotion |

Fidelity gate: `python3 ops/sleeve_shadow.py <dir> --verify` replays from fresh data and must reproduce every logged row; a mismatch means look-ahead or revised data.

---

## Layout

```
plan/         the spec. 00-INDEX first; appendix/ = frozen records and the testing program; reviews/ = history
kernel/       C++ core: JEV filter, risk veto, sizing, router, runner, paper loop, broker transport
research/     strategy/ (harness, sleeves, long-history study), sources/ (data adapters),
              plane/ (LLM research pipeline), sandbox/ (worker isolation), prereg/, ledger/, reports/, tests/
collector/    Python: macro and filing signal collection, and the JEV sidecar
ops/          paper-run tooling: deploy/start.sh, monitor, candidate emitter, forward ledgers,
              evaluator, trial registration, long-history fetch and run, alert relay
scripts/      freeze-check.sh, pre-commit-secrets.sh, sign-stage.sh
data/         local only, gitignored
```

| Component | Where | What it does |
|---|---|---|
| Kernel loop | `kernel/runner/paper_loop*.cpp` | reads candidates and the account every 60 s, decides, orders, reconciles |
| Order router | `kernel/exec/router.cpp` | state machine for entry, cancel, repair, exit; stops are never left off |
| Veto engine | `kernel/risk/veto.cpp` | R1–R19 as code |
| Journal | `kernel/log/journal.cpp` | hash-chained, written before the order |
| Candidate emitter | `ops/emit_candidates.py` | passive-core candidates from SIP bars |
| Forward ledgers | `ops/sleeve_shadow.py`, `event_shadow.py`, `macro_shadow.py` | virtual books on the same engine and `cost_v2` |
| JEV twins | `ops/jev_twin.py` | filtered twin of each ledger, paired report |
| Evaluator | `ops/sleeve_eval.py` | paired stats, Holm, checkpoint state |
| Trial registration | `ops/forward_register.py` | opens the forward program in the trial ledger |
| Long-history study | `research/strategy/long_history.py`, `ops/long_history_*.py` | canonical rules over decades, decay by sub-period |
| Monitor | `ops/monitor.py` | one terminal view of all of it |

---

## What is enforced, and what is not

Being straight about this is the point of the project.

| Guarantee | Enforced by | Verified |
|---|---|---|
| No order without a prior journal row | kernel ordering | tests + drills |
| No promotion of a capital stage by code | no such code path exists | freeze-check |
| Entries hold on daily loss above 3%; a drawdown of 15% latches the kernel kill | paper loop kill inputs | unit tests (not yet end to end on a live venue) |
| Longs keep a stop; a missing stop raises an alert | router + `unprotected-position` alert | unit and drill tests |
| Forward ledgers cannot be rewritten | hash chain per ledger, replay `--verify` | tests |

## Honest limits

- **A months-long paper run proves plumbing, not alpha.** Nothing here claims otherwise.
- **Exits do not cancel resting stops first.** Alpaca refuses a sell of shares held by open orders, so there is no automated month-end exit yet (finding K5). It is the prerequisite for any long-or-cash champion.
- **The 15% drawdown latch uses the kernel's MEDIUM kill**, which also flattens positions when the venue is open.
- **A repair that still fails after three tries flattens the position.**
- **Early closes** (2026-11-27, 2026-12-24) are not in the calendar; those days hold entries.
- **Paper fills flatter live results** (no queue, no dividends), most for single-stock and intraday sleeves.
- **Several new pieces have never run against live data**: the EDGAR, FRED, OpenRouter and Ken French pulls, and `paper_loop_main.cpp` was only compiled on the operator's machine.
- **PEAD has no forward data source** for its registered signal, so it stays retired.

## Security

- Secrets never enter the repo, a log, a prompt or a chat; `scripts/pre-commit-secrets.sh` and `.gitleaks.toml` guard commits.
- The loop directory lives on ext4 with a lock; a second loop refuses to start.
- Research cannot touch the journal, HALT, the stage chain, candidates or broker keys.
- The STAGE file is written only by `scripts/sign-stage.sh`; the agent never signs.
- LLM evidence counts only after the model's knowledge cutoff plus 30 days.

## Rules

- No code path promotes a capital stage. Demotion is automatic.
- Risk limits R1–R19 are code constants; a change needs a doc edit, a version bump and a fresh paper window.
- Live scope is a cash account, long only, 1x, allowlisted US stocks and ETFs.
- A journal row is written before every order.
- Every backtest goes through the trial ledger.
- Version-marked identifiers pinned by hashes or ledgers (`baseline_v1`, `cost_v2`, `exit_*_v1`, …) are never renamed.

Details: [`plan/05`](./plan/05-risk-and-determinism.md), [`plan/10`](./plan/10-capital-gates-and-spend-control.md), [`plan/11`](./plan/11-calibration-and-self-improvement.md).

## Spec and docs

`plan/` is the source of truth; code implements it and never invents it. Start at [`plan/00-INDEX.md`](./plan/00-INDEX.md). Docs 08–11 never weaken a rule in docs 01–07.

| Read | For |
|---|---|
| [`plan/appendix/10-sleeve-integration-plan.md`](./plan/appendix/10-sleeve-integration-plan.md) | the testing program |
| [`plan/appendix/11-sleeve-evidence-review.md`](./plan/appendix/11-sleeve-evidence-review.md) | what the literature says about each strategy |
| [`plan/reviews/2026-09-29-alpha-results.md`](./plan/reviews/2026-09-29-alpha-results.md) | the five A-gate results |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | components and data flow |
| [`ops/deploy/README.md`](./ops/deploy/README.md) | run, restart, stop, troubleshoot |
| [`TODO.md`](./TODO.md) | the itemized checklist |

The `arena` branch holds an archived crypto bot from an earlier hackathon.

## Contributing

Read [`AGENTS.md`](./AGENTS.md) first: no code without a plan box, every backtest through the harness, secrets never in the repo. CI runs every collector and research suite, the full C++ gate, the sanitizer build and `freeze-check`.

## License

No license file has been chosen yet; all rights reserved by the repository owner.
