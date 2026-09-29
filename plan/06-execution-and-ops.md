# 06 — Execution and Ops (freeze v3)

Freeze v3 keeps the H1 order lifecycle exactly as accepted and adds what
the v2 doc never had: execution rules per sleeve, a cost model that is
the evaluation authority, cash-account settlement operations, and
outbound-only alerting. The ~340-line close-ownership / incident-identity /
recovery contract formerly in §6.1b moved VERBATIM to
`appendix/06b-close-ownership-and-recovery-record.md` and remains binding.

## 6.0 Execution by sleeve (v3)

| Sleeve | Signal time | Entry order | Protection | Normal exit |
|---|---|---|---|---|
| T1/T2 trend/sector | month-end official close (SIP) | next session: sells-to-close first (MOC), buys the following session with settled proceeds (MOC) | OTO stop-only, GTC catastrophe stop (`exit_trend_v1`) | MOC at the next rebalance when the signal flips |
| I1 intraday | 10:00 ET (SIP, delayed) | 15:30 ET marketable limit (limit = ask + 1 tick cap, IEX quote) | OTO stop-only, day (`exit_intraday_v1`) | MOC the same day |
| E1/E2 events | EDGAR acceptance time (R12) | next session 10:00 ET marketable limit | OTO stop-only, GTC (`exit_event_v1`) | MOC on the holding-period day |
| B0 baseline (shadow only) | per doc 12 | per doc 12 | bracket (`exit_profile_v1`) | stop / TP / time_exit |

Ordering rules that every sleeve obeys:
- Marketable limits, never naked market orders, for entries; the limit cap
  is the pre-registered slippage bound (a fill worse than the cap does not
  happen; an unfilled entry is cancelled at the sleeve's window end —
  no chasing).
- MOC exits go in before the broker-declared MOC cutoff (adapter data).
  MOC vs protective stop (K5 live finding 2026-09-29): Alpaca rejects both
  MOC and market sells when an OTO stop is live; the stop must be cancelled
  first. The stop is cancelled before MOC submission if it is currently live
  (postpones the close to the next cycle when the stop is no longer active).
  If the stop fills first, the MOC becomes an over-sell that a cash account
  rejects — the router treats that reject as the expected terminal for the
  MOC (journaled, reconciled), never as an error loop. If the MOC is
  rejected or missed, the position stays protected and the exit is retried
  at the next session open (journaled incident).
- Whole shares for protected orders (adapter constraint); rounding is the
  last step of the sizing hierarchy and never rounds up past a cap.
- No extended-hours orders in v1. No order in the first 5 minutes after
  the open except the E-sleeve window, which starts at 10:00 ET.

## 6.0a Cost model and TCA (v3 — the evaluation authority)

Alpaca paper is a plumbing test, not a cost oracle: per Alpaca's own
documentation it does not check order size against NBBO quantity,
partial-fills a random 10% of eligible orders, ignores market impact,
queue position, price improvement, latency slippage, and regulatory fees,
and does not simulate dividends. Therefore:

- `paper_fill_v1` (frozen, unchanged — see Locked decisions) stays the
  conservative per-leg fill rule used by `baseline_v1` and S2/S5
  reproductions.
- `cost_v2` (v3, for every sleeve pre-registration) = `paper_fill_v1`
  priced from **SIP NBBO at the decision time** (delayed history in
  research; the live quote in G0b shadow accounting) + SEC Section 31 fee
  and FINRA TAF on sells + a participation cap (order ≤ 1% of the
  symbol's 20-day median volume and ≤ displayed size at the touch; larger
  orders are split across sessions or not placed) + dividends credited
  from the corporate-action layer (paper does not simulate them).
  Stress legs 1×/1.5×/2×/3× on the spread + fee component.
- TCA per fill: implementation shortfall vs arrival mid (decision time)
  and vs the modeled cost; daily and per-sleeve aggregates in the summary.
  Live (G1+) realized shortfall > 1.5× modeled over 30 fills → S3 pause.

## 6.0b Cash-account settlement operations (v3)

- The settlement ledger (doc 04 §4.2 5c) is rebuilt at startup from the
  journal + broker account and reconciled every cycle (S2).
- Intraday sleeves use **two alternating capital tranches** so that each
  day's buys are funded by cash that settled; the ledger enforces it (R18).
