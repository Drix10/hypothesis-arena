# Vision and scope

## Thesis

Markets price a firm's own news quickly and the news of the firms it is
linked to slowly. A shock at one company reaches its suppliers, customers,
product-market peers and co-mentioned firms over days to months, because
connecting those dots costs attention.

Evidence for:

- Customer returns predict supplier returns about a month ahead
  (Cohen-Frazzini 2008); trade links predict industry returns up to a year
  ahead (Menzly-Ozbas 2010); large firms lead small firms within an
  industry (Hou 2007).
- Connected-firm momentum built from shared analyst coverage earned
  1.68% a month (t = 9.67) and subsumes industry, customer, technology and
  geographic momentum (Ali-Hirshleifer 2020), though it has weakened in
  recent years. News co-mention links cross-predict returns (Scherbina-
  Schlusche; Schwenkler-Zheng).
- Firms that quietly rewrite their filings underperform (Cohen-Malloy-
  Nguyen 2020). Supplier disasters propagate losses to customers
  (Barrot-Sauvagnat 2016).
- Language-model representations of news predict returns beyond older text
  methods (Chen-Kelly-Xiu); model-labeled firm links add modestly to text
  similarity (Huang et al. 2026).

Evidence against, which sets the bar:

- Published effects lose about half their size after publication
  (McLean-Pontiff 2016).
- A 2009-2026 replication of the filing-change effect on the S&P 100 found
  nothing.
- The headline-reading model signal fell from a Sharpe of 6.5 to 1.2 as
  adoption rose (Lopez-Lira-Tang).
- Model "reasoning" about events is largely recall of training data.

Where an edge exists it sits in less-covered firms, indirect links and the
short leg, which is also where costs and borrow bite. The fund earns its
edge by measuring it, not by assuming it.

## What the fund builds

1. **The engine** (`engine.md`): a point-in-time link graph of US-listed
   firms built from SEC filings, text similarity, news co-mentions and
   common ownership, plus a stream of dated events.
2. **Strategies** (`strategies.md`): deterministic strategies that trade
   propagation along the graph, and one where a language model reasons about
   a specific event and proposes the linked trade, checked by an independent
   verifier and executed by fixed rules.
3. **The kernel** (`kernel.md`, `risk.md`, `execution.md`): a C++ program
   that owns every order, every limit and every exit.
4. **Validation** (`validation.md`): pre-registration, a trial ledger,
   contamination control and a gate every strategy must pass.

The system is autonomous in research, decisions and execution inside fixed
limits. It is never autonomous in raising capital exposure (`stages.md`).

## Operator path and constraint sets

The operator lives in India today and plans to fund the first live account
after moving to the US. Until then everything is paper. Each stage names the
constraint set it runs under, and only evidence produced under that set
promotes the stage (`validation.md`, Transferability).

| | India set | US set (research target) |
|---|---|---|
| Funding | RBI LRS, USD 250,000 per financial year | US bank account |
| Account | cash, T+1 settled cash | margin (Reg T), at least $2,000 equity |
| Direction | long only | long and short |
| Gross exposure | at most 75% of equity | at most 150% of equity |
| Shorts | none | easy-to-borrow names only |
| Instruments | US common stock, US ETFs | US common stock, US ETFs |
| Excluded | margin, shorts, options, futures, FX, leveraged or inverse ETFs, crypto | options, futures, FX, leveraged or inverse ETFs, crypto |
| First capital | paper | expected under $25,000 |

- The India set binds because LRS prohibits remittances for margin trading
  and for foreign-exchange trading abroad. It governs any live funding made
  while India-resident.
- Research books and shadow testing run under the US set at $25,000.
- Tax and reporting items are evidence for the jurisdiction check
  (`stages.md`), not code.
- This section summarizes public sources for planning. It is not legal or
  tax advice; the first live stage needs a qualified professional's written
  confirmation.

Managing other people's money is a later phase with its own legal path
(`stages.md`, Outside capital). Nothing in this plan accepts outside
capital.

## Venue and data

- **Broker: Alpaca**, paper now and live later subject to the jurisdiction
  check. REST and WebSocket; 200 requests a minute per key; bracket, OCO and
  OTO orders; market-on-close via `time_in_force=cls`. Shorts need a margin
  account with $2,000 equity; easy-to-borrow names carry no borrow fee;
  hard-to-borrow names need a locate in 100-share lots.
- **Second venue:** not before the scaled stage. Interactive Brokers could
  add non-US markets or borrow availability. It needs a scope change here and
  the jurisdiction check.
- **Market data (free plan):** real-time IEX quotes and bars for order
  pricing and vetoes; 15-minute-delayed SIP history for research, signals and
  cost modeling.
