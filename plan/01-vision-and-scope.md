# 01 - Vision and Scope

## 1.1 Thesis: epistemic arbitrage at the speed that matters

Markets price a firm's own news fast and the news of the firms it is
linked to slowly. A shock at one company reaches its suppliers, customers,
product-market peers and co-mentioned firms over days to months, because
connecting those dots costs attention. The evidence is broad and
consistent:

- Customer returns predict supplier returns about a month ahead
  (Cohen-Frazzini, JF 2008); trade links predict industry returns up to a
  year ahead (Menzly-Ozbas, JF 2010); big firms lead small firms inside
  an industry (Hou, RFS 2007).
- These spillovers are one phenomenon: a connected-firm momentum factor
  built from shared analyst coverage earns 1.68%/month (t = 9.67) and
  subsumes industry, customer, technology and geographic momentum
  (Ali-Hirshleifer, JFE 2020), though its predictability has declined in
  recent years. Links inferred from news co-mentions cross-predict returns
  at day, week and month horizons (Scherbina-Schlusche); a Chinese-market
  study finds news co-mention momentum survives trading costs where other
  spillover strategies do not; news-implied firm networks carry contagion
  that yields predictable returns (Schwenkler-Zheng).
- Firms that quietly rewrite their filings underperform (Cohen-Malloy-
  Nguyen, JF 2020); supplier disasters propagate measurable losses to
  customers (Barrot-Sauvagnat, QJE 2016).
- LLM representations of news predict returns beyond older text methods
  (Chen-Kelly-Xiu); LLM-labeled links between firms add modestly to text
  similarity (Sharpe 0.82 vs 0.74, Huang et al. 2026).

The same literature sets the limits. Published effects decay by about
half after publication (McLean-Pontiff 2016); customer momentum is smaller
and insignificant in its post-discovery sample; a 2009-2026 S&P 100
replication of the filing-change effect found nothing; the headline-reading
LLM signal fell from a Sharpe of 6.5 to 1.2 as adoption rose
(Lopez-Lira-Tang). The edge, where it exists, sits in less-covered firms,
indirect links and the short leg, which is where costs and borrow bite.
The fund therefore earns its edge by measuring, not by assuming.

What the fund builds:

1. **The epistemic engine** (doc 08): a point-in-time Market Link Graph of
   US-listed firms built from SEC filings, text similarity, global news
   co-mentions and common ownership, plus a stream of dated events (filings,
   earnings, abnormal moves, news bursts, disasters).
2. **Ripple strategies** (doc 02): deterministic sleeves that trade
   propagation along the graph, and one sleeve where an LLM reasons over
   the graph about a specific event and proposes the linked trade, checked
   by an independent verifier and executed by deterministic rules.
3. **The deterministic core** (docs 04-06): a C++ kernel that owns every
   order, every limit and every exit.
4. **The validation machine** (docs 11-12): pre-registration, a global
   trial ledger, contamination control and a gate every sleeve must pass.

It is autonomous in research, decision, and execution inside fixed
limits, and never autonomous in capital escalation (doc 10).

## 1.2 Operator path and constraint sets (locked 2026-10-02)

The operator is an India-resident individual today and plans to fund the
first live account after moving to the US. Until then everything is
paper. Each stage manifest names the constraint set it runs under; only
evidence produced under that set promotes it (doc 11 §11.0d).

| | C1 - India-resident | C2 - US-resident (research target) |
|---|---|---|
| Funding | RBI LRS (USD 250,000 per financial year) | US bank account |
| Account | cash, T+1 settled cash (R18) | margin (Reg T), at least $2,000 equity |
| Direction | long only | long and short |
| Gross exposure | ≤ 75% of equity | ≤ 150% of equity |
| Shorts | none | easy-to-borrow names only; hard-to-borrow excluded |
| Instruments | US common stock, US ETFs | US common stock, US ETFs |
| Excluded | margin, shorts, options, futures, FX, leveraged/inverse ETFs, crypto | options, futures, FX, leveraged/inverse ETFs, crypto |
| First capital | n/a (paper) | expected under $25,000 |

