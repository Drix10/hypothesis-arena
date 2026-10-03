# Strategies

Every strategy is a hypothesis with an evidence grade, a pre-registration
and kill criteria. None trades until it passes the gates in `validation.md`.
Parameters come from the cited literature and are fixed at pre-registration;
every variant counts against the trial ledger. The mathematics behind each
signal is in `math.md`; the graph and events they read are built by the
engine (`engine.md`).

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

## Link Momentum (`link_momentum`)

Connected-firm momentum on the link graph.

- **Hypothesis:** a firm's next-month return follows the past-month return of
  the firms it is linked to, because investors process linked-firm news
  slowly.
- **Grade B+.** Ali-Hirshleifer: 1.68% a month, t = 9.67, weaker recently.
  Scherbina-Schlusche: news co-mention links cross-predict returns, with
  survival after costs shown only in a Chinese-market study. Cohen-Frazzini;
  Menzly-Ozbas. Caveats: shared analyst coverage, the strongest link source,
  needs paid I/B/E/S data and is replaced by free proxies; single-link
  versions decayed after publication; spillover is stronger when the linked
  firm draws little attention.
- **Graph** (point in time at each month-end): edges from (a) customer and
  supplier disclosures in 10-K filings, (b) the 10 nearest 10-K
  business-description peers, (c) news co-mentions over the trailing 90 days,
  (d) common institutional ownership from 13F filings. Weights are normalized
  per firm per source and the sources combine with equal weights
  (`math.md`, The link matrix).
- **Signal:** the edge-weighted mean of linked firms' past-month returns,
  neutralized for the firm's own return, size and industry return
  (`math.md`, Propagation signals). The tradable book is the 20 most extreme
  names a side; the full quintile spread is reported as the research measure.
- **Universe:** US common stock, price at least $5, 60-day median dollar
  volume at least $10M, market cap at least $500M, at least one link from two
  different edge sources. The short side also needs market cap of at least
  $1B (a history proxy for easy-to-borrow; the live check is the broker flag)
  and passes the short crowding filter (`risk.md`).
- **Expected economics (planning only):** the free-data proxies are weaker
  than the papers' analyst links and the haircut halves what remains, so a
  spread of 0.4-0.6% a month before costs is the planning case, against about
  0.3% a month of costs at $25,000 (`math.md`, Costs and capacity). The
  margin is thin and the strategy can fail on costs alone.
- **Registered variants (3 trials):** `filings` uses edges (a), (b) and (d),
  deterministic, 2016 onward. `news` adds (c). `intraday` is `news` with the
  peer return measured intraday only (Wang 2025: peer intraday returns
  continue, peer overnight returns reverse).
- **Model twin:** `link_momentum_llm` replaces the regex customer extractor
  with the reader-tier extractor (anonymized, span-verified, extraction
  class). It is judged by the paired test against the `news` variant
  (`validation.md`, Model component gate).
- **Schedule:** signal from the month-end close; trades the next session;
  monthly rebalance; 20 names a side at $25,000.
- **Exit (`exit_link`):** signal exit at the rebalance; a broker-native GTC
  catastrophe stop at 3 × the 20-day ATR (sell-stop for longs, buy-stop for
  shorts).
- **Failure modes:** crowding of the published effect; costs in smaller
  names; short squeezes; graph errors from bad entity resolution;
  momentum-style crashes when the short leg rallies hardest after sharp
  rebounds (Daniel-Moskowitz 2016), partly contained by the 10% volatility
  target and the net-exposure band.
- **Kill:** backtest gate fails; or the shadow gate tracks outside its band;
  or drawdown exceeds 1.5× the backtest's worst 12-month drawdown.

## Filing Change (`filing_change`)

- **Hypothesis:** firms whose 10-K or 10-Q text changes substantially against
  the same filing a year earlier underperform; firms that barely change
  outperform.
- **Grade B-.** Cohen-Malloy-Nguyen: up to 188 bp a month. A 2009-2026 S&P
  100 replication found no effect, so the test runs on mid caps outside the
  most-scrutinized firms, where the paper's effect concentrated.
- **Signal:** deterministic similarity of each filing to its prior-year
  counterpart, section by section (risk factors, MD&A); quintiles; monthly
  rebalance; a name is held about 3 months after its filing.
- **Universe:** as Link Momentum, excluding the 100 largest firms.
- **Contamination class:** deterministic.
- **Known risk:** firms that later delist are short-leg winners. Missing
  prices for them trigger the 5% void rule and the paid-data trigger
  (`data.md`, Paid data).

## Event Ripple (`event_ripple`)

A language model reasons about where an event ripples.

- **Hypothesis:** when a material event hits one firm, a model that reads the
  event and the firm's link neighborhood identifies which linked firms move,
  and in which direction, better than a fixed propagation rule.
