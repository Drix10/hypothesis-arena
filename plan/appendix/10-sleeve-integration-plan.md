# Testing program for the built sleeves (rev 2, 2026-09-30)

Status: operating protocol under docs 07, 11 and 12; it adds no gate and
relaxes none. Evidence base: `11-sleeve-evidence-review.md`. Recorded by the
agent on the operator's instruction in chat, 2026-09-30 ("plan the best
testing strategy for all of these, update all plan docs, then code").

## 1. Where things stand (from the trial ledger and `research/reports/`)

All five built sleeves have run their A-gate (doc 11 §11.3a) on the frozen
2023-09-01..2026-08-31 holdout and all failed:

| Sleeve | Result | Why |
|---|---|---|
| T1 trend (ma10, mom12) | FAIL | near miss: Sharpe about equal to the vol-matched passive, smaller drawdown; excess-over-cash CI, DSR, MinTRL fail |
| T2 sector momentum | FAIL | same pattern, weaker |
| I1 intraday momentum | FAIL, clearly | negative Sharpe, negative at 2x cost |
| E1 insider | FAIL, clearly | Sharpe below passive, drawdown 27%, 7.9% of events unpriced |
| E2det PEAD | FAIL, clearly | no drift in tradable names |

Consequences that override the earlier draft of this appendix:
1. No sleeve is a promotion candidate. Doc 07 §7.6 allows exactly one
   champion through the kernel (G0b), and none exists. The g2 run is a
   plumbing test with the passive core; it is not a sleeve.
2. The netting router is not on the critical path. It is needed only
   when two or more sleeves trade the same account (after G1). The exit
   sequence for shares held by stop legs (K5) is the real prerequisite for
   any long-or-cash champion.
3. The burned holdouts stay burned. Nothing here re-tunes on
   2016-2026-08. Only data after 2026-09-01 is new information.
4. A 3-year holdout cannot discriminate a Sharpe of 0.5-1 anyway:
   minimum track record (1.645/S)^2 years is 2.7 y at S=1.0, 4.8 y at 0.75,
   10.8 y at 0.5. This is why T1/T2 fail on DSR/MinTRL even with a holdout
   Sharpe near 1.3 (a bull market).

## 2. Strategy: four evidence tracks, run concurrently, never mixed

The best test of "does this already-published thing work" is not another
short forward test; it is long data. So:

- **Track L (long history, decades):** the canonical trend and industry
  momentum rules on Ken French daily industry portfolios (1926+), judged by
  post-publication sub-periods and the decay ratio (McLean-Pontiff).
  Pre-registered (`research/prereg/l1_long_history_v1.json`), run once per
  data vintage, three trials counted in the global N. Answers "does the
  effect still exist, and how much has it decayed" with 100 years of power.
  Not promotion evidence (doc 11 §11.0d: it is not the live constraint set);
  it sets the prior that decides whether a sleeve is worth forward time.
- **Track F (forward replication ledgers, from 2026-09-30):** every built
  sleeve plus its controls runs as a virtual ledger on live data
  (`ops/sleeve_shadow.py`, `ops/event_shadow.py`, `ops/macro_shadow.py`), all
  on the identical engine, `cost_v2`, next-open fills, settled cash, all
  registered in the trial ledger before any result
  (`ops/forward_register.py`). Question asked: does the failed A-gate
  hypothesis hold on untouched data, and how does it track its own replay.
  These are research observations under doc 11 §11.2; they are not
  challengers of a champion (there is none), so the "3 challengers" cap does
  not apply, and they consume no capital and no AI spend except Track J.
- **Track J (JEV paired A/B, `ops/jev_twin.py`):** doc 11 §11.3b. Each
  ledger's twin drops the adds the JEV vetoes; the test is filtered minus
  unfiltered on identical post-cutoff candidates, >= 100 resolved decisions.
  Spend stays under the doc 10 §10.4 caps; without OPENROUTER_API_KEY it does
  nothing.
- **Track R (real orders):** only the passive core through the kernel (g2).
  Judged on fidelity and operations, never on Sharpe.

