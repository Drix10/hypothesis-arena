# Validation and promotion

This doc has three jobs: show that a strategy has edge net of all costs, keep
model-derived evidence honest, and change the system only when the evidence
clears the bar below. Nothing here promotes anything by itself; every path ends
at a human.

## Trial ledger

Every backtest, variant, parameter set or evaluation run by anyone (human,
harness or research factory) appends one row to a single append-only,
hash-chained trial ledger before results are shown: trial id, hypothesis card
id, pre-registration hash, family, variant, dataset manifest hashes, code hash,
cost model, window, split scheme, metrics, verdict, runner identity and
timestamp. Failed, crashed and abandoned runs are rows too. The ledger is the
only source of the search count N used by every multiple-testing correction;
declared counts that disagree with it void the run. Head checkpoints are signed
off-host like the journal (`risk.md`, Audit). Rows are never edited or deleted.

## Statistics standard

Necessary, never sufficient.

- **Splits:** walk-forward with purging and embargo where labels overlap;
  combinatorial purged cross-validation (CPCV) when choosing among registered
  variants; one final untouched holdout never used for any choice (default: the
  last 3 years or last 25% of the sample, whichever is longer, fixed in the
  pre-registration).
- **Excess returns:** Sharpe-based statistics (bootstrap CI, 2× cost test, DSR,
  MinTRL, PBO) use returns in excess of the cash leg; a strategy parked in
  T-bills must not score on the T-bill yield. DSR's cross-trial variance is
  floored at the sampling variance of one Sharpe estimate, because a handful of
  variants cannot estimate it.
- **Metrics:** daily portfolio returns, net of the cost model, with
  stationary-bootstrap confidence intervals; Sharpe inference with HAC standard
  errors; maximum drawdown; turnover; exposure.
- **Effective number of trials:** the raw ledger count overstates the search
  when trials are near-duplicates (variants of one rule) and understates
  nothing. `N_eff` is the number of clusters found by optimal-number-of-clusters
  clustering of all ledger trials' daily return series (López de Prado 2019),
  floored at the number of trials in the strategy's own family. The harness
  computes it from the ledger; it is never declared. Diagnostic runs (placebo
  graphs, source ablations, delisting sensitivity) write ledger rows of kind
  `diagnostic`, linked to their trial; they can never be selected, so they do
  not enter `N_eff`.
- **Trial budget for `connected_drift`:** 3 selectable variants (proposed;
  `strategies.md`, Pre-registration fields), so the family floor of `N_eff` is
  3. Drop-one ablations, the run without the scaler, the own-firm skip-month and
  1-month hold, the placebo graph, delisting sensitivity and event-day insider
  entry are diagnostic runs: each writes a ledger row, none is selectable, none
  counts toward `N_eff`. A diagnostic result that is used to choose or change
  anything stops being a diagnostic and is a new trial.
- **Seen-window caveat:** the free feed's 2016-2026 window was already seen by
  an earlier long-only trend test. Any run that touches the trend scaler is
  labeled `seen-window` in its report, and the shadow-gate minimum for the
  strategy doubles to 6 rebalances. The scaler is judged by its diagnostic run
  against the unscaled book, never as standalone evidence.
- **Overfitting diagnostics:** Deflated Sharpe Ratio with `N_eff`; Probability
  of Backtest Overfitting when there are at least 2 variants; minimum
  track-record length (MinTRL) for the observed Sharpe. A contrived oracle has
  passed DSR and PBO in published testing, so passing proves little and failing
  is decisive.
- **New signals:** a holdout t-statistic of at least 3.0 for signals that do not
  come from the literature (for example from the research factory).
- **Literature-derived strategies:** planning estimates apply a 50% haircut to
  published effect sizes (post-publication decay is about 58% on average); the
  haircut estimate must still clear 2× cost.

## Contamination control

A language model trained on data through date C "knows" outcomes before C. Every
pre-registration declares one contamination class for each model component,
where C is the role pin's recorded knowledge cutoff (`engine.md`, Model
selection and pinning; an undisclosed cutoff is taken as the model's public
release date):

