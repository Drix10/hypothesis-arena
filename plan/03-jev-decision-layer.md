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
  - ray: "ML momentum / macro surprises / flows"
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
veto.noul > 0.5                → HOLD (risk veto, unconditional, logged)
enter.noul < 0.5                → HOLD (no edge)
enter 0.5–0.8 + (analyst == karen
  OR conviction < strong)       → HOLD (mid-band needs strong non-karen)
analyst == karen                → HOLD (judge voted risk)
conviction == flat              → HOLD
conviction == lean              → size 5% notional/equity
conviction == strong            → size 10–15% notional/equity
conviction == max               → size up to 25% IF §3.3 distribution test
                                  passes, else downgrade to strong
```

`enter` bands: `>0.8` = act on any passing row; `0.5–0.8` = act only via the
mid-band row above; `<0.5` = HOLD. Sizes are % notional/equity at the leverage
from doc 05 §5.2 (still capped by R2). Tune only with logged data, never intraday.

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
  "symbol": "EURUSD",
  "price": 0, "spread_bps": 0, "session": "asia|london|new_york|us_open|closed",
  "indicators": {"rsi": 0, "zscore": 0, "atr": 0, "regime": "trend|range|volatile"},
  "sentiment": {"stale": false, "signal_count_6h": 0},
  "signals": [{"id": "...", "list": "...", "text": "<=280 chars"}],
  "portfolio": {"equity": 0, "exposure_pct": 0, "open_positions": 0},
  "thesis_text": "≤500 chars from Gemini 5-min loop, may be empty",
  "risk_flags": {"var_breach": false, "corr_breach": false}
}
```

No numeric sentiment score in v1 — deliberate. Nothing upstream produces polarity
(signal records are raw text), and a keyword-guessed score would be fake precision.
JEV reads the inline signal texts directly (max 5, newest first, TRIGGER-classified
lists only, doc 02 §2.4). If scored sentiment is ever wanted, it arrives as a new
versioned question, not a smuggled float.

## 3.5 Caching, failure, determinism

Cache key = `jev_slow_key + question_set_version`, NOT the full context_hash.
The full hash changes every tick (price moves), so keying on it would guarantee
zero cache hits and spam the API. Slow key fields only: `symbol ‖ regime ‖
signal-count bucket (0/1–2/3–5/6+) ‖ exposure bucket (0–25/25–50/50–75%) ‖
thesis hash (first 16 hex) ‖ question version`. TTL 60 s. The full `context_hash`
is still logged per decision for replay.
- JEV down / timeout (>10 s) / malformed response → exactly 1 retry after ~5 s,
  then HOLD + log `jev_error`. Every failure increments the S5 streak counter.
  Risk gates still run locally.
- Daily call cap (default 500, alert at 80%). Breaching it pauses entries exactly
  like S5; exits stay live.
- Redaction: logged state rows carry signal texts (≤280 chars) but never API keys,
  tokens, or full thesis dumps. Verified by grep before any log leaves the machine.
- `question_set_version` pinned in code (starts at `v1`). Any criteria change
  bumps version, invalidates cache, logged in journal.
- Every cycle logs: context_hash, answers, probabilities, thresholds applied,
  final action. Replay test re-applies §3.2 to logged rows.

## 3.6 What "done" means

- [ ] `jev.py` sidecar: stdin state → 1 batched call → stdout answers + log row.
- [ ] Threshold/consensus table unit-tested with 20 hand-worked cases.
- [ ] Cache + failure-path tests (timeout, 500, malformed → HOLD).
- [ ] Replay of 200 recorded/synthetic states: distribution sane
      (no degenerate all-0.99), cache hit rate > 50% on slow key.

## Locked decisions

- Exactly these 4 questions in v1. New questions need a version bump + doc edit.
- Thresholds changed only between test windows, never live.
- JEV never sizes directly; it scores, the table sizes.
