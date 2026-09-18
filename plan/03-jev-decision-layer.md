# 03 — JEV Decision Layer

Model: `typesafe/jev-1.13` via `POST https://openrouter.ai/api/alpha/decisions`,
or direct TypeSafe. Endpoint, model string, and access are verified in Phase 0
before any build; the pinned string is written here and never floats (D3).
`jev-latest` or any floating alias is forbidden — a silent version change breaks
replay (D3) and invalidates every calibration curve in doc 11.
JEV writes no text. It answers typed questions about a `state` with calibrated
probabilities. Our code owns the workflow and acts on the answers.

## 3.1 The single call shape (locked)

One Decisions call per trading cycle, 4 questions batched, state = frozen
context JSON (from C++ snapshot, serialized by the sidecar).

**Still exactly four questions.** The research plane (doc 08) makes the *state*
richer; it does not make the question set wider. More questions cost tokens on
every cycle, need 20 fresh hand-worked cases each, and dilute the calibration
sample per question (doc 11 §11.1). Richness goes in the state, where it is free
to carry and cheap to score:

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
disagreement == true            → HOLD (R14: conflicting research never sizes up)
event_window.scheduled_event_within_60m
                                → HOLD (no entries into known scheduled events)
calibration.vs_baseline == worse
                                → HOLD (R13 will also halt entries; this is the
                                  in-band belt to that suspenders)
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

Rows are evaluated top to bottom; the first HOLD wins and is the logged reason.
The four new rows sit above the `enter` bands deliberately — a risk veto, a
research contradiction, a known event, and a broken calibration each stop the
trade regardless of how good the edge looks.

`enter` bands: `>0.8` = act on any passing row; `0.5–0.8` = act only via the
mid-band row above; `<0.5` = HOLD. Sizes are % notional/equity at the leverage
from doc 05 §5.2 (still capped by R2). Tune only with logged data, never intraday.

## 3.3 Consensus rule (ported from hypothesis-arena)

- conviction `max` requires P(top choice) ≥ 0.6 AND runner-up ≤ 0.3 from the
  `analyst.probabilities` distribution; else downgrade one level.