- C1 binds because LRS prohibits remittances for margin trading and for
  foreign-exchange trading abroad. It governs any live funding made while
  India-resident.
- C2 rules are in doc 05 (R1, R2, R18, R19, R20 C2 rows). Research books
  and G0a shadow run under C2 at $25,000.
- Tax and reporting items for either set are jurisdiction-gate evidence,
  not code (doc 10 §10.1a).
- This section summarizes public sources for planning. It is not legal or
  tax advice; G1 requires a qualified professional's written confirmation
  attached to the promotion manifest.

Managing other people's money (an advisory business or a fund) is a later
phase with its own legal path (doc 10 §10.6). Nothing in this plan accepts
outside capital.

## 1.3 Venue and data (locked)

- **US equities/ETFs: Alpaca** - paper (G0) and live (G1+, subject to the
  jurisdiction gate). REST + WebSocket; trading API limit 200
  requests/minute/key; bracket/OCO/OTO orders; market-on-close via
  `time_in_force=cls`. Margin and short selling per Alpaca's published
  rules: shorts need a margin account with $2,000 equity, easy-to-borrow
  names carry no locate or borrow fee, hard-to-borrow names need a locate
  in 100-share lots.
- **Second venue (not before G2):** Interactive Brokers, for markets
  beyond the US or for borrow availability, added by a doc 01 amendment
  and the jurisdiction gate. Not for latency.
- **Market data (free plan):** real-time IEX quotes/trades/bars for order
  pricing and vetoes; 15-minute-delayed SIP history for research, signals
  and cost modeling.
- **Feed protocol:** broker WebSocket + REST reconcile every 15 min; no FIX.
- **Sessions:** US regular session 09:30-16:00 America/New_York (IANA,
  exchange calendar, early closes honored); no extended-hours trading.
  Calendar missing = closed (fail closed).
- **Compliance as data:** broker and regulatory rules live in the
  `broker_compliance_policy` table keyed by effective date (doc 05 R9). The
  FINRA pattern-day-trader framework was eliminated by SEC approval on
  2026-04-14 (effective 2026-06-04); Alpaca has already removed PDT
  restrictions and the related account fields. That is a table row, not
  code.
- **Information sources:** doc 09. Primary documents (EDGAR) and global
  news metadata (GDELT) are free; social media is quarantined.

## 1.4 Latency tiers: reasoning latency, not execution latency

| Tier | Horizon | Needs | Verdict |
|---|---|---|---|
| T0 | µs-ns | colocation, direct feeds, DMA, queue position | Out of scope. Rents go to the fastest. |
| T1 | ms-s event reaction | sub-second ingestion + order entry | Not competitive: the firm's own news is priced in seconds by others. |
| T2 | minutes-hours | reliable bars, close auction access | Reachable; used for entry timing only. |
| T3 | days-months | daily data, low turnover | The edge: linked-firm ripples take days to months to be priced. |

The fund competes on how completely and how correctly it connects an event
to the firms it affects, measured from the event to the next session, not
on microseconds. The C++ kernel's sub-millisecond local budget (doc 04
§4.4) buys determinism, auditability and reliable exits, not alpha.
Revisiting T0/T1 requires a legal entity, a DMA broker, paid direct feeds,
colocation and a doc 01 scope change.

## 1.5 Who decides what (locked)

