# 11 — Calibration, Shadow Evaluation, and Promotion

Two jobs: know whether JEV's probabilities mean anything, and change the system
only when the evidence clears a bar that published LLM-trading work does not.

Nothing in this doc can promote anything by itself. Every arrow ends at a human.

## 11.1 Calibration tracking (online, automatic)

Every JEV answer is a probabilistic claim, so it gets scored against what actually
happened. Scored per question, per regime, per symbol class, on a rolling window.

| Question | Resolves against | Horizon |
|---|---|---|
| `enter.noul` | P( if the opportunity is taken at the frozen snapshot price using `exit_profile_v1`, the trade reaches +1R before −1R within the horizon ) — the question text and this label statement are identical by freeze (CAL1); any question rewording versions the question and restarts its calibration clock. | min(stop/TP/time_exit hit, 24 h) |
| `latent_risk.noul` | Did a material adverse event occur that NO deterministic flag caught (gap through stop, unflagged halt, overnight shock without event blackout)? Counterfactual trade at snapshot size. | 24 h |
| `edge_family.choice` | Which family's evidence matched the realized path (rule-based classifier, no LLM)? Family-fit only — never scored as success probability. | trade lifetime |
| `conviction.score` | Realized R-multiple bucket | trade lifetime |

Outcome-resolution protocol (locked — labels are code, not judgment): both
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
path — always assumed when our fill volume is non-trivial vs venue depth or
when resolution occurs within the venue's frozen SELF_WINDOW_S of our fill),
`UNKNOWN` (cannot determine — scored with confidence intervals widened, never
as exogenous by default). Frozen SELF_WINDOW_S (CAL6): OANDA practice 5 s,
Alpaca paper 5 s, with a venue-depth participation threshold of 1% (our fill
≥ 1% of top-of-book depth at the resolving print). Self-influenced outcomes are never neutral market
truth: they are scored separately and cannot promote a challenger alone.

- **HOLDs are scored too, sampled.** A system that only scores trades it took
  cannot discover that it is systematically too cautious — or that its `enter`
  scores are noise. Every HOLD is eligible, but only a deterministically
  sampled 25% (CAL2) is actually resolved and scored — full enumeration
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
  plus per-level hit-rate tables — never treated as a probability forecast.
- **Baseline: the point-in-time base-rate predictor** — at each prediction
  timestamp, the observed base rate of the outcome using only information
  available *before* t. Never a rolling window that includes future outcomes
  (that leaks). Scored model_t vs base_rate_t, with confidence intervals
  alongside the 0.02 R13 margin — the margin is the circuit breaker, the
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
  for not being unable to ever clear promotion because of sampling noise — R5,
  S3, and R6 remain live regardless and catch the cases R13 is too data-hungry
  to catch quickly.
- Expect miscalibration and design for it: instruction-tuned models are measurably
  overconfident, and post-training makes calibration *worse* rather than better
  (ECE +13.1%, Brier +6.5% vs base models). The decision table in doc 03 §3.2
  therefore leans on *bands and consensus*, never on a raw probability value.
- Calibration drift is monitored per regime. A model calibrated in `range` and
  broken in `volatile` is the ordinary case, not the exception — that is regime
  blindness, and it is only visible if the metrics are sliced by regime.

## 11.2 Shadow and challenger evaluation

Everything not live runs in shadow, permanently:

- **Champion** — the live configuration. One only.
- **Challengers** — up to 3 concurrent variants (threshold set, feature set, model,
  prompt/question version). Each consumes the same frozen snapshots, produces
  decisions, and is scored on simulated fills using the doc 06 §6.5 paper model.
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

## 11.3 The promotion gate (the only path into the live decision path)

A challenger may be proposed for promotion only when **all** of the following hold:

1. **≥ 200 decisions and ≥ 100 closed simulated trades** in shadow. Short windows
   guarantee out-of-sample decay. (Single authoritative minimum: the earlier
   "60 closed trades" draft is superseded — the CAL7 primary-metric validity
   floor of 100 governs.)
2. **Forward-only evaluation with walk-forward discipline.** The challenger was
   defined before the data it is evaluated on existed. Time-series splits are
   walk-forward with purged/embargoed boundaries where labels overlap, and the
   final verdict comes from an untouched holdout never used for selection.
   Retro-fitting a variant to a window already on disk is prohibited and is
   detectable from the definition timestamp in the journal.
3. **Net of costs** — the paper fill model plus its share of AI spend. Gross
   results are not reported and not considered.
