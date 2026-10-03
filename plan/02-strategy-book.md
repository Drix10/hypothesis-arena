# 02 - Strategy Book (`strategy_book_version: sb2`)

This doc defines what the fund trades, why it might work, and how we will
know if it does not. Every sleeve is a hypothesis with an evidence grade,
a pre-registration, and kill criteria. None trades until it passes the
doc 11 gates. Parameters come from the cited literature and are frozen at
pre-registration; variants count against the trial ledger (doc 11 §11.0).
The mathematics behind each signal is in doc 14; the graph and events
they read are built by the engine (doc 08).

## 2.0 The funnel (every sleeve, no shortcuts)

```
hypothesis (human, research factory, or engine) → pre-registration
(frozen spec + variant count + data window + holdout + contamination
class) → A-gate: historical backtest, trial-ledgered, net of costs →
B-gate: G0a shadow on live data → champion candidate → G0b paper orders
through the kernel → G0→G1 human gate → G1 live
```

A sleeve that fails any gate is recorded with its numbers and archived.
It is not modified until it passes: a new idea is a new pre-registration.

## 2.1 Evidence grades

- **A** - multiple peer-reviewed studies + documented post-publication
  out-of-sample persistence.
- **B** - peer-reviewed, out-of-sample evidence limited or contested, or
  concentrated in segments we can only partly trade.
- **C** - contested or failed replications; tested because the answer
  matters to the fund.
- **D** - speculative. Research factory only.

Published effects are haircut by 50% for planning (McLean-Pontiff: about
58% lower post-publication); new, non-literature signals need t ≥ 3
(Harvey-Liu-Zhu).

## 2.2 Sleeve spec template (every sleeve fills every field)

`id / version` · hypothesis · evidence grade + sources · mechanism (why it
should persist) · universe · data (dataset + manifest hash) ·
contamination class (doc 11 §11.0c) · signal (exact) · schedule (signal
time, order time, order type) · exit profile · sizing · turnover/capacity ·
account mechanics (C1 settlement or C2 margin/borrow) · AI involvement and
its no-AI twin · known failure modes · kill criteria · minimum evaluation
windows · status.

## 2.3 Sleeves

### L1 `link_momentum_v1` - connected-firm momentum on the Market Link Graph

- **Hypothesis:** a firm's next-month return follows the past-month return
  of the firms it is linked to, because investors process linked-firm news
  slowly.
- **Grade B+.** Ali-Hirshleifer (JFE 2020): connected-firm momentum
  1.68%/month, t = 9.67, subsuming industry, customer, technology and
  geographic momentum, weaker in recent years; Scherbina-Schlusche: news
  co-mention links cross-predict returns (survival after costs shown so
  far only in a Chinese-market study); Cohen-Frazzini (JF 2008);
  Menzly-Ozbas (JF 2010). Caveats: shared analyst coverage (the strongest
  link source) needs paid I/B/E/S data and is replaced by free proxies;
  single-link versions decayed after publication; spillover is stronger
  when the linked firm draws little attention.
- **Graph (doc 08 §8.2, point in time at each month-end):** edges from
  (a) customer/supplier disclosures in 10-K filings, (b) the 10 nearest
  10-K business-description peers, (c) GDELT news co-mentions over the
  trailing 90 days, (d) common institutional ownership from 13F filings
  (Anton-Polk, JF 2014). Each source's weights are normalized per firm; the
  four sources combine with equal weights (doc 14 §14.3).
- **Signal:** `link_ret_i` = edge-weighted mean of linked firms' returns
  over the past month, neutralized for the firm's own return, size and
  industry return (doc 14 §14.4). Tradable book: the 20 most extreme names
  a side; the full quintile spread is reported as the research measure.
- **Universe:** US common stock, price ≥ $5, 60-day median dollar volume
  ≥ $10M, market cap ≥ $500M, at least one link from two different edge
  sources; short side additionally ≥ $1B (an easy-to-borrow proxy for
  history; live check is the broker flag) and passes the R20 crowding
  filter.
- **Expected economics (planning only):** connected-firm momentum earned
  1.13-1.68%/month in its papers on analyst links; our free-data proxies
  are weaker and the haircut halves what remains, so a spread of
  0.4-0.6%/month before costs is the planning case, against roughly
  0.3%/month of costs at $25,000 (doc 14 §14.10). The margin is thin; the
  sleeve can fail on costs alone.
