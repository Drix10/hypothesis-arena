# 03 - JEV Decision Layer

Model: `typesafe/jev-1.13` via `POST https://openrouter.ai/api/alpha/decisions`,
or direct TypeSafe. Endpoint, model string, and access are verified in Phase 0
before any build; the pinned string is written here and never floats (D3).
`jev-latest` or any floating alias is forbidden: a silent version change breaks
replay (D3) and invalidates every calibration curve in doc 11.
JEV writes no text. It answers typed questions about a `state` with calibrated
probabilities. Our code owns the workflow and acts on the answers.

## 3.0 JEV's role (read first)

JEV is an optional, challenger-grade filter, not a mandatory gate, because:

1. The only JEV evidence in the repo (S5 real-stream pipeline proof with
   stub answers) failed its economic bar; no live JEV value is measured.
2. JEV is a single pinned model at a single provider behind an alpha
   endpoint (`/api/alpha/decisions`). A champion path that cannot trade
   without it inherits that dependency with no proven benefit.
3. Single instruction-tuned models are overconfident; LLM ensembles can
   reach crowd-level forecasting accuracy. Calibration is tested, not assumed.

Consequences:
- The kernel carries a deterministic always-take path (doc 04 §4.2 4b):
  candidate c1 → veto (row 0 + R1-R19) → size → exec, no AnswerSet.
  The S5 paired design measures always-take against filtered.
- A sleeve's champion configuration names its filter policy explicitly:
  `filter = none | jev`. `jev` is admitted only after the doc 11
  paired-delta gate (filtered minus always-take, same candidates, net of
  JEV cost) passes with a pre-registered minimum effect.
- Challenger research may test a `jev` ensemble (N pinned models,
  aggregated deterministically) under its own contract tag and cost tag;
  it never replaces the pinned contract by edit.
- There is one contract, and it is candidate-bound: JEV evaluates an
  already-built candidate and never originates side, family or economics.
  It is implemented once per layer: the sidecar (`collector/jev.py`), the
  research evaluator (`research/strategy/jev_filter.py`) and the kernel
  (`kernel/jev_filter.hpp`), tied together by 32 committed cross-language
  vectors (`kernel/jev_vectors/`). The earlier state-based artifact is
  retired in the sidecar; the kernel's legacy validator for it is test-only
  and no decision path consults it.

## 3.1 The single call shape (locked)

One Decisions call per candidate, 4 questions batched. The state is the
candidate (exact CID strings) plus its market snapshot, serialized by the
sidecar.

Exactly four questions. `edge_family` asks which family the evidence fits;
its probabilities are family fit, never trade-success probability.
`latent_risk` asks only about risk the deterministic engine does not capture.
The contract tag inside every signed payload and decision key is
`contract = "jev"`.

- `enter` (noul): "Given this context, take this opportunity now?"
  - criteria.true: "Edge + timing align; risk within limits"
  - criteria.false: "Wait or stay flat; edge unclear or timing off"
- `edge_family` (choice): "Which strategy family does the evidence support?"
  - mean_reversion: z-score / distance from equilibrium / half-life, regime-compatible
  - momentum: trend / macro surprise / flow
  - macro: rates / central-bank / event-drift
  - execution: liquidity / spread only, never a directional reason alone;
    selecting it forbids risk-taking (table row 6)
  - Nothing in this distribution may be read as P(trade wins).
- `conviction` (score): ["flat", "lean", "strong", "max"], a bounded
  qualitative control. It gates budget tiers (§3.2) but cannot authorize size;
  sizing authority belongs to the risk engine alone.
- `latent_risk` (noul): "Material risk NOT captured by the deterministic engine?"
  - criteria.true: "Hidden risk likely - unflagged event, gap/overnight exposure,
    suspicious provenance, regime the engine is blind in"
  - criteria.false: "No latent risk seen"
  - Additive only: it can add a HOLD, never override a C++ rule, never enlarge risk.

Response fields used: `answers.enter.noul`, `answers.edge_family.choice`
(+`probabilities`, family fit only), `answers.conviction.score`,
`answers.latent_risk.noul`.

