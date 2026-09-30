# 02 - Strategy Book: Alpha Sleeves (freeze v3, `strategy_book_version: sb1`)

> Legacy filename. Until freeze v3 this doc held the X-lists signal system.
> That material is **NON-PRODUCTION / HISTORICAL** and now lives verbatim in
> `appendix/02-x-lists-archive.md` (X stays out of production: its §2.6).
> The code-phase freeze-check update renames this file; until then the
> path is kept so the frozen gate keeps verifying the archive banner.
> Status label for everything in the archive: HISTORICAL / NON-PRODUCTION.

This is the missing center of the freeze-v2 plan: **what the fund actually
trades, why it might work, and how we will know if it does not.** Every
sleeve below is a hypothesis with an evidence grade, a pre-registration
draft, and kill criteria. None is authorized to trade until it passes the
doc 11 gates. Parameters are literature defaults frozen at
pre-registration; variants count against the trial ledger (doc 11 §11.0).

## 2.0 The funnel (every sleeve walks it, no shortcuts)

```
idea (research factory or human) → pre-registration (frozen spec + variant
count + data window + holdout) → A-gate: historical backtest on SIP data,
trial-ledgered, net of cost_v2 → B-gate: G0a shadow on live data for its
minimum window → champion candidate → G0b paper orders through the kernel
→ G0→G1 human gate → G1 live (one liquid ETF) …
```

A sleeve that fails any gate is recorded with its numbers and archived.
It is never "improved" into passing: a new idea is a new pre-registration.

## 2.1 Evidence grades (used below)

- **A** - multiple peer-reviewed studies + documented post-publication
  out-of-sample persistence.
- **B** - peer-reviewed, but out-of-sample evidence limited, contested, or
  concentrated in segments we can only partly trade.
- **C** - contested or failed replications; worth testing only because the
  test itself answers a question the fund needs answered.
- **D** - speculative. Research factory only.

A published effect is haircut before it is believed: average
post-publication decay is ≈58% (McLean–Pontiff), and new factors need
t ≥ 3 (Harvey–Liu–Zhu). Expected-return statements in this doc are
ranges for planning, never promises.

## 2.2 Sleeve spec template (every sleeve fills every field)

`id / version` · hypothesis · evidence grade + sources · mechanism (why it
should persist) · universe · data (dataset + manifest hash) · signal
(exact) · schedule (signal time, order time, order type) · exit profile ·
sizing · turnover/capacity · cash-account mechanics · AI involvement ·
known failure modes · kill criteria · minimum evaluation windows · status.

## 2.3 Sleeves

### T1 `trend_etf_v1` - ETF time-series trend (first champion candidate)

- **Hypothesis:** asset-class returns show time-series momentum; holding an
  asset only while its price is above its long moving average captures
  most of its return with far smaller drawdowns.
- **Grade B+.** Time-series momentum is documented across asset classes
  (Moskowitz–Ooi–Pedersen 2012; century-long studies); post-2008 Sharpe
  broadly comparable to pre-2008, but with long flat spells (2009–2013)
  and alpha partly attributable to volatility scaling. Long-only ETF
  implementations (moving-average timing) are widely replicated.
- **Mechanism:** under-reaction then slow adjustment; hedging demand;
  crisis-alpha from exiting risk assets in trends down.
- **Universe (5 = kernel cap):** VTI (US equity), VEU (ex-US equity), VNQ
  (US REITs), IEF (7–10y Treasuries), DBC (commodities). Cash leg: BIL
  (T-bills). Common history starts 2007 in the literature; the free SIP feed only reaches back to 2016-01-04 (see doc 09 9.1a).
- **Signal (primary):** on the last trading day of the month, asset held
  for the next month iff its month-end close > the mean of its last 10
  month-end closes; else its slot is cash.
  **Registered variant (counts as 2 trials):** 12-month total return minus
  T-bill return > 0.
- **Schedule:** signal from the official close (SIP daily bar); orders the
  next session: sells-to-close first via market-on-close; buys the session
  after (settled proceeds, R18). One rebalance per month.
- **Exit profile `exit_trend_v1`:** signal exit at rebalance; broker-native
  catastrophe stop at entry × (1 − 3 × 20-day ATR%) (GTC, re-placed each
  rebalance). Requires the OTO stop-only protection shape (doc 13 P3.5).
- **Sizing:** equal weight 1/5 of sleeve capital per slot (fewest free
  parameters); whole shares; the kernel's risk-budget hierarchy still
  caps each position (doc 03 §3.3 steps 3–6).
- **Turnover/capacity:** ~2–4 trades/month; capacity irrelevant at our
  scale.
- **AI involvement:** none in the signal. The research factory may
  propose variants; each is a new trial.
- **Failure modes:** whipsaw in range-bound years; correlated drawdown
  when all assets fall together before signals flip; month-end timing
  luck.
- **Kill:** A-gate fail; or G0a/G0b drawdown > 1.5× the backtest's worst
  12-month drawdown; or Sharpe lower bound < 0 after the minimum window.