- **Registered variants (3 trials):** V0 edges (a)+(b)+(d), deterministic,
  2016+; V1 adds (c) GDELT; V2 = V1 with the peer return measured
  intraday only (Wang, JFQA 2025: peer intraday returns continue, peer
  overnight returns reverse).
- **AI twin:** `link_momentum_ai_v1` replaces the regex customer extractor
  with the reader-tier extractor (anonymized, span-verified; contamination
  class B). Judged by the doc 11 §11.3b paired delta against V1.
- **Schedule:** signal from the month-end close; trades the next session;
  monthly rebalance; 20 names a side at $25,000.
- **Exit `exit_link_v1`:** signal exit at rebalance; broker-native GTC
  catastrophe stop at 3 × 20-day ATR (sell-stop for longs, buy-stop for
  shorts).
- **Failure modes:** crowding of the published effect; costs in smaller
  names; short squeezes; graph errors from bad entity resolution;
  momentum-style crashes in sharp market rebounds, when the short leg
  (recent losers' links) rallies hardest (Daniel-Moskowitz, JFE 2016),
  partly contained by the 10% volatility target and the R2 net band.
- **Kill:** A-gate fail; or B-gate tracking outside band; or drawdown over
  1.5× the backtest's worst 12-month drawdown.

### L2 `text_change_v1` - changes in periodic filings

- **Hypothesis:** firms whose 10-K/10-Q text changes substantially against
  the same filing a year earlier underperform; firms that barely change
  outperform.
- **Grade B−.** Cohen-Malloy-Nguyen (JF 2020): up to 188 bp/month; a
  2009-2026 S&P 100 replication found no effect. The test therefore runs
  on mid caps outside the most-scrutinized firms, where the paper's effect
  concentrated.
- **Signal:** deterministic similarity of each filing to its prior-year
  counterpart, section by section (risk factors, MD&A); quintiles; monthly
  rebalance; a name is held about 3 months after its filing.
- **Universe:** as L1, excluding the 100 largest firms by market cap.
- **Contamination class:** A (deterministic).
- **Known risk:** firms that later delist are short-leg winners; missing
  prices for them trigger the 5% void rule and the D2 trigger (doc 09
  §9.1b).

### L3 `ripple_event_v1` - LLM ripple reasoning on events

- **Hypothesis:** when a material event hits one firm, a model that reads
  the event and the firm's link neighborhood identifies which linked firms
  move, in which direction, better than a fixed propagation rule.
- **Grade C.** Supporting: Chen-Kelly-Xiu (LLM news signals),
  Huang et al. 2026 (LLM-typed links), FinRipple (ACL Findings 2025, ripple
  prediction with knowledge graphs). Against: LLM reasoning is largely
  recall of training data ("causal parrots", Zečević et al., TMLR 2023);
  headline-signal returns decayed with adoption (Lopez-Lira-Tang). The
  sleeve exists to measure whether reasoning beats a rule.
- **Events (doc 08 §8.3):** 8-K material items, earnings releases with
  XBRL surprise, abnormal returns above 3 standard deviations on volume,
  GDELT news bursts naming the firm from at least 3 independent outlets,
  and disasters reported in news that names the firm. Mapping disasters to
  disclosed facility locations (10-K Item 2) is a later research card.
- **Brain (doc 08 §8.4):** for each event, retrieves the firm's two-hop
  neighborhood and recent events, and writes at most 5 typed ripple
  hypotheses: target firm, direction, horizon (5 / 21 / 63 sessions),
  mechanism (enum), and the evidence path. An independent verifier (a
  different model family plus deterministic span checks) must pass every
  hypothesis before it becomes a `ripple_hypothesis` feature.
- **Sleeve rule (deterministic):** a verified hypothesis becomes a
  candidate at the next session 10:00 ET (marketable limit) unless the
  target has already moved more than 1 × its 20-day ATR in the hypothesized
  direction since the event (already priced). Hold for the horizon;
  `exit_event_v1` (time exit + catastrophe stop); equal risk slots; at most
  10 concurrent positions; one position per target.
- **Deterministic twin `ripple_det_v1`:** same events, one-hop propagation
  with the sign table of doc 14 §14.5, same entry and exit. The twin is
  deterministic (class A) and runs its own A-gate on history.
- **Contamination class:** C for the brain (post-cutoff only, doc 11
  §11.0c). Pre-cutoff runs with chronologically consistent models are
  research, never promotion evidence.
- **AI cost:** at most 20 events/day reach the brain; cost per event and
  per closed trade is reported (doc 10 §10.4).
- **X corroboration (`xcorr_v1`, doc 09 §9.1c):** a separate filter test on
  the twin's (and later L3's) candidates: does a bot-filtered X burst
  before the decision improve them? X never creates an event or a
  candidate.