- Monthly sleeves sell first and buy the next session with settled
  proceeds (the rebalance is two sessions by design).
- A T-bill ETF used as the cash leg is itself subject to T+1: moving from
  it into risk assets is a two-session operation; the cash buffer implied
  by R2's 75% cap absorbs same-day needs.
- Any broker-reported good-faith or free-riding flag is a HARD-class
  compliance incident: entries stop, human review, root cause in the
  journal before resuming.

## 6.1 Order lifecycle (locked, v2: broker-native protection)

Local C++ stops are the active controller, never the disaster protection. A
position the broker cannot protect on its own is a position the process cannot
survive losing — so protection is established broker-side first:

```
intent (risk PASS) → re-check HALT file → journal row → send entry +
  protective SL/TP through a broker-specific protected mode (E1: entry is
  permitted ONLY through an order mode whose adapter implementation
  positively establishes the entry↔protection relationship — OANDA
  stopLossOnFill/takeProfitOnFill; Alpaca bracket legs with adapter-proven
  semantics). Each adapter proves: entry ack, protection ack, partial-fill
  behavior, cancel/replace behavior, double-trigger behavior — including
  fast-market edge behavior. "Atomic" is the requirement (no naked entry),
  not a cross-broker primitive claim. → ack/timeout → query once:
   filled + protection acked → journal fill → PROTECTED → track
   filled, protection missing → PROTECTIVE_ORDER_MISSING: establish now or
     flatten immediately; never hold naked awaiting a retry loop
   partial (0% < filled < 100%) → journal partial with filled qty →
     protection covers filled qty ONLY → cancel remainder → confirm
     cancelled → journal cancel. Protection never covers unfilled qty;
     a partial never becomes PROTECTED on the full intended size.
   nothing         → cancel → confirm cancelled → journal cancel
   cancel failed   → UNKNOWN_EXECUTION (never "filled"): freeze new orders
     for the symbol, query broker, reconcile per §5.4 S2, preserve or
     establish protection first
 → exit (stop, TP, calendar time_exit, or flip rule below) → journal + reflection row
```

- Durable order state machine (survives restarts): intent_id + client order ID
  + send_attempt + broker_ack_state persisted before send. After any crash the
  process reconciles ack state with the broker BEFORE issuing anything new —
  a restart must never double-send what the dead process already sent.
- Client order ID = typed intent fingerprint + broker/account namespace +
  persisted intent_id, hashed: `hex(sha256(broker ‖ account ‖ context_hash ‖
  symbol ‖ side ‖ intent_id))`, truncated only if the broker requires it —
  one intent, one ID, no attempt counter, no delimiter ambiguity, no
  cross-account collision. (An `attempt` field in the hash was a
  duplicate-order bug: every retry would mint a fresh ID and double-fill.
  Retries reuse the ID.)
- One send attempt + one status query. No martingale re-sends.
- Stops are attached at entry or the entry is rejected. exit_profile_v1
  (doc 03 §3.3): fixed stop + fixed 2R take-profit + mandatory calendar
  time_exit (E4): time_exit = actual exchange close − frozen exit buffer
  (30 min default), from the validated IANA/exchange calendar — never a
  hard-coded 15:55 ET, which is wrong on early closes.
  Stop floor 0.1% ⇒ min TP 0.2% (20bp), which must EXCEED all-in modeled
  cost + safety margin under the frozen cost stress — 20bp clears
  fees/slippage only if the cost model says so, never by construction.
  Entry requires: expected gross edge > all-in modeled cost + margin.
- Journal-before-order is absolute for NORMAL entries. Emergency exits carry
  an explicit exception: if the journal write fails mid-emergency, execute
  first, then append through the durable emergency-exit buffer — a delayed
  exit is worse than a delayed row, and the row still lands. (This supersedes
  any "no exceptions" wording: the exception is this paragraph.)
- Discretionary exit is REMOVED from live actuation (E3): `enter.noul < 0.3`
  twice is logged and researched, but never market-exits a position. Live
  exits are: stop, TP, time_exit, deterministic risk/kill exit, broker
  reconciliation logic. Exits never depend on JEV — the hard stop/TP always
  stand regardless; stale/missing JEV never forces, and never blocks, an exit.
