# Market link mathematics

The quantitative models behind the engine (`engine.md`) and the strategies
(`strategies.md`). Every formula here is computed by deterministic code from
point-in-time data. Parameters marked *registered* are fixed in a
pre-registration; changing one is a new trial (`validation.md`, Trial
ledger).

## Notation

- Firms `i, j` (keyed by CIK; tickers are mapped point in time). Trading days
  `t`. Months `m`.
- `r_i,t` total return; `r_m,t` market return (VTI); `rf_t` T-bill return.
- `A_t` is the information available at `t`. A datum enters `A_t` at its
  availability time (EDGAR acceptance, GDELT batch publication, bar close plus
  the 15-minute SIP delay), never at the period it describes.
- `W_t` is the link matrix at `t`; `W_t[i, j] ≥ 0` is the strength of the link
  through which news about `j` reaches `i`.

## Point-in-time discipline

Every object below is a function of `A_t` only. Graph edges carry the
availability time of their evidence and are visible from the next computation
after it. A backtest that touches any datum before its availability time is
void. Entity resolution (CIK, ticker, former names) uses the mapping valid at
`t`.

Delistings: a held name whose price series ends without a merger price is
closed at its last price plus a delisting return of −30% for a long and 0% for
a short (Shumway 1997, applied asymmetrically so missing data never helps the
strategy). Firm-months in the universe with no return are counted; more than 5%
missing voids the run (`data.md`).

## Shocks

What propagates is the unexpected part of a firm's news, measured as:

- **Abnormal return:** `e_i,t = r_i,t − rf_t − β_i (r_m,t − rf_t) − γ_i f_ind,t`,
  with `β_i` and `γ_i` from a 252-day rolling regression ending at `t−1` and
  `f_ind` the firm's industry ETF excess return. Standardized:
  `z_i,t = e_i,t / σ_i`, with `σ_i` the residual standard deviation.
- **Earnings surprise (SUE):** `(EPS_q − EPS_{q−4}) / sd_k(EPS_{q−k} − EPS_{q−k−4})`
  over the prior 8 quarters `k = 1..8` (at least 6 present, else unavailable),
  from XBRL actuals; available at the 10-Q, 10-K or 8-K item 2.02 acceptance
  time, whichever carries the number first.
- **Text change:** `Δ_i = 1 − cos(v_i,y, v_i,y−1)` between term-frequency
  vectors of the same filing section in consecutive years (Filing Change).
- **News burst:** the daily count `n_i,t` of distinct outlets in GDELT naming
  firm `i`; burst score `b_i,t = (n_i,t − μ_i) / sqrt(μ_i)` against a 60-day
  trailing Poisson mean `μ_i` (floor 1). An event fires at `b ≥ 3` with at
  least 3 independent outlets (*registered*).
- **Event unit:** each event is a dated record
  `(event_id, firm, type, t_available, magnitude, direction, evidence_ids)`
  (`engine.md`, Event pipeline).

## The link matrix

One matrix per edge source `s`, each row-normalized so `Σ_j W^s[i, j] = 1`
(rows with no edges stay zero):

- **Supply chain:** `i` is linked to `j` if a filing available at `t` names `j`
  as a customer or supplier of `i`. Weight is the disclosed revenue share where
  given, else 1. Edges age out 18 months after their latest supporting filing.
- **Text peers:** cosine similarity of 10-K business-description embeddings or
  term vectors; the top `k = 10` neighbors with similarity above the
  universe's 90th percentile; weight is the similarity.
- **News co-mention:** `c_ij` is the number of distinct articles in the
  trailing 90 days naming both firms; an edge exists if `c_ij ≥ 3`; weight is
  `log(1 + c_ij)`.
- **Common ownership:** from 13F holdings at the latest quarter available at
  `t`: the number of funds holding both firms, scaled by the geometric mean of
  each firm's fund count (Anton-Polk 2014); top 10.

Combined: `W = Σ_s ω_s W^s` with `ω_s = 1/S` over the sources the variant uses
(*registered*), then row-normalized. Sources combine with fixed weights and
are never fitted, because fitting weights on returns is a search that counts
as trials.

## Propagation signals

- **One hop (Link Momentum):** `link_ret_i,m = Σ_j W[i, j] · R_j,m−1`, where
  `R_j,m−1` is `j`'s return over the past month. The firm's own return is
  excluded by construction (`W[i, i] = 0`).
