# Execution and operations

The order lifecycle, execution rules per strategy, the cost model as the
evaluation authority, account operations (India-set settlement, US-set margin
and borrow) and outbound-only alerting. The close-ownership, incident-identity
and recovery contract is in `appendix/close-ownership-and-recovery.md` and is
binding.

## Execution by strategy

| Strategy | Signal time | Entry order | Protection | Normal exit |
|---|---|---|---|---|
| Link Momentum and Filing Change (monthly) | month-end official close (SIP) | next session: closes first (MOC), then opens; under the India set buys wait for settled proceeds | OTO stop-only, GTC catastrophe stop at 3 × the 20-day ATR; sell-stop for longs, buy-stop for shorts (`exit_link`) | MOC at the rebalance when the name leaves its band |
| Event Ripple (events) | `ripple_hypothesis` availability | next session 10:00 ET marketable limit, unless already priced (`strategies.md`) | OTO stop-only, GTC (`exit_event`) | MOC on the horizon day |
| ETF Trend, long-short (monthly) | month-end official close | next session: closes first, then opens | OTO stop-only, GTC (`exit_trend`) | MOC at the rebalance when the signal flips |

Short-side rules (US set, after kernel short selling is built): a short open is
a SELL on a symbol not held, sent only after `short_controls` pass at order
time; a cover is a BUY of at most the short quantity; the protective leg is a
buy-stop; the stop-before-close rule below applies with sides reversed. A name
that flips side at a rebalance (long to short or the reverse) is closed in the
rebalance session and opened at the next session: Alpaca rejects an order while
an opposite-side order is open on the symbol (wash-trade protection), and
`flip_lock` forbids a quick round trip. The resting protective stop is an
opposite-side order, so it is cancelled and confirmed before any new order on
the same symbol.

Ordering rules for every strategy:

- Marketable limits, never naked market orders, for entries. The limit cap is
  the pre-registered slippage bound: no fill worse than the cap, and an
  unfilled entry is cancelled at the strategy's window end, never chased.
- MOC exits go in before the broker-declared MOC cutoff (adapter data).
- **Stop before close** (observed on Alpaca paper 2026-09-29): the broker
  rejects both MOC and market sells while an OTO stop is live, so the stop is
  cancelled before MOC submission if it is live (if the stop is no longer
  active, the close moves to the next cycle). If the stop fills first, the MOC
  becomes an over-sell that a cash account rejects; the router treats that
  reject as the expected terminal for the MOC (journaled, reconciled), not as
  an error loop. If the MOC is rejected or missed, the position stays protected
  and the exit is retried at the next session open (a journaled incident).
- Whole shares for protected orders (an adapter constraint). Rounding is the
  last step of sizing and never rounds up past a cap.
- No extended-hours orders. No order in the first 5 minutes after the open;
  event entries start at 10:00 ET.

## Costs and cost analysis (the evaluation authority)

Alpaca paper is a plumbing test, not a cost oracle. Per Alpaca's documentation
it does not check order size against NBBO quantity, partial-fills a random 10%
of eligible orders, ignores market impact, queue position, price improvement,
latency slippage and regulatory fees, and does not simulate dividends.
Therefore the harness cost model (`math.md`, Costs and capacity) is the
economic evidence and paper results are plumbing evidence:

- The fill rule: a buy fills at mid plus one full spread, a sell at mid minus
  one full spread (minimum 1 bp), full size, flagged `simulated`, no partials
  in paper.
- Spreads come from SIP NBBO at the decision time (delayed history in research;
  the live quote in paper-trading shadow accounting). The cost model adds SEC
  Section 31 and FINRA TAF fees on sells, a participation cap (order at most 1%
  of the symbol's 20-day median volume and at most the displayed size at the
  touch; larger orders are split across sessions or not placed), square-root
  market impact, dividends credited from the corporate-action layer, and for
  US-set shorts borrow fees, margin interest and dividends owed. There is no
  rebate on short proceeds.
- Stress legs of 1×, 1.5×, 2× and 3× on the spread, fee and impact components.
- Cost analysis per fill: implementation shortfall against the arrival mid
  (decision time) and against the modeled cost, with daily and per-strategy
  aggregates in the summary. Live realized shortfall above 1.5× modeled over 30
  fills pauses the strategy.
