# 11 - Validation, Calibration, Shadow Evaluation, and Promotion

This doc has three jobs: show that a sleeve has edge net of all costs,
check whether any probabilistic AI component means what it claims, and
change the system only when the evidence clears the bar below. Nothing
here promotes anything by itself; every path ends at a human. §11.1-§11.3
apply wherever a sleeve uses `filter = jev`; §11.0 and §11.3a-b apply to
all sleeves.

## 11.0 The validation standard

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
- Metrics: DAILY portfolio returns (as §11.3), net of the set's cost model
  (`cost_v2` C1, `cost_v3` C2), with
  stationary-bootstrap confidence intervals; Sharpe inference with HAC
  standard errors; max drawdown; turnover; exposure.
- Effective number of trials: the raw ledger count overstates the search
  when trials are near-duplicates (variants of one rule) and understates
  nothing. `N_eff` = the number of clusters found by optimal-number-of-
  clusters clustering of all ledger trials' daily return series
  (López de Prado 2019), floored at the number of trials in the sleeve's
  own family. Computed by the harness from the ledger, never declared.
  Diagnostic runs (placebo graphs, source ablations, delisting
  sensitivity) write ledger rows of kind `diagnostic`, linked to their
  trial; they can never be selected, so they do not enter `N_eff`.
- Overfitting diagnostics: Deflated Sharpe Ratio with `N_eff`;
  Probability of Backtest Overfitting when ≥ 2 variants; minimum
  track-record length (MinTRL) for the observed Sharpe. These are
  necessary, not sufficient: a contrived oracle has passed DSR and PBO in
  published testing, so passing proves little and failing is decisive.
- New, non-literature signals (e.g. from the research factory): holdout
  t-statistic ≥ 3.0 (multiple-testing standard).
- Literature-derived sleeves: planning estimates apply a 50% haircut to
  published effect sizes (post-publication decay ≈ 58% on average); the
  haircut estimate must still clear 2× cost.

### 11.0c Temporal-contamination control for model evidence

A language model trained on data through date C "knows" outcomes before
C. Every pre-registration declares one contamination class for each model
component, where C is the role pin's recorded knowledge cutoff (doc 08
§8.10; an undisclosed cutoff is taken as the model's public release date):

- **Class A - deterministic.** No model output enters the signal. History
  is usable without restriction.
- **Class B - extraction.** A model extracts facts that already exist in a
  dated document, with firm identities anonymized and every fact verified
  by a deterministic exact-span match (doc 08 §8.2a). The extracted fact is
  checkable against the document, so the model cannot add a fact from the
  future; what remains is selection bias (memory of what mattered). History
  before C is usable for the A-gate, the report is labeled
  `contamination: B`, and promotion additionally requires the B-gate on
  live data. Selection-bias check: a random sample of at least 200
  filings dated before C is re-extracted by a pinned model whose own
  cutoff precedes each filing; edge-set agreement (Jaccard) is reported,
  and agreement below 0.8 downgrades the component to class C.
- **Class C - judgment.** A model judges direction, magnitude or outcome
  (the L3 brain, JEV, any forecast). Only data timestamped after C + 30
  days counts. Pre-cutoff runs are labeled contaminated and carry zero
  promotion weight, including runs with chronologically consistent models
  (research only).

A model upgrade restarts the clock for class C and requires a fresh
precision audit for class B. Every class B or C component is judged
against its deterministic twin (§11.3b).

### 11.0d Transferability

Promotion evidence counts only if produced under the constraint set of
the target stage (doc 01 §1.2) with its account ledger simulated: C1 is
long only, cash account, settlement ledger, 1×, `cost_v2`; C2 is long and
short in a margin account with the doc 05 C2 limits, margin, borrow and
short-dividend ledger, `cost_v3` (doc 14 §14.10), at the registered book
size. Both require allowlisted instruments and the signal/data timing the
live sleeve will have (SIP availability delays included). Evidence from
books outside the target set is research, never promotion evidence, and
C2 evidence never promotes a C1 stage or the reverse.

## 11.1 Calibration tracking (online, automatic)

Every JEV answer is a probabilistic claim and is scored against what
happened, per question, per regime, per symbol class, on a rolling window.

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
≥ 1% of top-of-book depth at the resolving print). Self-influenced outcomes are not neutral market
truth: they are scored separately and cannot promote a challenger alone.

- HOLDs are scored too, sampled. Scoring only trades taken cannot reveal
  that the system is too cautious or that its `enter` scores are noise.
  Every HOLD is eligible, but only a deterministically sampled 25% (CAL2)
  is resolved and scored; full enumeration would let the quietest regime
  dominate the calibration set with easy cases.
  Inclusion rule (frozen): `sha256(context_hash ‖ regime) mod 4 == 0`;
  every HOLD row logs `sampling_probability=0.25`, its stratum, and
  included/excluded; aggregate calibration over sampled HOLDs uses
  inverse-probability weighting (weight 4.0). Counterfactual resolution uses the frozen snapshot price and the
  same stop/TP rules, marked `counterfactual=true`, and is never mixed into PnL.