- **Neutralization:** the cross-sectional regression
  `link_ret_i = a + b · R_i,m−1 + c · log(size_i) + d · R_ind(i),m−1 + u_i`
  is fitted each month and the residual `u_i` is the signal. `R_ind` is the
  firm's industry ETF return. Without this, link peers (mostly same-industry)
  make the signal a copy of industry momentum, and a firm's own past month
  would add the short-term reversal effect. Every report also gives the alpha
  against UMD, industry momentum (Moskowitz-Grinblatt) and short-term reversal
  factors.
- **Multi-hop (research variant):** `s = Σ_{k≥1} α^(k−1) W^k x = (I − αW)^(−1) W x`
  with `0 ≤ α < 1/ρ(W)` (Katz form). `α = 0` is one hop. A non-zero `α` is a
  separate registered variant.
- **Intraday and overnight split (intraday variant):**
  `R = R^intraday + R^overnight` from open and close prices; the variant uses
  `R^intraday` of linked firms only (Wang 2025).

## Composite score

The Connected Drift Book (`strategies.md`) scores each eligible stock `i` at
each month-end from three components: link propagation `x_link` (the residual
`u_i` above, with partner returns taken as residual returns net of market and
industry), Filing Change `x_filing` (the section-level `Δ` of Item 1A and
MD&A, sign-flipped so a large change is negative, with litigation and CEO/CFO
language as sub-scores) and insider purchases `x_ins` (opportunistic open-market
Form 4 purchases in the trailing month; undefined where no event fires).

- **Standardization:** each component `x` is winsorized at the 1st and 99th
  cross-sectional percentiles, ranked, and mapped to a z-score through the
  inverse normal CDF of `(rank − 0.5) / n`.
- **Residualization:** each z-score is regressed cross-sectionally each month on
  market beta `β_i`, `log(size_i)`, industry dummies and the firm's own
  one-month return `R_i,m−1`; the residual is kept and rescaled to unit
  cross-sectional standard deviation, so the composite averages comparable
  scores. The order is winsorize, rank to z, residualize (the evidence report's
  Stage 1). A firm with no insider event is excluded from that component's
  ranking and regression and its score set to 0 afterwards.
- **Composite:** `S_i = (z_link,i + z_filing,i + z_ins,i) / 3`, with `z` the
  rescaled residual and a missing `z` equal to 0 (*registered*). The primary
  weights are fixed and never fitted; only the registered ridge-toward-equal
  variant fits `ŵ_k`, shrinking weights `w_k = (1 − λ)/3 + λ ŵ_k` with one
  shrink factor `λ` chosen once under CPCV.
- **Agreement gate:** candidate `i` is dropped when `sign(z_k,i) ≠ sign(S_i)`
  and `|z_k,i| > τ` for any component `k` with `z_k,i ≠ 0`. `τ` is registered
  (proposed 1.0).
- **Exposure scaler:** gross is `G_t = G · clip(s_t, 0, 1)`, where `s_t` is a
  continuous function of the ETF Trend state and trailing volatility, and the
  change per rebalance is capped: `|s_t − s_{t−1}| ≤ δ`. The functional form,
  `δ` and the volatility target (10% annual, `Sizing` below) are registered;
  the form and `δ` are proposed with the pre-registration (`strategies.md`,
  Open items). The scaler never raises gross above the
  constraint set's limit.
- **Effective signal count:** over a window of months, take the correlation
  matrix `C` of `(z_link, z_filing, z_ins)` (pairwise-complete, with the
  event-sparse insider column computed over the months it fires) and its
  eigenvalues `λ_k`; the count is `(Σλ_k)² / Σλ_k²`. It is 3 when the
  components are uncorrelated and 1 when they are one signal. The Grinold gain
  from combining is at most about `sqrt(3)`, the bound reached only at a count
  of 3 (`IR = IC · sqrt(breadth)`). The matrix and the count are the first
  harness output, before any return (`validation.md`, First report).

## Event propagation

For an event at source `j` with signed magnitude `x_j` (standardized abnormal
return, SUE, or burst-weighted tone), the deterministic twin predicts for each
neighbor `i`:

```
pred_i = sign_table[type(i, j)] · sign(x_j)      if W[i, j] > 0
sign_table: customer +1 | supplier +1 | text peer +1 | co-mention +1 |
            common ownership +1 | competitor: estimated (below)
```

The competitor sign is estimated on the training window only: the
cross-sectional slope of linked-firm abnormal returns on source shocks over
past competitor-labeled events. If `|t| < 2` the competitor edge produces no
trade. Targets are ranked by `W[i, j] · |x_j|` and the top 5 become
candidates, matching the brain's limit.