- **Sessions:** US regular session 09:30-16:00 America/New_York, exchange
  calendar with early closes. No extended hours. A missing calendar means
  closed.
- **Compliance as data:** broker and regulatory rules live in a
  `broker_compliance_policy` table keyed by effective date. The FINRA
  pattern-day-trader rule was eliminated by SEC approval on 2026-04-14
  (effective 2026-06-04) and Alpaca has removed it. That is a table row, not
  code.
- **Information sources:** `data.md`. Filings and news metadata are free;
  social media is quarantined.

## Latency

| Tier | Horizon | Verdict |
|---|---|---|
| Microseconds | colocation, direct feeds | out of scope |
| Milliseconds to seconds | event reaction | not competitive; the firm's own news is priced in seconds |
| Minutes to hours | bars, close auction | reachable; used for entry timing only |
| Days to months | daily data, low turnover | the edge: linked-firm ripples are priced over this horizon |

The fund competes on how completely and correctly it connects an event to
the firms it affects, measured from the event to the next session. The
kernel's sub-millisecond local budget buys determinism, auditability and
reliable exits, not alpha.

## Who decides what

| Layer | Job | Technology |
|---|---|---|
| Engine | link graph, events, ripple hypotheses, verification | Python: deterministic parsers, reader-tier model, verifier |
| Strategy engine | turn graph signals and verified hypotheses into candidates with entry, stop and exit bound | deterministic Python |
| Kernel | snapshot, risk, sizing, execution | C++ |
| Stage chain, kill switches, spend | permit or forbid, never expand | signed stage files, C++ constants, a human signature |
| Validation and promotion | score, gate, judge | offline harness and a human sign-off |

The hot path never blocks on a model. Risk gates are local and
unconditional: they run when every model and data source is down, and the
default is HOLD. Models never size, send, amend or cancel an order and never
see equity or PnL. OS permissions enforce the boundary (`engine.md`).

## Out of scope

1. Browser automation in the trading system; browser scraping only as
   `data.md` allows.
2. Content syndication of any kind.
3. Colocation, FPGA, GPU, or any latency competition.
4. A second venue before the scaled stage.
5. An investor dashboard. Logs, journal and daily summary are enough.
6. Fine-tuning with live capital. Shadow testing and human promotion only.
7. Anything live outside the stage's constraint set. Research books may
   simulate other instruments only as labeled, non-promotable research.
8. Paid data subscriptions for core operation.
9. Self-modifying agents, runtime prompt or tool rewriting, online learning
   on the live path.
10. Chat-gateway agent frameworks on any host that can reach capital. Alerts
    are outbound-only.
11. Automatic capital escalation.
12. Crypto.
13. Outside capital before the path in `stages.md` is complete.

## Success criteria for the paper stage

- **Economic:** at least one strategy passes the backtest gate and the shadow
  gate (`validation.md`): net-of-cost Sharpe with a lower confidence bound
  above zero, positive spanning alpha against the reference book, beats cash,
  survives 2× costs, adjusted for the number of trials.
- **Model value:** the model-driven strategy beats its rule-based twin on the
  same events, net of model cost, on post-cutoff data, or the model layer is
  removed.
- **Transferability:** every paper number was produced under the target
  constraint set with its account ledger simulated.
- **Determinism:** the same logged context replayed gives the same decision,
  checked weekly.
- **Risk:** zero trades that violate `risk.md`. One violation halts trading.
- **Latency (local):** snapshot to order intent under 1 ms.
- **Autonomy:** 30 consecutive paper days with no required human
  intervention; every intervention logged with its cause.
- **Cost:** model spend within the stage cap; cost per closed trade and per
  strategy reported daily.
- **Isolation:** the engine cannot write the journal, `HALT` or the stage
  chain and cannot read broker credentials, proven by test.

## Decisions

- Hot path in C++. Engine, research and strategy code in Python.
- The edge hypothesis is linked-firm information diffusion over days to
  months, tested strategy by strategy.
- Live instruments are US-listed equities and ETFs under the stage's
  constraint set. No crypto, forex or derivatives.
- Venue is Alpaca.
- Data is free for core operation, primary sources first, social signals
  quarantined.
- Four stages (paper, tiny, scaled, full), human-signed, never auto-promoted;
  demotion is automatic and unvetoable. Promotion needs 30 clean paper days, a
  passed strategy gate and a signature.
- Pipeline: engine features, or verified ripple hypotheses for Event Ripple,
  go to a deterministic strategy, which writes a candidate; the kernel risk
  engine sizes it; the runner executes it.
- Not high-frequency trading.
