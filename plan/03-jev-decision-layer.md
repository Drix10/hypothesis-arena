# 03 — JEV Decision Layer

Model: `typesafe/jev-1.13` via `POST https://openrouter.ai/api/alpha/decisions`,
or direct TypeSafe. Endpoint, model string, and access are verified in Phase 0
before any build; the pinned string is written here and never floats (D3).
`jev-latest` or any floating alias is forbidden — a silent version change breaks
replay (D3) and invalidates every calibration curve in doc 11.
JEV writes no text. It answers typed questions about a `state` with calibrated
probabilities. Our code owns the workflow and acts on the answers.

## 3.1 The single call shape (locked, v3)

One Decisions call per trading cycle, 4 questions batched, state = frozen
context JSON (from C++ snapshot, serialized by the sidecar).

**Still exactly four questions — but v3 changes what two of them mean.** v2's
`analyst` (jim/ray/karen/quant personas) asked JEV to choose between evidence
producers that do not exist as separate producers, and its probabilities were
then misused as trade-success probabilities. v2's `veto` asked the model to
recompute what deterministic C++ already knows. Both semantics are retired.
`question_set_version = v3`; the v2 cases in §3.7 remain valid as table-logic
tests and were re-run, plus new v3 semantic cases.

- `enter` (noul): "Given this context, take this opportunity now?"
  - criteria.true: "Edge + timing align; risk within limits"
  - criteria.false: "Wait or stay flat; edge unclear or timing off"
- `edge_family` (choice): "Which strategy family does the evidence support?"
  - mean_reversion: z-score / distance from equilibrium / half-life, regime-compatible
  - momentum: trend / macro surprise / flow
  - macro: rates / central-bank / event-drift
  - execution: liquidity / spread only — never a directional reason alone;
    selecting it forbids risk-taking (table row 6)
  - These probabilities describe *family fit*, never trade-success probability.
    Nothing in this distribution may be read as P(trade wins).
- `conviction` (score): ["flat", "lean", "strong", "max"] — a bounded
  qualitative control. It gates budget tiers (§3.2) but cannot authorize size;
  sizing authority belongs to the risk engine alone.
- `latent_risk` (noul): "Material risk NOT captured by the deterministic engine?"
  - criteria.true: "Hidden risk likely — unflagged event, gap/overnight exposure,
    suspicious provenance, regime the engine is blind in"
  - criteria.false: "No latent risk seen"
  - Additive only: it can add a HOLD, never override a C++ rule, never enlarge risk.

Response fields used: `answers.enter.noul`, `answers.edge_family.choice`
(+`probabilities`, family-fit only), `answers.conviction.score`,
`answers.latent_risk.noul`.

## 3.2 Decision table (locked v3 — code implements exactly this)

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
  comparison alone never holds — see calibration semantics below)
enter.noul < 0.5              → HOLD (no edge)
enter 0.5–0.8 + (edge_family == execution
  OR conviction < strong)     → HOLD (mid-band needs strong directional)
edge_family == execution      → HOLD (liquidity-only evidence never directs risk)
conviction == flat            → HOLD
conviction == lean            → base risk budget (1×R)
conviction == strong          → base risk budget (1×R)
conviction == max + max-gate  → ELIGIBLE for elevated budget (engine decides,
  §3.3 — conviction nominates, never authorizes)
conviction == max, gate fails → downgrade to strong
```

`enter` bands: `>0.8` = act on any passing row; `0.5–0.8` = act only via the
mid-band row; `<0.5` = HOLD; exactly `0.5` belongs to mid-band. Sizes are
computed by the §3.3 hierarchy, capped by R2 and the stage multiplier.
Tune only with logged data, never intraday.

## 3.3 Sizing: risk budget first (locked v3)

Notional percentages do not size positions; risk does. Two equal notionals
with different stop distances are different trades, and the engine treats
them that way:

```
1. risk budget: R = 25bp equity (base). Elevated 2×R is granted SOLELY by
   the deterministic risk engine on independently validated conditions —
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