- Neither the fill rule nor the cost model is loosened without a doc edit and a
  fresh paper window.

## Account operations

India set (cash account):

- The settlement ledger is rebuilt at startup from the journal and broker
  account and reconciled every cycle.
- Monthly strategies sell first and buy the next session with settled proceeds
  (the rebalance is two sessions by design).
- A T-bill ETF used as the cash leg is itself subject to T+1: moving from it
  into risk assets is a two-session operation, and the cash buffer implied by
  the 75% exposure cap absorbs same-day needs.
- Any broker-reported good-faith or free-riding flag is a HARD-class compliance
  incident: entries stop, a human reviews, and the root cause goes in the
  journal before resuming.

US set (margin account, after kernel short selling is built):

- The US-set paper run uses its own Alpaca paper account (Alpaca allows up to
  three per owner), started at $25,000, apart from the India-set plumbing run,
  so the two books never net or share buying power.
- Alpaca paper does not simulate dividends. The account ledger books them from
  the corporate-action data: credited on longs, charged on shorts. Without
  this, paper shorts look cheaper than live ones.
- The account ledger tracks margin requirement, maintenance buffer, each
  short's borrow status, accrued margin interest and dividends owed, and
  reconciles with the broker's margin data every cycle.
- Borrow status is re-read from the broker's asset flags before every short
  open and once per session for every held short. A change to hard-to-borrow, a
  recall or a buy-in notice schedules a cover for the next session.
- A rebalance closes first, then opens; opens are sized against the buffer that
  remains after the closes are acknowledged.
- A broker margin call is a MEDIUM kill: no new risk, gross cut to half the
  strategy target, and human review.

## Order lifecycle

Local C++ stops are the active controller, never the disaster protection. A
position the broker cannot protect on its own is a position the process cannot
survive losing, so protection is established broker-side first:

```
intent (risk PASS) -> re-check HALT file -> journal row -> send entry +
  protective legs through a broker-specific protected mode (entry is
  permitted ONLY through an order mode whose adapter implementation
  positively establishes the entry-to-protection relationship: Alpaca
  bracket or OTO legs with adapter-proven semantics). Each adapter proves:
  entry ack, protection ack, partial-fill behavior, cancel and replace
  behavior, double-trigger behavior, including fast-market edge behavior.
  The requirement is no naked entry, not a cross-broker atomic primitive.
  -> ack or timeout -> query once:
   filled + protection acked -> journal fill -> PROTECTED -> track
   filled, protection missing -> PROTECTIVE_ORDER_MISSING: establish now or
     flatten immediately; never hold naked awaiting a retry loop
   partial (0% < filled < 100%) -> journal partial with filled qty ->
     protection covers filled qty ONLY -> cancel remainder -> confirm
     cancelled -> journal cancel. Protection never covers unfilled qty; a
     partial never becomes PROTECTED on the full intended size.
   nothing         -> cancel -> confirm cancelled -> journal cancel
   cancel failed   -> UNKNOWN_EXECUTION (never "filled"): freeze new orders
     for the symbol, query the broker, reconcile (risk.md), preserve or
     establish protection first
 -> exit (stop, take-profit, time exit, or the flip rule below) -> journal + reflection row
```

- **Durable order state machine** (survives restarts): intent id, client order
  id, send attempt and broker ack state are persisted before send. After any
  crash the process reconciles ack state with the broker before issuing
  anything new; a restart never double-sends what the dead process sent.
- **Client order id** is the typed intent fingerprint plus the broker and
  account namespace plus the persisted intent id, hashed:
  `hex(sha256(broker ‖ account ‖ context_hash ‖ symbol ‖ side ‖ intent_id))`,
  truncated only if the broker requires it. One intent, one id, no attempt
  counter, no delimiter ambiguity and no cross-account collision. Retries reuse
  the id (an attempt field in the hash would mint a fresh id per retry and
  double-fill).
- One send attempt and one status query. No martingale re-sends.
- Stops are attached at entry or the entry is rejected. An entry requires
  expected gross edge above all-in modeled cost plus a margin.
