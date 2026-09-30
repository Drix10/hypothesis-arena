# Sleeve integration plan (2026-09-30)

Status: operating plan for G0a/G0b. It does not change any frozen contract;
where it touches one it says so. Evidence base (full text in `11-sleeve-evidence-review.md`): the 2026-09-30 literature
review (McLean-Pontiff 2016, Moskowitz-Ooi-Pedersen 2012, Hurst-Ooi-Pedersen,
Faber 2007/2017, Moskowitz-Grinblatt 1999, Cohen-Malloy-Pomorski 2012,
Martineau 2022, Gao-Han-Li-Zhou 2018, Harvey et al. 2018, Kaminski-Lo 2014,
Bailey-Lopez de Prado 2014, Harvey-Liu-Zhu 2016, Lopez-Lira-Tang and the
lookahead-bias papers, Goyal-Welch-Zafirov 2024, AQR macro momentum).

## 1. The statistical fact that shapes everything

A forward paper test cannot prove an edge. Minimum track record at 95% one
sided is about (1.645/S)^2 years: 2.7 y at Sharpe 1.0, 4.8 y at 0.75, 10.8 y
at 0.5. So a paper run is judged on **fidelity, cost calibration and
operational integrity**, never on its own Sharpe. Whether an edge exists is
decided by the pre-registered out-of-sample backtest (DSR, PBO, t>3 for new
signals, a 50% haircut on published effects) plus a forward record that
stays inside the backtest's band. Weights stay fixed and preregistered for 12
months; no bandit reallocation. Sequential tests may only kill a sleeve.

## 2. Tiers

| Sleeve | Tier now | Reason |
|---|---|---|
| core_passive_v1 (VTI/IEF) | R: real paper orders | beta benchmark; proves plumbing |
| trend_etf_v1 (T1, ma10 / 12m) | S now, R after fidelity gate | strongest evidence, but needs the netting router first |
| sector_mom_v1 (T2, 12-1) | S now, R at 10-15% risk after gate | evidence split post-2000; merge with T1 if forward correlation > 0.7 |
| insider (E1) | S | real but decayed since 2008; opportunistic buys only, acceptance-time entry |
| PEAD (E2det) | S, probable drop | large-cap drift gone since ~2006; only the text variant is worth watching, on post-cutoff data |
| intraday_mom (I1) | S, separate paper account if ever routed | R^2 ~1-2%, needs real-time data and MOC |
| macro overlays | S | only macro-momentum has evidence; levels are noise |
| JEV filter / research plane | S, paired A/B | post-cutoff data only, anonymised prompts, model pinned |

Tier R = orders reach the broker. Tier S = virtual ledger only (`cost_v2`,
next-open fills, settled cash).

## 3. Architecture (single book, many ledgers)

- Sleeves emit **target weights**, never orders.
- Every sleeve keeps a virtual ledger. Tier S ledgers are written by
  `ops/sleeve_shadow.py` (append-only, hash-chained, one row per session in
  `<dir>/sleeves/<sleeve>.jsonl`, only sessions from FORWARD_START, which is
  after every frozen holdout).
- Fidelity gate: `sleeve_shadow.py --verify` replays from fresh data and must
  reproduce every logged row within 20 bp; a mismatch means look-ahead or
  revised data.
- Promotion to Tier R requires a netting layer: one order per symbol per
  rebalance (Alpaca rejects an opposite-side order while another is open on
  the symbol, and locks shares held by open orders), sleeve tag and rebalance
  id in `client_order_id`, router-owned account-level stops, virtual dividend
  credit (paper pays none), and daily reconciliation of the sum of Tier R
  ledgers against broker equity (5 bp/day tolerance, breach = kill switch).
  That layer is **not built yet**; until it is, only the core sleeve routes.
- Risk: equal-volatility budgets on promoted sleeves, M1 vol target as a
  normaliser (10% per sleeve, gross <= 1.0, no leverage), stops only as
  catastrophic protection, monthly signals are their own stop.

## 4. g2 gates (weeks 2-8), none of them is a Sharpe test

1. Implementation fidelity: paper/shadow ledger vs backtest replay, rho > 0.95,
   tracking error < 2% annualised.
2. Cost model: realised slippage vs cost_v2.
3. Operational integrity: no rejected orders, journal/equity reconciliation,
   kill-switch drills, no `unprotected-position` alerts left open.
4. Signal timing: event sleeves act on filing acceptance timestamps.

Promote a Tier S sleeve only if its backtest passed DSR/PBO, its shadow
ledger passes `--verify`, and forward returns sit inside the backtest's 90%
band. Promote at a 5-10% risk budget.

## 5. Order of work

1. [done] Shadow ledgers for core, T1, T2 (`ops/sleeve_shadow.py`), monitor
   panel, start.sh background loop, CI test.
2. [done] Event sleeves in the same ledger (`ops/event_shadow.py`): E1 insider
   (3 prereg variants, acceptance-time entry) and I1 intraday (2 variants).
   E2det PEAD is NOT wired: its registered signal needs SEC Financial
   Statement Data Sets, published only after each quarter, so there is no
   forward source; rebuilding SUE elsewhere would be an unregistered signal.
3. [done, opt-in] Collector as a background poller (`WITH_COLLECTOR=1`). The
   macro-lite tilt and event-day flags that would consume it are not built.
4. JEV paired A/B: every sleeve's filtered twin on identical candidates,
   prompt/context hash journaled before the outcome; success criterion
   preregistered before any run.
5. Netting router and Tier R promotion of T1 (after the fidelity gate).
6. [partly done] Kill inputs: account daily loss > 3% holds entries for the
   ET day; account drawdown >= 15% from `hwm.txt` latches (`dd-kill.latch`,
   operator deletes it to clear) into the kernel's existing MEDIUM kill, which
   stops entries and runs the existing flatten sweep. Per-sleeve -1.5x/-2x
   limits wait for Tier R. Practitioner conventions, not tuned values.

## 6. Known caveats

Paper fills (NBBO, no queue, no dividends) flatter live results, most for
single-stock and intraday sleeves. Net Sharpe figures in the review are
planning priors after haircuts, not measurements.
