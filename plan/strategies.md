# Strategies

The fund runs one strategy, the Connected Drift Book (`connected_drift`). It is
a hypothesis with an evidence grade, a pre-registration and kill criteria, and
it trades nothing until it passes the gates in `validation.md`. Parameters come
from the cited literature and are fixed at pre-registration; every variant
counts against the trial ledger. The mathematics is in `math.md`; the graph and
events it reads are built by the engine (`engine.md`). The evidence behind the
design is `research/lessons/connected-drift-evidence.md`; figures cited here
are from that report and are mostly in-sample and decayed.

## The funnel

```
hypothesis (human, research factory or engine)
  -> pre-registration (fixed spec, variant count, data window, holdout,
     contamination class)
  -> backtest gate (historical, in the trial ledger, net of costs)
  -> shadow gate (live data, simulated fills)
  -> champion candidate -> paper orders through the kernel
  -> paper-to-tiny review -> tiny live stage
```

A strategy that fails a gate is recorded with its numbers and archived. It is
not modified until it passes; a new idea is a new pre-registration.

## Evidence grades

- **A**: several peer-reviewed studies and documented out-of-sample
  persistence after publication.
- **B**: peer-reviewed, with limited or contested out-of-sample evidence, or
  concentrated in segments we can only partly trade.
- **C**: contested or failed replications; tested because the answer matters.
- **D**: speculative. Research factory only.

Published effects are cut by 50% for planning (McLean-Pontiff measured about
58% post-publication decay). New signals that are not from the literature
need t of at least 3 (Harvey-Liu-Zhu).

## Pre-registration template

Every strategy fills every field: id; hypothesis; evidence grade and
sources; mechanism (why it should persist); universe; datasets with manifest
hashes; contamination class; exact signal; schedule (signal time, order time,
order type); exit rule; sizing; turnover and capacity; account mechanics
(India-set settlement or US-set margin and borrow); model involvement and its
no-model twin; known failure modes; kill criteria; minimum evaluation window;
status.

## Connected Drift Book (`connected_drift`)

One long-short US equity book. The score of each stock is the equal-weight mean
of three standardized, residualized components. All three exploit slow
information diffusion: investors process a partner's return, a changed filing
paragraph or an insider's purchase late. They trade at monthly tranches a small
account can reach, and each covers a hole in the others: link momentum has
decayed since publication, so Filing Change and insider events add breadth;
Filing Change is concentrated in the short leg and in mid caps, and the link
score helps pick shorts that are borrowable and not crowded; insider buys are
event-sparse and long only, which pairs with a short-heavy Filing Change.

The case is breadth and netted turnover, not a strong signal. The published
effects are decayed: customer momentum fell from 1.52% to 0.62% a month after
2005 and is insignificant value-weighted (Pinchuk); a mega-cap Filing Change
replication found nothing; the average anomaly nets about zero after borrow
fees (Muravyev et al.). Nobody has measured the correlation among the three
components, so the first harness output is that measurement (`validation.md`,
First report). The book can fail on costs alone, which is an acceptable result
of a pre-registered test.

- **Hypothesis:** a stock's next-quarter return rises with the residual
  past-month return of its linked firms, falls with large section-level
  changes in its own filings, and rises after opportunistic insider purchases,
  because each is slow, indirect information.
- **Grade B-.** The weakest component sets it: Filing Change B-, link
  propagation B+, insider purchases a component without a spanning test of
  its own.
- **Contamination class:** deterministic. No model output enters the signal.
  The model twin `link_momentum_llm` is a separate registration judged by the
  paired test (`validation.md`, Model component gate).

### Score

Each component is winsorized, cross-sectionally ranked to a z-score and
residualized against market beta, size, industry and the firm's own trailing
one-month return, so none carries a known factor twice (`math.md`, Composite
score). The score is `(z_link + z_filing + z_insider) / 3`. A missing
component is 0, so event signals move only the names where they fire. Weights
are equal and never fitted: fitting weights on event-sparse components is the
failure mode of the combination literature.

#### Link propagation component

The edge-weighted mean of linked firms' past-month returns on the link graph.

- **Evidence:** Ali-Hirshleifer: 1.68% a month, t = 9.67, weaker recently.
  Scherbina-Schlusche: news co-mention links cross-predict returns, with
  survival after costs shown only in a Chinese-market study. Cohen-Frazzini;
  Menzly-Ozbas. Caveats: shared analyst coverage, the strongest link source,
  needs paid I/B/E/S data and is replaced by free proxies; single-link
  versions decayed after publication; spillover is stronger when the linked
  firm draws little attention.