## 3.2 Decision table (locked - code implements exactly this)

Row 0 is the deterministic engine, not JEV. JEV rows follow; the first HOLD
wins and is the logged reason.

```
deterministic veto (C++ risk/: any R-breach, session closed,
  short/corp-action block, pending-risk breach) → HOLD (authoritative,
  not a model opinion)
latent_risk.noul > 0.5       → HOLD (additive hidden-risk veto)
disagreement == true          → HOLD (R14: opposite TRIGGER effects, §3.4)
event blackout active         → HOLD (C++-computed from impact+phase, §3.4)
calibration_gate == breach      → HOLD (deterministic R13 breach;
  comparison alone never holds - see calibration semantics below)
enter.noul < 0.5              → HOLD (no edge)
enter 0.5–0.8 + (edge_family == execution
  OR conviction < strong)     → HOLD (mid-band needs strong directional)
edge_family == execution      → HOLD (liquidity-only evidence never directs risk)
conviction == flat            → HOLD
conviction == lean            → base risk budget (1×R)
conviction == strong          → base risk budget (1×R)
conviction == max + max-gate  → ELIGIBLE for elevated budget (engine decides,
  §3.3 - conviction nominates, never authorizes)
conviction == max, gate fails → downgrade to strong
```

`enter` bands: `>0.8` = act on any passing row; `0.5–0.8` = act only via the
mid-band row; `<0.5` = HOLD; exactly `0.5` belongs to mid-band. Sizes are
computed by the §3.3 hierarchy, capped by R2 and the stage multiplier.
Tune only with logged data, never intraday.

## 3.3 Sizing: risk budget first (locked)

Risk sizes positions, not notional percentages: two equal notionals with
different stop distances are different trades.

```
1. risk budget: R = 25bp equity (base). Elevated 2×R is granted SOLELY by
   the deterministic risk engine on independently validated conditions -
   conviction never authorizes size, including here. Engine conditions (all
   observed/logged, none a model output except E/L as bounded inputs):
   enter ≥ 0.8 AND latent_risk ≤ 0.3 AND calibration_gate == pass AND
   edge_family ≠ execution AND conviction == max (necessary nominating input,
   not authority) AND no R6 vol trip AND exposure headroom under R2 AND no
   pending-risk breach. Any condition unmet → base budget (max downgrades
   to strong).
2. stop distance from exit_profile_v1 (doc 05): notional = budget / stop_dist
3. liquidity cap (spread/impact estimate; Phase-3 adapter refines)
4. portfolio caps: R2 notional, marginal-risk gate (Phase 3), pending-risk
5. stage multiplier (doc 10) applied last, before R2 re-check
6. round to valid broker units (adapter declares minima/steps)
```

Size = min(steps 2-6). Conviction enters the hierarchy only through the
max-gate, which is necessary but not sufficient:

- max-gate (nomination only): `enter ≥ 0.8` AND `latent_risk ≤ 0.3` AND
  `calibration_gate == pass` AND `edge_family ≠ execution` AND `conviction == max`
  → the engine evaluates its independent conditions (step 1) for a 2×R grant.
  Conviction max confers no authority. `pass` is required (not merely
  `≠ breach`) because `insufficient` means the evidence base is too thin to
  judge calibration, and thin evidence must never authorize elevated risk.
  `insufficient` stays non-blocking for ordinary base-budget entry per R13
  policy; only the 2×R multiplier demands `pass`.
- Anything else at `max` downgrades to strong (base budget).
- `edge_family` probabilities are family-fit evidence and carry zero sizing
  weight.

Exit profile v1 (frozen live profile; variants shadow-tested, never live-tuned):
stop 1.5×ATR(14) floored 0.1%, TP 2R, plus mandatory calendar-aware
`time_exit` (E4): time_exit = actual exchange close - frozen exit buffer
(30 min default), from the validated IANA/exchange calendar, never a
hard-coded clock time (wrong on early closes). Forex max 24 h. Profile
changes are versioned (`exit_profile_v2`...) and need the doc-11 promotion
path.