- **Kill:** paired delta (L3 − twin) fails at the power-based minimum
  sample (doc 11 §11.3b, about 1,000 resolved candidates per arm), or the
  kill-only monitor shows harm earlier → the brain is removed; the twin
  continues on its own merits.

### L4 `tsmom_ls_v1` - time-series momentum on ETFs, long and short

- **Hypothesis:** an asset's 12-month excess-return sign predicts its next
  month (Moskowitz-Ooi-Pedersen, JFE 2012). The published strategy is
  long-short; the short side carries the crisis-period return.
- **Grade A.** Century-long replications; weaker in the 2010s.
- **Universe:** about 10 liquid unlevered ETFs across US and ex-US equity,
  Treasuries, TIPS, commodities and gold; BIL is the cash leg.
- **Signal:** sign of the 12-month return minus T-bills; inverse-volatility
  weights to a 10% annual target; monthly.
- **Role:** a low-correlation diversifier for the link sleeves and the
  cheapest test of the C2 harness.
- **Caveat:** 2016-2026 includes a holdout already seen by the retired
  long-only trend sleeve, so the report is labeled `seen-window` and the
  B-gate minimum doubles to 6 rebalances.

### Controls

- `core_passive_v1` (VTI/IEF): the passive core and reference book base.
- Cash (BIL), vol-matched passive, 60/40 and `baseline_v1` (doc 12).

## 2.4 Portfolio construction

- G0b runs exactly one champion sleeve through the kernel at a time; every
  other sleeve runs in G0a shadow with harness fills on live data.
- Shadow book (research, for planning G2): sleeve risk budgets by equal
  risk contribution on trailing 12-month shadow returns, no sleeve above
  50% of risk, rebalanced monthly; gross within the constraint set.
- Multi-sleeve live allocation needs the netting router and a versioned
  universe-cap change (doc 13).
- Order of testing (not a promise of promotion): L4 → L1 (V0, V1, V2) →
  L2 → L3 twin; L3 brain forward shadow starts as soon as the engine
  produces verified hypotheses, because its evidence is forward-only.

## 2.5 Retired sleeves (record)

All ran their A-gate on the 2023-09-01..2026-08-31 holdout under C1 and
failed (`plan/reviews/2026-09-29-alpha-results.md`, `research/reports/`).
They run as forward ledgers only (`plan/appendix/10-sleeve-integration-plan.md`).

| Sleeve | Result |
|---|---|
| T1 `trend_etf_v1` (long or cash) | Sharpe about equal to passive; excess over cash, DSR, MinTRL fail |
| T2 `sector_mom_v1` | same pattern, weaker |
| I1 `intraday_mom_v1` | negative net Sharpe, negative at 2× cost |
| E1 `insider_buy_v1` | below passive, 27% drawdown, 7.9% events unpriced |
| E2-det `earnings_reader_v1` | no drift in tradable names |
| M1 `vol_target_overlay_v1` | not tested (no survivor to overlay) |
| X1 `fx_carry_mom_research_v1` | research only; forex is not a live target |

The X-lists signal system is HISTORICAL / NON-PRODUCTION; its record is
`appendix/02-x-lists-archive.md`. X input is not used in production.

## Locked decisions

- The fund trades sleeves, not opinions. Each sleeve is a rule set with a
  pre-registration, an evidence grade, a contamination class and kill
  criteria.
- Parameters come from the cited literature and are frozen at
  pre-registration; no tuning on data already seen. Variants are trials.
- Live sleeves obey the constraint set named in their stage manifest
  (doc 01 §1.2).
- AI enters a sleeve as engine features verified deterministically
  (L1-ai) or as verified ripple hypotheses (L3). Every AI sleeve has a
  deterministic twin on the same events, and the AI stays only if the
  paired test proves incremental value net of its cost.
- One champion sleeve in G0b at a time; everything else in shadow.
