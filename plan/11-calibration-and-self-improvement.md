# 11 - Validation, Calibration, Shadow Evaluation, and Promotion (freeze v3)

Three jobs: prove that a sleeve has edge net of everything, know whether
any probabilistic AI component means what it claims, and change the system
only when the evidence clears a bar that published LLM-trading work does
not. Nothing in this doc promotes anything by itself. Every arrow ends at
a human. Freeze v3 adds §11.0 and §11.3a–b; §§11.1–11.3 are the freeze-v2
contract, unchanged, and apply wherever a sleeve uses `filter = jev`.

## 11.0 The validation standard (v3)

### 11.0a Global trial ledger

Every backtest, variant, parameter set, or evaluation run by anyone -
human, harness, or research factory - appends one row to a single
append-only, hash-chained trial ledger **before** results are shown:
trial id, hypothesis card id, pre-registration hash, family, variant,
dataset manifest hashes, code hash, cost model version, window, split
scheme, metrics, verdict, runner identity, timestamp. Failed, crashed, and
abandoned runs are rows too. The ledger is the only source of the search
count N used by every multiple-testing correction; declared counts that
disagree with it void the run. Head checkpoints are signed off-host like
the journal (doc 05 §5.5). Rows are never edited or deleted.

### 11.0b Statistics standard (necessary, never sufficient)

- Splits: walk-forward with purging and embargo where labels overlap;
  combinatorial purged cross-validation (CPCV) when choosing among
  registered variants; one final untouched holdout never used for any
  choice (default: the last 3 years or last 25% of the sample, whichever
  is longer, fixed in the pre-registration).
- Sharpe-based statistics (bootstrap CI, 2x-cost test, DSR, MinTRL, PBO) use
  returns in excess of the cash leg; a sleeve parked in T-bills must not
  score on the T-bill yield. DSR's cross-trial variance is floored at the
  sampling variance of one Sharpe estimate, because a handful of variants
  cannot estimate it.
- Metrics: DAILY portfolio returns (as §11.3), net of `cost_v2`, with
  stationary-bootstrap confidence intervals; Sharpe inference with HAC
  standard errors; max drawdown; turnover; exposure.
- Overfitting diagnostics: Deflated Sharpe Ratio with N from the ledger;
  Probability of Backtest Overfitting when ≥ 2 variants; minimum
  track-record length (MinTRL) for the observed Sharpe. These are
  **necessary**: a contrived oracle has passed DSR and PBO in published
  testing, so passing them proves little and failing them is decisive.
- New, non-literature signals (e.g. from the research factory): holdout
  t-statistic ≥ 3.0 (multiple-testing standard).
- Literature-derived sleeves: planning estimates apply a 50% haircut to
  published effect sizes (post-publication decay ≈ 58% on average); the
  haircut estimate must still clear 2× cost.

### 11.0c Temporal-contamination control for LLM evidence

A language model trained on data through date C "knows" outcomes before
C. Any evaluation in which an LLM output influences a feature, a filter,
or a candidate uses **only data timestamped after C + 30 days**, where C
is the role pin's recorded knowledge cutoff (doc 08 §8.8); an undisclosed
cutoff is taken as the model's public release date. Consequences: LLM
components are judged mostly on forward shadow; pre-cutoff backtests of
LLM components are labeled contaminated and carry zero promotion weight;
a model upgrade restarts the clock. Deterministic sleeves are unaffected.

### 11.0d Transferability

Promotion evidence counts only if produced under the live constraint set
of the target stage: long only, cash account with the settlement ledger
simulated, 1×, allowlisted instruments, `cost_v2`, the signal/data timing
the live sleeve will have (SIP availability delays included). Evidence
from shadow books that short, lever, or trade non-allowlisted instruments
is research, never promotion evidence.

## 11.1 Calibration tracking (online, automatic)

Every JEV answer is a probabilistic claim, so it gets scored against what actually
happened. Scored per question, per regime, per symbol class, on a rolling window.

