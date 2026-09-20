# 12 — Statistical Baseline (the permanent champion)

The AI layer must beat *this*, net of its own cost, or be removed (doc 11 §11.3).
The baseline is frozen, versioned (`baseline_v1`), and fully reproducible — a
vague "indicators + regime" is not a thing you can beat. Any challenger is
scored against this exact specification on the same window.

## 12.1 Universe

- Forex majors: EURUSD, USDJPY, GBPUSD, USDCHF, AUDUSD, USDCAD (6).
- US stocks: deterministic scan (doc 04 universe service) filtered to
  POINT-IN-TIME S&P-500 constituents (BASE1): membership, delistings, IPO
  age, liquidity, and corporate actions are all evaluated as-of the entry
  timestamp from versioned constituent records — today's membership applied
  to history is survivorship bias and voids the run. Filter: median daily
  dollar volume > $50M and spread ≤ 5bp at entry, point-in-time.
- The point-in-time universe is a VERSIONED ARTIFACT (frozen requirement):
  `universe_vN` = constituent list + membership intervals + delisting/IPO
  dates + corporate-action adjustments, content-hashed and pinned per
  promotion run. The harness loads `universe_vN` BY HASH; "current S&P
  constituents" is never an input to a historical run, and any run that
  cannot name its universe hash is void. A new artifact version = new
  hash = re-validation of every challenger scored against it.
- No crypto, no OTC, no IPOs younger than 1 year, no symbols with pending
  corporate actions.

## 12.2 Features (exact)

RSI(14), z-score(20, 2σ), ATR(14), 20/50 trend filter, session flag, realized
1h-vol bucket. Regime = trend/range/volatile from ADX(14) + vol bucket with
frozen cutoffs (ADX>25 trend, else range unless vol bucket high → volatile).
Vol bucket construction (BASE3, frozen): 1 h log-return stdev, trailing 24
bars, NYSE-session bars for equities (09:30–16:00 America/New_York), 24/5
bars for FX; cutoffs low < 0.5× / high > 2× the trailing-480-bar median;
warmup 480 bars before the first bucketed decision; missing bars skipped,
never filled. Nothing else. No research plane, no JEV, no text.

## 12.3 Entries

- Mean reversion (range regime only): |z| > 2 → toward mean.
- Momentum (trend regime only): 20>50 and RSI(14) confirms direction → with
  trend. Confirmation frozen (BASE2): long requires RSI(14) > 50, short
  requires RSI(14) < 50.
- Macro regime (volatile): no entries. One rule for both asset classes.
- Max 3 positions, R1–R9 all apply (the baseline obeys the same risk table).

## 12.4 Exits and sizing

- exit_profile_v1 (doc 03 §3.3): 1.5×ATR stop, 2R TP, time_exit (stocks EOD,
  forex 24h). Risk budget 25bp/trade, hierarchy per doc 03 §3.3 steps 2–6.
- No discretion, no overrides, no second-guessing.

## 12.5 Costs and labels

- Paper fill model (doc 06 Locked): BUY at mid + one full spread adverse,
  SELL at mid − one full spread adverse (BASE4), min 1bp, full size,
  simulated. Cost stress at 1×/1.5×/2×/3× spread + fee — the baseline must be
  reported at all four; a challenger beats the baseline only if it beats it at
  2× too (robustness, not optimism).
- Labels per doc 11 §11.1 protocol (stop-first, gap = loss, censored third class).
- Sessions America/New_York for stocks; forex needs open venue feed. Halts and
  missing data → excluded, never interpolated.

## Locked decisions

- `baseline_v1` is permanent. It can gain versioned successors; it is never
  edited in place and never retired without a human-signed doc edit.
- The AI layer (JEV + research + all challengers) is scored against this file,
  same window, same costs. Losing net of cost = removal, not tuning.