Ripple resolution, used to score both Event Ripple and its twin: a hypothesis
`(i, direction d, horizon h)` resolves to the cumulative abnormal return
`CAR_i(t+1, t+h) = Σ e_i,τ`; a hit is `sign(CAR) = d`. Reported per mechanism
and per confidence bucket: hit rate, mean signed CAR, and the Brier score of
the bucket against the hit outcome.

## Lead-lag estimation and learned networks

Return-learned links are a separate, riskier edge source, kept to research
until they pass edge validation:

- **Granger network** (Billio-Getmansky-Lo-Pelizzon 2012): edge `j → i` if
  `r_j` Granger-causes `r_i` on a rolling 252-day window; significance
  controlled by Benjamini-Hochberg FDR at 10% across all tested pairs.
- **Connectedness** (Diebold-Yilmaz 2014): forecast-error variance
  decomposition of a sector-ETF VAR; a monitoring statistic for regime and
  contagion, not a trading signal.
- **Graph learning** (Pu-Roberts-Dong-Zohren 2023, network momentum): sparse,
  interpretable graphs learned from momentum features; a research-factory
  card, because every learned graph is a fitted object whose search counts
  toward the trial count.

## Edge validation

A language model's account of cause and effect is not evidence. An edge source
earns a place by transmitting shocks it could not have predicted:

1. **Exogenous-shock test:** for source events plausibly exogenous to the
   linked firm (natural disasters at a disclosed facility, plant fires, sudden
   executive deaths; Barrot-Sauvagnat 2016), the linked firms' `CAR(+1, +21)`
   must differ from zero in the predicted direction, with event-clustered
   standard errors.
2. **Placebo graph:** the same signal built on a degree-preserving random
   rewiring of `W` (100 draws). The real graph's signal Sharpe must exceed the
   95th percentile of the placebo distribution.
3. **Source ablation:** each edge source is dropped in turn and the change in
   signal Sharpe is reported (diagnostic, not a selection step).

Edge-validation results are reported with every backtest gate of a graph
strategy.

## Event intensity

Events cluster: one shock begets news about linked firms. The intensity of news
events for firm `i` is modeled as a mutually exciting (Hawkes) process,
`λ_i(t) = μ_i + Σ_j Σ_{t_k^j < t} α_ij · exp(−κ (t − t_k^j))`
(Aït-Sahalia-Cacho-Diaz-Laeven 2015). It is used for monitoring (contagion
spreading through the graph) and for de-duplicating events that echo an
earlier one: a burst whose excess intensity is explained by a linked firm's
event within 2 days is tagged as an echo and does not trigger Event Ripple.
The trigger itself is the simpler Poisson burst score above.

## Portfolio construction

- **Ranks:** each month, rank the eligible universe on the signal. The research
  measure is the full top-minus-bottom quintile portfolio; the tradable book,
  the one the backtest gate judges, holds the registered number `N` of most
  extreme names a side at the registered book size `B` (*registered*). `N` is
  at least `G / (2 · 5%)` for gross `G`, so no short exceeds the 5% position
  cap (`risk.md`); at 150% gross that is 15. Both are reported; a gap between
  them is a concentration finding, not a choice.
- **Share-price tilt:** the target per name is `T = G · B / (2N)`, and a name is
  eligible only if one share is at most 25% of `T`. At `B` = $100,000, 150%
  gross and 20 names a side, `T` is $3,750 and the cap about $940 a share. The
  report gives the signal on the excluded high-price names so a price tilt
  cannot pass as alpha.
- **Attention diagnostic:** spillover is stronger when the linked firm gets
  less attention. Results are reported by tercile of trailing GDELT mention
  count; the tercile is never used to select the tradable book without a new
  pre-registration.
- **Size diagnostic:** results by market-cap tercile. A small book's
  structural advantage is that large funds cannot hold enough of the smaller
  names for the effect to matter to them. If the edge lives only in the bottom
  tercile, the next pre-registration targets it, with its wider spreads priced
  in.
- **Neutrality:** equal dollar weights within each leg; dollar-neutral at
  rebalance (net within ±10% of equity); realized beta to VTI reported;
  `|β| ≤ 0.3` is a backtest gate condition (`validation.md`).
- **Sizing:** strategy gross is scaled so the ex-ante annual volatility (60-day
  EWMA covariance, sector-shrunk) targets 10%, capped by the constraint set's
  gross limit. Whole shares; a name is eligible only if one share is at most
  25% of its target position.