- **Journal before order** is absolute for normal entries. Emergency exits are
  the one exception: if the journal write fails mid-emergency, execute first,
  then append through the durable emergency-exit buffer (a delayed exit is worse
  than a delayed row, and the row still lands).
- **No discretionary exit** in live actuation. Live exits are: stop,
  take-profit, time exit, a deterministic risk or kill exit, and broker
  reconciliation logic. Exits never depend on research freshness, a model or a
  stale feed.
- Feed stale beyond 30 seconds forbids entries (veto). Exits go via REST if the
  WebSocket is down.
- The stage multiplier (`stages.md`) is applied to the computed size after
  risk-budget sizing and before the exposure check. An order that is legal at
  the full stage and illegal at the tiny stage is rejected there, with the
  stage named in the HOLD reason.
- Time exit is the actual exchange close minus a fixed exit buffer (30 minutes
  by default) from the validated IANA and exchange calendar, early-close days
  included, never a hard-coded clock time.

## Close ownership and incident identity

One position, one close: per symbol and side and per incident exactly one close
identity may be live, every kill-path close is pre-flighted by its stable id,
incident epochs are durable or nothing, HARD quantities come from the signed
broker position with a write-ahead chain, recovery refuses torn or orphaned
durable state, and one OS-lifetime lock owns a state directory. The full rule
set is in `appendix/close-ownership-and-recovery.md`. Every live close is a
SELL of a long position or, under the US set, a BUY-to-cover of a short; a close
that would exceed the held quantity is refused before the POST (the kernel does
not rely on the venue to reject it).

## Reflection

After every closed trade a row is appended: strategy id, candidate id,
entry and exit `context_hash`, PnL, implementation shortfall against modeled
cost, regime and exit reason. Auto fields only, no model prose. A weekly review
aggregates per strategy: hit rate, per-regime PnL, cost drift and tracking
against the backtest. Rule changes come only through a new pre-registration
(`validation.md`), never from the review directly.

## Outage playbook

In every case, exits, broker-native stops and reconcile keep working.

| Failure | Detection | Automatic response | Human needed? |
|---|---|---|---|
| Feed gap or WebSocket down | sequence gap, stale over 30 s | entries vetoed; exits via REST; reconnect with backoff | only if over 5 min |
| Broker outage | auth or API failure, 5xx storm | entries stop; exit attempts via REST; unresolvable drift goes to HARD | yes, at HARD |
| Broker rate limit | 429 | back off per the adapter budget; entries for the cycle dropped, exits prioritized | no |
| Transport or TLS failure | handshake, cert or HTTP error | fail closed: no order leaves; broker-native stops protect positions | if over 5 min |
| Settlement mismatch | ledger against broker | entries HOLD; reconcile | if unresolved in 1 session |
| Model provider outage | timeout, 5xx, malformed | research degrades to harvest-only; entries needing research context HOLD | if over 6 h |
| Research plane down or stale | features past TTL | features absent; research-dependent entries HOLD | if over 6 h |
| Strategy engine down | no candidates past the window | no new entries for that strategy; exits unaffected | if over 1 session |
| Runaway research loop | research caps | per-symbol pause; plane pause on majority in window | at pause |
| Conflicting evidence | conflict flag | HOLD | no |
| Spend spike | hourly projection | tier 1, then 2, then 3, ending in a MEDIUM kill and demotion | at tier 3 |
| Journal chain break | daily verify | HARD kill, forensics before restart | yes |
| Stage files unverifiable | startup or cycle boundary | fall back to the paper stage, alert | yes |

In every row, new risk stops, existing risk stays managed, and the system fails
toward paper.

## Daily rhythm (paper phase)

| Time | Action |
|---|---|
| 00:00 UTC | roll journal files, verify the hash chain (the ops-day clock advances only after verification succeeds), snapshot equity |
| Continuous (session) | feed and strategy schedules; alerts on drawdown, divergence, account-rule and spend events |
| Every 15 min | position and settlement reconcile |
| Hourly | model-spend projection and tier evaluation |
| 16:30 ET | strategy signals from SIP daily bars; next-session order plan journaled |
| 08:00 UTC | daily summary (a script, no model): trades, PnL per strategy, holds by reason, cost analysis against the model, settlement state, model spend with projection, tier and cost per closed trade, feature and candidate rejects, research aborts, stage |
| Weekly | per-strategy tracking against the backtest; trial-ledger review; at most 3 research-factory proposals triaged |
| 23:55 UTC | replay sample, back up the journal and ledgers |