| Question | Resolves against | Horizon |
|---|---|---|
| `enter.noul` | P( if the opportunity is taken at the frozen snapshot price using `exit_profile_v1`, the trade reaches +1R before −1R within the horizon ) - the question text and this label statement are identical by freeze (CAL1); any question rewording versions the question and restarts its calibration clock. | min(stop/TP/time_exit hit, 24 h) |
| `latent_risk.noul` | Did a material adverse event occur that NO deterministic flag caught (gap through stop, unflagged halt, overnight shock without event blackout)? Counterfactual trade at snapshot size. | 24 h |
| `edge_family.choice` | Which family's evidence matched the realized path (rule-based classifier, no LLM)? Family-fit only - never scored as success probability. | trade lifetime |
| `conviction.score` | Realized R-multiple bucket | trade lifetime |

Outcome-resolution protocol (locked - labels are code, not judgment): both
stop and TP touched in one candle → stop-first (loss); gap over stop → loss
at first tradable print beyond the gap; neither hit by horizon → censored
(excluded from Brier, counted separately); halt/close before resolution →
excluded; stocks resolve within the session, forex within 24 h. Censored is a
third class, never silently a win or a loss. Censoring is tracked, not just
excluded (CAL3): resolution rate, censor rate, and censoring by regime are
reported every cycle; promotion is BLOCKED while resolution coverage < 80%
or any regime's censor rate exceeds 2× the global rate.

