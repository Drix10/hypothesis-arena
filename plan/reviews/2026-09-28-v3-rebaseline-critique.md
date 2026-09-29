# Full plan + codebase critique — input to freeze v3 ("alpha-first rebaseline")

Date: 2026-09-28. Scope: all 13 plan docs + `system-manifest.yaml`,
`TODO.md`, `ARCHITECTURE.md`, `README.md`, `AGENTS.md`, the tracked code
surface (collector, research plane, strategy track, C++ kernel incl. H1),
CI, and the S2/S5 evidence artifacts. Method: every doc read end to end;
claims checked against code and committed evidence; external facts
checked against primary or near-primary sources (list at the end). This
file is a HISTORICAL review record: it motivates the freeze-v3 edits, it
does not itself authorize anything. The authoritative plan is docs 00–13.

Operator instruction (2026-09-28, human): full authority to rewrite plans
and code; objective "the best AI hedge fund / HFT mix"; plan first, code
after; integrate what is useful from `anthropics/financial-services`.

---

## 0. Executive verdict

The project built an unusually rigorous *safety and audit* machine and
has not yet shown a single source of *edge*. Everything the plan relies
on for returns is either unproven or already measured negative:

| Claim in the plan | What the evidence in this repo says |
|---|---|
| "The primary edge is statistical" (doc 01, doc 09 §9.0) | `baseline_v1` S2 diagnostic ledger: 573 trades, win rate 1.4%, avg −0.049R, Sharpe −1.09 at 1× cost, −2.10 at 3×; primary (spread-eligible) ledger EMPTY because no quote data was fetched. |
| JEV filters candidates into profit (doc 03, doc 11) | S5 real-stream pipeline proof (stub answers): filtered Sharpe −2.69 / −1.49, economic bar FAIL, baseline artifact absent. No live JEV evidence exists at all. |
| "Trades forex + US stocks" (doc 01, README) | OANDA practice is BLOCKED for the India-resident operator; RBI's Liberalised Remittance Scheme prohibits remitting for margin trading and for trading foreign exchange abroad. Live forex spot and margin stocks are not a legal target for this operator. |
| G1 must be a forex major because of the $25k PDT rule (doc 10 §10.2) | Both premises are gone: forex is not legal live (above), and the SEC approved FINRA's elimination of the pattern-day-trader framework on 2026-04-14 (effective 2026-06-04, broker implementation deadline 2027-10-20). |
| Paper loop is close (README, TODO) | H1 router/runner/broker are built and audited through ~9 corrective rounds (runner ~1045 checks), but `kernel/runner/main.cpp` sets `deps.transport = nullptr`: there is no HTTPS/WebSocket transport, so the system has never placed one paper order. |

Diagnosis in one line: **the build optimized the probability that a
wrong trade is prevented, while the probability that a right trade exists
stayed unmeasured.** The fix is not less safety; it is (a) re-pointing
the effort at a measurable alpha pipeline, (b) re-scoping the venue and
instrument set to what the operator can legally trade, and (c) getting a
minimal legal strategy into the paper loop so evidence starts accruing.

---

## 1. Severity-ranked findings

Severity: S0 = invalidates the plan's objective; S1 = would produce wrong
decisions, illegal live operation, or unsound evidence; S2 = serious
inconsistency or process defect; S3 = hygiene.

### S0-1 No demonstrated alpha; the "permanent champion" loses money

- `baseline_v1` (doc 12) is hourly mean-reversion/momentum on ≤5 symbols
  with `exit_profile_v1` (stop 1.5×ATR(14) on **1 h** bars, TP 2R,
  same-session time exit for equities). TP distance ≈ 3 hourly ATRs must
  be covered within at most 6.5 h. Result: 464/573 exits by time (81%),
  8 wins. This is a **horizon/exit mismatch by construction**, not bad
  luck: the profile guarantees most trades become cost-paying random
  walks.
- Doc 11/12 make "beat baseline_v1" the bar for the AI layer. Beating a
  negative-Sharpe control is not evidence of anything. Doc 11's own
  locked note ("beats baseline alone is not edge proof") is correct but
  is not operationalized as a gate.