## Monitoring and alerting

- **Liveness:** a heartbeat file touched every cycle in session; stale over 120
  seconds in session alerts. Off-session silence is expected.
- **Kill switch:** the `HALT` file stops entries within 1 cycle. Deleting it
  does not resume (restart plus a flag is required). MEDIUM and HARD are
  defined in `stages.md` and drilled monthly.
- **Outbound-only alert adapter** (`ops/alert_relay.py`), required before
  unattended paper trading: a one-way push (an authenticated HTTPS POST to a
  push-notification endpoint, or SMTP send-only) carrying bounded, redacted
  alert records. It accepts no inbound messages, runs no commands, holds no
  broker credential and is not a chat agent. At minimum it carries HARD kills,
  stage demotions, account-rule incidents and spend tier 3. An alert written
  only to a log file does not count as an alert.
- **Account kill inputs:** the paper loop feeds the kill gate a latched
  drawdown input (15% below the persisted high-water mark; an operator clears
  the latch and restarts) and holds entries for the session after a daily loss
  above 3%.
- **Autonomy metric:** every human intervention is logged with its cause.

## Done when

- Kill-switch drill: HALT leads to no entries within 1 cycle, exits
  unaffected.
- Reconcile drill: forced drift is detected, synced and logged, including a
  settlement-ledger mismatch.
- The daily summary runs from the journal alone.
- The cost model is implemented in the research harness and in paper-trading
  shadow accounting, with cost analysis per fill in the summary.
- The transport is wired and drilled on Alpaca paper.
- OTO stop-only protection and MOC exit sequencing are drilled, including the
  stop-fills-before-MOC and MOC-reject paths.
- Journal retention of 90 days local plus a daily backup; redaction verified by
  grep.
- The outbound-only alert adapter delivers a real notification on a forced
  HARD kill.
- 30 clean paper-trading days with zero rule violations.
- Every outage playbook row drilled at least once, with exits proven alive.

## Decisions

- Journal before order for normal entries (the emergency-exit exception
  applies). No row, no send for entries.
- Exits never depend on research freshness, a model or WebSocket health
  (broker-native stops; REST fallback). Only entries may wait on data.
- Resume from HALT is manual, as is every stage promotion.
- **Broker-status quarantine** (per Alpaca's order-lifecycle docs):
  `done_for_day`, `calculated` and `replaced` are never routed as generic DEAD;
  the id is burned, filled quantity is authoritative for today but never
  folded; the first sighting freezes the symbol, journals and alerts; any
  next-session exposure is a new intent under a new id. `canceled`, `expired`
  and `rejected` are safe-DEAD.
- **Live-hold statuses:** `held`, `stopped` and `accepted_for_bidding` are
  PENDING; the runner waits and never re-issues blind.
- Every outage default stops new risk and keeps old risk managed.
- The fill rule above is the single paper fill rule; the cost model wraps it
  for every strategy.
- Alpaca paper results are plumbing evidence; the harness cost model is the
  economic evidence.
- Alerts are outbound-only; nothing on a capital host accepts inbound commands.
- **Audit stop rule** (engineering process): reopening audit is allowed only
  for (1) changes to decision outcomes, (2) corruption or loss of durable
  trading state, (3) duplicate-order, wrong-side or wrong-quantity risk, (4)
  security boundary violations, (5) reproducibility, lookahead or
  statistical-validity failures, or (6) a failing correctness or drill gate.
  Other cleanup collects into one bounded backlog, never another cascade.
  Alpha first: no hardening round may start on a component whose stage does not
  yet need it while a strategy gate on the critical path is open; priority is
  decided by whether the change alters the probability that the fund makes or
  loses money. Grep observations are static tripwires, not proofs
  (compiler-enforced authority probes excepted).