## 3.4 State contract (what the sidecar sends)

JEV receives one already-built candidate and its market snapshot, never raw
external text and never anything it could turn into a different trade. No
signal texts and no thesis/critique prose cross into the payload; those live
in the research digest (doc 08). Schema validation proves shape, not truth
(doc 08 §8.7).

```json
{
  "contract": "jev",
  "stage": "G0_PAPER|G1_TINY|G2_SCALED|G3_FULL",
  "cid": "sha256 of the twelve identity fields",
  "candidate": {"strategy_version": "...", "symbol": "VTI",
                "snapshot_ts_ns": "...", "proposed_side": "BUY",
                "proposed_family": "momentum", "entry_px": "100.00",
                "stop_px": "95.00", "tp_px": "110.00", "time_exit_ns": "...",
                "exit_profile_version": "...", "cost_model_version": "...",
                "feature_revision": "...", "cid": "..."},
  "symbol": "VTI",
  "feature_snapshot_hash": "1 to 256 chars, bound but not part of the cid",
  "snapshot_epoch": 1700000000,
  "price_s": "100.00", "spread_bps_s": "2.0",
  "session": "us_open", "regime": "trend"
}
```

State rules (locked):
- Every economic value travels as the exact string the cid was hashed over;
  C++ hashes the strings and parses them to doubles only for coherence
  checks (BUY needs stop < entry < TP, SELL the reverse). Floats are never
  re-rendered on the identity path.
- `stage` selects the spend cap and is not part of the decision key.
- Market fields the caller cannot measure are sent as the literal string
  `"unknown"`, never guessed.
- `edge_family` in the answer must equal the candidate's `proposed_family`:
  family fit cannot substitute a different strategy.
- A state carrying a non-finite number, a non-string market field or a cid
  that does not match its candidate fields is refused before any call.

## 3.5 Caching, failure, determinism (locked)

Research is cached; decisions are re-issued. A slow contextual key alone can
bless a stale answer for a moved market (same regime bucket, different
price/spread/z-score), so each answer is bound to a decision fingerprint:

- `decision_key` = sha256_hex of the `|`-joined exact strings
  `cid | symbol | snapshot_epoch | price_s | spread_bps_s | session |
  regime | feature_snapshot_hash | contract`. `cid` binds all twelve
  candidate identity fields (side, entry, stop, TP, time exit, sleeve,
  cost model and so on), so one candidate at one market snapshot buys at
  most one provider call. The C++ kernel and the Python evaluator recompute
  this field-for-field; do not reword it.
- A cached answer is usable only if the decision_key is still compatible AND
  answer age ≤ 60 s AND no protected state (stage, HALT, R-flags) changed.
  Otherwise the sidecar re-issues the call.
- Spend safety has two layers:
  (a) rate ceiling: 5000 provider calls/day (alert at 2500), an emergency
  brake on runaway call loops, not a money cap. Every `post()` invocation
  counts, including timeouts, 500s and malformed responses;
  (b) money governance from doc 10: true date-based rolling-30d USD (files
  outside `[today-29d, today]` ignored) against the stage absolute cap
  ($150 G0/G1, $400 G2, $1000 G3). A breach halts JEV calls
  (`spend-stage-cap`) while exits and reconcile stay live. Unknown stage
  values HOLD as `invalid-stage` before any provider call; there is no
  default cap.
  At probe scale (~$1e-5/call) a $5000/day money cap would be meaningless,
  so the ceiling in (a) is a call count.
- JEV down / timeout (>10 s) / malformed response → exactly 1 retry after ~5 s,
  then HOLD + log `jev_error`. Every failure increments the S5 streak counter.
  Risk gates still run locally.
  AMBIGUOUS-TRANSPORT EXCEPTION (frozen): a timeout, reset, refused or DNS
  failure with NO provider response is ambiguous, since the provider may
  have billed the POST before the transport died. Such a failure never
  retries and never refunds: the pre-call reservation stands as conservative
  spend, the governor trips (`ambiguous-transport` HOLD + `unknown_charges`),
  and a human reconciles against provider billing before the ledger is
  repaired. Only failures the provider demonstrably answered (HTTP error
  statuses, malformed bodies) retry once with a per-attempt refund. A blind
  retry after an ambiguous POST can double-spend; the $2 reservation
  protects the local ledger, not the external bill.