- **Graph** (point in time at each month-end): edges from (a) customer and
  supplier disclosures in 10-K filings, (b) the 10 nearest 10-K
  business-description peers and (d) common institutional ownership from 13F
  filings. Weights are normalized per firm per source and the sources combine
  with equal weights (`math.md`, The link matrix). Customer and supplier edges
  carry a relation type so complementary and competitive links do not share a
  sign.
- **Partner returns** are residual returns net of market and industry: raw
  partner moves are mostly a common factor. Own-firm and partner momentum are
  both neutralized (`math.md`, Propagation signals).
- **Known risks:** crowding of the published effect; costs in smaller names;
  graph errors from bad entity resolution; thinning of customer disclosure
  after SEC Release 33-10825 (coverage by year is measured before edge (a) is
  registered; if it collapses the book registers without edge (a)).
- **Model twin:** `link_momentum_llm` replaces the regex customer extractor
  with the reader-tier extractor (anonymized, span-verified, extraction
  class).

#### Filing Change component

- **Hypothesis:** firms whose 10-K or 10-Q text changes substantially against
  the same filing a year earlier underperform; firms that barely change
  outperform slightly.
- **Grade B-.** Cohen-Malloy-Nguyen: up to 188 bp a month on risk factors,
  but all-sections value-weighted long-short is 34-58 bp. A 2009-2026 S&P 100
  replication found no effect, so the test runs on mid caps outside the
  most-scrutinized firms, where the paper's effect concentrated.
- **Signal:** deterministic similarity of each 10-K and 10-Q to its prior-year
  counterpart, section by section: Item 1A and MD&A, with litigation and
  CEO/CFO language as the highest-prior sub-scores. A low-similarity name gets
  a negative z and a high-similarity name a small positive one, because the
  paper finds the long leg's alpha reverts to zero and the short leg's
  persists. Whole-document cosine is not used: it saturates near 1.
- **Known risk:** changers predict bankruptcy, so the short leg overlaps
  distress and delisting. Firms that later delist are short-leg winners;
  missing prices for them trigger the 5% void rule and the paid-data trigger
  (`data.md`, Paid data). Section extraction rates bound coverage.

#### Insider purchase component

- **Signal:** open-market Form 4 purchases by opportunistic insiders, those
  whose trades do not follow a calendar-month habit of three or more years
  (Cohen-Malloy-Pomorski 2012), in the trailing month. The component is zero
  where no event fires. Sales and routine trades never enter.
- **Entry:** events enter at the next monthly composite. A diagnostic run
  enters at the second session after the filing, because the first-day
  reaction is not capturable at a next-session fill.
- **Known risk:** about a quarter of the abnormal return comes in the first 5
  days (Jeng et al.), and a 2018-2024 microcap study finds no significant
  calendar-time alpha once day 1 is skipped. The insider evidence is
  strongest in smaller caps than the universe floor admits, so this component
  is tested in the universe the book can trade.

### Gating

- **Agreement gate.** A candidate is dropped when any single component
  contradicts the composite's sign beyond a threshold fixed at registration
  (proposed: one standard deviation).
- **Short vetoes.** A short candidate is dropped on any of: distress; no
  broker borrow flag or failing the short crowding filter (`risk.md`);
  concentrated forced-seller exposure, read from the 13F ownership edges (the
  rebound risk of a name under fire-sale pressure, Coval-Stafford); market cap
  below $1B (a history proxy for easy to borrow; the live check is the broker
  flag). The forced-seller veto is a veto, not a signal, and adds no variant.
- **Reversal control.** Extreme own one-month moves are neutralized in the
  score. A no-news extreme is where a momentum-style link score is most likely
  wrong; a reliable no-news flag on the free feed is an open question.

### Execution and exposure

- **Schedule:** signal from the month-end close; trades the next session;
  monthly tranches with a 3-month hold (one third of the book re-ranked each
  month); a no-trade band and a position cap. Shocks to less visible text
  peers transmit over up to 12 months (Hoberg-Phillips 2018), so slow tranching
  lowers turnover cost.