4. **Search budget declared.** The number of variants tried in this family is
   recorded, and the required improvement scales with it. Trying 50 variants and
   promoting the best of 50 is how you promote noise. Note that Deflated Sharpe
   and PBO do **not** protect against this on their own — a contrived oracle with
   Sharpe 35 passed both in published testing — so the search count is recorded
   as a fact and reviewed by a human rather than laundered through a statistic.
5. **Beats the champion on the primary metric and does not lose on the guardrails**:
   primary = risk-adjusted return net of all costs; guardrails = max drawdown,
   trade count (over-trading check), calibration (Brier), and R-rule proximity.
   Primary metric frozen (CAL7): net Sharpe (all-in costs incl. AI share) with
   a 95% stationary-bootstrap CI, minimum 100 closed trades; Sharpe-ratio
   inference uses HAC (heteroskedasticity-and-autocorrelation-consistent)
   standard errors with the kernel/bandwidth choice documented per run —
   reported as its own procedure, not attributed to Lo–MacKinlay (whose
   variance-ratio work is a different methodology). Return sampling frozen:
   DAILY portfolio returns, marked-to-market at the 16:00 ET equity close
   (FX sleeve at the 17:00 ET rollover), zero-return days INCLUDED (a flat
   book is still an observation), no overlapping windows, no annualization
   games (×sqrt(252) on daily, stated), cash earns exactly 0, open positions
   marked at the close — never at intra-day favorable prints. Ties break toward the
   champion; any window cherry-picking (start/end chosen after seeing
   results) voids the run. Search correction (CAL8): Holm step-down at
   α=0.05 over the family's tested variants on the primary metric — the
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
   unaccounted — "union over families" means a single global family, not
   prose about separate corrections); Holm-adjusted p < 0.05 required.
6. **A non-LLM baseline is beaten.** The challenger must beat the frozen
   statistical baseline (doc 12: exact universe, features, entries, exits,
   costs — indicators + regime + risk table, no JEV, no research plane) on the
   same window, including under 1.5×/2×/3× cost stress. If it does not, the AI layer is costing money to
   subtract value, and the honest response is to remove it rather than tune it.
7. **Human review and sign-off**, recorded in doc 07's sign-off log with name,
   date, challenger ID, and the window it was judged on.

Promotion then executes as: stop the process → swap config → bump
`question_set_version` → **fresh paper window** (doc 05, locked) → re-enter the
stage gates in doc 10. A promoted change does not inherit its predecessor's stage.

**Forbidden, explicitly:** automatic promotion, auto-tuning of thresholds,
online/continual learning on the live path, agent self-modification of prompts,
tools, or skills, and any change to R1–R17 by anything other than a doc edit.

## 11.4 Reflection → hypothesis loop (bounded)

Doc 06 §6.2 already writes an auto-field reflection row per closed trade. This doc
adds the bounded loop on top:

- Weekly, the research plane reads reflection rows + calibration curves + the
  `lessons.jsonl` file (doc 09 Tier D) and produces at most **3 written proposals**.
  A proposal is prose plus a precise diff-sized description of what would change.
- Proposals are queued for human review. They are **not** implemented, not
  shadowed, and not costed until a human converts one into a challenger.
- Cap of 3 exists so the loop cannot generate work faster than a human can judge
  it. An unbounded self-improvement loop is a spend bug and a governance bug at
  the same time.

## 11.5 What "done" means

- [ ] Calibration harness scores `enter` and `latent_risk` including counterfactual HOLDs.
- [ ] Reliability curves render weekly, sliced by regime.
- [ ] Base-rate baseline computed on the same window; R13 breach drill demotes.
- [ ] Champion + 3 challengers run on identical snapshots for 7 days; cost per
      challenger attributed and counted against doc 10 caps.
- [ ] A challenger that breaches an R-rule is auto-disqualified in test.
- [ ] Non-LLM baseline strategy implemented and scored — it is a permanent fixture,
      not a one-off.
- [ ] Promotion dry run produces a complete sign-off record and forces a fresh
      paper window.

## Locked decisions

- Every JEV answer is scored, HOLDs included, against a base-rate baseline.
- Calibration worse than base rate halts entries and demotes (R13).
- Promotion requires forward-only, cost-inclusive, search-budget-declared evidence,
  a beaten non-LLM baseline, and a human signature. No exceptions, no automation.
- The AI layer must beat the statistical baseline or be removed rather than tuned.