- The S2 dataset used the Alpaca **IEX** feed (≈ a few percent of
  consolidated volume) and no quotes, so spread eligibility was
  impossible. The free Alpaca plan serves **15-minute-delayed SIP**
  history (bars, trades, quotes); the blocker is self-inflicted.

### S0-2 The instrument/venue scope is not legal for the operator

- RBI LRS explicitly prohibits remittances for margin trading and for
  trading foreign exchange abroad (FEMA). Consequences for live stages:
  no forex spot/CFD, no margin account, therefore **no short selling and
  no leverage**; US-listed equities/ETFs in a **cash account**, long
  only, funded in USD within the $250k/FY LRS limit.
- Doc 05 §5.2 (forex ≤ 5×, stocks ≤ 2×), doc 10 G1 forex rule, doc 12
  forex universe, doc 04 `FXBrokerAdapter`, manifest `forex_paper:
  OANDA-v20-practice` all assume what cannot go live.
- Worse for evidence: any paper result produced with shorts, leverage,
  or FX spot is **non-transferable** to the only legal live book.
  Paper must be run under the live constraint set, or it is not
  promotion evidence.
- A cash account adds constraints the plan never models: T+1
  settlement, good-faith and free-riding violations (Reg T) — selling a
  position bought with unsettled funds, or buying with unsettled
  proceeds and selling before settlement, triggers 90-day restrictions.
  An intraday sleeve in a cash account needs a settled-cash ledger and
  alternating capital tranches.

### S0-3 "HFT" is not reachable; the plan is honest about it in doc 04 but
nowhere defines what *is* reachable

- HFT rents come from microsecond/nanosecond latency, colocation, direct
  exchange feeds and queue position (Budish–Cramton–Shim; Aquilina–
  Budish–O'Neill). This deployment has: internet REST (Alpaca trading
  API limit 200 requests/min/key), IEX-only real-time data on the free
  plan, PFOF-style retail routing, EDGAR polling at ≤10 req/s, and an
  India-to-US network path. Latency-arbitrage and news-reaction races
  (milliseconds) are lost before they start.
- What is reachable and evidence-backed: intraday (minutes–hours,
  e.g. market intraday momentum), daily/weekly (time-series and
  cross-sectional momentum on liquid ETFs), and event-driven multi-day
  horizons from EDGAR (insider purchases, earnings text). The C++
  sub-millisecond budget is still worth keeping — for determinism and
  reliability, not for alpha.

### S1-1 No transport: the paper loop cannot start

`kernel/runner/main.cpp`: `deps.transport = nullptr; // Phase 4 wires
live HTTPS`. The kernel has no TLS, no HTTP client, no WebSocket client,
and the "from scratch, no deps" rule makes writing TLS unthinkable. This
is the single hard engineering blocker to G0 and it is not a TODO box
anywhere. Decision required: link a vetted client (libcurl + system TLS)
behind the existing transport seam, or run a small broker-gateway
process (same `mirotrade` identity) that speaks the runner's shaped
observation protocol. Either is acceptable at latency tiers T2/T3.

### S1-2 LLM evidence is exposed to temporal contamination

Profit Mirage (2025), Look-Ahead-Bench (2026), Detecting Lookahead Bias
in LLM Forecasts (2025), HindsightBench (2026) and the agentic-trading
survey (2026) all show apparent LLM trading alpha largely dissolves once
the model's parametric knowledge of outcomes is controlled. The plan's
R12 guards *data* timestamps; nothing guards the *model's memory*. Any
backtest of an LLM-derived signal over periods before the model's
training cutoff is contaminated. Needed: pinned knowledge-cutoff per
research model, evaluation windows strictly after cutoff + embargo, and
forward shadow as the primary evidence for LLM sleeves.

### S1-3 Untrusted text meets code execution in the live research plane

Doc 08's `extract` node runs a smolagents `CodeAgent` (model-written
Python, network egress via proxy) over attacker-influenceable filings.
The Docker/egress hardening is real, but the attack surface is
unnecessary: the deterministic parser is already the authority and the
LLM output is advisory. The `anthropics/financial-services` managed-agent
cookbooks use a stricter pattern for exactly this case: the worker that
reads untrusted documents has **Read/Grep only, no code execution, no
connectors**, returns length-capped schema-validated JSON; a separate
critic re-verifies against trusted sources; exactly one worker holds
Write and never opens untrusted files. Adopt it; move code-writing agents
to the offline research factory, which only touches trusted local data.

