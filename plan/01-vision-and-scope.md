# 01 — Vision and Scope

## What we are building

An AI hedge fund: a system that turns free public information + market data into
systematic forex + US-stock trading decisions, executed by a C++ core at low
latency, with every decision calibrated (JEV) and risk-gated.

It is **fully autonomous in research, decision, and execution**, and **never
autonomous in capital escalation**. After the operator funds it and signs the
stage gate, it runs without supervision: it researches, decides, trades, scores
its own calibration, throttles its own spend, and demotes itself when it
misbehaves. What it cannot do is give itself more money or more rope (doc 10).

Three inputs, one output:
- **Input A (slow, rich):** the agentic research plane — free OSINT, SEC filings,
  macro releases, and X-List sentiment, fused into typed features (docs 08, 09).
- **Input B (fast, thin):** broker quotes / trades / account state (forex majors +
  US-listed stocks).
- **Input C (governing):** the stage file, risk constants, and spend counters —
  the box the other two operate inside (doc 10).
- **Output:** BUY / SELL / HOLD + size + stop, executed or paper-logged.

**The primary edge is statistical, not linguistic.** Indicators, regime detection,
and the risk table do the work; JEV supplies a calibrated gate; the research plane
supplies context and disconfirmation. Published evidence on pure-LLM trading is
poor (doc 09 §9.0), and the architecture is built on the assumption that it is
poor: if the AI layer cannot beat the plain statistical baseline net of its own
inference cost, doc 11 requires removing it, not tuning it.

## Who decides what (locked)

| Layer | Job | Technology |
|---|---|---|
| Thesis text | Write the "why" in prose | Research plane `hypothesize` node (capped, advisory only) |
| Routing, ranking, gating | Calibrated yes/no, pick-winner, conviction | JEV via OpenRouter Decisions API |
| Snapshot, risk, execution | Fast, deterministic, auditable | C++ from scratch |
| Knowledge feed | Curated signals from X Lists | Sidecar (API/RSS, never Selenium in C++) |
| Research, OSINT fusion, hypotheses, self-critique | Produce typed features + capped prose | Research plane: LangGraph + smolagents, sandboxed, off hot path (doc 08) |
| Capital stage, kill switches, spend | Permit or forbid; never expand | `STAGE` file + C++ constants + human signature (doc 10) |
| Calibration + promotion | Score answers, judge challengers | Offline harness + human sign-off (doc 11) |

Hot path never blocks on prose LLM. Hot path may read cached JEV answers.
Risk gates are local and unconditional — they run even if JEV is down
(default: HOLD).

Agents never size, send, amend, or cancel an order, and never see equity or PnL.
They write typed features into one file; `ctx/` validates and bounds them. The
boundary is enforced by OS permissions, not convention (doc 08 §8.1, R11).

## Explicitly OUT of scope (do not build)

1. No Selenium in the trading system. Ever. (Scraping was the old pipeline's
   weakest part; the feed becomes API/RSS-based sidecar or dies.)
2. No LinkedIn/blog syndication in the fund. That was the content pipeline's
   job; it does not ship with trading capital.
3. No FPGA/GPU in phase 1. CPU C++ first, measure, then decide.
4. No new venues in phase 1. Phase-0 brokers only.
5. No portfolio UI / investor dashboard in phase 1. Logs + journal files only.
6. No auto fine-tuning of models with live capital in phase 1. Shadow + human
   promote only.
7. No leverage above the risk doc's table. No exceptions, no "just this once".
8. No paid data subscriptions for core operation. Free tiers only; a source that
   starts charging is dropped, not funded (doc 09).
9. No self-modifying agents, no runtime prompt/tool/skill rewriting, no online
   learning on the live path. Shadow + human promote only (doc 11).
10. No chat-gateway agent frameworks on the trading host (Hermes Agent, OpenClaw
   and similar). Inbound chat control of a process near capital is a
   remote-code-execution path, not a feature (doc 08 §8.2).
11. No automatic capital escalation. Ever. Promotion is a human editing a file
   with the process stopped (doc 10 §10.1).

## Success criteria (phase 1)

- Paper-trade 30 days, every decision logged with: context hash, JEV answers,
  risk verdict, fill or HOLD reason.
- Determinism: same logged context replayed → same decision. Proven by replay test.
- Risk: zero trades violating `05-risk-and-determinism.md`. One violation = halt.
- Latency: context snapshot → order intent < 1 ms local, including the cached-JEV
  read. Excludes all network calls (JEV fetch, order send, reconcile).
- Calibration: JEV `enter` and `veto` beat a base-rate baseline on Brier score over
  ≥ 200 decisions (doc 11 §11.1).
- Autonomy: 30 consecutive days with no human intervention required, and every
  intervention that *was* required logged with its cause.
- Cost: AI spend within the stage cap, and cost per closed trade reported daily
  (doc 10 §10.4).
- Isolation: the research plane cannot write the journal, the `HALT` file, or the
  `STAGE` file. Proven by test, not asserted.

## Venue + data proposal (Phase-0 proposal — human must accept)

Researched 2026-09-18. Free/paper only, no paid data invented. Nothing here is
approved until a human signs it; approval writes these names into the Locked
decisions below.

- **Forex majors (paper first): OANDA v20 practice.** Free demo, REST +
  streaming pricing, `api-fxpractice.oanda.com`, personal token from the
  practice portal. Same API shape as live, so paper-to-live is a URL + token
  swap. Fallback if signup frictions: FXCM demo (FIX/ForexConnect).
- **US stocks (paper first): Alpaca paper.** Free, live-market-price
  simulation, REST + WebSocket, resettable, no deposit. Same key-swap path to
  live. Stocks trade 09:30–16:00 ET only (R9); sub-$25k counts day-trades
  locally in `risk/` regardless of broker pattern-day-trader flagging.
- **Feed protocol:** broker WebSocket/REST poller in `feed/` (OANDA streaming
  quotes, Alpaca WS); REST reconcile every 15 min (S2). No FIX in v1.
- **Sessions:** forex needs an open venue feed (no closed-market entries);
  stocks hard window 09:30–16:00 ET. Session calendar source: exchange + broker
  holiday calendars, free, fail-closed (unknown = closed).
- **Macro calendar (free):** FRED/ALFRED release coverage + Fed/ECB calendars
  (primary web pages + ICS feeds where offered). ALFRED vintages for anything
  replayed (no revised-data lookahead).
- **Earnings calendar (free):** EDGAR-derived (8-K item 2.02 / earnings-release
  exhibits) + company IR pages. No paid earnings API.

## Locked decisions

- Language for hot path: C++ (no debate).
- Decision calibration: JEV `typesafe/jev-1.13` via OpenRouter Decisions API.
- Instruments: forex majors + US-listed stocks. No crypto in v1.
- Venue/data: broker(s) + feed chosen in Phase 0 (paper/sandbox first); names written
  into this doc before any build.
- Capital mode: paper until 30 clean days + human sign-off. Four stages
  (G0_PAPER → G1_TINY → G2_SCALED → G3_FULL), human-signed, never auto-promoted;
  demotion is automatic and cannot be vetoed (doc 10).
- Research plane: LangGraph (orchestration, durable checkpoints) + smolagents
  (sandboxed leaf workers) + self-hosted Langfuse/OpenTelemetry (doc 08 §8.2).
- Data: free tiers only. Every non-price source starts CONTEXT or NULL and is
  promoted to TRIGGER only on measured hit-rate + human sign-off (doc 09).
- The statistical baseline (no JEV, no research plane) is a permanent fixture and
  the bar the AI layer must beat net of cost (doc 11 §11.3).