Size = min(steps 2–6). Conviction never appears in this hierarchy except
through the max-gate, which is necessary but not sufficient:

- max-gate (nomination only): `enter ≥ 0.8` AND `latent_risk ≤ 0.3` AND
  `calibration_gate == pass` AND `edge_family ≠ execution` AND `conviction == max`
  → the engine evaluates its independent conditions (step 1) for a 2×R grant.
  Conviction max is necessary but confers zero authority. Rationale: `pass`
  is required (not merely `≠ breach`) because `insufficient` means the
  evidence base is too thin to judge calibration — thin evidence must never
  authorize elevated risk. `insufficient` remains non-blocking for ordinary
  base-budget entry per R13 policy; only the 2×R multiplier demands `pass`.
- Anything else at `max` downgrades to strong (base budget).
- `edge_family` probabilities are family-fit evidence; they carry zero sizing
  weight. No analyst-distribution test survives from v2 — it confused
  "which view fits" with "the trade wins."

Exit profile v1 (frozen live profile; variants shadow-tested, never live-tuned):
stop 1.5×ATR(14) floored 0.1%, TP 2R, plus mandatory `time_exit` — calendar-aware
(E4): time_exit = actual exchange close − frozen exit buffer (30 min default),
from the validated IANA/exchange calendar, never a hard-coded clock time
(which is wrong on early closes). Forex max 24 h. Profile changes are versioned
(`exit_profile_v2`…) and need the doc-11 promotion path.

## 3.4 State contract v3 (what the sidecar sends)

JEV is a clean-room decision model: it receives validated structured evidence,
never raw external text. No signal texts, no thesis/critique prose cross into
the payload — those live in the research digest (doc 08) for human and
critique-node reading only. Schema validation proves shape, not truth (doc 08
§8.5); truth comes from evidence levels below.

```json
{
  "context_hash": "sha256 of canonical context",
  "symbol": "EURUSD",
  "price": 0, "spread_bps": 0, "session": "asia|london|new_york|us_open|closed",
  "indicators": {"rsi": 0, "zscore": 0, "atr": 0, "regime": "trend|range|volatile"},
  "features": [{"kind": "filing_event", "symbols": ["AAPL"],
                "value": {"type": "enum", "v": "8-K:item-2.02"},
                "effect": "bullish|bearish|risk_up|risk_down|neutral|unknown",
                "evidence": "source|derived|inference",
                "confidence_bucket": "low|medium|high",
                "age_s": 240, "source_id": "edgar_submissions"}],
  "source_status": {"edgar_submissions": "healthy|stale|failed|not_scheduled|unavailable|na"},
  "signal_buckets": {"trigger_6h": 3, "context_6h": 12},
  "portfolio": {"equity": 0, "exposure_pct": 0, "pending_exposure_pct": 0,
                 "open_positions": 0, "buying_power": 0},
  "disagreement": false,
  "event_window": {"blackout": false, "impact": "none|low|medium|high|binary",
                     "phase": "none|pre|blackout|post"},
  "calibration": {"enter_brier_200": 0.0,
    "vs_baseline": "better|equal|worse|insufficient",
    "gate": "pass|insufficient|breach"},
  "stage": "G0_PAPER|G1_TINY|G2_SCALED|G3_FULL",
  "research_revision": "epoch/bundle id",
  "risk_flags": {"deterministic_veto": false, "var_breach": false, "corr_breach": false}
}
```

State rules (locked v3):
- `features`: max 16 in payload (snapshot carries 64; newest TRIGGER/CONTEXT-
  eligible first). Enums, bools, counts, buckets only — no model floats.
- `effect` comes from a deterministic interpretation table per kind, never from
  model invention. `disagreement` is computed by C++: opposite TRIGGER effects
  (bullish vs bearish, or risk_up clash) on one symbol → true (R14).
- `evidence`: `source` = deterministic parser over a primary source (only these
  are TRIGGER-eligible); `derived` = deterministic transform of source facts;
  `inference` = model-produced, CONTEXT-only until a measured track record
  promotes the producing rule, never the individual claim.