- **Grade C.** For: Chen-Kelly-Xiu, Huang et al. 2026, FinRipple (ACL
  Findings 2025). Against: model reasoning is largely recall of training
  data ("causal parrots", Zečević et al. 2023); headline-signal returns
  decayed with adoption. The strategy exists to measure whether reasoning
  beats a rule.
- **Events** (`engine.md`, Event pipeline): material 8-K items, earnings with
  an XBRL surprise, abnormal returns above 3 standard deviations on volume,
  news bursts naming the firm from at least 3 independent outlets, and
  disasters reported in news that names the firm. Mapping disasters to
  facility locations (10-K Item 2) is a later research card.
- **Brain** (`engine.md`, Ripple reasoning): for each event it retrieves the
  firm's two-hop neighborhood and recent events and writes at most 5 typed
  hypotheses: target firm, direction, horizon (5, 21 or 63 sessions),
  mechanism (enum) and the evidence path. An independent verifier (a
  different model family plus deterministic span checks) must pass every
  hypothesis before it becomes a `ripple_hypothesis` feature.
- **Strategy rule (deterministic):** a verified hypothesis becomes a
  candidate at the next session's 10:00 ET as a marketable limit, unless the
  target has already moved more than 1 × its 20-day ATR in the hypothesized
  direction since the event (already priced). Hold for the horizon with
  `exit_event` (time exit plus catastrophe stop). Equal risk slots, at most 10
  concurrent positions, one position per target.
- **Rule-based twin (`event_ripple_rules`):** the same events, one-hop
  propagation with the sign table in `math.md`, the same entry and exit.
  Deterministic class, with its own backtest gate on history.
- **Contamination class:** judgment for the brain. Only post-cutoff data
  counts (`validation.md`, Contamination control). Pre-cutoff runs with
  chronologically consistent models are research, never promotion evidence.
- **Model cost:** at most 20 events a day reach the brain; cost per event and
  per closed trade is reported (`stages.md`, Model spend).
- **X corroboration (`x_corroboration`, `data.md`):** a separate filter test
  on the twin's candidates, and later Event Ripple's: does a bot-filtered X
  burst before the decision improve them? X never creates an event or a
  candidate.
- **Kill:** the paired difference (Event Ripple minus twin) fails at the
  power-based minimum sample (about 1,000 resolved candidates per arm), or
  the kill-only monitor shows harm earlier. The brain is removed and the twin
  continues on its own merits.

## ETF Trend (`etf_trend`)

Time-series momentum on ETFs, long and short.

- **Hypothesis:** an asset's 12-month excess-return sign predicts its next
  month (Moskowitz-Ooi-Pedersen 2012). The published strategy is long-short
  and the short side carries the crisis-period return.
- **Grade A.** Century-long replications; weaker in the 2010s.
- **Universe:** about 10 liquid unlevered ETFs across US and ex-US equity,
  Treasuries, TIPS, commodities and gold. BIL is the cash leg.
- **Signal:** the sign of the 12-month return minus T-bills; inverse-
  volatility weights to a 10% annual target; monthly.
- **Role:** a low-correlation diversifier for the link strategies and the
  cheapest test of the US-set harness.
- **Caveat:** the 2016-2026 holdout was already seen by an earlier long-only
  trend test, so the report is labeled `seen-window` and the shadow gate
  minimum doubles to 6 rebalances.

## Controls

- The passive core: VTI and IEF at 60/40, the base of the reference book.
- Cash (BIL), the volatility-matched passive benchmark and 60/40
  (`validation.md`, Controls and benchmarks).
- Each model strategy's no-model twin.

## Portfolio construction

- Paper trading runs one champion through the kernel at a time. Every other
  strategy runs in shadow with simulated fills on live data.
- Shadow book (research, for planning the scaled stage): risk budgets equal
  by risk contribution on trailing 12-month shadow returns, no strategy above
  50% of risk, rebalanced monthly, gross within the constraint set.
- Several live strategies at once need the netting router and a universe-cap
  change (`kernel.md`).
- Order of testing, not a promise of promotion: ETF Trend, then Link Momentum
  (filings, news, intraday), then Filing Change, then Event Ripple rules.
  Event Ripple's forward shadow starts as soon as the engine produces
  verified hypotheses, because its evidence is forward-only.

## Decisions

- The fund trades strategies, not opinions. Each is a rule set with a
  pre-registration, an evidence grade, a contamination class and kill
  criteria.
- Parameters come from the literature and are fixed at pre-registration. No
  tuning on data already seen. Variants are trials.
- Live strategies obey the constraint set named by their stage.
- A model enters a strategy as engine features verified deterministically
  (the Link Momentum model variant) or as verified ripple hypotheses (Event
  Ripple). Every model strategy has a deterministic twin on the same events,
  and the model stays only if the paired test shows incremental value net of
  its cost.
- One champion in paper trading at a time; everything else in shadow.