| Layer | Job | Technology |
|---|---|---|
| Epistemic engine | Link graph, events, ripple hypotheses, verification | Python plane: deterministic parsers + reader-tier LLM + verifier (doc 08) |
| Strategy sleeves | Turn graph signals and verified hypotheses into candidates with entry/stop/exit bound | Deterministic Python sleeve engine → candidate contract c1 (doc 02, doc 04) |
| Optional filter | Calibrated PASS/HOLD on a candidate | JEV, challenger until proven (doc 03) |
| Snapshot, risk, sizing, execution | Fast, deterministic, auditable | C++ kernel (docs 04-06, 13) |
| Capital stage, kill switches, spend | Permit or forbid; never expand | Stage chain + C++ constants + human signature (doc 10) |
| Validation + promotion | Score, gate, judge | Offline harness + human sign-off (doc 11) |

The hot path never blocks on an LLM. Risk gates are local and
unconditional: they run even if every model and data source is down
(default: HOLD). Models never size, send, amend, or cancel an order, and
never see equity or PnL. The boundary is enforced by OS permissions
(doc 08, R11).

## 1.6 Explicitly out of scope (do not build)

1. No Selenium in the trading system; browser automation only per doc 09
   ingestion rules.
2. No content syndication (LinkedIn/blog) anywhere in the fund.
3. No FPGA/GPU colocation, no T0/T1 latency competition (§1.4).
4. No venue beyond Alpaca before G2 (§1.3).
5. No investor dashboard. Logs, journal, daily summary.
6. No fine-tuning with live capital. Shadow + human promotion only.
7. Nothing live outside the stage's constraint set (§1.2). Research books
   may simulate instruments outside the target set only as labeled,
   non-promotable research.
8. No paid data subscription for core operation (doc 09 §9.1b).
9. No self-modifying agents, no runtime prompt/tool/skill rewriting, no
   online learning on the live path (doc 11).
10. No chat-gateway agent frameworks on any host that can reach capital.
    Alerts are outbound-only (doc 06 §6.4).
11. No automatic capital escalation (doc 10).
12. No crypto.
13. No outside capital until the doc 10 §10.6 path is completed.

## 1.7 Success criteria (G0 paper)

- **Economic:** at least one sleeve passes the doc 11 A-gate and B-gate:
  net-of-all-cost Sharpe with a lower confidence bound above zero, beats
  cash, positive spanning alpha against the reference book, survives 2×
  cost stress, trial-count-adjusted.
- **AI value:** the LLM ripple sleeve beats its deterministic twin on the
  same events, net of AI cost, on post-cutoff data (doc 11 §11.3b), or the
  LLM layer is removed.
- **Transferability:** every paper number was produced under the target
  constraint set with its account ledger simulated.
- **Determinism:** same logged context replayed → same decision (weekly).
- **Risk:** zero trades violating doc 05. One violation = halt.
- **Latency (local, excl. network):** snapshot → order intent < 1 ms.
- **Autonomy:** 30 consecutive G0b days with no required human
  intervention; every intervention logged with its cause.
- **Cost:** AI spend within the stage cap; cost per closed trade and per
  sleeve reported daily (doc 10 §10.4).
- **Isolation:** the engine cannot write the journal, `HALT`, or the stage
  chain, and cannot read broker credentials - proven by test.

## Locked decisions

- Hot path: C++. Engine, research and strategy code: Python.
- The edge hypothesis is linked-firm information diffusion at T3
  horizons, tested sleeve by sleeve under doc 11.
- Instruments live: US-listed equities and ETFs under the stage's
  constraint set (C1 or C2). No crypto, no forex spot, no derivatives.
- Venue: Alpaca (paper G0, live from G1 after the jurisdiction gate).
- Data: free for core operation; primary sources first; social signals
  quarantined (doc 09).
- Capital mode: paper until G0b's 30 clean days + passed sleeve gate +
  human sign-off. Four stages (G0_PAPER → G1_TINY → G2_SCALED → G3_FULL),
  human-signed, never auto-promoted; demotion automatic and unvetoable.
- Candidate pipeline: engine features (and, for L3, verified ripple
  hypotheses) → deterministic sleeve → candidate c1 → optional JEV filter
  → C++ risk engine sizes → runner executes.
- Not HFT: T3 strategies on a fast deterministic core (§1.4).