- `strong` requires top choice P ≥ 0.5; else downgrade to `lean`.
- Thesis and critique prose are advisory only — they populate `state.thesis_text`
  and `state.critique_text` but never override the table above. Prose cannot raise
  conviction; `disagreement` can only lower it (to HOLD).

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
  "thesis_text": "≤500 chars from the research plane, may be empty",
  "critique_text": "≤500 chars, the strongest disconfirming case, may be empty",
  "disagreement": false,
  "features": [{"kind": "filing_event", "symbols": ["AAPL"], "value": {"type": "enum", "v": "8-K:item-2.02"},
                "confidence_bucket": "high", "age_s": 240, "source_id": "edgar_submissions"}],
  "features_absent": ["edgar_submissions"],
  "event_window": {"scheduled_event_within_60m": false, "kind": "none|earnings|macro_release"},
  "calibration": {"enter_brier_200": 0.0, "vs_baseline": "better|equal|worse"},
  "stage": "G0_PAPER|G1_TINY|G2_SCALED|G3_FULL",
  "risk_flags": {"var_breach": false, "corr_breach": false}
}
```

State additions (doc 08 §8.5 supplies them, `ctx/` validates and bounds them):
- `features`: max 16 in the JEV payload (the snapshot carries up to 64; the payload
  takes the 16 newest TRIGGER/CONTEXT-eligible ones). Enums, booleans, counts and
  buckets only — **no model-produced floats**, same reasoning as §3.4 below.
- `features_absent`: sources that *should* be present and are not. Absent is a
  distinct state from neutral and JEV is told which it is.
- `disagreement`: true when the `critique` node contradicts `hypothesize`, or when
  two TRIGGER features on the same symbol point opposite ways. It is an input to
  the decision table below and to R14.
- `calibration`: the system's own recent track record, so a degraded run is visible
  in-band as well as to R13.
- `stage`: present so the logged row is self-describing on replay. **JEV does not
  size from it** — sizing is the table's job and the stage multiplier is applied by
  `risk/` afterwards.

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
  like S5; exits stay live. The cap is a *safety* limit, not the budget: the
  budget is the spend tier system in doc 10 §10.4, which throttles **research**
  first and never throttles JEV away. If money is tight the system knows less; it
  does not decide less carefully.
- Every call is cost-tagged `{stage, cycle_id, symbol, node, model, tokens, usd}`
  (doc 10 §10.4). An untagged call is a build failure.
- Every answer is scored against realized outcomes, HOLDs included, per doc 11
  §11.1. Calibration worse than the base-rate baseline over 200 decisions halts
  entries (R13).
- Redaction: logged state rows carry signal texts (≤280 chars) but never API keys,
  tokens, or full thesis dumps. Verified by grep before any log leaves the machine.
- `question_set_version` pinned in code. **Now `v2`**: the question texts are
  unchanged but the state they read is materially richer, so the version bumps and
  20 fresh hand-worked cases are required before build (Phase 0). Any criteria
  change bumps version, invalidates cache, logged in journal.
- Slow-key fields gain `disagreement` and a features-count bucket (0/1–3/4–8/9+),
  so a new contradicting feature busts the cache instead of being masked by a
  60 s TTL. Everything else about the key is unchanged.
- Every cycle logs: context_hash, answers, probabilities, thresholds applied,
  final action. Replay test re-applies §3.2 to logged rows.

## 3.6 What "done" means

- [ ] `jev.py` sidecar: stdin state → 1 batched call → stdout answers + log row.
- [x] Threshold/consensus table unit-tested with 20 hand-worked cases
      (§3.7, Phase-0 evidence, 2026-09-18).
- [ ] Cache + failure-path tests (timeout, 500, malformed → HOLD).
- [ ] Replay of 200 recorded/synthetic states: distribution sane
      (no degenerate all-0.99), cache hit rate > 50% on slow key.

## 3.7 Phase-0 hand-worked cases (evidence, 20 cases, 2026-09-18)

Notation: E = enter.noul, A = analyst winner (probs top/runner), C =
conviction, V = veto.noul, D = disagreement, W = event_window scheduled,
K = calibration.vs_baseline. Expected = table action + size + logged reason.

| # | E | A (top/runner) | C | Flags | Expected |
|---|---|---|---|---|---|
| 1 | .90 | jim (.7/.2) | max | V=.8 | HOLD veto (row 1 beats perfect setup) |
| 2 | .85 | ray (.6/.3) | strong | D=true | HOLD R14 disagreement |
| 3 | .90 | quant (.7/.2) | strong | W=true macro_release | HOLD event window |
| 4 | .88 | jim (.7/.2) | strong | K=worse | HOLD calibration worse |
| 5 | .42 | jim (.7/.2) | strong | — | HOLD no edge (E<.5) |
| 6 | .65 | karen (.6/.2) | strong | — | HOLD mid-band needs strong non-karen |
| 7 | .70 | jim (.6/.3) | lean | — | HOLD mid-band needs strong |
| 8 | .90 | karen (.7/.2) | strong | — | HOLD karen |
| 9 | .92 | jim (.8/.1) | flat | — | HOLD flat |
| 10 | .55 | quant (.6/.3) | strong | — | ACT strong 10-15% (mid-band pass) |
| 11 | .90 | jim (.7/.2) | lean | — | ACT lean 5% |
| 12 | .85 | ray (.55/.3) | strong | — | ACT strong 10-15% (top>=.5) |
| 13 | .93 | quant (.65/.25) | max | — | ACT max ≤25% (consensus pass) |
| 14 | .90 | jim (.55/.40) | max | — | Downgrade strong (runner>.3) |
| 15 | .88 | ray (.45/.3) | strong | — | Downgrade lean 5% (top<.5) |
| 16 | .81 | jim (.6/.2) | lean | — | ACT lean 5% (band edge above .8) |
| 17 | .50 | jim (.6/.2) | strong | — | ACT strong (exactly .5 is mid-band) |
| 18 | .79 | karen (.7/.2) | max pass | — | HOLD, reason = mid-band row (first match wins) |
| 19 | .90 | jim (.7/.2) | strong | V=.50 | ACT strong (veto needs STRICTLY >.5) |
| 20 | .91 | quant (.60/.30) | max | — | ACT max (boundaries inclusive: top>=.6, runner<=.3) |

Cases 17-20 pin boundary semantics: E=.5 belongs to mid-band, V fires only
above .5, consensus thresholds are inclusive. Any future threshold change
re-opens all 20 plus new ones.

## Locked decisions

- Exactly these 4 questions in v2. Richness goes into the state, never into more
  questions. New questions need a version bump + 20 fresh hand-worked cases.
- Research output enters as typed features and two capped prose fields. It can
  lower conviction and never raise it.
- Thresholds changed only between test windows, never live.
- JEV never sizes directly; it scores, the table sizes.
