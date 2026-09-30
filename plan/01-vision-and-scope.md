# 01 - Vision and Scope (freeze v3)

## 1.1 What we are building

An AI-assisted **systematic, multi-sleeve** fund that trades US-listed
equities and ETFs, whose every money decision is made by deterministic,
replayable code under hard risk rules, and and whose AI is used only where
the evidence says it helps:

1. **Research throughput** - an offline research factory in which agents
   propose hypotheses, write pre-registrations, write and run backtest
   code on trusted local data, and draft reports; every trial is logged
   and gated statistically before a human sees a promotion request
   (doc 08 §8.7, doc 11). This is the model real quant shops have moved
   to (agentic signal research feeding a human investment committee),
   not LLMs deciding trades.
2. **Typed extraction from primary documents** - SEC filings and official
   releases read by a reader tier that has no code execution and no
   network, producing schema-capped facts that a deterministic resolver
   verifies against canonical records (doc 08 §8.3).
3. **An optional calibrated filter** (JEV filter) that is admitted to the
   champion path only after it proves a positive paired delta against
   always-take (doc 03, doc 11).

It is **autonomous in research, decision, and execution** inside a box,
and **never autonomous in capital escalation** (doc 10). What it cannot
do is give itself more money, more instruments, or more rope.

Inputs and output:
- **Input A (slow, rich):** free primary data - SEC EDGAR (8-K, 10-Q/K,
  Form 4, XBRL), FRED/ALFRED, Treasury/BLS/BEA, official calendars -
  fused into typed features (docs 08, 09).
- **Input B (fast, thin):** broker market data and account state (Alpaca:
  real-time IEX on the free plan; 15-minute-delayed consolidated SIP
  history for research).
- **Input C (governing):** the stage chain, jurisdiction allowlist, risk
  constants, spend counters (doc 10).
- **Output:** BUY / SELL-to-close / HOLD + size + protective stop, from a
  named strategy sleeve, executed on paper or live under the stage.

**The edge must be earned, not assumed.** Published evidence on end-to-end
LLM trading is poor and mostly dissolves once look-ahead and cost are
controlled (doc 09 §9.0). Freeze v2's statistical baseline measured
negative (doc 12). Every sleeve therefore enters as a pre-registered
hypothesis and must pass the doc 11 gate before it touches the paper
champion book.

## 1.2 Operator and jurisdiction (LOCKED 2026-09-28)

The operator is an India-resident individual. This fixes what can be
traded live and therefore what paper evidence is worth collecting:

- Funding route: RBI Liberalised Remittance Scheme (LRS), USD 250,000
  per financial year per person. LRS explicitly prohibits remittances for
  **margin trading** and for **trading foreign exchange abroad**.
- Consequences (binding on every live stage, R18/R19):
  - **Cash account only** - no margin, therefore **no short selling** and
    **no leverage** (1× everywhere).
  - **No forex spot, CFDs, or FX margin products** live. Forex exposure,
    if ever wanted, only through US-listed currency ETFs and only after
    the jurisdiction gate confirms them (doc 10).
  - **No options, futures, or leveraged/inverse products** in v1 live.
  - US equity **T+1 settlement** and cash-account rules (Reg T good-faith
    and free-riding) bind intraday turnover (R18).
- Tax/reporting items (US withholding on dividends with a W-8BEN, Indian
  TCS on LRS remittances, foreign-asset reporting in the Indian return)
  are jurisdiction-gate evidence items, not code (doc 10 §10.1a).
- This section summarizes public sources for planning. It is not legal
  advice; G1 requires a qualified professional's written confirmation
  attached to the promotion manifest.

## 1.3 Venue and data (LOCKED 2026-09-28)

- **US equities/ETFs: Alpaca** - paper (G0) and live (G1+, subject to the
  jurisdiction gate). Alpaca accepts Indian residents for international
  accounts, USD base currency, funded by bank wire under LRS. REST +
  WebSocket; trading API limit 200 requests/minute/key; bracket/OCO/OTO
  orders; market-on-close via `time_in_force=cls`.