## 3. Controls and benchmarks (doc 12 §12.6, all as ledgers)

`bench_cash_bil_v1` (cash), `bench_ew_trend_v1` and `bench_ew_sector_v1`
(equal-weight buy-and-hold of each sleeve's own universe, the vol-matched
passive counterpart), `bench_spy_v1` (equity sleeves), `core_passive_v1`
(60/40 sanity reference and the macro-lite baseline). Every sleeve is scored
only as a paired daily difference against its mapped benchmark
(`ops/sleeve_eval.py` `MAPPING`); paired differences remove market beta and
are the most powerful test available. Benchmarks are not trials.

## 4. Statistics (doc 11 §11.0b, applied to the forward program)

- One pooled Holm correction over every non-benchmark, non-twin forward
  ledger (a ledger with no computable p counts as p=1, so the family never
  shrinks); a separate Holm over the JEV twins. N in DSR comes only from the
  ledger.
- Test statistic: HAC t of the daily paired difference, stationary-bootstrap
  95% CI on the annualised active return, information ratio, tracking error.
- Power is reported per ledger ((1.645/IR)^2 years to reach one-sided 95%) so
  nobody reads a short window as evidence.
- New non-literature signals (macro-lite, twins): t >= 3.0 on the difference
  to the mapped baseline, not to zero.

## 5. Checkpoints and pre-set actions (implemented in `ops/sleeve_eval.py`)

| Sessions | State | What it can do |
|---|---|---|
| < 60 | WARMUP | plumbing and fidelity only; no judgement |
| >= 60 | CONTINUE | B-gate window for a sleeve that has passed an A-gate (none yet) |
| >= 126 | KILL-FUTILE if the 95% CI UPPER bound of the annualised active return is < 0 | stop spending attention (ledger stays, marked) |
| >= 504 (2 y) | ELIGIBLE-FOR-REVIEW only if Holm-adjusted p < 0.05, CI lower bound > 0 and drawdown not larger than the benchmark's | a human MAY review; it is never a promotion |

Weights and specs are fixed for the whole program; no bandit reallocation, no
early stopping for success. A spec change opens new trials.

## 6. Fidelity gate (does the book equal the strategy)

`python3 ops/sleeve_shadow.py <dir> --verify` replays from fresh data and
must reproduce every logged row within 20 bp, else look-ahead or revised
data (exit 1). The hash chain of every ledger is checked by the evaluator on
every pass (CHAIN-BROKEN excludes a ledger and exits 3).

## 7. What runs, and how the pieces fit

`start.sh` starts the kernel loop (real orders, core only) and one background
job (`sleeve_shadow.py --loop`, hourly after close) that: registers the
forward program in the trial ledger once; writes every sleeve, event-sleeve,
macro-lite, benchmark and JEV-twin ledger to `<dir>/sleeves/`; writes
`status.json` (per-sleeve drawdown flags, soft -15%, hard -20% for a 10%
volatility target) and `eval.json` (paired statistics, Holm, checkpoint
state); the monitor shows all of it. Track L is run by hand on a networked
host: `python3 ops/long_history_fetch.py` then `python3 ops/long_history_run.py`.

## 8. Decision tree after the first evidence

1. Track L shows a sleeve's effect is gone post-publication (decay ratio CI
   includes <= 0): retire it from Track F, keep it as history.
2. Track L shows it persists: the forward ledger keeps running; a new
   pre-registration on the FORWARD window (never the burned holdout) with the
   canonical spec is written before the 2-year checkpoint, and only then can
   the A-gate be re-run on data that did not exist at registration.
3. Only a sleeve that passes its A-gate then enters the B-gate, then the
   human picks the single G0b champion. The netting router and the K5 exit
   sequence are built only when a champion needs them.

## 9. Not covered

PEAD has no forward data source for its registered signal (SEC Financial
Statement Data Sets are published after each quarter); it stays retired.
Event-day flags need a dated FOMC/CPI/NFP calendar that the repo lacks.
The kernel's account-level kill inputs (3% daily loss entry hold, 15%
drawdown latch into the MEDIUM kill) are live in g2; per-sleeve limits are
reported only.