- UNKNOWN-COST EXCEPTION (frozen): a valid provider answer whose usage/cost
  cannot be reconciled (malformed, negative, non-finite or out-of-bound
  cost) is HOLD `unknown-cost`, and no answer enters the decision path. An
  unknown bill is unbounded by the reservation, so the absolute cap cannot
  bless it. The governor is poisoned for subsequent calls either way.
- SINGLE-FLIGHT (frozen): the spend lock covers cache-recheck → cap →
  reserve → call → settle, so one decision_key buys at most one provider
  call even with concurrent sidecars. The loser of a race serves the
  winner's cached artifact (CACHED) instead of calling again.
- Every call is cost-tagged `{stage, cycle_id, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category: decision}` (doc 10 §10.4).
  An untagged call is a build failure. Failed provider attempts are logged
  with `usd: unknown`, an explicitly unattributed attempt, never a silent zero.
- Every answer is scored against realized outcomes, HOLDs included, per doc 11
  §11.1. Calibration semantics (locked): `vs_baseline`
  (better|equal|worse|insufficient) is a descriptive comparison;
  `gate` (pass|insufficient|breach) is the deterministic control, where
  breach = worse by more than the 0.02 R13 margin over ≥20 realized outcomes.
  ONLY `gate == breach` HOLDs entries (and demotes per R13). A bare "worse"
  comparison never holds by itself.
- Redaction: logged state rows carry structured evidence only (no raw texts,
  no prose) and never API keys or tokens. Verified by grep before any log
  leaves the machine.
- `contract` is pinned in code (`collector/jev.py` `CONTRACT`). Any criteria
  change means a new contract tag, invalidates cache, and is logged in the
  journal.
- Every cycle logs: context_hash, answers, probabilities, thresholds applied,
  final action. A replay test re-applies §3.2 to logged rows.

Determinism, by layer: the remote model is not strongly deterministic
(provider routing, revisions, stochastic backends), so only the following is
claimed. Decision determinism is guaranteed: same logged Snapshot + same
logged AnswerSet + same code/version → identical risk/decision result.
Model repeatability is measured, not asserted: the same-state → same-answer
rate is tracked per §11.1. Logged per call: model ID, model revision,
provider, contract, prompt hash, decision key, response hash. Replay never
calls the remote model.

Answer authentication: the sidecar runs as a dedicated `mirojev` user (doc 08
§8.5) and Ed25519-signs every answer artifact. The single authoritative
AnswerSet schema:
`contract | model | revision | provider | cid | candidate | symbol |
feature_snapshot_hash | snapshot_epoch | price_s | spread_bps_s | session |
regime | decision_key | created_at | expires_at (= created + 60 s) | answers`.
`created_at` and `expires_at` are integer unix seconds; `answers` are flat
(`enter` and `latent_risk` floats in [0,1], `edge_family`, `conviction`).
Expiry is signed into the artifact so C++ verifies freshness without
consulting Python's cache. C++ verifies before trusting; a bad signature is
a HOLD + alert, and a forged `answers.json` buys an attacker nothing past
the still-authoritative C++ risk layer.

## 3.5a Answer boundary artifact (frozen - the C++ contract)

Python owns slowness (HTTP, retries, cache, signatures, cost); C++ owns
decisions. They meet only at this artifact. The adapter reports what the
frozen dependency said; it never says how much to trade.

```
answer artifact: { payload, response_hash, signature }
payload: contract | model | revision | provider | cid | candidate |
  symbol | feature_snapshot_hash | snapshot_epoch | price_s |
  spread_bps_s | session | regime | decision_key | created_at |
  expires_at (=created+60s) | answers
```