- `confidence_bucket` is computed from provenance (source reliability ×
  timestamp quality × parser confidence × corroboration), never self-reported.
- `source_status` replaces the old absent-list: `failed`/`stale` (source down),
  `not_scheduled` (nothing expected — not a negative), `na` (irrelevant here).
- `event_window`: C++ maps (impact, phase) → `blackout` per the tier table
  (BINARY: pre+blackout; HIGH: blackout ± post; MEDIUM: entries need strong;
  LOW: no constraint). The table decides; JEV only sees the result.
  Frozen kernel reading (P3.5 Slice B): MEDIUM with an active phase HOLDs
  unconditionally at the veto — the frozen decision table cannot express
  "strong required", so the veto over-approximates fail-closed. Refining
  this needs a table-contract amendment, never a silent behavior change.
- No numeric sentiment score, no raw texts, no prose. If scored sentiment is
  ever wanted, it arrives as a new versioned question, not a smuggled float.

## 3.5 Caching, failure, determinism (locked v3)

Two layers — research is cached, decisions are re-issued. A slow contextual
key alone can bless a stale answer for a moved market (same regime bucket,
different price/spread/z-score), so the answer is bound to a decision
fingerprint instead:

- `research_key` = `symbol ‖ regime ‖ research_revision ‖ feature-ID set ‖
  question_set_version`. TTL 5 min. Busts on any new contradicting feature.