- **Minimum windows:** A-gate full history with an untouched final 3-year
  holdout; B-gate 3 months shadow (few trades - judged on tracking error
  vs its backtest, not on Sharpe).

### T2 `sector_mom_v1` - sector relative + absolute momentum

- **Hypothesis:** industries with the strongest 12-month returns (skipping
  the last month) keep outperforming over the next month; an absolute
  filter avoids holding equities in downtrends.
- **Grade B.** Industry momentum (Moskowitz–Grinblatt 1999) persists
  but decays and suffers momentum crashes.
- **Universe:** 9 original SPDR sector ETFs (XLB, XLE, XLF, XLI, XLK, XLP,
  XLU, XLV, XLY; from 1998). Cash leg BIL.
- **Signal:** rank on 12-1-month total return; hold the top 3 equally,
  each only if its 12-month return exceeds the T-bill return, else cash.
- **Schedule:** monthly; sell day D (MOC), buy day D+1 with settled
  proceeds (keeps ≤ 3 symbols per kernel epoch).
- **Exit `exit_trend_v1`**, sizing 1/3 per slot. **AI:** none.
- **Failure modes:** momentum crash at trend reversals; sector
  concentration. **Kill** as T1.

### I1 `intraday_mom_v1` - market intraday momentum (the T2-tier sleeve)

- **Hypothesis:** the market's first half-hour return (previous close →
  10:00 ET) predicts its last half-hour return, more so on high-volatility
  and macro-release days.
- **Grade B−.** Gao–Han–Li–Zhou (JFE 2018), SPY 1993–2013 with
  out-of-sample R² ≈ 1.6%, present in 10 other liquid ETFs. Persistence
  after 2013 is unverified here and must be re-tested on SIP minute bars.
- **Mechanism:** late-day informed trading and rebalancing flows that
  follow early information.
- **Universe:** SPY (primary); QQQ, IWM as separate pre-registered tests.
- **Signal:** r1 = log(price at 10:00 ET / previous official close). If
  r1 > 0 → BUY at 15:30 ET; else flat (long only).
  **Registered variant:** trade only on days whose r1 magnitude is above
  its trailing-60-day median.
- **Schedule/orders:** marketable limit at 15:30 (limit = ask + 1 tick
  cap); exit at the close via market-on-close before the broker's MOC
  cutoff; protective stop leg attached at entry (OTO stop-only) at
  entry − 3 × 30-min ATR. The MOC must reconcile with the live stop
  (doc 06 §6.0: stop cancelled only after MOC ack; a stop fill makes the
  MOC an over-sell that the cash account rejects - both paths journaled).
- **Exit profile `exit_intraday_v1`**; sizing: full sleeve tranche.
- **Cash-account mechanics:** buy with settled cash, sell the same day is
  permitted; the proceeds settle T+1, so two alternating capital tranches
  are required (effective utilization ≈ 50%). R18 enforces it.
- **Turnover:** ≤ 1 round trip/day; edge per trade is a few bp, so it
  lives or dies on cost - 2× cost stress is decisive.
- **AI:** none in the signal. **Kill:** A-gate fail at 2× cost; or live
  implementation shortfall > 2× modeled.

### E1 `insider_buy_v1` - EDGAR Form 4 opportunistic insider purchases

- **Hypothesis:** open-market purchases by officers/directors who do not
  trade on a routine calendar pattern predict positive abnormal returns
  over the following month.
- **Grade B.** Cohen–Malloy–Pomorski (JF 2012) "opportunistic" vs
  "routine"; effect stronger in small/illiquid names we partly exclude.
- **Universe:** US common stocks with price ≥ $5 and 60-day median dollar
  volume ≥ $20M at the filing date (point-in-time from SIP daily bars).
- **Signal (deterministic, no LLM):** Form 4 XML, transaction code `P`,
  officer or director reporter, not flagged as a Rule 10b5-1 plan trade,
  reporter not "routine" (traded in the same calendar month in each of
  the prior 3 years). Aggregate per issuer per filing day.
- **Schedule:** signal time = EDGAR acceptance datetime (R12); BUY at the
  next session open + 30 min (marketable limit); hold 21 trading days;
  at most 5 concurrent names (kernel cap), oldest signal wins ties.
- **Exit `exit_event_v1`:** time exit at day 21 (MOC) + catastrophe stop
  at entry − 3 × 20-day ATR. Sizing: equal slots of sleeve capital / 5.
- **Data risk:** delisted names' price history may be incomplete from the
  free feed → survivorship bias; the exclusion count is reported with
  every run and a run with > 5% excluded events is void.
- **Kill** as T1; plus decay monitor (rolling 12-month event alpha).

### E2 `earnings_reader_v1` - AI-assisted earnings press-release reader

- **Hypothesis:** a reader-tier LLM extracts guidance changes from 8-K
  item 2.02 press releases (EX-99.1) that predict post-announcement drift
  *beyond* what a deterministic XBRL-based surprise measure predicts.