### S1-4 Validation methodology has the right words but no trial ledger

Doc 11 names walk-forward, purging, Holm, search budgets, and correctly
warns that DSR/PBO alone do not protect against oracles. Missing: a
single append-only **trial ledger** that every backtest in the repo must
write to (so the search count N is a fact, not a declaration), minimum
track-record length, CPCV for model selection, capacity/participation
limits, post-publication decay haircuts (McLean–Pontiff: ≈58% average
decline), and a Harvey–Liu–Zhu-style t ≥ 3 bar for new factors.

### S1-5 Paper fill evidence cannot come from Alpaca paper alone

Alpaca's own docs: paper does not check order size against NBBO
quantity, randomly partial-fills 10% of eligible orders, ignores market
impact, queue position, price improvement, latency slippage, regulatory
fees, and **does not simulate dividends**. Alpaca paper is a plumbing
test; the research harness's own conservative fill model (plus SEC/TAF
fees and participation caps) must remain the evaluation authority.

### S1-6 Risk rules conflict with a long-only cash book

- R1 "max 2 in the same direction" makes a long-only book of more than
  two positions impossible.
- R2 "total exposure ≤ 75% notional/equity" is fine, but settled-cash
  availability is the binding constraint in a cash account and has no
  rule.
- R4 (flip lock) is inert long-only; harmless.
- Doc 05 §5.1a "conviction sizes: lean 5%, strong 10–15%, max up to 25%
  notional" directly contradicts doc 03 §3.3 (risk-budget sizing,
  conviction never authorizes size). Stale v1 text survived the v3 edit.
- `EXEC_UNIVERSE_MAX = 5` (kernel, manifest) caps a multi-sleeve book;
  fine for G0 if exactly one sleeve drives the kernel at a time.

### S2-1 Doc defects (garbled or contradictory text)

- Doc 05 "Degraded strategy modes": a sentence fragment ("(entries off,
  management on), EXIT_ONLY, HARD_STOP") dangles after the paragraph.
- Doc 10 §10.1: a sentence about DEMOTION_EVENT is spliced into the
  PROMOTION_MANIFEST field list; the section defines signed manifests
  and then says "One file, `STAGE`" as if the manifests did not exist.