`response_hash` is the SHA-256 of `canon(payload)` and `signature` is
Ed25519 over the same bytes. The artifact carries no public key: the
verifier holds the trust anchor.
Kernel-owned values (expected cid, symbol and feature hash) come from the
engine, never from the artifact; a mismatch in any of them, or in the
recomputed `decision_key`, is a HOLD. `context_hash` (kernel Snapshot digest,
doc 04 §4.2 item 3) is not the JEV `state_hash` (digest of the full JEV
request state).

C++ semantics for every malformed/stale answer (locked; each row is HOLD):

```
missing / unparsable    → HOLD (absent)
bad enum / shape / type → HOLD (malformed)
bad signature           → HOLD (unauthenticated) + alert
wrong contract          → HOLD (contract_mismatch)
wrong candidate id      → HOLD (cid_mismatch)
economics / family /
feature / symbol drift  → HOLD (economics_binding | family_binding |
                                feature_binding | symbol_binding)
wrong decision key      → HOLD (decision_binding)
expired answer (>60 s)  → HOLD (expired)
edge_family == execution→ cannot authorize risk (table row 6)
latent_risk > 0.5       → HOLD (additive)
```

Replay never calls the remote provider: snapshot + features + portfolio +
the logged AnswerSet re-enter C++ and must reproduce the decision bit-for-bit,
even if the provider disappears.

## 3.5b Model retirement runbook (S7-B, governance - no JEV semantic change)

A deployed JEV configuration is identified exactly by the tuple
`model | revision | provider | contract`, matching the frozen names in
`collector/jev.py` (`MODEL`, `REVISION`, `PROVIDER`, `CONTRACT`), the answer
payload keys (`model`, `revision`, `provider`, `contract`), and
`plan/system-manifest.yaml` (`jev_model`, `jev_revision`,
`jev_provider_name`). The tuple is immutable per deployment: changing any
element retires one identity and introduces a different one. Retirement and
replacement are human operations; nothing here retires, switches, or
promotes automatically.

Lifecycle (who moves what, and what may still call):
- `active`: the pinned identity serves new provider calls.
- `retirement-declared` (human declares): the identity is drained. An
  already-valid cache artifact may still be served under the existing cache
  contract, but no new provider calls are issued for it. Expired, malformed,
  wrong-revision, wrong-provider, or otherwise wrong-binding cache is a MISS
  → HOLD, never a call and never a fallback model. Declaring retirement never
  redirects traffic to another model; a different model is a different
  identity, not a fallback.
- `retired`: the identity is never selected for new calls.
- `quarantined` (emergency path, human declares): immediate stop for that
  identity: no new calls, no fabricated fallback answer, while the
  deterministic engine (veto, exits, reconcile) stays live. The net effect is
  HOLD/fail-closed, never a silent switch.

The authoritative retirement record is human-owned and auditable: the exact
identity tuple, the state entered, the effective time, the human
signer/actor, and the reason/action. It is governance and deployment
authority, not LangGraph state and not model output. The mechanical cutover
for any retirement or replacement is: stop the provider process → write the
retirement record → verify the old identity cannot be selected → install and
verify the new identity → run freeze-check → restart. No in-process swap, no
automatic fallback.

Replacement is a new challenger under doc 11, never an inheritance: own
model/revision/provider metadata, own experiment identity, own cost/pricing
entry, own registry record, fresh paper window, and human promotion. It does
not inherit the retired identity's calibration, promotion status, or stage.

Replay preservation: retired identities' AnswerSets, response/state hashes,
signatures, cost records, and experiment artifacts are retained for replay
and audit. Replay stays local and never requires the retired provider to be
reachable. Identity and pricing history are not deleted when the model
retires (spend-side handling: doc 10 §10.4.3).

## 3.6 What "done" means

- [x] `jev.py` sidecar: stdin state → 1 batched call → stdout answers + log row.
- [x] Threshold/table unit-tested with hand-worked cases (§3.7).
- [x] Cache + failure-path tests (timeout, 500, malformed → HOLD; stale
      decision_key → re-issue).