- **Deterministic class.** No model output enters the signal. History is usable
  without restriction.
- **Extraction class.** A model extracts facts that already exist in a dated
  document, with firm identities anonymized and every fact verified by a
  deterministic exact-span match (`engine.md`, Link extraction). The extracted
  fact is checkable against the document, so the model cannot add a fact from
  the future; what remains is selection bias (memory of what mattered). History
  before C is usable for the backtest gate, the report is labeled
  `contamination: extraction`, and promotion additionally requires the shadow
  gate on live data. Selection-bias check: a random sample of at least 200
  filings dated before C is re-extracted by a pinned model whose own cutoff
  precedes each filing; edge-set agreement (Jaccard) is reported, and agreement
  below 0.8 downgrades the component to judgment class.
- **Judgment class.** A model judges direction, magnitude or outcome (the Event
  Ripple brain, any forecast). Only data timestamped after C plus 30 days
  counts. Pre-cutoff runs are labeled contaminated and carry zero promotion
  weight, including runs with chronologically consistent models (research only).

A model upgrade restarts the clock for judgment class and requires a fresh
precision audit for extraction class. Every extraction- or judgment-class
component is judged against its deterministic twin (Model component gate).

## Transferability

Promotion evidence counts only if it was produced under the constraint set of
the target stage (`vision.md`) with its account ledger simulated. The India set
is long only, cash account, settlement ledger and 1×. The US set is long and
short in a margin account with the US-set limits in `risk.md` and the margin,
borrow and short-dividend ledger, at the registered book size. Both use the
cost model in `math.md` and require allowlisted instruments and the signal and
data timing the live strategy will have (SIP availability delays included).
Evidence from books outside the target set is research, never promotion
evidence, and US-set evidence never promotes an India-set stage or the reverse.

## Shadow and challenger evaluation

Everything not live runs in shadow, permanently:

- The champion is the live configuration. There is one.
- Challengers are up to 3 concurrent variants (parameter set, feature set,
  model or prompt version). Each consumes the same frozen snapshots, produces
  decisions, and is scored on simulated fills using the fill rule wrapped by the
  cost model (`execution.md`). Challengers place no orders and hold no capital.
- Challengers get their own cost tag, so their model spend is visible and counts
  against the caps in `stages.md`.
- Every challenger carries registry metadata: experiment id, parent strategy,
  hypothesis, created_at, creator version, search family and budget, feature
  set, model and prompt hashes, training, validation and holdout windows, cost
  budget, result, promotion status and human signature. Unauditable experiments
  do not promote.
- A challenger that would have breached any rule in `risk.md` is disqualified on
  the spot and logged. Making money by taking more risk than permitted is not a
  result.

### Forward ledgers

Forward ledgers run each strategy in shadow and each benchmark as a log-only
virtual book on live data with harness fills. Every ledger is registered in the
trial ledger before any result, keeps fixed weights, and is judged as a paired
daily difference against its benchmark: `WARMUP` under 60 sessions, `KILL-FUTILE`
from 126 sessions when the 95% CI upper bound of the active return is below zero
(a kill-only sequential rule), and "eligible for review" (never promotion) at
504 sessions. They are research observations, not challengers, so the cap of
three challengers does not apply.