- Doc 07 Phase 7: an orphan line ("intervention, every intervention
  that did occur logged…"). Phase 4 references "Baseline stats frozen for
  S3" (an old meaning of S3 now reused by the strategy track).
- Doc 00 numbers two entries "13.".
- Doc 05 D-rules out of order (D5 after D7); doc 03 §3.5 says JEV is
  called "4 calls/cycle" in doc 08 but "one batched call" in doc 03.
- Doc 08 §8.3b item 2 references "the `veto` question", retired in v3.
- ARCHITECTURE.md: "389 tracked files" (actual 544), "four jobs" (five),
  "stdlib FAILURE" (fixed in S7-B).

### S2-2 Plan docs carry implementation records

Doc 06 §6.1b (~300 lines of H1 crash-ordering detail) and doc 08 §8.4
(ledger digest internals) are implementation records, valuable but
misplaced: they bury the plan's decisions. Move them verbatim into
`plan/appendix/` and leave one-paragraph contracts in place.

### S2-3 Process imbalance

Round 1–9 audits, S7-A/B/C, and at least nine H1 corrective rounds have
been spent on control-plane robustness (for a research spend cap of
$150/30 d and a paper account) while S2 and S5 economic acceptance are
open and no strategy has positive evidence. Doc 06 already has an
"AUDIT STOP RULE"; it was not enforced against the H1 and S7 cascades.
The rebaseline adds an explicit **alpha-first** rule: engineering beyond
the current stage's needs is deferred until a sleeve passes its gate.

### S2-4 CI gaps

- `ci.yml` triggers only on push to `main` and on pull requests: feature
  branch pushes get no hosted evidence.
- `test_baseline.py`, `test_candidate.py` (needs pytest, not pinned),
  `test_jev_v4.py` and `kernel/tests/test_v4.cpp` are **not in CI**: the
  strategy track (S1/S3/S4) has no hosted regression guard.
- No secret scanning. The financial-services repo pins gitleaks by
  SHA-256 in CI; adopt it (and a pre-commit hook).
- Local-reproducibility: `freeze-check.sh` needs `xxd`; kernel
  chmod-000 checks cannot fail closed when run as root. Document or
  guard both.

### S2-5 Single-provider decision dependency

JEV is one pinned model at one provider via an **alpha** endpoint
(`/api/alpha/decisions`). The retirement runbook (doc 03 §3.5b) handles
a retirement cleanly, but the architecture makes JEV mandatory in the
kernel's decision path. With S5 showing no measured value, JEV should be
an optional, challenger-grade filter: the kernel needs a deterministic
**always-take** path (candidate → veto → size → exec) so the champion
never depends on a third-party alpha endpoint unless it proved its value.

### S3 hygiene

- `TODO.md` is 92 KB with single lines over 12,000 characters and a
  Latin-1 byte in an otherwise UTF-8 file: unusable as a work queue.
  Archive it, start a fresh ledger.
- `.env.example` and README say "do not add OANDA keys" while OANDA is
  blocked — say "never" and remove the path.
- The operator shared live credentials in a chat session on 2026-09-28:
  rotate every key (OpenRouter, FRED, BEA, Alpaca paper) regardless of
  the stated plan to rotate; never paste keys into sessions.

---

## 2. What is genuinely strong (keep, do not re-litigate)

- The one-way authority boundary: research emits typed features only;
  deterministic code owns every money decision; OS-user isolation.
- Candidate-bound contracts (c1 CID, JEV v4) — direction is never
  invented at the execution boundary.
- Fail-closed defaults everywhere; absent ≠ neutral; demotion automatic,
  promotion human.
- The spend governor (after the S7-C fixes) and the reservation model.
- Journal-before-order, broker-native protection, idempotent IDs,
  reconcile-first recovery (H1).
- R12 structural anti-lookahead for data; point-in-time universe
  requirement; stop-first/gap/censor label protocol; Holm over a pooled
  family; daily-return Sharpe; HOLD sampling with inverse-probability
  weights.
- `broker_compliance_policy` keyed by effective date: the PDT repeal is
  a data update, exactly as designed.

---

## 3. `anthropics/financial-services` — what transfers and what does not

Repo read at `574ed36`. It ships Cowork plugins and Claude Managed Agent
templates for banking, research, PE, fund admin and operations. Every
agent "drafts analyst work product for human sign-off" and never
executes transactions — philosophically aligned with our boundary.

Transfers (adopted in freeze v3):
1. **Three-tier untrusted-document isolation** (earnings-reviewer,
   kyc-screener, gl-reconciler cookbooks): reader tier (no code, no
   network, no connectors; capped, schema-validated JSON out), trusted
   orchestrator tier (read-only trusted connectors), single Write-holder
   that never opens untrusted files. → doc 08 reader tier.
2. **Independent critic re-verification** against trusted sources
   (gl-reconciler `critic`). → doc 08: critique becomes verification of
   extracted facts against XBRL/companyfacts/canonical records, not
   free-form adversarial prose.
3. **Harness-side schema validation** of worker output (`validate.py`)
   and **allowlisted, schema-validated handoffs** (`orchestrate.py`,
   including its warning that handoffs parsed from model text downstream
   of untrusted readers are an injection path). → doc 08 factory.
4. **Skills as versioned, file-based methods** with drift checks
   (`check.py`): research prompts become pinned skill files hashed into
   the model pin (D3). Methods reused as skill content:
   `thesis-tracker` (falsifiable thesis, pillars, explicit invalidation
   triggers), `catalyst-calendar` (event calendar), `earnings-analysis`
   (beat/miss vs guidance structure), `macro-rates-monitor` (curve
   slopes, real rates, breakevens — rebuilt on free FRED series),
   `fx-carry-trade` (carry and carry-to-vol — rebuilt on FRED rates +
   realized vol, research only).
5. **Secret scanning** (pinned gitleaks in CI). → CI item.

Does not transfer:
- All data connectors (FactSet, S&P/Kensho, LSEG, Morningstar, Moody's,
  PitchBook, Daloopa, Aiera, MT Newswires, Chronograph) are paid. The
  free-data rule excludes them for core operation.
- Banking/PE/fund-admin deliverable skills (pitch decks, CIMs, LBOs,
  NAV tie-outs) have no role in a systematic book.
- Managed Agents deployment is optional infrastructure; the research
  plane stays provider-agnostic behind the spend governor.

---

## 4. External evidence that shapes freeze v3 (summary)

- LLM trading claims: LiveTradeBench (50-day live, 21 LLMs): leaderboard
  strength does not imply trading results; CLQT/Profit Mirage: apparent
  agent alpha largely dissolves once look-ahead is controlled; agentic
  quant survey (2026): evidence gets less favorable moving from backtests
  to live and reliability-controlled tests.
- Where AI demonstrably helps in real funds: research throughput. Man
  Group's AlphaGPT proposes signals, writes the code, and backtests
  before humans see them; outputs then pass the same committee and
  thresholds as human research. That is the model for our research
  factory — not per-trade LLM decisions.
- LLM probability quality: ensembles of LLMs can match human crowds on
  binary forecasting (Science Advances 2024/25), single instruction-tuned
  models are overconfident. JEV's single-model calibration is a
  challenger question, not an assumption.
- Anomaly decay: ≈58% average post-publication decline (McLean–Pontiff);
  multiple-testing bar t ≥ 3 (Harvey–Liu–Zhu). PEAD: absent in large
  caps since ~2006 (Martineau) but contested by 2025 papers. Press-release
  text is as informative as the surprise for *announcement-day* returns
  (arXiv 2509.24254) — a window we cannot trade competitively. "Lazy
  Prices" (10-K text changes) failed a 2009–2026 free-data S&P 100
  replication. Time-series momentum post-crisis Sharpe broadly
  comparable to pre-2008 but with long flat spells (2009–2013) and alpha
  heavily dependent on volatility scaling. Market intraday momentum
  (first half-hour predicts last half-hour; JFE 2018) is documented
  through 2013; recent persistence must be re-tested on SIP data.
- Market structure/regulation: PDT framework eliminated (SEC approval
  2026-04-14, FINRA Rule 4210 amendment); cash-account good-faith and
  free-riding rules unchanged; US equity settlement T+1.
- Data: Alpaca Basic plan = real-time IEX + 15-min-delayed SIP history;
  paper-trading simulation limits as listed in S1-5.

---

## 5. Decisions carried into freeze v3 (see docs 00–13)

1. Objective restated: an AI-assisted **systematic multi-sleeve** fund
   whose AI earns its place in the research factory and in typed
   evidence extraction; the live path is deterministic.
2. Live scope = what the operator may legally trade: US-listed equities
   and ETFs, cash account, long only, 1× (doc 01, doc 05 R18/R19,
   doc 10 jurisdiction gate). Forex becomes research/shadow only
   (FRED rates + currency-ETF proxies). OANDA stays BLOCKED.
3. Paper evidence must be produced under the live constraint set
   (transferability rule, doc 11).
4. Strategy book (doc 02, legacy filename) with evidence-graded sleeves:
   ETF trend, ETF sector momentum, market intraday momentum, EDGAR
   insider purchases, EDGAR earnings reader (AI-assisted), macro risk
   overlay; FX carry/momentum research. `baseline_v1` stays frozen as a
   negative control with its failure diagnosed.
5. JEV becomes an optional, challenger-grade filter; the kernel gains an
   always-take path (doc 03/04/13).
6. Research plane splits into a live plane (reader-tier extraction, no
   code execution on untrusted text) and an offline research factory
   (agentic hypothesis → pre-registration → code → gated backtest →
   shadow), with a global trial ledger (doc 08, doc 11).
7. Validation adds temporal-contamination control for LLMs, trial
   ledger, CPCV/PBO/DSR as necessary-not-sufficient, MinTRL, decay
   haircut, t ≥ 3 for new factors, absolute economic bar vs cash and a
   vol-matched passive benchmark (doc 11, doc 12).
8. G0 splits into G0a (shadow paper on live data, harness fills, no
   broker orders — can start as soon as a sleeve passes its backtest
   gate) and G0b (kernel H1 + Alpaca paper orders). The 30-day G0→G1
   clock runs on G0b only (doc 07, doc 10).
9. Transport decision is a named P3.5 box (doc 13).
10. Alpha-first process rule; implementation records moved to
    `plan/appendix/`; TODO archived and rebuilt (doc 00, doc 07).
11. Spend caps, tier thresholds, anti-flap, cadence, R2 semantics, JEV
    v3/v4 contracts, f2, P3.1–P3.3 kernel contracts: **unchanged**.

---

## 6. Sources

- Profit Mirage: https://www.researchgate.net/publication/396373592
- Look-Ahead-Bench: https://ideas.repec.org/p/arx/papers/2601.13770.html
- Detecting Lookahead Bias in LLM Forecasts: https://ideas.repec.org/p/arx/papers/2512.23847.html
- HindsightBench: https://arxiv.org/pdf/2607.18867
- CLQT benchmark: https://arxiv.org/pdf/2606.29771
- LiveTradeBench: https://ideas.repec.org/p/arx/papers/2511.03628.html
- Agentic Quantitative Trading survey: https://arxiv.org/abs/2608.31041
- Man Group AlphaGPT: https://www.man.com/insights/what-ai-can-do-for-alpha ; https://www.hedgeweek.com/man-group-deploys-agentic-ai-for-quant-signal-discovery/
- TradingAgents: https://arxiv.org/abs/2412.20138
- Wisdom of the silicon crowd: https://www.science.org/doi/10.1126/sciadv.adp1528
- Lopez-Lira & Tang: https://arxiv.org/abs/2304.07619
- McLean & Pontiff: https://www.fmg.ac.uk/sites/default/files/2020-08/Jeffrey-Pontiff.pdf
- Harvey–Liu–Zhu / factor zoo context: https://link.springer.com/article/10.1007/s11573-021-01035-y
- Deflated Sharpe Ratio: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- Probability of Backtest Overfitting: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
- CPCV comparison: https://www.sciencedirect.com/science/article/abs/pii/S0950705124011110
- Martineau, RIP PEAD: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3111607
- PEAD revisited: https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again/
- Press-release structure: https://arxiv.org/abs/2509.24254
- Lazy Prices + free-data replication: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1658471 ; https://github.com/iqueipopg/lazy-prices
- Time-series momentum: https://www.sciencedirect.com/science/article/pii/S0304405X11002613 ; https://www.sciencedirect.com/science/article/abs/pii/S1386418116301379
- Market intraday momentum: https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351
- HFT arms race: https://academic.oup.com/qje/article/130/4/1547/1916146 ; https://academic.oup.com/qje/article/137/1/493/6368348
- PDT elimination: https://www.schwab.com/learn/story/sec-approves-scrapping-25000-day-trader-minimum ; https://www.sec.gov/files/rules/sro/finra/2026/34-105226.pdf
- Cash-account violations: https://www.schwab.com/learn/story/avoid-these-violations-when-trading-cash ; https://www.fidelity.com/learning-center/trading-investing/trading/avoiding-cash-trading-violations
- RBI LRS prohibitions: https://www.taxtmi.com/article/detailed?id=15845 ; https://www.business-standard.com/industry/banking/rbi-remittance-rules-2025-lrs-foreign-deposit-ban-outward-remittances-125061200438_1.html
- Alpaca for India residents: https://brokerchooser.com/broker-reviews/alpaca-trading-review/alpaca-trading-india ; https://alpaca.markets/support/countries-alpaca-is-available
- Alpaca market data plans: https://docs.alpaca.markets/us/docs/about-market-data-api
- Alpaca paper trading limits: https://docs.alpaca.markets/us/docs/paper-trading
- Alpaca API rate limit: https://alpaca.markets/support/usage-limit-api-calls
- anthropics/financial-services (read at 574ed36): https://github.com/anthropics/financial-services

Legal note: the jurisdiction statements above summarize public sources
for planning. They are not legal advice; the doc 10 LIVE JURISDICTION
GATE requires a qualified professional's written confirmation before G1.