- Metrics: Brier score, log-loss, and a 10-bin reliability curve per
  question, over trailing 200 and 1000 decisions. Per-answer metric mapping
  (CAL4/CAL5, locked): `enter`/`latent_risk` (probabilities) → Brier +
  log-loss + reliability; `edge_family` (categorical) → multiclass log-loss
  + one-vs-rest Brier, accuracy descriptive-only; `conviction` (ordinal
  flat/lean/strong/max) → realized-R-bucket rank correlation (Somers' D)
  plus per-level hit-rate tables - never treated as a probability forecast.
- Baseline: the point-in-time base-rate predictor - at each prediction
  timestamp, the observed base rate of the outcome using only information
  available *before* t. Never a rolling window that includes future outcomes
  (that leaks future information). Scored model_t vs base_rate_t, with confidence intervals
  alongside the 0.02 R13 margin - the margin is the circuit breaker, the
  intervals are the judgment.
- R13 (hard), with a noise floor. If Brier over the trailing 200
  decisions is worse than the base-rate baseline by more than a 0.02 margin,
  entries halt and the stage demotes one level (doc 10 §10.2). Exits continue.
  Resume needs human review. The margin and a minimum-sample gate exist
  because a raw "any amount worse" comparison is not meaningful on a
  rare-event question: unflagged adverse events are uncommon by design, so
  a trivial baseline can look good on a small sample from low variance, and
  a couple of unlucky calls could trip R13 on noise. R13 is evaluated only
  once the window holds ≥20 realized outcomes of the resolving class
  (≥20 unflagged-event resolutions for `latent_risk`; ≥20 closed or
  sampled-counterfactual resolutions for `enter`) in addition to the
  200-decision window. Below that count, the daily summary reports
  `R13: insufficient sample` rather than a pass/fail verdict, and entries
  are not gated on it. R5, S3, and R6 remain live regardless and cover
  what R13 is too data-hungry to catch quickly.
- Miscalibration is expected: instruction-tuned models are measurably
  overconfident, and post-training worsens calibration (ECE +13.1%, Brier
  +6.5% vs base models). The decision table in doc 03 §3.2 therefore uses
  bands and consensus, never a raw probability value.
- Calibration drift is monitored per regime. A model calibrated in `range`
  and broken in `volatile` is common and is visible only when metrics are
  sliced by regime.

## 11.1a Regime change and evidence decay (deterministic, frozen)

Slicing calibration by regime (§11.1) is measurement. This section covers
what happens when the regime itself changes and how old evidence loses
weight. There is no online learning, no agent-set threshold, and no
discretionary detector.

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
   is noise, not a change (same precedent as FROZEN_N=3 in doc 08 §8.7
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
   persistence and never create a transition. A missing bucket is not
   neutral, and it is not a change.
7. New version / fresh window. A finite-H adoption, an H change, or a
   regime-signal definition change each bump the calibration config
   version and open a fresh paper window. The calibration harness
   carries an explicit version/artifact identity containing at least the
   regime definition version, H, and the weighting rule version; a change
   to any of these is observable and triggers the fresh-window rule.
   Regime changes themselves never version anything; they are data, handled
   by the decay rule.

## 11.2 Shadow and challenger evaluation

Everything not live runs in shadow, permanently:

- Champion - the live configuration. One only.
- Challengers - up to 3 concurrent variants (threshold set, feature set, model,
  prompt/question version). Each consumes the same frozen snapshots, produces
  decisions, and is scored on simulated fills using the doc 06 paper fill model (`paper_fill_v1`,
  wrapped by the set's cost model, doc 06 §6.0a).
  Challengers place no orders and hold no capital.
- Challengers get their own `question_set_version` and their own cost tag, so
  their AI spend is visible and counts against the caps in doc 10 §10.4.
- Every challenger carries registry metadata (interface now, full system in its
  build phase): experiment_id, parent strategy, hypothesis, created_at,
  creator version, search family + budget, feature set, model + prompt hashes,
  training/validation/holdout windows, cost budget, result, promotion status,
  human signature. Unauditable experiments do not promote.
- A challenger that would have breached any R-rule is disqualified on the spot and
  logged. Making money by taking more risk than permitted is not a
  result.

## 11.2a Forward replication ledgers (additive to §11.2)

When no champion exists, built sleeves that failed their A-gate may still run
as log-only forward replication ledgers against paired benchmarks: registered
in the trial ledger before results, one pooled Holm over the family, fixed
weights, kill-only sequential rules, and "eligible for review" (never
promotion) at 504 sessions. They are research observations, not challengers,
so the §11.2 cap of three challengers does not apply to them. Full protocol:
`plan/appendix/10-sleeve-integration-plan.md`.

The same machinery runs the B-gate and forward shadow of the doc 02
sleeves: forward ledgers (`ops/sleeve_shadow.py`), the paired evaluator
and checkpoints (`ops/sleeve_eval.py`), and the `--verify` fidelity
replay (every logged row reproduced within 20 bp), extended for C2
(shorts, margin, borrow, short dividends, `cost_v3`). Multiple-testing
families are kept apart so dead hypotheses do not tax new ones: the
retired C1 sleeves form one Holm family, the doc 02 program another, and
AI-component tests (JEV twins, L1-ai, L3 vs twin, `xcorr_v1`) a third.

## 11.3 The promotion gate (the only path into the live decision path)

A challenger may be proposed for promotion only when all of the following hold:

1. ≥ 200 decisions and ≥ 100 closed simulated trades in shadow. Short
   windows guarantee out-of-sample decay. The CAL7 primary-metric validity
   floor of 100 closed trades is the single authoritative minimum.
2. Forward-only evaluation with walk-forward discipline. The challenger was
   defined before the data it is evaluated on existed. Time-series splits are
   walk-forward with purged/embargoed boundaries where labels overlap, and the
   final verdict comes from an untouched holdout never used for selection.
   Retro-fitting a variant to a window already on disk is prohibited and is
   detectable from the definition timestamp in the journal.
3. Net of costs: the paper fill model plus its share of AI spend. Gross
   results are not reported or considered.
4. Search budget declared. The number of variants tried in this family is
   recorded, and the required improvement scales with it (promoting the best
   of 50 variants promotes noise). Deflated Sharpe and PBO do not protect
   against this on their own - a contrived oracle with Sharpe 35 passed both
   in published testing - so the search count is recorded as a fact and
   reviewed by a human.
5. Beats the champion on the primary metric and does not lose on the guardrails:
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
   book is still an observation), no overlapping windows, no ad hoc
   annualization (×sqrt(252) on daily, stated), cash earns exactly 0, open positions
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
   there are no separate per-family Holms; "union over families" means a
   single global family); Holm-adjusted p < 0.05 required.
6. A non-LLM baseline is beaten. The challenger must beat the frozen
   statistical baseline (doc 12: exact universe, features, entries, exits,
   costs - indicators + regime + risk table, no JEV, no research plane) on the
   same window, including under 1.5×/2×/3× cost stress. If it does not, the AI layer subtracts value and
   is removed rather than tuned.
7. Human review and sign-off, recorded in doc 07's sign-off log with name,
   date, challenger ID, and the window it was judged on.

Promotion then executes as: stop the process → swap config → bump
`question_set_version` → fresh paper window (doc 05, locked) → re-enter the
stage gates in doc 10. A promoted change does not inherit its predecessor's stage.

Forbidden: automatic promotion, auto-tuning of thresholds,
online/continual learning on the live path, agent self-modification of prompts,
tools, or skills, and any change to R1–R20 by anything other than a doc edit.

## 11.3a Sleeve gates (`val_v2`) - how a sleeve becomes a champion candidate

A-gate (historical, harness): all of the following on the frozen
pre-registration, recorded in the trial ledger. Statistics 1-3 are
computed on the evaluation window: every date after the last date used
to fit anything (all of it for literature sleeves with frozen parameters).
A 3-year holdout alone cannot detect the Sharpe ratios these sleeves can
plausibly earn (doc 14 §14.11); the holdout is the consistency check in
item 7.
1. Net Sharpe (daily, the target set's cost model at 1×: `cost_v2`
   for C1, `cost_v3` for C2) with 95% stationary-bootstrap CI lower
   bound > 0; point estimate > 0 at 2× cost.
2. Excess return over cash (T-bill leg) CI lower bound > 0.
3. Spanning test against the reference book: regress the sleeve's daily
   net excess returns on the reference book's (`r_s = α + β·r_b + ε`).
   The 95% stationary-bootstrap CI lower bound of α is > 0 at 1× cost and
   the α point estimate is > 0 at 2× cost. The reference book is the
   vol-matched passive benchmark (doc 12 §12.6) plus every promoted sleeve
   at its registered risk weight. Max drawdown is within the sleeve's
   pre-registered limit (default 2× its annual volatility target).
   Long-short sleeves also keep |β| to VTI ≤ 0.3 on the holdout. The
   Fama-French five-factor plus momentum alpha and the head-to-head
   comparison with the passive benchmark are reported, not gating.
   Reason: a sleeve improves the book's attainable Sharpe exactly when its
   alpha against the book is positive (Huberman-Kandel 1987). The earlier
   standalone test (Sharpe and drawdown versus passive) rewarded beta and
   rejected diversifiers.
4. DSR ≥ 0.95 with `N_eff` (§11.0b); PBO ≤ 0.2 when variants exist;
   history length ≥ MinTRL; t ≥ 3 for non-literature signals; haircut
   rule met.
5. Transferability (§11.0d); participation caps respected; excluded
   events or firm-months ≤ 5%.
6. For AI-assisted sleeves: the paired no-AI variant exists and the AI
   component is judged separately under §11.3b.
7. Holdout consistency: the last 3 years have a positive net point
   estimate and lie inside the 5th-95th percentile band of
   block-bootstrapped evaluation-window paths of equal length.

B-gate (G0a shadow on live data): the sleeve runs forward with harness
fills from the day it passes A-gate. Minimum window: 60 sessions and
30 trades for daily-frequency sleeves; 3 rebalances for monthly sleeves
(judged on tracking, not Sharpe). Passing: realized shadow results inside
the pre-registered tracking band (default: between the 5th and 95th
percentiles of block-bootstrapped backtest paths of equal length),
modeled costs within 1.5× of live-quote cost estimates, zero operational
anomalies unexplained in the journal.

Champion selection: among B-gate passers, the human picks the G0b
champion using the pre-registered primary metric; ties break toward the
simpler sleeve (fewer parameters, lower turnover).

## 11.3b AI-component gate - paired delta against the deterministic twin

Every model component is judged against the same sleeve without it, on
identical inputs, net of the component's own AI cost:

- **Filters** (JEV, an ensemble): the filtered policy beats always-take on
  identical post-cutoff candidates.
- **Class B extraction** (e.g. L1-ai link edges): the sleeve on the
  model-extracted graph beats the sleeve on the deterministic graph over
  the same months; history is allowed per §11.0c, and the delta must hold
  again in the B-gate window.
- **Class C ripple reasoning** (L3): the brain's candidates beat the
  deterministic twin `ripple_det_v1` on the same events after C + 30 days.
  Both are scored by ripple resolution (doc 14 §14.5) and by sleeve
  returns; the twin is the benchmark, not cash.

Passing: one-sided p < 0.05 by day-block stationary bootstrap on the daily
return difference, pre-registered minimum effect met, the pre-registered
minimum sample reached, and for probabilistic answers calibration ≥ base
rate per §11.1. A component that fails is removed, not tuned; the twin
continues on its own merits.

Minimum sample by power, not by habit: the pre-registration states the
minimum effect and computes the sample needed for 80% power at α = 0.05.
For ripple candidates with a 21-session CAR standard deviation near 9% and
a minimum effect of 1 percentage point, that is on the order of 1,000
resolved candidates per arm, i.e. about a year at the 20-event daily cap.
Filters keep the floor of 100 resolved candidates where their power
analysis allows it; class B extraction needs ≥ 24 months. Before the
minimum is reached, sequential monitoring may only stop the component
for harm (kill-only, §11.2a), never promote it.

## 11.4 Reflection → research-factory loop (bounded)

Doc 06 §6.2 writes an auto-field reflection row per closed trade. On top:

- Weekly, the research factory (doc 08 §8.9) reads reflection rows,
  sleeve tracking reports, calibration curves (where applicable), and
  `lessons.jsonl`, and produces at most **3 hypothesis cards**.
- Cards are queued for human review. They are not implemented, shadowed,
  or costed until a human approves a pre-registration.
- The cap of 3 keeps the loop from generating work faster than a human
  can judge it.

## 11.5 What "done" means

- [ ] Trial ledger implemented; every harness run writes it,
      including failures; DSR/Holm read N from it.
- [ ] Statistics module: walk-forward purge/embargo, CPCV, PBO, DSR,
      MinTRL, stationary bootstrap, HAC Sharpe - each with fixture tests.
- [ ] Contamination guard: an LLM-involved evaluation window that
      starts before cutoff + 30 d is rejected by the harness.
- [ ] A-gate and B-gate report generators with the `val_v2` spanning test
      and contamination-class labels.
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
- Model evidence follows its contamination class (§11.0c): judgment
  (class C) counts only after the model's knowledge cutoff + embargo.
- DSR/PBO/MinTRL are necessary, never sufficient.
- An AI component must beat the same sleeve without it (paired delta) or
  be removed rather than tuned.
- Calibration ("do the probabilities mean what they claim") is a SEPARATE
  question from filter efficacy (paired delta) and from sleeve performance
  (daily net returns/Sharpe/drawdown). "Beats a control" alone is not
  edge proof: promotion also needs the pre-registered absolute bar.
- Every JEV answer on a `jev` sleeve is scored, HOLDs included, against
  a base-rate baseline; worse than base rate halts that sleeve (R13).
