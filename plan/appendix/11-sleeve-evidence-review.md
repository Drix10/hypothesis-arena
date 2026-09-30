# Sleeve evidence review: what the literature supports (2026-09-30)

Source: a web literature review run on 2026-09-30 for the sleeve integration
plan (`10-sleeve-integration-plan.md`). It is reference material, not a
frozen contract. Sharpe ranges are planning priors after haircuts, not
measured results; kill-switch thresholds are practitioner conventions, not
optimised values. Several practitioner sources are secondary (Equibles,
Swedroe's summary of Lopez-Lira and Tang, the Faber out-of-sample figures);
for Goyal-Welch-Zafirov only the abstract and excerpts were verified. Alpaca's
post-June-2026 PDT behaviour on paper accounts was not confirmed (irrelevant
at ~$100k equity).

## Summary

A months-long paper test cannot prove a Sharpe of 0.5-1.0 is real: at 95%
one-sided confidence it takes about 2.7 years at Sharpe 1.0, 4.8 years at 0.75
and 10.8 years at 0.5 ((1.645/S)^2). Forward runs therefore gate on fidelity
to the backtest, cost calibration and operational integrity. Whether an edge
exists is judged by out-of-sample research and deflated backtests that count
every variant tried. Post-publication decay is the default assumption:
McLean-Pontiff (JF 2016) find published-predictor returns 26% lower
out-of-sample and 58% lower post-publication, so haircut backtests about 50%
before risk budgeting (more for PEAD and single-stock anomalies).

## Verdicts

| Component | Verdict | Evidence | Planning net Sharpe |
|---|---|---|---|
| Passive core (VTI/IEF) | keep | strong (beta) | ~0.4-0.6 |
| Time-series trend on ETFs | adopt, canonical spec | strong; weaker 2010s | ~0.3-0.6 long/cash; value is lower drawdown |
| Sector ETF momentum | adopt small | mixed post-2000 | ~0.0-0.4 incremental |
| Insider purchases (Form 4) | shadow, promote if it tracks | moderate, decayed post-2008 | small after costs and filing lag |
| PEAD | shadow / probable drop | weak for non-microcaps since ~2006 | ~0 tradable |
| Intraday momentum | shadow | moderate, execution-fragile | unknown; R^2 ~1-2% |
| Vol-target overlay (M1) | risk normaliser, not alpha | strong for tails | n/a |
| Collector -> LLM plane | shadow, post-cutoff only | weak/contaminated | unknown |
| JEV LLM filter | shadow, paired A/B | weak | unknown |
| Kill switch | wire | operational | n/a |

## Per-strategy specification

**Trend (adopt).** Moskowitz-Ooi-Pedersen 2012: the past 12-month excess
return predicts the next month, persisting about a year then partly
reversing, volatility-scaled. Hurst-Ooi-Pedersen (century of evidence): low
decades such as the 2010s have happened before. Skeptics: single-asset
time-series regressions show little out-of-sample predictability; the edge is
a diversified, volatility-scaled portfolio, and trend reacts slowly to
crashes. Faber's OOS update (2006-2016): timing added value mainly by cutting
volatility and drawdown; returns were lower; costs excluded.
- Universe 8-12 liquid ETFs across asset classes (SPY/VTI, EFA, EEM, IEF, TLT,
  TIP, GLD, DBC/PDBC, VNQ) plus BIL/SHV as cash.
- Signal: equal-weight blend of 1/3/12-month return signs, or Faber's month-end
  price above the 10-month SMA.
- Long-or-cash, monthly on the last trading day, no-trade band ~20% of target
  weight, inverse-volatility sizing (60-day EWMA).
- Use adjusted total-return prices; compute on the close before the rebalance.

**Sector momentum (adopt small).** Moskowitz-Grinblatt 1999: 20 industries,
1963-1995, industry momentum stronger than stock momentum, mostly the long
side, strongest at 1 month, fading after 12; the (6,6) version earned about
0.43%/month. ETF evidence splits: Andreu-Swinkels-Tjong-A-Tjoe find ~5%/yr
excess with ETF spreads (~0.17%) below break-even costs (~0.65%); Du, Craft
Denning and Zhao (2014) find "no momentum in sector ETFs" post-2000; Arnott
et al. argue it is largely factor momentum.
- Universe: the SPDR sectors (XLC and XLRE have short histories; handle
  explicitly). Rank on 6- or 12-month return skipping the latest month, hold
  the top 3, cash/IEF for any holding with a negative 12-month return,
  monthly. Risk budget 10-15%; merge with trend if forward correlation > 0.7.

**Insider purchases (shadow).** Cohen-Malloy-Pomorski (JF 2012): "routine"
insiders (same calendar month in each of the prior 3 years) carry no
information; "opportunistic" trades earn 82 bp/month value-weighted, building
over ~6 months without reversal. Lakonishok-Lee 2001: purchase effect
concentrated in small firms. Replications find smaller post-2008 effects (an
Aalto replication ~4% vs the original); an Equibles analysis of 47,458
purchases failed to reproduce the split and shows sensitivity to benchmark and
window choices.
- Open-market purchases only (code P); exclude 10b5-1 plan trades (checkbox
  since 2023) and option exercises; opportunistic only (3-year history);
  prefer officers/directors and clusters (2+ insiders in 30 days), >= $50k.
- Market cap > ~$300M and ADV > $5M. Enter the day after the EDGAR
  acceptance timestamp (filers have 2 business days; the transaction date is
  look-ahead). Hold 3-6 months, 10-25 names equal-weight.
- Pitfalls: 4/A amendments, duplicate reporting persons, pre-2003 filing lag.

**PEAD (shadow / probable drop).** Bernard-Thomas 1989: SUE deciles, 60
trading days. Martineau (CFR 2022): for large stocks PEAD has been
non-existent since 2006 and only recently disappeared for microcaps. Two 2025
papers claim it is alive; Subrahmanyam (SSRN Dec 2025) replicates and finds
drift "does not exist in all but microcaps". The one variant worth watching is
PEAD.txt (Meursault et al., Philadelphia Fed WP 21-07; JFQA): text-based
surprises, 2010-2019 drift much larger than SUE-based, only on post-cutoff
calls. Pitfalls: before-open vs after-close announcement timing, stale
consensus, survivorship in earnings calendars.

**Intraday momentum (shadow).** Gao-Han-Li-Zhou (JFE 2018): SPY 1993-2013, the
first half-hour return predicts the last half-hour, OOS R^2 ~1.2-1.4%.
Baltussen-Da-Lammers-Martens (JFE 2021): 60+ futures 1974-2020, return to 30
minutes before the close predicts the last 30 minutes, linked to dealer gamma
hedging and leveraged-ETF rebalancing; 12 of 16 developed markets.
- Long SPY at 15:30 ET if r(prior close -> 15:30) > 0, exit at the close.
- Why shadow: free SIP is 15-minute delayed (needs the real-time feed); thin
  edge very sensitive to fills; daily round trip; would clash with other
  sleeves' SPY resting orders. Route only in a separate paper account.

## Overlays

- **Volatility targeting.** Harvey et al. (JPM 2018): raises Sharpe only for
  risk assets (equities, credit); reduces extreme returns and vol-of-vol
  across assets. Cederburg-O'Doherty-Wang-Yan (JFE 2020): Moreira-Muir style
  portfolios generally earn lower certainty-equivalent returns and Sharpe out
  of sample; Barroso-Detzel: they do not survive costs. Use as a common risk
  scale and tail cap: 20-60 day EWMA, 10% annual target per sleeve, gross
  <= 1.0, no leverage; not alpha.
- **Stops.** Kaminski-Lo (JFM 2014): under a random walk stops always lower
  expected return; with momentum they can add 50-100 bp/month during stop-out
  periods (1950-2004, into bonds); short tight stops have negative premiums.
  Keep brackets/OTO only as catastrophic protection (3-4x daily ATR) on
  single-stock sleeves; for ETF sleeves the monthly signal is the stop.
- **Kill switch (practitioner conventions, not tuned).** Per-sleeve soft
  -1.5x expected annual volatility from peak halves the sleeve; hard -2x
  freezes it; account daily loss > 3% blocks new orders for the day; account
  drawdown -15% triggers flatten-to-core.

## Architecture on Alpaca (facts that shape the design)

- `client_order_id` up to 128 chars, unique (retries idempotent, queryable).
  Alpaca does not keep per-strategy positions: positions net per symbol.
- Wash-trade protection rejects an order while an opposite-side order is open
  on the symbol (paper and live). Recommended: bracket/OTO, or replace the
  existing order. Netting across sleeves is therefore mandatory.
- Up to 3 paper accounts per owner. Paper does not simulate dividends; fills
  simulate against the NBBO; PDT logic is simulated.
- Design: sleeves emit target weights; per-sleeve virtual ledgers; a netting
  layer emits one order per symbol per rebalance (internal crosses recorded as
  zero-cost transfers); protective orders owned by the router at account
  level; optional separate accounts for intraday and single-stock sleeves;
  equal-volatility risk parity across promoted sleeves (core 50%, trend 25%
  of risk budget, sector 10%, promotions at 5-10%); daily P&L per sleeve
  reconciled to broker equity within 5 bp/day.

## Statistical protocol

- Pre-g2 backtest gate: preregister one canonical spec plus at most 2
  variants; count every configuration ever tried as N; Deflated Sharpe Ratio
  >= 0.95 (Bailey-Lopez de Prado 2014; a PSR of 0.966 fell to a DSR of 0.629
  once N=10 trials were counted); PBO via CSCV < 0.2-0.3, or White's Reality
  Check / Hansen SPA for the few-variant ETF sleeves; Harvey-Liu-Zhu t > 3.0
  for any new factor; ~50% haircut on published effects.
- Forward test: correlate daily paper-ledger returns with a backtest replay on
  the same dates (rho > 0.95, tracking error < 2% annualised), calibrate
  costs, reconcile books, check event-sleeve timing. Sequential monitoring
  (SPRT / confidence sequences) only to kill; never stop early for success.
- No bandit allocation for at least 12 months (it shrinks the sample on
  apparent losers); afterwards Bayesian shrinkage of sleeve Sharpes toward a
  common prior (~0.3).

## LLM signals and the JEV filter

- Lopez-Lira-Tang: post-cutoff headlines carry some next-day drift, especially
  small stocks and negative news, but returns decline with LLM adoption
  (reported Sharpe 6.54 late 2021 -> 3.68 in 2022 -> 2.33 in 2023 -> 1.22
  Jan-May 2024, before costs). "The Memorization Problem" (2025): LLMs recall
  historical indicators, headlines and returns, so in-sample forecasts equal
  recall. Gao-Jiang-Yan (arXiv 2512.23847): lookahead propensity explains
  ~37% of the standalone effect in one test (~12% with Llama-3.3-70B in a
  later version). Glasserman-Lin (JFDS 2024): anonymising names improved
  in-sample results; firm knowledge distracts and persists out of sample.
- Credible forward test: post-cutoff data only; pin model id and date (a
  silent swap resets the test); anonymise tickers and names; paired A/B
  (unfiltered ledger vs JEV-filtered twin on identical candidates; paired
  bootstrap or Newey-West on the daily difference); journal prompt, context
  hash and output before the outcome; preregister the criterion (e.g. vetoed
  candidates underperform approved by > 50 bp over 20 days with t > 2 after
  200+ decisions). Treat the research plane as a new-factor search: t > 3 and
  count every prompt variant in N.

## Macro data

Goyal-Welch-Zafirov (RFS 2024): about half of the new variables have no
significance even in-sample; of those that do, about half perform poorly out of
sample; only a few (variance premium, Q4 consumption growth) survive both.
Robust evidence exists for macro momentum (AQR, Brooks 2017): 1-year changes
in growth/inflation forecasts, the 2-year yield, and the 1-year equity return;
Sharpe 1.2 over 1970-2016 gross and hypothetical, 0.7 over 2010-2016,
correlation ~0.4 to trend; long-only single-country ETFs capture little of its
cross-country breadth. Use the collector for a shadow "macro-lite" tilt (1-year
change in DGS2 and the 1-year equity return, +/-10% on the equity/bond split)
and event-risk flags (FOMC/CPI/NFP days block new event entries). Do not drive
allocation from raw levels (curve slope, PMI, unemployment). Use vintage data
(ALFRED) and release timestamps; revised FRED series are look-ahead.

## Sequence recommended by the review

Where `10-sleeve-integration-plan.md` differs, it governs: the netting router
is not on the critical path there.


1. Sleeve contract, virtual ledgers, netting router, router-owned protective
   orders, client_order_id encoding, virtual dividends, kill inputs (critical
   path). 2. Freeze canonical specs and run DSR/PBO with a 50% haircut. 3. g2:
   Tier R core (+ trend and sector once netting exists), Tier S the rest.
   4. Weeks 2-8: gate on fidelity, cost calibration, reconciliation. 5. Month 3+:
   promote at 5-10% risk only if the backtest passed DSR/PBO, the shadow ledger
   reproduces, and forward returns sit inside the backtest's 90% band; keep PEAD
   dropped unless the text variant shows t > 3. 6. Month 12+: revisit weights.

## Sources

- https://w4.stern.nyu.edu/facdir/lpederse/papers/TimeSeriesMomentum.pdf
- https://quantdecoded.com/en/trend-following-the-case-for-time-series-momentum
- https://arxiv.org/pdf/2507.15876
- https://quantpedia.com/strategies/time-series-momentum-effect
- https://alphaarchitect.com/are-trend-following-and-time-series-momentum-research-results-robust/
- https://www.aqr.com/-/media/AQR/Documents/Insights/White-Papers/A-Half-Century-of-Macro-Momentum.pdf
- https://allocatortraining.com/wp-content/uploads/2023/06/A-Quantitative-Approach-to-Tactical-Asset-Allocation.pdf
- https://github.com/alpacahq/alpaca-docs/blob/master/content/trading/paper-trading.md
- http://www-stat.wharton.upenn.edu/~steele/Courses/956/Resource/Momentum/MoskowitzGrinblatt99.pdf
- https://link.springer.com/article/10.1007/s11408-022-00417-8
- https://www.efmaefm.org/0EFMAMEETINGS/EFMA%20ANNUAL%20MEETINGS/2011-Braga/papers/0166.pdf
- https://link.springer.com/article/10.1057/jam.2014.24
- http://www.scienpress.com/Upload/JAFB/Vol%2012_3_2.pdf
- https://dash.harvard.edu/bitstream/handle/1/33785679/cohen,malloy,pomorski_decoding-inside-information.pdf
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1692517
- https://equibles.com/research/what-happens-after-an-insider-buys-evidence-from-47-458-open-market-purchases
- https://aaltodoc.aalto.fi/server/api/core/bitstreams/fbbd1ec6-d5b4-44dd-881d-144ffd0ea21c/content
- https://pure-oai.bham.ac.uk/ws/portalfiles/portal/148211989/Mimicking_Insider_Trades.pdf
- https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again/
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5930255
- https://www.cambridge.org/core/services/aop-cambridge-core/content/view/5EB217BB68B5FB054FE38541BAAC4679/S0022109022001181a.pdf/peadtxt_postearningsannouncement_drift_using_text.pdf
- https://www.researchgate.net/publication/272303487_Intraday_Momentum_The_First_Half-Hour_Return_Predicts_the_Last_Half-Hour_Return
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3760365
- https://www.sciencedirect.com/science/article/abs/pii/S138641812100001X
- https://tradezero.com/en-us/blog/the-usd25-000-day-trading-minimum-is-gone-here-s-what-it-means-for-you
- https://www.wilmerhale.com/en/insights/client-alerts/20260423-sec-approves-amendments-to-finra-rule-4210-replacing-day-trading-margin-requirements-with-a-modernized-intraday-margin-standard
- https://forum.alpaca.markets/t/pattern-day-trading-question/11678
- https://quantpedia.com/the-impact-of-volatility-targeting-on-equities-bonds-commodities-and-currencies/
- https://alphaarchitect.com/volatility-targeting-improves-risk-adjusted-returns/
- https://jpm.pm-research.com/content/45/1/14.abstract
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3175538
- https://doi.org/10.2139/ssrn.3982504
- https://www.ssrn.com/abstract=3357038
- https://www.sciencedirect.com/science/article/abs/pii/S138641811300030X
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338
- https://allthingsphi.com/blog/2016/11/18/when-do-stop-loss-rules-stop-losses.html
- https://docs.alpaca.markets/us/docs/working-with-orders
- https://docs.alpaca.markets/us/docs/orders-at-alpaca
- https://forum.alpaca.markets/t/apierror-potential-wash-trade-detected-use-complex-orders/13441
- https://forum.alpaca.markets/t/i-am-getting-a-error-for-when-trying-to-sell-using-my-api/13689
- https://forum.alpaca.markets/t/wash-trade-rules/18200
- https://forum.alpaca.markets/t/feature-request-more-paper-trading-accounts/18125
- https://pdfs.semanticscholar.org/c215/d0a2064ce1a3565d276475abc84305418f0f.pdf
- https://portfoliooptimizer.io/blog/the-probabilistic-sharpe-ratio-bias-adjustment-confidence-intervals-hypothesis-testing-and-minimum-track-record-length/
- http://boston.qwafafew.org/wp-content/uploads/sites/4/2017/01/Lopez_de_Prado_Sharpe.pdf
- https://arxiv.org/abs/2304.07619
- https://larryswedroe.substack.com/p/can-chatgpt-forecast-stock-price
- https://www.researchgate.net/publication/390924734_The_Memorization_Problem_Can_We_Trust_LLMs'_Economic_Forecasts
- https://quantpedia.com/the-memorization-problem-can-we-trust-llms-forecasts/
- https://www.pm-research.com/content/iijjfds/6/1/25
- https://arxiv.org/html/2309.17322
- https://academic.oup.com/rfs/advance-article-pdf/doi/10.1093/rfs/hhae044/59214194/hhae044.pdf