Every resolved outcome carries `outcome_source` (locked vocabulary):
`EXOGENOUS` (price path shows no traceable contribution from our fills),
`SELF_INFLUENCED` (our order/fill precedes and plausibly shapes the resolving
path - always assumed when our fill volume is non-trivial vs venue depth or
when resolution occurs within the venue's frozen SELF_WINDOW_S of our fill),
`UNKNOWN` (cannot determine - scored with confidence intervals widened, never
as exogenous by default). Frozen SELF_WINDOW_S (CAL6): OANDA practice 5 s,
Alpaca paper 5 s, with a venue-depth participation threshold of 1% (our fill
≥ 1% of top-of-book depth at the resolving print). Self-influenced outcomes are never neutral market
truth: they are scored separately and cannot promote a challenger alone.

- **HOLDs are scored too, sampled.** A system that only scores trades it took
  cannot discover that it is systematically too cautious - or that its `enter`
  scores are noise. Every HOLD is eligible, but only a deterministically
  sampled 25% (CAL2) is actually resolved and scored - full enumeration
  would let the quietest regime swamp the calibration set with cheap, easy-to-score
  cases and bias the whole metric toward "calibrated when nothing is happening."
  Inclusion rule (frozen): `sha256(context_hash ‖ regime) mod 4 == 0`;
  every HOLD row logs `sampling_probability=0.25`, its stratum, and
  included/excluded; aggregate calibration over sampled HOLDs uses
  inverse-probability weighting (weight 4.0). The sampling rate is logged per row so the harness can reweight if the realized
  mix drifts. Counterfactual resolution uses the frozen snapshot price and the
  same stop/TP rules, marked `counterfactual=true`, and is never mixed into PnL.
- Metrics: **Brier score**, **log-loss**, and a 10-bin **reliability curve** per
  question, over trailing 200 and 1000 decisions. Per-answer metric mapping
  (CAL4/CAL5, locked): `enter`/`latent_risk` (probabilities) → Brier +
  log-loss + reliability; `edge_family` (categorical) → multiclass log-loss
  + one-vs-rest Brier, accuracy descriptive-only; `conviction` (ordinal
  flat/lean/strong/max) → realized-R-bucket rank correlation (Somers' D)
  plus per-level hit-rate tables - never treated as a probability forecast.
- **Baseline: the point-in-time base-rate predictor** - at each prediction
  timestamp, the observed base rate of the outcome using only information
  available *before* t. Never a rolling window that includes future outcomes
  (that leaks). Scored model_t vs base_rate_t, with confidence intervals
  alongside the 0.02 R13 margin - the margin is the circuit breaker, the
  intervals are the judgment.
- **R13 (new, hard), with a noise floor.** If Brier over the trailing 200
  decisions is worse than the base-rate baseline **by more than a 0.02 margin**,
  entries halt and the stage demotes one level (doc 10 §10.2). Exits continue.
  Resume needs human review. The margin and a minimum-sample gate both exist
  because a raw "any amount worse" comparison is not statistically meaningful on
  a rare-event question: unflagged adverse events are uncommon by design (that is
  the point of the risk table), so a trivial baseline can look artificially good on
  a small sample purely from low variance, and a couple of unlucky calls could
  otherwise trip R13 on noise rather than a real calibration failure. **R13 is
  evaluated only once the window holds ≥20 realized outcomes of the resolving
  class** (≥20 unflagged-event resolutions for `latent_risk`; ≥20 closed or
  sampled-counterfactual resolutions for `enter`) **in addition to** the 200-
  decision window. Below that count, the daily summary reports
  `R13: insufficient sample` rather than a pass/fail verdict, and entries are not
  gated on it. This trades a small amount of protection early in a paper window
  for not being unable to ever clear promotion because of sampling noise - R5,
  S3, and R6 remain live regardless and catch the cases R13 is too data-hungry
  to catch quickly.
- Expect miscalibration and design for it: instruction-tuned models are measurably
  overconfident, and post-training makes calibration *worse* rather than better
  (ECE +13.1%, Brier +6.5% vs base models). The decision table in doc 03 §3.2
  therefore leans on *bands and consensus*, never on a raw probability value.
- Calibration drift is monitored per regime. A model calibrated in `range` and
  broken in `volatile` is the ordinary case, not the exception - that is regime
  blindness, and it is only visible if the metrics are sliced by regime.

## 11.1a Regime change and evidence decay (deterministic, frozen)

Slicing calibration by regime (§11.1) is measurement. This section is
treatment: what happens when the regime itself changes, and how old
evidence loses weight. No online learning, no agent-set thresholds, no
hidden discretionary detector.

1. Regime signal. The frozen per-snapshot regime bucket trend|range|
   volatile from ADX(14) + 1h-vol bucket (doc 12; also JEV state
   indicators, doc 03 §3.4), tracked per symbol. No other signal may
   define regime without a doc edit + version bump + fresh paper window.
2. Daily representative and change. For each symbol and each UTC
   calendar day, the daily representative is the regime of the last
   valid completed 1h observation for that symbol during that day. No
   valid observation → UNKNOWN for that day. A new regime is confirmed
   only when day d-1 has a known bucket, day d has the same new bucket,
   and both differ from the preceding known day d-2. UNKNOWN days break
   adjacency and are never skipped over to manufacture a two-day
   transition. The two-day persistence exists because a single-day flip
   is noise, not a change (same precedent as FROZEN_N=3 in doc 08 §8.5
   and the two-expected-bar gates in doc 05). Evaluated once per UTC day
   at 00:05 UTC from frozen daily closes using only completed
   information - never intra-day, never revised intra-day.
3. Reduced weight. Calibration samples (§11.1 trailing-200/1000 windows,
   R13 window, reliability curves) resolved under a regime bucket no
   longer current receive exponential weight w = 2^(-age_days / H).
   Current-regime samples keep weight 1.
4. Half-life rule. H (days) is a versioned calibration constant with
   frozen default H = infinity (all weights 1: no decay). A finite H is
   a config change requiring measured G0-paper justification, human
   sign-off, and a fresh paper window - the same bar as any limit change
   (doc 05). No finite H is invented here from literature alone.
5. Scope and weight composition. The rule affects calibration
   MEASUREMENT only (Brier/log-loss/reliability weights, R13 window
   weights). It never affects decision authorization (the table + vetoes
   read current state only), research weighting, or promotion arithmetic
   beyond the measured metrics. For every calibration row:
   total_weight = inclusion_weight × decay_weight, where normal
   inclusion = 1, sampled CAL2 HOLD = 4 (the frozen inverse-probability
   weight), and decay_weight = 2^(-age_days / H) (1 when H is
   infinite). Model and baseline metrics use the SAME row weights -
   weighting that applied to one side only would bias the comparison.
   Every calibration render states H, the decay rule, the weighted
   effective sample size, and the unweighted resolved-count floor -
   reported, never silent.
6. Unavailable regime. If the bucket cannot be computed (missing bars,
   feed gap), the day is tagged UNKNOWN: decay_weight = 1 while the row
   retains its normal inclusion weight (1 normally, 4 for an included
   CAL2 HOLD) - UNKNOWN never erases inverse-probability weighting. The
   gap is logged, and UNKNOWN days never count toward the two-day change
   persistence and never create a transition. Absent is not neutral, but
   it is also not a change.
7. New version / fresh window. A finite-H adoption, an H change, or a
   regime-signal definition change each bump the calibration config
   version and open a fresh paper window. The calibration harness
   carries an explicit version/artifact identity containing at least the
   regime definition version, H, and the weighting rule version; a change
   to any of these is observable and triggers the fresh-window rule.
   Regime CHANGES themselves never version anything - they are data, and
   the decay rule handles them by construction.

## 11.2 Shadow and challenger evaluation

Everything not live runs in shadow, permanently:

- **Champion** - the live configuration. One only.
- **Challengers** - up to 3 concurrent variants (threshold set, feature set, model,
  prompt/question version). Each consumes the same frozen snapshots, produces
  decisions, and is scored on simulated fills using the doc 06 paper fill model (`paper_fill_v1`,
  wrapped by `cost_v2` for v3 sleeves, doc 06 §6.0a).
  Challengers place no orders and hold no capital.
- Challengers get their own `question_set_version` and their own cost tag, so
  their AI spend is visible and counts against the caps in doc 10 §10.4.
- Every challenger carries registry metadata (interface now, full system in its
  build phase): experiment_id, parent strategy, hypothesis, created_at,
  creator version, search family + budget, feature set, model + prompt hashes,
  training/validation/holdout windows, cost budget, result, promotion status,
  human signature. Unauditable experiments do not promote.
- A challenger that would have breached any R-rule is disqualified on the spot and
  logged. "It would have made money by taking more risk than we permit" is not a
  result; it is a disqualification.

## 11.2a Forward replication program (2026-09-30, additive to §11.2)

When no champion exists, built sleeves that failed their A-gate may still run
as log-only forward replication ledgers against paired benchmarks: registered
in the trial ledger before results, one pooled Holm over the family, fixed
weights, kill-only sequential rules, and "eligible for review" (never
promotion) at 504 sessions. They are research observations, not challengers,
so the §11.2 cap of three challengers does not apply to them. Full protocol:
`plan/appendix/10-sleeve-integration-plan.md`.

## 11.3 The promotion gate (the only path into the live decision path)

A challenger may be proposed for promotion only when **all** of the following hold:

1. **≥ 200 decisions and ≥ 100 closed simulated trades** in shadow. Short windows
   guarantee out-of-sample decay. (Single authoritative minimum: the earlier
   "60 closed trades" draft is superseded - the CAL7 primary-metric validity
   floor of 100 governs.)
2. **Forward-only evaluation with walk-forward discipline.** The challenger was
   defined before the data it is evaluated on existed. Time-series splits are
   walk-forward with purged/embargoed boundaries where labels overlap, and the
   final verdict comes from an untouched holdout never used for selection.
   Retro-fitting a variant to a window already on disk is prohibited and is
   detectable from the definition timestamp in the journal.
3. **Net of costs** - the paper fill model plus its share of AI spend. Gross
   results are not reported and not considered.
4. **Search budget declared.** The number of variants tried in this family is
   recorded, and the required improvement scales with it. Trying 50 variants and
   promoting the best of 50 is how you promote noise. Note that Deflated Sharpe
   and PBO do **not** protect against this on their own - a contrived oracle with
   Sharpe 35 passed both in published testing - so the search count is recorded
   as a fact and reviewed by a human rather than laundered through a statistic.
5. **Beats the champion on the primary metric and does not lose on the guardrails**:
   primary = risk-adjusted return net of all costs; guardrails = max drawdown,
   trade count (over-trading check), calibration (Brier), and R-rule proximity.
   Primary metric frozen (CAL7): net Sharpe (all-in costs incl. AI share) with
   a 95% stationary-bootstrap CI, minimum 100 closed trades; Sharpe-ratio
   inference uses HAC (heteroskedasticity-and-autocorrelation-consistent)
   standard errors with the kernel/bandwidth choice documented per run -
   reported as its own procedure, not attributed to Lo–MacKinlay (whose
   variance-ratio work is a different methodology). Return sampling frozen:
   DAILY portfolio returns, marked-to-market at the 16:00 ET equity close
   (FX sleeve at the 17:00 ET rollover), zero-return days INCLUDED (a flat
   book is still an observation), no overlapping windows, no annualization
   games (×sqrt(252) on daily, stated), cash earns exactly 0, open positions
   marked at the close - never at intra-day favorable prints. Ties break toward the
   champion; any window cherry-picking (start/end chosen after seeing
   results) voids the run. Search correction (CAL8): Holm step-down at
   α=0.05 over the family's tested variants on the primary metric - the
   declared variant count from step 4 sets the multiplicity, no post-hoc
   discounting. Full Holm construction is frozen as a promotion-gate
   requirement (H0/H1/statistic/direction/resampling/family/threshold):
   H0 = challenger net Sharpe ≤ champion net Sharpe (one-sided, challenger
   must be strictly better); test statistic = paired bootstrap difference
   of net Sharpes on the same window; p-values from the stationary
   bootstrap (same resampling as the CAL7 CI); family = ONE pooled Holm
   over the union of ALL variants declared across ALL families evaluated
   in the promotion run (per-family declarations from step 4 feed the pool;
   there are no separate per-family Holms whose error rates could combine
   unaccounted - "union over families" means a single global family, not
   prose about separate corrections); Holm-adjusted p < 0.05 required.
6. **A non-LLM baseline is beaten.** The challenger must beat the frozen
   statistical baseline (doc 12: exact universe, features, entries, exits,
   costs - indicators + regime + risk table, no JEV, no research plane) on the
   same window, including under 1.5×/2×/3× cost stress. If it does not, the AI layer is costing money to
   subtract value, and the response is to remove it rather than tune it.
7. **Human review and sign-off**, recorded in doc 07's sign-off log with name,
   date, challenger ID, and the window it was judged on.

Promotion then executes as: stop the process → swap config → bump
`question_set_version` → **fresh paper window** (doc 05, locked) → re-enter the
stage gates in doc 10. A promoted change does not inherit its predecessor's stage.

**Forbidden, explicitly:** automatic promotion, auto-tuning of thresholds,
online/continual learning on the live path, agent self-modification of prompts,
tools, or skills, and any change to R1–R17 by anything other than a doc edit.

## 11.3a Sleeve gates (v3) - how a sleeve becomes a champion candidate

**A-gate (historical, harness):** all of the following on the frozen
pre-registration, recorded in the trial ledger:
1. Holdout net Sharpe (daily, `cost_v2` 1×) with 95% stationary-bootstrap
   CI lower bound > 0; point estimate > 0 at 2× cost.
2. Excess return over cash (T-bill leg) CI lower bound > 0.
3. Versus the vol-matched passive benchmark (doc 12 §12.6): net Sharpe not
   lower (point estimate) AND max drawdown not larger. A sleeve that
   neither beats passive risk-adjusted nor reduces its drawdown adds
   nothing a buy-and-hold account would not.
4. DSR ≥ 0.95 with ledger N; PBO ≤ 0.2 when variants exist; history
   length ≥ MinTRL; t ≥ 3 for non-literature signals; haircut rule met.
5. Transferability (§11.0d); participation caps respected; excluded-event
   count ≤ 5% (event sleeves).
6. For AI-assisted sleeves: the paired no-AI variant exists and the AI
   component is judged separately under §11.3b.

**B-gate (G0a shadow on live data):** the sleeve runs forward with harness
fills from the day it passes A-gate. Minimum window: 60 sessions and
30 trades for daily-frequency sleeves; 3 rebalances for monthly sleeves
(judged on tracking, not Sharpe). Passing: realized shadow results inside
the pre-registered tracking band (default: between the 5th and 95th
percentiles of block-bootstrapped backtest paths of equal length),
modeled costs within 1.5× of live-quote cost estimates, zero operational
anomalies unexplained in the journal.

**Champion selection:** among B-gate passers, the human picks the G0b
champion using the pre-registered primary metric; ties break toward the
simpler sleeve (fewer parameters, lower turnover).

## 11.3b Filter / AI-component gate (v3) - paired delta

A filter (JEV, an ensemble, a reader-tier feature) enters a champion
only if, on identical post-cutoff candidates (§11.0c), the filtered policy
beats always-take net of the filter's own AI cost: one-sided p < 0.05 by
day-block stationary bootstrap, pre-registered minimum effect met, ≥ 100
resolved candidates, and (for probabilistic answers) calibration ≥ base
rate per §11.1. S5's harness is the implementation; its economic
acceptance is this gate.

## 11.4 Reflection → research-factory loop (bounded)

Doc 06 §6.2 writes an auto-field reflection row per closed trade. On top:

- Weekly, the research factory (doc 08 §8.7) reads reflection rows,
  sleeve tracking reports, calibration curves (where applicable), and
  `lessons.jsonl`, and produces at most **3 hypothesis cards**.
- Cards are queued for human review. They are not implemented, shadowed,
  or costed until a human approves a pre-registration.
- The cap of 3 exists so the loop cannot generate work faster than a human
  can judge it. An unbounded self-improvement loop is a spend bug and a
  governance bug at the same time.

## 11.5 What "done" means

- [ ] (v3) Trial ledger implemented; every harness run writes it,
      including failures; DSR/Holm read N from it.
- [ ] (v3) Statistics module: walk-forward purge/embargo, CPCV, PBO, DSR,
      MinTRL, stationary bootstrap, HAC Sharpe - each with fixture tests.
- [ ] (v3) Contamination guard: an LLM-involved evaluation window that
      starts before cutoff + 30 d is rejected by the harness.
- [ ] (v3) A-gate and B-gate report generators; first reports for T1/I1.
- [ ] Calibration harness scores `enter` and `latent_risk` including
      counterfactual HOLDs (needed only once a `jev` sleeve exists).
- [ ] Reliability curves weekly, sliced by regime (same condition).
- [ ] Controls computed on every window (doc 12).
- [ ] A challenger that breaches an R-rule is auto-disqualified in test.
- [ ] Promotion dry run produces a complete sign-off record and forces a
      fresh paper window.

## Locked decisions

- Every trial is ledgered; the ledger decides N. No ledger row, no result.
- Promotion requires forward-only, cost-inclusive, transferable,
  search-adjusted evidence, beaten controls, and a human signature. No
  exceptions, no automation.
- LLM evidence counts only after the model's knowledge cutoff + embargo.
- DSR/PBO/MinTRL are necessary, never sufficient.
- An AI component must beat the same sleeve without it (paired delta) or
  be removed rather than tuned.
- Calibration ("do the probabilities mean what they claim") is a SEPARATE
  question from filter efficacy (paired delta) and from sleeve performance
  (daily net returns/Sharpe/drawdown). "Beats a control" alone is not
  edge proof: promotion also needs the pre-registered absolute bar.
- Every JEV answer on a `jev` sleeve is scored, HOLDs included, against
  a base-rate baseline; worse than base rate halts that sleeve (R13).