- **Forex: OANDA v20 practice - BLOCKED** (India ineligible; Addendum 39).
  FXCM demo fallback is also out: forex spot is not a legal live target
  (§1.2), so paper forex trading would produce non-transferable evidence.
  FX research continues offline from FRED exchange rates and short rates
  (doc 02 sleeve X1), never as an executed book.
- **Market data (free plan):** real-time IEX quotes/trades/bars (a small
  share of consolidated volume - quotes may be wider than NBBO) for live
  decisions; 15-minute-delayed **SIP** bars/trades/quotes for all research
  and cost modeling. No paid feed in core operation.
- **Feed protocol:** broker WebSocket + REST reconcile every 15 min; no FIX.
- **Sessions:** US regular session 09:30–16:00 America/New_York (IANA,
  exchange calendar, early closes honored); no extended-hours trading in
  v1. Calendar missing = closed (fail closed).
- **Compliance as data:** broker/regulatory rules live in the
  `broker_compliance_policy` table keyed by effective date (doc 05 R9).
  Example already in force: the FINRA pattern-day-trader framework was
  eliminated by SEC approval on 2026-04-14 (effective 2026-06-04, broker
  implementation by 2027-10-20). It changes a table row, not code - and a
  cash account is governed by settlement rules, not PDT, anyway.
- **Macro calendar:** FRED/ALFRED release calendar + Fed/ECB official
  calendars; ALFRED vintages for anything replayed.
- **Earnings calendar:** EDGAR-derived (8-K item 2.02 history + filing
  cadence) + company IR pages. No paid earnings API.

## 1.4 Latency tiers - why this is not HFT, and what is reachable

| Tier | Horizon | Needs | Verdict for this deployment |
|---|---|---|---|
| T0 | µs–ns | colocation, direct exchange feeds, DMA, queue position | **Out of scope.** Latency-arbitrage rents go to the fastest; we are not in that race. |
| T1 | ms–s event reaction | sub-second news ingestion + order entry | **Not competitive.** EDGAR polling, internet REST at 200 req/min, IEX-only real-time data, and an India–US path lose every first-mover race. |
| T2 | minutes–hours intraday | reliable bars, close auction access, careful execution | **Reachable.** Candidate: market intraday momentum (doc 02 sleeve I1). |
| T3 | days–months | daily data, low turnover | **Reachable and most robust.** Trend, sector momentum, EDGAR event sleeves, macro risk overlay. |

The C++ kernel's sub-millisecond local budget (doc 04 §4.4) stays: it buys
determinism, auditability, and reliable exits - not alpha. "HFT mix" in
this project means: **a fast deterministic execution core running T2/T3
strategies with institutional-grade risk, reconciliation, and cost
accounting.** Revisiting T0/T1 requires a legal entity, a DMA broker,
paid direct feeds, colocation, and a doc 01 scope change - the doc 07
distraction firewall holds it out.

## 1.5 Who decides what (locked)

| Layer | Job | Technology |
|---|---|---|
| Strategy sleeves | Originate candidates (side is always BUY-to-open or SELL-to-close live) with entry/stop/exit bound pre-decision | Deterministic Python research code → kernel candidate contract c1 (doc 02, doc 04) |
| Optional filter | Calibrated PASS/HOLD on a candidate | JEV via OpenRouter Decisions API - challenger until proven (doc 03) |
| Snapshot, risk, sizing, execution | Fast, deterministic, auditable | C++ kernel (docs 04–06, 13) |
| Evidence extraction | Typed facts from primary documents | Reader-tier LLM + deterministic resolver (doc 08) |
| Research factory | Hypotheses, pre-registrations, backtest code, reports | Sandboxed agents on trusted local data, trial-ledgered (docs 08, 11) |
| Capital stage, kill switches, spend | Permit or forbid; never expand | Stage chain + C++ constants + human signature (doc 10) |
| Validation + promotion | Score, gate, judge | Offline harness + human sign-off (doc 11) |