- Feed stale > 30 s → entries forbidden (veto). Exits go via REST if WS is down.
- Stage multiplier (doc 10 §10.2) is applied to the computed size **after** the
  conviction table and before the R2 check. An order that is legal at G3 and
  illegal at G1 is rejected at G1, with the stage named in the HOLD reason.

## 6.1b Close ownership + incident identity (frozen; moved)

One position, one close: per (symbol, side) and per incident exactly one
close identity may be live, every kill-path close is pre-flighted by its
stable id, incident epochs are durable-or-nothing, HARD quantities come
from the signed broker position with a write-ahead chain, recovery refuses
torn or orphaned durable state, and one OS-lifetime lock owns a state
directory. The full frozen rule set — MEDIUM/HARD ownership, incident ids,
HARD chain integrity and attribution durability, overflow-safe parsing,
state-file integrity (absent vs corrupt), single-process ownership,
recovery-before-mutation, per-book orphan coverage, and the rest — is in
`appendix/06b-close-ownership-and-recovery-record.md`, unchanged and
binding. Long-only note (v3): every live close is a SELL of a long
position; a close that would exceed the held quantity is refused before
the POST (a cash account would reject it anyway; the kernel never relies
on the venue to catch it).

## 6.2 Reflection (after every closed trade)

Row appended: sleeve id, candidate CID, entry/exit context_hash, PnL,
implementation shortfall vs modeled cost, regime, filter answers (if any),
exit reason — auto fields only, no LLM prose. Weekly review aggregates per
sleeve: hit rate, per-regime PnL, cost drift, tracking vs backtest. Rule
changes come only through a new pre-registration (doc 11), never from
the review directly.

## 6.2a Outage playbook (the unattended cases)

In all of them: **exits, broker-native stops, and reconcile keep working.**

| Failure | Detection | Automatic response | Human needed? |
|---|---|---|---|
| Feed gap / WS down | sequence gap, stale > 30 s | Entries vetoed; exits via REST; reconnect with backoff (S1) | Only if > 5 min |
| Broker outage | auth/API failure, 5xx storm | Entries stop; exit attempts via REST; unresolvable drift → HARD (S9) | Yes, at HARD |
| Broker rate limit | 429 | Back off per adapter budget; entries for the cycle dropped, exits prioritized | No |
| Transport/TLS failure | handshake/cert/HTTP error | Fail closed: no order leaves; broker-native stops protect positions | If > 5 min |
| Settlement mismatch | ledger vs broker | Entries HOLD; reconcile (R18) | If unresolved in 1 session |
| JEV / LLM provider outage | timeout, 5xx, malformed | `jev_v4` sleeves: 1 retry → HOLD; S5 streak → SOFT; always-take sleeves unaffected | At S5 alert |
| Research plane down or stale | features past TTL | Features absent; research-dependent entries HOLD (S6) | If > 6 h |
| Sleeve engine down | no candidates past window | No new entries for that sleeve; exits unaffected | If > 1 session |
| Runaway research loop | R15 | per-symbol pause; plane pause on majority-in-window | At pause |
| Conflicting evidence | `disagreement=true` | HOLD (R14) | No |
| Spend spike | hourly projection | Tier 1 → 2 → 3 (R10), ending in MEDIUM kill + demote | At tier 3 |
| Calibration decay (`jev_v4` sleeves) | trailing-200 Brier | Sleeve entries halt, demote (R13) | Yes |
| Journal chain break | daily verify | HARD kill, forensics before restart | Yes |
| Stage chain unverifiable | startup / cycle boundary | Fall back to G0_PAPER, alert | Yes |

The pattern behind every row: **new risk stops, old risk stays managed,
and the system fails toward paper.**

## 6.3 Daily ops rhythm (paper phase)

| Time | Action |
|---|---|
| 00:00 UTC | Roll journal files, verify hash chain (the ops-day clock advances only after verification succeeds), snapshot equity |
| Continuous (session) | Feed + sleeve schedules; alerts on R5/S3/S5/R18 |
| Every 15 min | Position + settlement reconcile (S2) |
| Hourly | AI spend projection + tier evaluation (R10) |
| 16:30 ET | Sleeve signals from SIP daily bars; next-session order plan journaled |
| 08:00 UTC | Daily summary (script, no LLM): trades, PnL per sleeve, holds by reason, TCA vs model, settlement state, AI spend + projection + tier + cost per closed trade, feature/candidate rejects, research aborts, stage |
| Weekly | Per-sleeve tracking vs backtest; trial-ledger review; ≤3 research-factory proposals triaged (doc 11) |
| 23:55 UTC | Replay sample (D1), back up journal + ledgers |