- **Grade C.** PEAD disappeared for large caps around 2006 (Martineau)
  but is contested by 2025 studies; press-release text is as informative
  as the surprise for the *announcement-day* return (arXiv 2509.24254),
  which we cannot trade competitively (T1 tier). Our window starts the
  next session. The prior is weak; this sleeve exists because it
  answers the fund's central question: **does AI reading add incremental
  edge?**
- **Design:** paired test, same events, same entry/exit:
  E2-det (deterministic features only: XBRL actuals vs prior-year, filing
  timing) vs E2-ai (E2-det + reader-tier extracted guidance direction
  per metric: raised / maintained / lowered / withdrawn / none).
  Candidate: BUY next session open + 30 min iff guidance raised on ≥1
  metric and lowered on none; hold 10 trading days; `exit_event_v1`.
- **Contamination rule:** only events after the reader model's pinned
  knowledge cutoff + 30-day embargo count (doc 11 §11.0c). Evidence is
  therefore mostly forward shadow; the A-gate uses E2-det history only.
- **AI involvement:** reader tier only (no tools, no network, schema-capped
  JSON), deterministic resolver verifies every extracted number against
  the document text and XBRL where present (doc 08 §8.3).
- **Kill:** paired delta (E2-ai − E2-det) CI includes 0 after the minimum
  event count → the AI component is removed (the E2-det sleeve may
  continue on its own merits).

### M1 `vol_target_overlay_v1` - portfolio volatility targeting

- **Hypothesis:** scaling exposure inversely to recent realized volatility
  improves risk-adjusted returns and keeps drawdowns inside R5.
- **Grade B−.** Moreira–Muir (2017) find gains; Cederburg et al. (2020)
  find weak out-of-sample benefit across many portfolios. Primary role
  here is **risk control** (keep the book's drawdown inside R5), judged
  on drawdown/Sharpe of the sleeve it overlays.
- **Rule:** exposure multiplier = min(1, 8% / annualized 20-day realized
  vol of the sleeve's return stream); applied at rebalance only. Never
  above 1 (no leverage).
- **Macro context (M2, research only):** FRED curve slopes (T10Y2Y,
  T10Y3M), real yield (DFII10), breakeven (T10YIE), credit spread
  (BAA10Y), NFCI, VIXCLS - logged as CONTEXT features with zero live
  effect until a pre-registered overlay rule passes doc 11.

### X1 `fx_carry_mom_research_v1` - FX research (never executed)

- G10 FX carry (3-month interbank-rate differentials) and 12-1 momentum
  from FRED daily exchange rates and OECD short rates, simulated
  dollar-neutral long-short. **Research only**: forex spot is not a legal
  live target (doc 01 §1.2). A future long-only currency-ETF expression
  would be a different sleeve and needs the jurisdiction gate first.

### B0 `baseline_v1` - frozen negative control

Doc 12. Kept, never edited, never promoted: it measured negative in S2
and the failure is diagnosed there (exit/horizon mismatch). It remains
the regression control for the harness itself.

## 2.4 Portfolio construction

- **G0b runs exactly ONE champion sleeve through the kernel at a time**
  (`EXEC_UNIVERSE_MAX = 5`); every other sleeve runs in G0a shadow with
  harness fills on live data. Multi-sleeve live allocation is a G2+
  design that first needs a versioned universe-cap change (doc 13).
- Shadow portfolio (research, for planning G2): sleeve risk budgets by
  equal risk contribution on trailing 12-month shadow returns, no sleeve
  above 50% of risk, rebalanced monthly; book gross ≤ 100% of settled
  cash (cash account), M1 applied at the book level.
- Order of testing (not a promise of promotion): T1 → I1 → E1 → T2 →
  E2 (forward) → M1 on the survivors. T1 is the first champion candidate
  because it is simple, robust, low-turnover, long-only by nature, and
  fits the kernel cap.

## 2.5 What "done" means (strategy book)

- [ ] Each sleeve has a frozen pre-registration file (spec + variants +
      windows + holdout + cost model + kill criteria) committed before its
      first backtest run.
- [ ] Every sleeve run writes to the global trial ledger (doc 11 §11.0a).
- [ ] T1 and I1 A-gate reports produced on SIP data with manifests.
- [ ] At least one sleeve passes A-gate and B-gate → G0b champion.
- [ ] E2 paired test running in forward shadow with contamination control.

## Locked decisions

- The fund trades sleeves, not opinions. Each sleeve is a deterministic
  rule set with a pre-registration, an evidence grade, and kill criteria.
- Parameters come from the cited literature and are frozen at
  pre-registration; no tuning on data already seen. Variants are trials.
- Live sleeves are long-only, cash-account, 1×, allowlisted instruments.
- AI enters a sleeve only through reader-tier features that are verified
  deterministically, and only if a paired test proves incremental value.
- One champion sleeve in G0b at a time; everything else in shadow.
- X material is HISTORICAL / NON-PRODUCTION (appendix); no X input in v1.