- **Scaler:** gross exposure is scaled by a continuous, rate-capped function of
  the ETF Trend and volatility state toward the plan's 10% annual volatility
  target (`math.md`, Exposure scaler). The aim is the Daniel-Moskowitz panic
  state (down market, high volatility, rebound), where momentum-style
  long-short books crash. No source quantifies this overlay on a
  market-neutral stock book and Cederburg and others find volatility-managed
  gains largely vanish out of sample and after costs, so the scaler is a
  hypothesis tested by a diagnostic run. It will sit out part of any
  V-rebound.
- **Exit (`exit_link`):** signal exit at the rebalance; a broker-native GTC
  catastrophe stop at 3 × the 20-day ATR (sell-stop for longs, buy-stop for
  shorts).
- **Expected economics (planning only):** the free-data proxies are weaker
  than the papers' analyst links and the haircut halves what remains, so a
  spread of 0.4-0.6% a month before costs is the planning case, against about
  0.3% a month of costs at a small book (`math.md`, Costs and capacity). The
  margin is thin.
- **Failure modes:** costs; crowding; short squeezes; entity-resolution
  errors; momentum-style crashes in rebounds; a composite no better than its
  single best component.
- **Kill:** backtest gate fails; or the shadow gate tracks outside its band;
  or drawdown exceeds 1.5× the backtest's worst 12-month drawdown.

### Pre-registration fields

Values marked *proposed* are not decided; they are listed under Open items.

