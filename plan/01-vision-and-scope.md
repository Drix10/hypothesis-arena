# 01 — Vision and Scope

## What we are building

An AI hedge fund: a system that turns curated X/Twitter knowledge + market data
into systematic crypto-futures trading decisions, executed by a C++ core at
low latency, with every decision calibrated (JEV) and risk-gated.

Two inputs, one output:
- **Input A (slow, rich):** curated technical knowledge + sentiment from X Lists
  (ported from the Twitter-Gemini-GitHub-MVP pipeline).
- **Input B (fast, thin):** WEEX orderbook / trades / account state.
- **Output:** BUY / SELL / HOLD + size + stop, executed or paper-logged.

## Who decides what (locked)

| Layer | Job | Technology |
|---|---|---|
| Thesis text | Write the "why" in prose | Gemini / LLM (5-min loop, out of hot path) |
| Routing, ranking, gating | Calibrated yes/no, pick-winner, conviction | JEV via OpenRouter Decisions API |
| Snapshot, risk, execution | Fast, deterministic, auditable | C++ from scratch |
| Knowledge feed | Curated signals from X Lists | Sidecar (API/RSS, never Selenium in C++) |

Hot path never blocks on prose LLM. Hot path may read cached JEV answers.
Risk gates are local and unconditional — they run even if JEV is down
(default: HOLD).

## Explicitly OUT of scope (do not build)

1. No Selenium in the trading system. Ever. (Scraping was the old pipeline's
   weakest part; the feed becomes API/RSS-based sidecar or dies.)
2. No LinkedIn/blog syndication in the fund. That was the content pipeline's
   job; it does not ship with trading capital.
3. No FPGA/GPU in phase 1. CPU C++ first, measure, then decide.
4. No new exchange integrations in phase 1. WEEX only.
5. No portfolio UI / investor dashboard in phase 1. Logs + journal files only.
6. No auto fine-tuning of models with live capital in phase 1. Shadow + human
   promote only.
7. No leverage above the risk doc's table. No exceptions, no "just this once".

## Success criteria (phase 1)

- Paper-trade 30 days, every decision logged with: context hash, JEV answers,
  risk verdict, fill or HOLD reason.
- Determinism: same logged context replayed → same decision. Proven by replay test.
- Risk: zero trades violating `05-risk-and-determinism.md`. One violation = halt.
- Latency: context snapshot → order intent < 1 ms local (excl. network + JEV cache read).

## Locked decisions

- Language for hot path: C++ (no debate).
- Decision calibration: JEV `typesafe/jev-1.13` via OpenRouter Decisions API.
- Exchange: WEEX only, phase 1.
- Capital mode: paper until 30 clean days + human sign-off.