Hot path never blocks on an LLM. Risk gates are local and unconditional -
they run even if every model and data source is down (default: HOLD).
Agents never size, send, amend, or cancel an order, and never see equity
or PnL. The boundary is enforced by OS permissions (doc 08, R11).

## 1.6 Explicitly OUT of scope (do not build)

1. No Selenium or browser automation in the trading system. Ever.
2. No content syndication (LinkedIn/blog) anywhere in the fund.
3. No FPGA/GPU, no colocation, no T0/T1 latency competition (§1.4).
4. No venues beyond Alpaca in v1. OANDA/FXCM stay out (§1.3).
5. No investor dashboard in phase 1. Logs, journal, daily summary.
6. No auto fine-tuning with live capital. Shadow + human promote only.
7. No leverage, margin, short selling, options, futures, FX spot/CFD, or
   leveraged/inverse ETFs live (§1.2). Research books may simulate them
   only in shadow and only as clearly labeled non-promotable research.
8. No paid data subscriptions for core operation. A source that starts
   charging is dropped, not funded (doc 09).
9. No self-modifying agents, no runtime prompt/tool/skill rewriting, no
   online learning on the live path (doc 11).
10. No chat-gateway agent frameworks on any host that can reach capital
    (Hermes Agent, OpenClaw and similar). Alerts are outbound-only
    (doc 06 §6.4); nothing accepts inbound commands.
11. No automatic capital escalation. Ever (doc 10).
12. No crypto.

## 1.7 Success criteria

Phase-1 (G0 paper) success is economic AND operational:

- **Economic:** at least one sleeve passes the doc 11 sleeve gate in
  backtest AND in G0a shadow on live data: net-of-all-cost Sharpe with a
  lower confidence bound above zero, beats cash and the vol-matched
  passive benchmark, survives 2× cost stress, trial-count-adjusted.
- **Transferability:** every paper number was produced under the live
  constraint set (cash, long-only, 1×, settled cash, allowlisted
  instruments).
- **Determinism:** same logged context replayed → same decision (weekly).
- **Risk:** zero trades violating doc 05. One violation = halt.
- **Latency (local, excl. network):** snapshot → order intent < 1 ms.
- **Autonomy:** 30 consecutive G0b days with no required human
  intervention; every intervention that did occur logged with its cause.
- **Cost:** AI spend within the stage cap; cost per closed trade and per
  sleeve reported daily (doc 10 §10.4).
- **Isolation:** the research plane cannot write the journal, `HALT`, or
  the stage chain, and cannot read broker credentials - proven by test.
- **Calibration (only if JEV is on the champion path):** JEV `enter` and
  `latent_risk` beat a base-rate baseline on Brier over ≥200 decisions.

## Locked decisions

- Hot path: C++ (no debate). Research and strategy code: Python.
- Instruments live: US-listed equities and ETFs, cash account, long only,
  1×. No crypto, no forex spot, no derivatives in v1.
- Venue: Alpaca (paper G0, live from G1 after the jurisdiction gate).
  OANDA v20 practice is BLOCKED; forex is research-only.
- Data: free tiers only; SIP-delayed history for research; ALFRED
  vintages for replayed macro; primary sources only.
- Capital mode: paper until G0b's 30 clean days + passed sleeve gate +
  human sign-off. Four stages (G0_PAPER → G1_TINY → G2_SCALED → G3_FULL),
  human-signed, never auto-promoted; demotion automatic and unvetoable.
- Candidate pipeline (canonical): deterministic sleeve → candidate c1
  (side/family/entry/stop/exit bound) → optional JEV filter → C++ risk
  engine authorizes size → runner executes. No model output invents
  direction at the execution boundary.
- AI placement: research factory + reader-tier extraction + optional
  filter. Never per-trade LLM discretion.
- Not HFT: T2/T3 strategies on a fast deterministic core (§1.4).