- `decision_key` = sha256_hex of `|`-joined (exactly, frozen sidecar recipe):
  `symbol | snapshot_epoch | price_return_bucket | spread_bps | atr_bucket |
  zscore | regime | event phase | exposure_pct | feature_revision |
  research_revision | question_set_version`, where `spread_bps`, `zscore`,
  and `exposure_pct` enter RAW (not bucketed — the "bucket" wording in
drafts was wrong), `feature_revision = sha256_hex(comma-joined sorted
  feature-ID set)`, and the join delimiter is the single ASCII pipe `|`
  (feature_revision's inner delimiter is the comma). Deterministic and
distinct from the research-epoch `research_revision`. Do not reword this
  recipe: the C++ kernel recomputes it field-for-field (P3.1 check 21).
- A cached answer is usable only if the decision_key is still compatible AND
  answer age ≤ 60 s AND no protected state (stage, HALT, R-flags) changed.
  Otherwise the sidecar re-issues the call — JEV answers are cheap, stale
  answers are expensive.
- Spend safety is two-layered (units resolved — the frozen doc named a number
  without units, so this amendment fixes the interpretation; ratify by review):
  (a) **rate ceiling: 5000 provider calls/day** (alert at 2500) — an emergency
  brake on runaway call loops, not a money cap. Every `post()` invocation
  counts, including timeouts/500s/malformed (retry storms are exactly what the
  brake is for); (b) **money governance from doc 10**: true date-based
  rolling-30d USD (files outside `[today-29d, today]` ignored) vs the stage
  absolute cap ($150 G0/G1, $400 G2, $1000 G3) — breach halts JEV calls
  (`spend-stage-cap`) while exits/reconcile stay live. Unknown stage values
  HOLD as `invalid-stage` before any provider call — no default cap.
  USD at probe scale (~$1e-5/call) makes a $5000/day JEV money cap
  meaningless, which is why the call-count reading is the coherent one.
- JEV down / timeout (>10 s) / malformed response → exactly 1 retry after ~5 s,
  then HOLD + log `jev_error`. Every failure increments the S5 streak counter.
  Risk gates still run locally.
  AMBIGUOUS-TRANSPORT EXCEPTION (frozen, pass-5 durability rule): a timeout
  / reset / refused / DNS failure with NO provider response is ambiguous —
  the provider may have billed the POST before the transport died. Such a
  failure NEVER retries and NEVER refunds: the pre-call reservation stands
  as conservative spend, the governor trips (`ambiguous-transport` HOLD +
  `unknown_charges`), and a human reconciles against provider billing
  before the ledger is repaired. Only failures the provider demonstrably
  answered (HTTP error statuses, malformed bodies) retry once with a
  per-attempt refund. A blind retry after an ambiguous POST can
  double-spend; the $2 reservation protects the local ledger, not the
  external bill.
- UNKNOWN-COST EXCEPTION (frozen): a valid provider answer whose usage/cost
  cannot be reconciled (malformed/negative/non-finite/out-of-bound cost)
  is HOLD `unknown-cost` — NO answer enters the decision path. An unknown
  bill is unbounded by the reservation, so the absolute cap cannot bless
  it. The governor is poisoned for subsequent calls either way.
- SINGLE-FLIGHT (frozen): the spend lock covers cache-recheck → cap →
  reserve → call → settle, so one decision_key buys at most one provider
  call even with concurrent sidecars. The loser of a race serves the
  winner's cached artifact (CACHED) instead of calling again.
- Every call is cost-tagged `{stage, cycle_id, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category: decision}` (doc 10 §10.4).
  An untagged call is a build failure. Failed provider attempts are logged
  with `usd: unknown` — an explicitly unattributed attempt, never silent zero.
- Every answer is scored against realized outcomes, HOLDs included, per doc 11
  §11.1. Calibration semantics (P3.3-E, locked): `vs_baseline`
  (better|equal|worse|insufficient) is a descriptive comparison;
  `gate` (pass|insufficient|breach) is the deterministic control, where
  breach = worse by more than the 0.02 R13 margin over ≥20 realized outcomes.
  ONLY `gate == breach` HOLDs entries (and demotes per R13). A bare "worse"
  comparison never holds by itself.
- Redaction: logged state rows carry structured evidence only (no raw texts,
  no prose) and never API keys or tokens. Verified by grep before any log
  leaves the machine.
- `question_set_version` pinned in code. **Now `v3`** (analyst→edge_family,
  veto→latent_risk, clean-room state). Any criteria change bumps version,
  invalidates cache, logged in journal.
- Every cycle logs: context_hash, answers, probabilities, thresholds applied,
  final action. Replay test re-applies §3.2 to logged rows.

Determinism, split honestly: the remote model is not strongly deterministic
(provider routing, revisions, stochastic backends), so the plan claims only
what it can prove. **Decision determinism is guaranteed:** same logged
Snapshot + same logged AnswerSet + same code/version → identical risk/decision
result, always. **Model repeatability is measured:** same state → same answer
rate is tracked per §11.1, never asserted. Logged per call: model ID, model
revision, provider, question_set_version, prompt hash, state hash, response
hash. Replay never calls the remote model.

Answer authentication: the sidecar runs as a dedicated `mirojev` user (doc 08
§8.2) and Ed25519-signs every answer artifact. The single authoritative
AnswerSet schema (reconciling §3.5's field list with the implementation):
`schema_version | question_set_version | model | revision | provider |
symbol | snapshot_epoch | state_hash | decision_key | created_at |
expires_at (= created + 60 s) | answers`. `state_hash` is the canonical-state
name for §3.5's `snapshot_hash` — same value, one term. Expiry is signed into
the artifact so C++ verifies freshness without consulting Python's cache. C++ verifies before trusting; a bad signature is a HOLD +
alert, and a forged `answers.json` buys an attacker nothing past the
still-authoritative C++ risk layer.

## 3.5a JEVAnswerSetV3 boundary artifact (frozen — the C++ contract)

Python owns slowness (HTTP, retries, cache, signatures, cost); C++ owns
decisions. They meet only at this artifact. The adapter answers "what did
the frozen dependency say"; it never answers "how much should we trade".

```
JEVAnswerSetV3: schema_version | question_set_version=v3 |
  model | revision | provider | symbol | snapshot_epoch |
  state_hash | decision_key | created_at | expires_at (=created+60s) |
  answers | response_hash | signature
```

Frozen hash distinction (`state_hash` vs `context_hash`): `context_hash`
(kernel-owned, doc 04 `ctx/`) is the SHA-256 of the canonical frozen
Snapshot. `state_hash` is the SHA-256 of `canon()` over the FULL JEV
request state object — which embeds `context_hash` as one field alongside
the question set, indicators, portfolio view, and feature list. Different
inputs, different digests, different verifiers: the kernel checks the
Snapshot against `context_hash` and the exact bytes it sent to JEV against
`state_hash`. Either mismatch is HOLD (wrong snapshot vs wrong question
— the engine must not conflate them). Python computes `state_hash`; only
the kernel mints `context_hash`, epochs, and the executable universe.

C++ semantics for every malformed/stale answer (locked — each row is HOLD):

```
missing answer          → HOLD (jev_absent)
bad enum / shape        → HOLD (jev_malformed)
bad signature           → HOLD (jev_unauthenticated) + alert
wrong revision/provider → HOLD (jev_contract_mismatch)
wrong state hash        → HOLD (jev_stale_state)
expired answer (>60 s)  → HOLD (jev_expired)
evidence == inference   → CONTEXT only, never trigger path
edge_family == execution→ cannot authorize risk (table row 6)
latent_risk > 0.5       → HOLD (additive)
```

Replay never calls the remote provider: snapshot + features + portfolio +
the logged AnswerSet re-enter C++ and must reproduce the decision bit-for-bit.
Same inputs + same AnswerSet → identical decision, even if the provider
disappears tomorrow.

## 3.6 What "done" means

- [x] `jev.py` sidecar: stdin state → 1 batched call → stdout answers + log row.
- [x] Threshold/table unit-tested with hand-worked cases (§3.7: 20 v2 cases
      re-run green under v3 + 8 new v3 semantic cases, 2026-09-18).
- [x] Cache + failure-path tests (timeout, 500, malformed → HOLD; stale
      decision_key → re-issue).
- [x] Replay of recorded AnswerSets with zero provider calls; decision
      determinism via signed artifacts (same Snapshot + AnswerSet → same input).
      (200-state distribution check deferred to paper window with live states.)

## 3.7 Hand-worked cases (v2 table-logic re-run + v3 semantics, 2026-09-18)

Cases 1–20 (v2) re-run green under the v3 table with renamed fields
(`analyst→edge_family`, `veto→latent_risk`); boundary pins 17–20 unchanged.
Notation: E = enter, F = edge_family, C = conviction, L = latent_risk.

| # | E | F | C | Flags | Expected |
|---|---|---|---|---|---|
| 21 | .90 | momentum | strong | L=.8 | HOLD latent risk (additive veto) |
| 22 | .88 | mean_reversion | strong | C++ deterministic veto (R2) | HOLD row 0, reason = engine |
| 23 | .85 | execution | strong | — | HOLD execution family never directs risk |
| 24 | .93 | macro | max | L=.1, calib better, gate | Elevated budget 2×R |
| 25 | .93 | macro | max | L=.4 | Downgrade strong (gate needs L≤.3) |
| 26 | .91 | momentum | max | calib breach | HOLD calibration (row above max) |
| 27 | .86 | mean_reversion | strong | opposite TRIGGER effects | HOLD disagreement |
| 28 | .89 | momentum | strong | BINARY pre-event blackout | HOLD blackout |

v3 rule proven by 24/25: conviction max is necessary but never sufficient —
it nominates, the engine's independently validated conditions authorize, and
the §3.3 hierarchy owns size. Family-fit probabilities carry zero sizing
weight, ever.

## Locked decisions

- Exactly these 4 questions in v3 (enter / edge_family / conviction /
  latent_risk). New questions need a version bump + fresh hand-worked cases.
- Research output enters as typed structured evidence only. No raw texts, no
  prose in JEV state; prose lives in the research digest (doc 08).
- Thresholds changed only between test windows, never live.
- JEV never sizes directly; it scores, the table gates, the risk engine sizes.