- [x] Replay of recorded AnswerSets with zero provider calls; decision
      determinism via signed artifacts (same Snapshot + AnswerSet → same input).
      The 200-state distribution check is deferred to the paper window with
      live states.

## 3.7 Hand-worked cases (2026-09-18)

Cases 1-20 are the table-logic cases; boundary pins 17-20 fix the `enter`
band edges. Notation: E = enter, F = edge_family, C = conviction,
L = latent_risk.

| # | E | F | C | Flags | Expected |
|---|---|---|---|---|---|
| 21 | .90 | momentum | strong | L=.8 | HOLD latent risk (additive veto) |
| 22 | .88 | mean_reversion | strong | C++ deterministic veto (R2) | HOLD row 0, reason = engine |
| 23 | .85 | execution | strong | - | HOLD execution family never directs risk |
| 24 | .93 | macro | max | L=.1, calib better, gate | Elevated budget 2×R |
| 25 | .93 | macro | max | L=.4 | Downgrade strong (gate needs L≤.3) |
| 26 | .91 | momentum | max | calib breach | HOLD calibration (row above max) |
| 27 | .86 | mean_reversion | strong | opposite TRIGGER effects | HOLD disagreement |
| 28 | .89 | momentum | strong | BINARY pre-event blackout | HOLD blackout |
| 29 | .93 | macro | max | L=.1, calib pass, independent snapshot carries R2 pending-risk | HOLD joint-error (row 0; reason = engine-veto:pending-risk) |

Case 29 is the joint-JEV-error stress (gap-analysis B1, frozen). The artifact
is an adversarial optimistic answer proxy: all four answers jointly wrong in
the optimistic direction (high enter, favored family, max conviction, low
latent risk, clean calibration), while an independent snapshot/risk state
forbids the trade (R2 pending-risk: intent + pending exposure over the 75%
cap). The proof is about authorization independence, not about the recorded
answer being empirically wrong: no claim is made that the historical fixture
was miscalibrated (its own pending_exposure_pct is 0.0). The deterministic
engine stays authoritative: a correlated JEV failure creates no authorization
path the snapshot state would not permit, and the failure is observable as
HOLD with the coded deterministic reason. No new question, no version change,
no field reinterpretation. Two halves prove it: the Slice-B composed suite
detects a real pending-risk breach via EvaluateVeto, maps it via
BuildEngineInputs, and blocks the optimistic artifact; the filter vectors
prove a vetoed state authorizes nothing regardless of answers.

Cases 24/25 prove that conviction max is necessary but never sufficient: it
nominates, the engine's independently validated conditions authorize, and the
§3.3 hierarchy owns size. Family-fit probabilities carry zero sizing weight.

## Locked decisions

- Exactly these 4 questions (enter / edge_family / conviction /
  latent_risk). New questions need a new contract tag + fresh hand-worked
  cases.
- Research output enters as typed structured evidence only. No raw texts, no
  prose in JEV state; prose lives in the research digest (doc 08).
- Thresholds change only between test windows, never live.
- JEV never sizes directly; it scores, the table gates, the risk engine sizes.
- The contract is candidate-bound: side/family/entry/stop/TP/time-exit
  are inputs JEV evaluates, never outputs it invents. The label must match
  the actual candidate economics (entry/stop/TP/time-exit/costs/horizon as
  one event), not a detached ±R race.
- JEV is optional. The champion path is always-take unless a sleeve's
  pre-registered paired-delta gate admits `filter = jev` (§3.0, doc 11). No
  kernel path may require an AnswerSet to exit, and no champion may require
  one to enter unless that gate passed.
- Candidate sides follow the stage's constraint set: BUY-to-open or
  SELL-to-close under the India set; US set adds SELL-short-to-open and BUY-to-cover once
  the kernel implements R20 (doc 07 kernel short selling). For a short candidate the
  coherence check is TP < entry < stop.
- Artifacts carry model/revision/provider metadata (signed into the
  payload), and the C++ filter gate runs in `kernel/build.sh` and CI.
