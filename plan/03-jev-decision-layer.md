# 03 — JEV Decision Layer

Model: `typesafe/jev-1.13` via `POST https://openrouter.ai/api/alpha/decisions`.
JEV writes no text. It answers typed questions about a `state` with calibrated
probabilities. Our code owns the workflow and acts on the answers.

## 3.1 The single call shape (locked)

One Decisions call per trading cycle, 4 questions batched, state = frozen
context JSON (from C++ snapshot, serialized by the sidecar):

- `enter` (noul): "Given this context and thesis, enter this trade now?"
  - criteria.true: "Edge + timing align; risk within limits"
  - criteria.false: "Wait or stay flat; edge unclear or timing off"
- `analyst` (choice): "Whose thesis wins this cycle?"
  - jim: "Mean reversion / z-score / regime"
  - ray: "ML momentum / funding / liquidation"
  - karen: "Risk veto / hold / reduce"
  - quant: "Liquidity / slippage / VWAP execution"
- `conviction` (score): "Position conviction?"
  - ["flat", "lean", "strong", "max"]
- `veto` (noul): "Does this trade breach risk?"
  - criteria.true: "VaR, correlation, drawdown, or exposure breach"
  - criteria.false: "Within all limits"

Response fields used: `answers.enter.noul`, `answers.analyst.choice`
(+`probabilities`), `answers.conviction.score`, `answers.veto.noul`.

## 3.2 Decision table (locked — code implements exactly this)

```
veto.noul > 0.5            → HOLD (risk veto, unconditional, logged)
else enter.noul < 0.5      → HOLD (no edge)
else analyst == karen      → HOLD (judge voted risk)
else conviction == flat    → HOLD
else conviction == lean    → size = min_size
else conviction == strong  → size = standard_size
else conviction == max     → size = standard_size AND requires 3/4 analyst
                              agreement (see 3.3), else downgrade to strong
```

Thresholds `0.5 / 0.8` for enter: `>0.8` = act now, `0.5–0.8` = act only if
`analyst != karen` and conviction ≥ strong, `<0.5` = HOLD. Tune only with
logged data, never intraday.

## 3.3 Consensus rule (ported from hypothesis-arena)

- conviction `max` requires P(top choice) ≥ 0.6 AND runner-up ≤ 0.3 from the
  `analyst.probabilities` distribution; else downgrade one level.
- `strong` requires top choice P ≥ 0.5; else downgrade to `lean`.
- Thesis prose (Gemini) is advisory only — it populates `state.thesis_text`
  but never overrides the table above.

## 3.4 State contract (what the sidecar sends)

```json
{
  "context_hash": "sha256 of canonical context",
  "symbol": "BTCUSDT",
  "price": 0, "funding": 0, "oi_change": 0,
  "indicators": {"rsi": 0, "zscore": 0, "regime": "trend|range|volatile"},
  "sentiment": {"score": 0, "stale": false, "top_signals": ["id..."]},
  "portfolio": {"equity": 0, "exposure_pct": 0, "open_positions": 0},
  "thesis_text": "≤500 chars from Gemini 5-min loop, may be empty",
  "risk_flags": {"var_breach": false, "corr_breach": false}
}
```

## 3.5 Caching, failure, determinism

- Cache key = `context_hash + question_set_version`. Same hash → cached answers,
  no API call. TTL 60 s.
- JEV down / timeout (>10 s) / malformed response → HOLD + log `jev_error`.
  Risk gates still run locally.
- `question_set_version` pinned in code (starts at `v1`). Any criteria change
  bumps version, invalidates cache, logged in journal.
- Every cycle logs: context_hash, answers, probabilities, thresholds applied,
  final action. Replay test re-applies §3.2 to logged rows.

## 3.6 What "done" means

- [ ] `jev.py` sidecar: stdin state → 1 batched call → stdout answers + log row.
- [ ] Threshold/consensus table unit-tested with 20 hand-worked cases.
- [ ] Cache + failure-path tests (timeout, 500, malformed → HOLD).
- [ ] 7-day paper log showing answer distributions (no degenerate all-0.99).

## Locked decisions

- Exactly these 4 questions in v1. New questions need a version bump + doc edit.
- Thresholds changed only between test windows, never live.
- JEV never sizes directly; it scores, the table sizes.