| Field | Value |
|---|---|
| id | `connected_drift` |
| Universe | US common stock, price at least $5, 60-day median dollar volume at least $10M, market cap at least $500M, links from at least two different edge sources, excluding the 100 largest firms. Shorts also need market cap at least $1B, the broker borrow flag and the crowding filter. |
| Datasets | Link-graph store (text peers, 13F edges, customer and supplier edges when the extractor exists), 10-K and 10-Q text, Form 4 events, daily bars, T-bill leg; manifest hashes at registration. |
| Signal | The composite above, from the month-end close. |
| Holding | Monthly tranches, 3-month hold, next-session execution. |
| Sizing | Proportional to score magnitude with a single-name cap; at least 15 names a side at 150% gross (20 planned); 10% annual volatility target with the capped scaler; beta to VTI at most 0.3 absolute. Cap and band values: *proposed*. |
| Drawdown limit | Default 2 × the annual volatility target (20%). |
| Evaluation window | From 2016 (the free feed's start); 2007 only for filings-based edges if paid history is bought (`data.md`). |
| Splits | Walk-forward with purging and embargo where labels overlap; CPCV only to choose among the registered variants. |
| Embargo | 63 sessions, the 3-month hold (*proposed*). |
| Holdout | The last 3 years or last 25% of the sample, whichever is longer (*proposed*), never used for any choice. The 2016-2026 window was already seen by an earlier long-only trend test, so a run touching the scaler is labeled `seen-window` and the shadow minimum doubles to 6 rebalances (`validation.md`). |
| Variants (3, *proposed*) | (1) equal-weight composite with scaler (primary); (2) ridge-toward-equal weights with one shrink factor chosen once; (3) the primary plus edge (c), news co-mentions over the trailing 90 days. |
| Diagnostic runs | Drop-one ablations (three), no scaler, own-firm skip-month, 1-month hold, placebo graph, delisting sensitivity, event-day insider entry. Not selectable, not in `N_eff`. |
| Multiple testing | `N_eff` floored at the family's 3; DSR at least 0.95; PBO at most 0.2; MinTRL met; the 50% haircut still clears 2× cost; spanning-alpha CI lower bound above 0 against the reference book. |
| Account mechanics | US set: margin, borrow and short-dividend ledger. |
| Model involvement | None. |

### Open items for operator approval

- Agreement-gate threshold: one standard deviation (proposed).
- Selectable variants: 3 (proposed), inside the 3-6 trials the combination
  notes recommend (an inference, not a sourced rule).
- Embargo: 63 sessions (proposed; the 1%-of-sample rule was not verified).
- Holdout: the last 3 years or 25%, whichever is longer (proposed).
- Single-name cap and no-trade band values (proposed).
- Whether the book replaces the separate Filing Change and filings-variant
  registrations or sits beside them; the Holm family size depends on it.

## What the earlier strategies became

- **Link Momentum** and **Filing Change** are the component specs above, with
  their definitions, filters and known risks.
- **ETF Trend** is the exposure scaler. It has no standalone test: its
  long-only form was already tested on 2016-2026.
- The **insider opportunistic buys** card is a component.
- **Event Ripple, forced-seller trading and binary contracts** are parked
  research cards.

## Research cards

Ideas that name a new information set and have no pre-registration. They are
not strategies: none is built, shadowed or costed until a human approves a
pre-registration (`engine.md`, Research factory).

- **Event Ripple.** A language model reads an event and the firm's link
  neighborhood and writes typed hypotheses about which linked firms move and
  in which direction, with a deterministic rules twin (`event_ripple_rules`) on
  the same events and one-hop sign table (`math.md`, Event propagation).
  Parked because it is judgment class: only post-cutoff data counts
  (`validation.md`, Contamination control), so history cannot evaluate it and
  it can only be shadowed forward. Part of the published result is
  memorization (the lookahead interaction vanishes after the model cutoff) and
  returns fall as adoption rises. The deterministic parts (event detection,
  residual-return measurement, relation-type sign conditioning) are reused by
  the link component. Grade C.
- **Forced-seller liquidity provision.** Long names under fire sales identified
  from fund flows or index exclusion, not from a price drop alone
  (Coval-Stafford 2007). Parked as a standalone trade: the horizon is a
  quarter, front-running is documented, the S&P 500 inclusion effect fell from
  7.4% to about 1%, and reversal profits are cost-bound. It survives as the
  short veto.
- **Binary level contracts.** Short-dated "price above level at expiry"
  contracts on equities, metals and rates, fair value from the underlying's
  implied volatility; the question is whether quoted prices show a
  favorite-longshot bias after fees and spread. Outside every constraint set
  (offshore venue, derivative), so any evidence is research, not promotion
  evidence (`vision.md`). Takers lose almost 32% on average on Kalshi and
  contracts under 10 cents lose over 60% (Whelan). A venue's testnet or vault
  figures are marketing, not data; only settled, fee-inclusive prices count.
- Post-earnings announcement drift is not carded: it has disappeared in recent
  years, in microcaps too (Martineau 2022).

## Controls

- The passive core: VTI and IEF at 60/40, the base of the reference book.
- Cash (BIL), the volatility-matched passive benchmark and 60/40
  (`validation.md`, Controls and benchmarks).
- Each model component's no-model twin.

## Portfolio construction

- Paper trading runs one champion through the kernel at a time. Every other
  configuration runs in shadow with simulated fills on live data.
- Shadow book (research, for planning the scaled stage): risk budgets equal
  by risk contribution on trailing 12-month shadow returns, no strategy above
  50% of risk, rebalanced monthly, gross within the constraint set.
- Several live strategies at once need the netting router and a universe-cap
  change (`kernel.md`).
- **Breadth:** the fund's durable edge is the number of independent validated
  signals, not any one of them. Independence is measured, never assumed: every
  gate report gives the correlation of the strategy's daily net returns with
  each promoted strategy, and the shadow book reports the effective number of
  independent signals, `(Σλ)² / Σλ²` over the eigenvalues of that correlation
  matrix. A strategy that adds no spanning alpha against the reference book is
  not admitted, however good it looks alone. The shadow book budgets risk per
  effective signal, not per strategy name. Inside the book the same statistic
  is computed over the three component scores (`math.md`, Effective signal
  count); the Grinold gain from combining is at most about the square root of
  three, and collapses toward one signal if the components are correlated.
- **Retirement:** a signal the decay monitors kill (`math.md`, Decay
  monitoring) is not re-tuned; its risk budget returns to the passive core, and
  a replacement enters as a new pre-registration.
- Order of testing, not a promise of promotion: the component correlation
  report, then the primary variant, then the diagnostic runs, then the
  spanning test and the shadow gate.

## Decisions

- The fund trades strategies, not opinions. Each is a rule set with a
  pre-registration, an evidence grade, a contamination class and kill
  criteria.
- One combined strategy replaces separate sleeves: components are integrated
  into one score, traded as one netted book under one universe, one cost model
  and one set of vetoes.
- Parameters come from the literature and are fixed at pre-registration. No
  tuning on data already seen. Variants are trials.
- Live strategies obey the constraint set named by their stage.
- A model enters a strategy as engine features verified deterministically
  (the link-component model twin). Every model component has a deterministic
  twin, and the model stays only if the paired test shows incremental value
  net of its cost.
- One champion in paper trading at a time; everything else in shadow.