## 6.4 Monitoring and alerting

- Liveness: heartbeat file touched every cycle in session; stale > 120 s
  in session → alert. Off-session silence is expected.
- Kill switch: `HALT` file → entries stop within 1 cycle. Deleting it does
  NOT resume (restart + flag required). MEDIUM and HARD per doc 10 §10.3,
  drilled monthly.
- (v3) **Outbound-only alert adapter** — required before unattended
  operation of G0b: a one-way push (e.g. authenticated HTTPS POST to a
  push-notification endpoint, or SMTP send-only) carrying bounded,
  redacted alert records. It accepts no inbound messages, runs no
  commands, holds no broker credential, and is not a chat agent (the
  doc 01 chat-gateway ban stands). At minimum it carries HARD kill, stage
  demotion, R13, R18 compliance incidents, and spend tier 3. An alert
  written only to a log file is not an alert in an unattended system.
- Autonomy metric: every human intervention logged with its cause.

## 6.5 What "done" means

- [ ] Kill-switch drill (HALT → no entries in ≤1 cycle, exits unaffected).
- [ ] Reconcile drill (forced drift detected + synced + logged), including
      a settlement-ledger mismatch.
- [ ] Daily summary runs from the journal alone.
- [ ] `cost_v2` implemented in the research harness and in G0b shadow
      accounting; TCA per fill in the summary.
- [ ] Transport wired and drilled on Alpaca paper (doc 04 5b).
- [ ] OTO stop-only protection + MOC exit sequencing drilled, including
      stop-fills-before-MOC and MOC-reject paths.
- [ ] Journal retention 90 days local + daily backup; redaction by grep.
- [ ] Outbound-only alert adapter delivers a real notification on a
      forced HARD kill.
- [ ] 30 clean G0b paper days with zero R-rule violations.
- [ ] Every §6.2a row drilled at least once, exits proven alive.

## Locked decisions

- Journal-before-order for normal entries (emergency-exit exception in
  §6.1). No row = no send for entries.
- Exits never depend on JEV, research freshness, or WS health (broker-
  native stops; REST fallback). Only entries may wait on data.
- Resume-from-HALT is manual. Always. So is every stage promotion.
- Broker-status quarantine (frozen, per Alpaca order-lifecycle docs):
  `done_for_day`, `calculated`, and `replaced` are NEVER routed as generic
  DEAD; the id is burned, filled qty authoritative-for-today but never
  folded; first sighting freezes the symbol + journals + alerts; any
  next-session exposure is a NEW intent under a NEW id. `canceled`/
  `expired`/`rejected` stay safe-DEAD.
- Live-hold statuses (frozen): `held`, `stopped`, `accepted_for_bidding`
  are PENDING; the runner waits, never re-issues blind.
- Every outage default stops new risk and keeps old risk managed.
- Paper fill rule (LOCKED 2026-09-18, `paper_fill_v1`): BUY at mid + one
  full spread adverse, SELL at mid − one full spread adverse (min 1bp),
  full size, flagged `simulated`, no partials in paper. `cost_v2` (§6.0a)
  wraps it for all v3 sleeves; neither is ever loosened without a doc
  edit + fresh paper window.
- Alpaca paper results are plumbing evidence; the harness cost model is
  the economic evidence (§6.0a).
- Alerts are outbound-only; nothing on a capital host accepts inbound
  commands.
- AUDIT STOP RULE (frozen engineering-process rule, v3-strengthened):
  reopening audit is allowed only for (1) P0/P1 decision-outcome changes,
  (2) corruption/loss of durable trading state, (3) duplicate-order /
  wrong-side / wrong-quantity risk, (4) security boundary violations,
  (5) reproducibility / lookahead / statistical-validity failures, (6) a
  failing correctness/drill gate. P2 cleanup collects into one bounded
  backlog, never another cascade. (v3) **Alpha-first:** no hardening
  round may start on a component whose stage does not yet need it while a
  strategy gate on the critical path is open; the question "does this
  change the probability that the fund makes money or loses it?" decides
  priority. Grep observations are static tripwires, not proofs
  (compiler-enforced authority probes excepted).