- **Turnover band:** a held name is kept while it stays in the top (bottom)
  40%; the band is registered and reported.
- **Tranches:** a name is held for the registered horizon (3 months for the
  Connected Drift Book) through monthly tranches: each month one third of the
  book is re-ranked and re-opened, so no single month's liquidity or timing
  decides the book. The horizon is fixed in the pre-registration.

## Costs and capacity

One cost model covers every strategy. Per trade of `q` shares at price `p`:

```
cost = q·p · ( spread/2 + fee_sec31 + fee_taf + η · σ_d · sqrt(q / ADV) )
     + borrow_rate · |short value| · days / 360          (US set shorts)
     + margin_rate · max(0, debit balance) · days / 360  (US set)
     + dividends owed on shorts
```

- `spread` comes from SIP NBBO at the decision time; `η = 1` (square-root
  impact law); `σ_d` is daily volatility; `ADV` is the 20-day median volume;
  participation is at most 1% of ADV per order.
- The fill rule underneath is conservative: a buy fills at mid plus one full
  spread, a sell at mid minus one full spread (minimum 1 bp), full size, no
  partials, flagged `simulated`. SEC Section 31 and FINRA TAF fees apply on
  sells. Dividends are credited from the corporate-action layer, because paper
  trading does not simulate them.
- Borrow is 0 for easy-to-borrow names at Alpaca; the stress legs charge
  0.5%, 2% and 5% a year, since borrow on smaller names costs more;
  hard-to-borrow names are excluded. Margin interest is the
  broker's published rate. There is no rebate on short proceeds. The India set
  has no short or margin terms.
- Stress legs 1×, 1.5×, 2× and 3× on spread, fee and impact.
- **Capacity:** the book size at which the expected net alpha, after the 50%
  haircut, equals expected cost, reported per strategy. A strategy whose
  capacity is below 4× the stage's capital does not promote.
- **Break-even at small size:** at 40 names, 150% gross and about 80%
  monthly turnover per side, round-trip spread and fees of 15 bp cost roughly
  3-4% of equity a year. A long-short spread must earn more than that after the
  haircut. The pre-registration states the expected turnover and break-even
  spread, and the turnover band is the main lever.

## Evaluation statistics

Definitions are in `validation.md`; the quantities used:

- Spanning regression `r_s,t = α + β r_b,t + ε_t` on the daily net excess
  returns of strategy `s` and the reference book `b`; `α` with a stationary-
  bootstrap CI and HAC standard errors.
- Deflated Sharpe ratio with the effective number of trials `N_eff`: the
  number of clusters of the ledger's trial return series under optimal-number-
  of-clusters clustering on their correlation matrix, never below the trials
  in the strategy's own family. Probability of backtest overfitting by CSCV
  when variants exist.
- Minimum track record length
  `MinTRL = 1 + (1 − γ3·SR + (γ4 − 1)/4 · SR²) · (z_α / (SR − SR*))²`
  observations (Bailey-López de Prado), per-period `SR`, skew `γ3`, kurtosis
  `γ4`, benchmark `SR* = 0`.
- **Power, binding on design:** the standard error of an annualized Sharpe
  over `T` years is about `sqrt((1 + SR²/2) / T)`. Over a 3-year holdout a CI
  lower bound above zero needs an annual Sharpe near 1.15; over the 9-10 years
  of free SIP history it needs about 0.65, and over 19 years (2007 onward)
  about 0.5. The planning prior for a graph
  strategy is 0.3-0.6. Therefore the backtest gate is computed on the whole
  pre-registered evaluation window, the holdout is a consistency check, and a
  strategy with a positive but underpowered estimate is a paid-data candidate
  (`data.md`, Paid data), not a pass.

## Decay monitoring

For every promoted or shadowed strategy: rolling 24-month spanning alpha and
its t-statistic, and a one-sided CUSUM on monthly net returns against the
haircut expectation. These can only pause or kill a strategy; they never
re-tune it.

## Decisions

- Every signal is a deterministic function of point-in-time data.
- Edge sources combine with fixed, registered weights; fitted weights and
  learned graphs are trials.
- An edge source is validated by the exogenous-shock and placebo-graph tests,
  not by a model's causal narrative.
- The cost model includes borrow, margin interest and short dividends for the
  US set; capacity below 4× stage capital blocks promotion.
- Decay monitors only pause or kill.
