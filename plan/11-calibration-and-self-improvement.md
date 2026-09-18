# 11 — Calibration, Shadow Evaluation, and Promotion

Two jobs: know whether JEV's probabilities mean anything, and change the system
only when the evidence clears a bar that published LLM-trading work does not.

Nothing in this doc can promote anything by itself. Every arrow ends at a human.

## 11.1 Calibration tracking (online, automatic)

Every JEV answer is a probabilistic claim, so it gets scored against what actually
happened. Scored per question, per regime, per symbol class, on a rolling window.

| Question | Resolves against | Horizon |
|---|---|---|
| `enter.noul` | Did the trade, had it been taken at the snapshot price, reach +1R before −1R? | min(stop/TP hit, 24 h) |
| `veto.noul` | Was any R-rule or limit actually breached in the following hour? | 1 h |
| `analyst.choice` | Which analyst's thesis matched the realized path (rule-based classifier, no LLM)? | trade lifetime |
| `conviction.score` | Realized R-multiple bucket | trade lifetime |

- **HOLDs are scored too, sampled.** A system that only scores trades it took
  cannot discover that it is systematically too cautious — or that its `enter`
  scores are noise. Every HOLD is eligible, but only a **25% stratified sample**
  (stratified by regime, so the set is not dominated by whichever regime happens
  to produce the most HOLDs) is actually resolved and scored — full enumeration
  would let the quietest regime swamp the calibration set with cheap, easy-to-score
  cases and bias the whole metric toward "calibrated when nothing is happening."
  The sampling rate is logged per row so the harness can reweight if the realized
  mix drifts. Counterfactual resolution uses the frozen snapshot price and the
  same stop/TP rules, marked `counterfactual=true`, and is never mixed into PnL.
- Metrics: **Brier score**, **log-loss**, and a 10-bin **reliability curve** per
  question, over trailing 200 and 1000 decisions.
- **Baseline: the base-rate predictor** — always answer the observed base rate of
  the outcome over the same window. This is the bar that matters. Beating a coin
  flip is not evidence; beating the base rate is the minimum.
- **R13 (new, hard), with a noise floor.** If Brier over the trailing 200
  decisions is worse than the base-rate baseline **by more than a 0.02 margin**,
  entries halt and the stage demotes one level (doc 10 §10.2). Exits continue.
  Resume needs human review. The margin and a minimum-sample gate both exist
  because a raw "any amount worse" comparison is not statistically meaningful on
  a rare-event question: `veto` breaches are uncommon by design (that is the
  point of the risk table), so a trivial baseline can look artificially good on
  a small sample purely from low variance, and a couple of unlucky calls could
  otherwise trip R13 on noise rather than a real calibration failure. **R13 is
  evaluated only once the window holds ≥20 realized outcomes of the resolving
  class** (≥20 actual breach/no-breach resolutions for `veto`; ≥20 closed or
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
- A challenger that would have breached any R-rule is disqualified on the spot and
  logged. "It would have made money by taking more risk than we permit" is not a
  result; it is a disqualification.

## 11.3 The promotion gate (the only path into the live decision path)

A challenger may be proposed for promotion only when **all** of the following hold:

1. **≥ 200 decisions and ≥ 60 closed simulated trades** in shadow. Short windows
   guarantee out-of-sample decay.
2. **Forward-only evaluation.** The challenger was defined before the data it is
   evaluated on existed. Retro-fitting a variant to a window already on disk is
   prohibited and is detectable from the definition timestamp in the journal.
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
6. **A non-LLM baseline is beaten.** The challenger must beat the plain
   statistical strategy (indicators + regime + risk table, no JEV, no research
   plane) on the same window. If it does not, the AI layer is costing money to
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

- [ ] Calibration harness scores `enter` and `veto` including counterfactual HOLDs.
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
