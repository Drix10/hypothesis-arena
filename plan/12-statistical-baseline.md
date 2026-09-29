# 12 — Controls and Benchmarks (freeze v3; `baseline_v1` frozen as negative control)

Freeze v2 called `baseline_v1` "the permanent champion" and made "beat
it" the AI layer's bar. S2 then measured it: it loses money, for a reason
that is structural (§12.7). Beating a losing control proves nothing, so
freeze v3 keeps `baseline_v1` exactly as specified — frozen, reproducible,
never edited — but demotes it to a **negative control** and adds the
benchmark set every sleeve must beat (§12.6). The frozen specification
below (§§12.1–12.5) is unchanged.

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

## 12.6 Benchmark set (v3) — what every sleeve is scored against

Computed on the same window, same calendar, same `cost_v2`, daily returns:

1. **Cash:** the T-bill leg (BIL total return). A sleeve that cannot beat
   cash net of cost is not a sleeve.
2. **Vol-matched passive:** buy-and-hold of the sleeve's natural passive
   counterpart (SPY for equity sleeves; the equal-weight buy-and-hold of
   the sleeve's own universe for T1/T2), scaled to the sleeve's realized
   volatility with cash (no leverage: scale ≤ 1, so the sleeve is instead
   compared at matched volatility by de-risking whichever is riskier).
3. **60/40** (SPY/IEF monthly rebalanced) as a sanity reference.
4. **The same sleeve without its AI component** (paired; doc 11 §11.3b).
5. **`baseline_v1`** — negative control and harness regression check: its
   frozen S2 numbers must reproduce bit-for-bit from the same manifests.

## 12.7 S2 result and diagnosis (recorded 2026-09-28)

S2 (Alpaca IEX 1 h bars, equities, validation slice): the primary
spread-eligible ledger was EMPTY (no quotes fetched → every candidate
spread-unknown); the diagnostic ledger (1bp-floor costs) realized 573
trades: 8 wins, 464 time exits (81%), average −0.049R, Sharpe −1.09 at 1×
and −2.10 at 3× cost, drawdown 6.3%.

Diagnosis (structural, not luck): `exit_profile_v1` places the stop at
1.5×ATR(14) of **hourly** bars and the take-profit at 2R ≈ 3 hourly ATRs,
while equities must exit by the session close. A 3-hourly-ATR move inside
at most 6.5 hours is rare, so most trades become time exits that pay
costs on a near-random walk. Any successor to `baseline_v1` needs a
horizon-consistent exit profile — which is a new versioned strategy (a
doc 02 sleeve), never an edit of v1.

S2 closure (doc 07 A1): rerun on SIP bars + SIP quotes so the primary
ledger exists; record the numbers; the FX leg is dropped (forex is
research-only). A negative result, honestly recorded, closes S2.

## Locked decisions

- `baseline_v1` is frozen and permanent as a negative control and harness
  regression check. It is never edited in place, never promoted, and
  never retired without an operator-approved doc edit. The deterministic
  reference implementation is `research/strategy/baseline_v1.py` and must
  reproduce this file exactly.
- Every sleeve and every AI component is scored against the §12.6
  benchmark set on the same window with the same costs. Losing net of
  cost to cash or to the vol-matched passive benchmark = not promotable.
  An AI layer that loses to its own no-AI variant is removed, not tuned.
- No control or sleeve may depend on data that is not freely available
  point in time (the point-in-time S&P-500 constituent artifact required
  by §12.1 is not free; `baseline_v1` equity runs therefore state their
  universe hash and its survivorship limitation explicitly).
