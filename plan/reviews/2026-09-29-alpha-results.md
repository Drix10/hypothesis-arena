# Alpha search results and strategic conclusion (2026-09-29)

Status record, not plan text. Every number below is in `research/reports/` and
the trial ledger (`research/ledger/trials.jsonl`, N=15 at this date).

## Results

All runs: settled-cash long-only engine, `cost_v2` at 1x and 2x, 3-year
holdout, benchmark = vol-matched 60/40 (VTI/IEF), Sharpe on returns in excess
of BIL. Free SIP history starts 2016-01-04.

| Sleeve | Variants | Best holdout excess Sharpe | Passive 60/40 | Verdict |
|---|---|---|---|---|
| T1 ETF trend | 2 | ~0.9 (CI lower bound <= 0) | 1.35 | FAIL |
| E1 insider purchases | 3 | 0.83 | 1.35 | FAIL |
| E2-det earnings drift | 3 | 0.28 | 1.33 | FAIL |

E1 and E2-det also lose 6-8% of events to missing prices (delisted names,
ticker changes), above the 5% limit, and model $71k-$146k of costs against a
$100k book over the sample.

## Reading

- The passive benchmark is very strong in this window; an active sleeve has to
  beat a Sharpe above 1.3 net of cost.
- Small-cap event effects exist in the literature but the spread and turnover
  they need at our size consume them under a conservative fill model.
- N=15 with a floored DSR variance makes every further trial harder to pass;
  more variants on the same data is not a strategy.

## Decisions

1. No sleeve is a G0b champion. G0b, as defined, does not start.
2. The paper loop is finished as infrastructure and can run with the
   non-alpha `core_passive_v1` sleeve to validate operations (fills,
   reconciliation, drills, alerts). That evidence does not count toward the
   G0 to G1 criteria.
3. Further alpha work needs a different information set, not more variants:
   a second price source with pre-2016 history, ticker-history mapping to
   recover the excluded events, and measured (not modeled) fills from the
   paper loop to calibrate `cost_v2` for small caps.