The machinery is `ops/forward_ledgers.py` (ledgers), `ops/forward_eval.py`
(paired evaluator and checkpoints), `ops/forward_register.py` (trial
registration) and the `--verify` fidelity replay (every logged row reproduced
within 20 bp). It is extended for the US set (shorts, margin, borrow, short
dividends and the short-side cost terms) before a US-set strategy enters shadow.
Multiple-testing families are kept apart so one hypothesis does not tax an
unrelated one: the strategies in `strategies.md` form one Holm family, which
holds the Connected Drift Book's 3 selectable variants plus any strategy
registered beside it, and model-component tests (the link-component model twin,
any parked card's judgment-class test, the X corroboration test) form another.

## Champion promotion

A challenger may be proposed for promotion only when all of the following hold:

1. At least 200 decisions and at least 100 closed simulated trades in shadow.
   Short windows guarantee out-of-sample decay. The floor of 100 closed trades
   is the single authoritative minimum for the primary metric.
2. Forward-only evaluation with walk-forward discipline. The challenger was
   defined before the data it is evaluated on existed. Time-series splits are
   walk-forward with purged and embargoed boundaries where labels overlap, and
   the final verdict comes from an untouched holdout never used for selection.
   Retro-fitting a variant to a window already on disk is prohibited and is
   detectable from the definition timestamp in the journal.
3. Net of costs: the fill rule plus its share of model spend. Gross results are
   not reported or considered.
4. Search budget declared. The number of variants tried in this family is
   recorded, and the required improvement scales with it (promoting the best of
   50 variants promotes noise). DSR and PBO do not protect against this on their
   own, since a contrived oracle with Sharpe 35 passed both in published
   testing, so the search count is recorded as a fact and reviewed by a human.
5. It beats the champion on the primary metric and does not lose on the
   guardrails. Primary: net Sharpe (all-in costs including the model share) with
   a 95% stationary-bootstrap CI, at least 100 closed trades; Sharpe inference
   uses HAC standard errors with the kernel and bandwidth documented per run.
   Guardrails: maximum drawdown, trade count (an over-trading check) and
   proximity to the risk rules. Return sampling is fixed: daily portfolio
   returns marked to market at the 16:00 ET equity close, zero-return days
   included (a flat book is still an observation), no overlapping windows,
   annualization by √252 on daily returns, cash earns exactly 0, open positions
   marked at the close and never at intra-day favorable prints. Ties break toward
   the champion; any window cherry-picking (start or end chosen after seeing
   results) voids the run. Search correction: a Holm step-down at α = 0.05 over
   the family's tested variants on the primary metric, with the declared variant
   count setting the multiplicity and no post-hoc discounting. The Connected
   Drift Book's 3 selectable variants count as 3 tested variants; diagnostic runs
   do not. The construction: H0 is challenger net Sharpe at most champion net Sharpe (one-sided; the
   challenger must be strictly better); the test statistic is the paired
   bootstrap difference of net Sharpes on the same window; p-values come from
   the stationary bootstrap (the same resampling as the CI); the family is one
   pooled Holm over the union of all variants declared across all families
   evaluated in the promotion run, with no separate per-family Holms;
   Holm-adjusted p below 0.05 is required.
6. The benchmarks are beaten (below), including under 1.5×, 2× and 3× cost
   stress. If a model layer does not beat the same strategy without it, the layer
   subtracts value and is removed rather than tuned.
7. Human review and sign-off, recorded in the approvals log in `roadmap.md` with
   name, date, challenger id and the window it was judged on.

Promotion then executes as: stop the process, swap config, fresh paper window
(`risk.md`), re-enter the stage gates in `stages.md`. A promoted change does not
inherit its predecessor's stage.

Forbidden: automatic promotion, auto-tuning of thresholds, online or continual
learning on the live path, agent self-modification of prompts, tools or skills,
and any change to the risk rules other than a doc edit.

## Strategy gates

How a strategy becomes a champion candidate.

**Backtest gate** (historical, in the harness): all of the following on the
fixed pre-registration, recorded in the trial ledger. Items 1-3 are computed on
the evaluation window: every date after the last date used to fit anything (all
of it for literature strategies with fixed parameters). A 3-year holdout alone
cannot detect the Sharpe ratios these strategies can plausibly earn
(`math.md`, Evaluation statistics); the holdout is the consistency check in
item 7.

1. Net Sharpe (daily, the cost model at 1×) with a 95% stationary-bootstrap CI
   lower bound above 0, and a point estimate above 0 at 2× cost.
2. Excess return over cash (the T-bill leg) with a CI lower bound above 0.
3. Spanning test against the reference book: regress the strategy's daily net
   excess returns on the reference book's (`r_s = α + β·r_b + ε`). The 95%
   stationary-bootstrap CI lower bound of α is above 0 at 1× cost and the α
   point estimate is above 0 at 2× cost. The reference book is the
   volatility-matched passive benchmark plus every promoted strategy at its
   registered risk weight. Maximum drawdown is within the strategy's
   pre-registered limit (default 2× its annual volatility target). Long-short
   strategies also keep |β| to VTI at most 0.3 on the holdout. The Fama-French
   five-factor plus momentum alpha, the head-to-head comparison with the
   passive benchmark and the sign and size of net alpha in each decade of the
   window are reported, not gating. A strategy improves the book's
   attainable Sharpe exactly when its alpha against the book is positive
   (Huberman-Kandel 1987); a standalone test of Sharpe and drawdown against
   passive would reward beta and reject diversifiers.
4. DSR of at least 0.95 with `N_eff`; PBO at most 0.2 when variants exist;
   history length at least MinTRL; t of at least 3 for non-literature signals;
   haircut rule met.
5. Transferability; participation caps respected; excluded events or firm-months
   at most 5%.
6. For model-assisted strategies: the paired no-model variant exists and the
   model component is judged separately (Model component gate).
7. Holdout consistency: the last 3 years have a positive net point estimate and
   lie inside the 5th-95th percentile band of block-bootstrapped
   evaluation-window paths of equal length.

**Outcomes.** A backtest gate that fails is one of two kinds. *Economic
failure*: the net point estimate at 1× cost is below zero, or the upper bound
of its CI is below the haircut expectation. The idea is dead at this
information set and the result is recorded. *Underpowered*: neither holds, so
the data cannot tell no edge from a real one at the planning Sharpe; the
strategy routes to a longer window or the paid-data trigger (`data.md`), never
to a pass and never to a loosened gate.

**Shadow gate** (live data): the strategy runs forward with harness fills from
the day it passes the backtest gate. Minimum window: 60 sessions and 30 trades
for daily-frequency strategies; 3 rebalances for monthly strategies (judged on
tracking, not Sharpe). Passing: realized shadow results inside the
pre-registered tracking band (default: between the 5th and 95th percentiles of
block-bootstrapped backtest paths of equal length), modeled costs within 1.5× of
live-quote cost estimates, and zero operational anomalies unexplained in the
journal.

**Champion selection:** among shadow-gate passers, the human picks the paper
champion using the pre-registered primary metric; ties break toward the simpler
strategy (fewer parameters, lower turnover).

## Composite reporting

For a composite strategy (`connected_drift`), reports come in this order:

1. **First report: component correlation.** Before any Sharpe, return or
   spanning result, the harness writes the correlation matrix of the component
   scores and the effective signal count `(Σλ)² / Σλ²` (`math.md`, Composite
   score), computed on the pre-registered evaluation window and excluding the
   holdout. If the components are highly correlated the composite collapses to
   one signal; the next step is a new pre-registration on the stronger
   component, not a reweighting.
2. **Primary variant** through the backtest gate below.
3. **Ablation report.** The drop-one runs (three), the run without the scaler
   and the other diagnostic runs are reported next to the primary with net
   Sharpe, spanning alpha and the change from the primary. They are
   attribution, not selection: a component whose removal leaves the spanning
   alpha unchanged or higher is reported as subtracting value, and removing it
   is a new pre-registration.

Every contamination, transferability and gate rule below applies to the
composite unchanged.

## Model component gate

Every model component is judged against the same strategy without it, on
identical inputs, net of the component's own model cost:

- **Extraction class** (for example the link-component model twin's link
  edges): the strategy on the model-extracted graph beats the strategy on the
  deterministic graph over the same months. History is allowed per the
  contamination rules, and the difference must hold again in the shadow-gate
  window.
- **Judgment class** (Event Ripple): the brain's candidates beat the
  deterministic twin `event_ripple_rules` on the same events after C plus 30
  days. Both are scored by ripple resolution (`math.md`) and by strategy
  returns; the twin is the benchmark, not cash.
- **Filters** (for example the X corroboration flag): the filtered policy beats
  taking every candidate, on identical candidates.

Passing: one-sided p below 0.05 by a day-block stationary bootstrap on the daily
return difference, the pre-registered minimum effect met, and the pre-registered
minimum sample reached. A component that fails is removed, not tuned; the twin
continues on its own merits.

Minimum sample by power, not by habit: the pre-registration states the minimum
effect and computes the sample needed for 80% power at α = 0.05. For ripple
candidates with a 21-session CAR standard deviation near 9% and a minimum effect
of 1 percentage point, that is on the order of 1,000 resolved candidates per
arm, about a year at the 20-event daily cap. Filters keep a floor of 100 resolved
candidates where their power analysis allows it; extraction class needs at least
24 months. Before the minimum is reached, sequential monitoring may only stop
the component for harm (kill-only), never promote it.

## Controls and benchmarks

Every strategy is scored against the same benchmark set on the same window,
calendar and cost model, on daily returns:

1. **Cash:** the T-bill leg (BIL total return). A strategy must beat cash net of
   cost.
2. **Volatility-matched passive:** buy-and-hold of the strategy's natural passive
   counterpart (SPY for equity strategies; the equal-weight buy-and-hold of the
   strategy's own universe for ETF strategies), scaled to the strategy's
   realized volatility with cash (no leverage: scale at most 1, so the comparison
   is at matched volatility by de-risking whichever is riskier).
3. **60/40:** SPY and IEF rebalanced monthly, as a sanity reference.
4. **The same strategy without its model component** (paired): the deterministic
   graph for the link-component model twin, `event_ripple_rules` for a parked Event
   Ripple.
5. **The reference book** for the spanning test: the volatility-matched passive
   core plus every promoted strategy at its registered risk weight. Long-short
   strategies also report Fama-French five-factor plus momentum alpha.

A strategy that loses net of cost to cash, or fails the spanning test against the
reference book, is not promotable; the head-to-head result against the
volatility-matched passive benchmark is always reported. A model layer that
loses to its own no-model variant is removed, not tuned. The harness is checked
for regressions by replaying the committed fixtures, not by a retired strategy.

## Reflection and the research-factory loop

`execution.md` writes an auto-field reflection row per closed trade. On top of
that:

- Weekly, the research factory (`engine.md`) reads reflection rows, strategy
  tracking reports and `lessons.jsonl` and produces at most 3 hypothesis cards.
- Cards are queued for human review. They are not implemented, shadowed or
  costed until a human approves a pre-registration.
- The cap of 3 keeps the loop from generating work faster than a human can
  judge it.

## Done when

- The trial ledger is implemented; every harness run writes it, including
  failures; DSR and Holm read N from it.
- The statistics module has walk-forward purge and embargo, CPCV, PBO, DSR,
  MinTRL, stationary bootstrap and HAC Sharpe, each with fixture tests.
- The contamination guard rejects a model-involved evaluation window that starts
  before cutoff plus 30 days.
- Backtest-gate and shadow-gate report generators carry the spanning test and
  contamination-class labels.
- Controls are computed on every window.
- A challenger that breaches a risk rule is auto-disqualified in test.
- A promotion dry run produces a complete sign-off record and forces a fresh
  paper window.

## Decisions

- Every trial is ledgered; the ledger decides N. No ledger row, no result.
- Promotion requires forward-only, cost-inclusive, transferable, search-adjusted
  evidence, beaten controls and a human signature. No exceptions, no automation.
- Model evidence follows its contamination class: judgment class counts only
  after the model's knowledge cutoff plus an embargo.
- DSR, PBO and MinTRL are necessary, never sufficient.
- A model component must beat the same strategy without it (paired difference)
  or be removed rather than tuned.
- "Beats a control" alone is not proof of edge: promotion also needs the
  pre-registered absolute bar.
