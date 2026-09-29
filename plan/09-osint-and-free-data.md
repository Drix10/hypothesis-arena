# 09 — OSINT, Free Data, and Source Ranking (freeze v3)

Every source here is free at the tier we use it. Some require a free signup
key (marked 🔑). None require a paid subscription for core operation. If a
source starts charging, the system loses that feature and keeps trading —
no source is load-bearing except the broker feed and the session calendar.

## 9.0 The honest prior (read before adding a source)

Published evidence on LLM-driven trading is poor, and freeze v3 adds the
2025–2026 literature that explains why:

- A leakage-safe, search-aware evaluation rejected **every** LLM-discovered
  strategy tested (two frontier models, up to 100 candidates, 453 stocks +
  39 ETFs, realistic costs); a contrived oracle with Sharpe 35 passed
  conventional DSR and PBO tests — those tests do not protect you alone.
- An evidence map of 77 studies: of 19 primary empirical LLM-trading
  studies, 2 had time-consistent splits, 1 specified costs, 0 reproducible.
- (v3) Apparent LLM-agent alpha largely dissolves once look-ahead from the
  model's training data is controlled (Profit Mirage 2025; Look-Ahead-Bench
  2026; Detecting Lookahead Bias in LLM Forecasts 2025; HindsightBench
  2026). Live benchmarks (LiveTradeBench, 50 days, 21 LLMs) find general
  model rankings do not predict trading results; the 2026 agentic-trading
  survey finds evidence gets less favorable moving from backtests to live.
- Foreknowledge of news is not edge: participants given next-day *WSJ*
  headlines hit 51.5% and 45% lost money.
- Instruction-tuned LLMs are overconfident; post-training worsens
  calibration (ECE +13.1%, Brier +6.5% vs base models).
- (v3) Published anomalies decay ≈58% after publication (McLean–Pontiff);
  new factors need t ≥ 3 (Harvey–Liu–Zhu).
- (v3) Where AI demonstrably helps real funds is research throughput
  (agentic signal proposal + coding + backtesting, then human committee),
  not per-trade discretion.

Consequences, baked into this plan:
1. **No source is assumed to have edge.** Every non-price source enters as
   CONTEXT/NULL and is promoted only by *incremental* edge over what the
   sleeves already know, net of cost, over a full paper window,
   human-reviewed (doc 11). Standalone hit-rate is not evidence.
2. **Sleeves carry the edge hypothesis** (doc 02), each with its own data
   contract; sources serve sleeves, not the other way round.
3. **Costs are modeled before edge is claimed** (`cost_v2`, doc 06 §6.0a).
   A 10 bp drag turns a 113%/yr gross path into 65%.
4. **LLM-derived evidence is time-honest** (doc 11 §11.0c).

## 9.1 Ranking (locked classes; weights tuned only per doc 11)

`TRIGGER` = may place a feature that can lead to an entry · `CONTEXT` =
informs only, never triggers · `NULL` = declared null hypothesis, measured,
never used until promoted.

**S6 status (RELEASED):** `event_direction_v1` is a deterministic
interpretation/carry layer: CONTEXT-only, unknown on ambiguity or unmapped
input, never a TRIGGER promotion; production integration only via doc 11.

### Tier A — real, usable, TRIGGER-eligible (or veto-side)

| Source | Gives | Latency / cadence | Cost | Class | Role | Failure default |
|---|---|---|---|---|---|---|
| Alpaca market data — real-time IEX | Quotes/trades/bars (IEX venue only; quotes can be wider than NBBO) | streaming | free w/ account | TRIGGER (order pricing + staleness/spread vetoes) | Order pricing, liveness | stale > 30 s → entries vetoed |
| Alpaca market data — SIP history (v3) | Consolidated bars/trades/quotes, ≥ 15 min delayed | on request | free (Basic plan) | TRIGGER (sleeve signals) | Every sleeve signal + backtest + `cost_v2` spreads | Missing bar → signal UNAVAILABLE → HOLD |
| Alpaca account/positions/orders | Account state, settled cash, fills | streaming + REST | free | authority for execution state | Reconcile, settlement ledger | outage → entries stop (S9) |
| **SEC EDGAR** submissions + XBRL `companyfacts`/`frames` + filing index | 8-K (incl. item 2.02 + EX-99.1), 10-Q/10-K, **Form 4** (XML), fundamentals | submissions < 1 s; XBRL < 1 min | free, UA required | TRIGGER (equities) | E1/E2 sleeves; corporate events; earnings calendar | Source `stale` after 15 min → features expire |
| **FRED / ALFRED** 🔑 | Rates, curve, real yields, breakevens, credit spreads, NFCI, VIX close, FX rates, release calendar, **vintages** | per release | free | TRIGGER (macro) / CONTEXT (overlay research) | M1/M2 context, X1 research, calendars | Last known vintage, marked stale |
| US Treasury FiscalData, BLS, BEA 🔑(BEA) | Auctions, yields, CPI/NFP detail, GDP | per release | free | TRIGGER (macro) | Macro context, event calendar | as above |
| Exchange + venue session/holiday calendars | `session`, early closes, settlement days | static + updates | free | TRIGGER (veto side) | R9/R18 veto input. Load-bearing. | **Missing calendar = no entries.** |
| Earnings calendar (EDGAR-derived) | Scheduled event risk | daily | free | TRIGGER (veto side) | Suppress entries into known events | Unknown → event-present → no entry |

**HISTORICAL / NON-PRODUCTION (not Tier A, never TRIGGER-eligible in v1):**

| X-Lists tail (doc 02 history only; archive in `appendix/02-x-lists-archive.md`) | DISABLED in v1 (terms conflict, no authorized interface). | n/a | n/a | NULL in v1, no promotion path without a doc-01 scope change | Removed from production, not fought for. |

### Tier B — situational, event-driven, CONTEXT by default

These fire rarely and are worth carrying only because their rare firings are
large. Each is a *risk-off / exposure-reduction* input first and an entry input
never, until promoted.

| Source | Gives | Latency | Cost | Class | Honest assessment |
|---|---|---|---|---|---|
| **USGS earthquakes** (GEV) | Global M≥4.5, 24 h | ~minutes | free | CONTEXT | Only a major quake in a major economy moves JPY or an insurer. ~Handful of relevant events per year. Cheap to carry; may *block entries only* — OSINT never widens, narrows, or moves stops (stops are the frozen exit profile, doc 03 §3.3; any modifier needs its own proven profile). |
| **NASA FIRMS** active fires (GEV) | Fire detections, 24 h | ~3 h (satellite pass) | free 🔑 | CONTEXT | Utility/insurer tail risk (e.g. CA). 3 h latency means the market has already moved — this is a risk flag, never a trade trigger. |
| **Open-Meteo / NOAA** weather | Temps, storms, HDD/CDD | hourly | free, no key | CONTEXT | Real edge exists in nat-gas and ags — **neither is in our instrument set**. Carried only for storm-driven US utility/insurer risk-off. Low priority. |
| **Launch Library 2** (GEV) | Launch schedule/outcomes | daily | free | NULL | Relevant to a handful of space-adjacent tickers. Declared null; measured. |
| **Submarine cables** (GEV, static dataset) | Cable routes | static | free | NULL | A cable cut is a real telecom/LatAm event, but the bundled dataset is *static geometry* — it does not tell you a cable was cut. Useless without an outage feed. Carried as geometry for enrichment only. |
| Macro/geopolitical news via RSS (central banks, Treasury, exchange notices) | Official statements | seconds–minutes | free | TRIGGER (macro, official sources only) | Only *primary* sources. No aggregators, no "news sentiment" vendors. |

### Tier C — carried as declared nulls or excluded (the honest verdict on God's-Eye-View)

The brief asks to integrate the public sources behind *God's Eye View* as
structured features. Most of them have **no plausible edge for forex majors and
US-listed equities**, and saying so is more useful than pretending otherwise. The
integration is therefore: ingest cheaply, emit as `NULL`-class features, measure
hit-rate for one full paper window, and let doc 11 promote anything that earns it.
Expected promotions: approximately zero. That is a fine outcome — the measurement
is what makes it a decision instead of a hunch.

| Source | Why it does not trade our instruments |
|---|---|
| **AISStream** vessels 🔑 | Supply-chain alpha from AIS is real *in commodities, at satellite-AIS coverage*. The free tier is terrestrial: the project's own README states terrestrial AIS "goes quiet mid-ocean and satellite AIS costs real money." Port-congestion features built on coverage-gapped data are noise dressed as intelligence. NULL. |
| **OpenSky / adsb.lol** flights | Corporate-jet inference is famously low-signal and high-legal-risk; military ADS-B is a crude geopolitical risk-on/off proxy at best, and the loud events are already in the FX tape before the tracker resolves. NULL, and never person-linked (the upstream project explicitly refuses named-person features; we inherit that line). |
| **CelesTrak** satellite catalog | No transmission mechanism to EURUSD or AAPL. Excluded. |
| CCTV mesh, TomTom traffic, transit, bikeshare, radio, directions, basemaps | Visualization layers. No mechanism. Excluded. |
| Mapped military installations | Incomplete by the source's own admission. Excluded. |

**Locked:** no GEV-derived feature may be TRIGGER-class in v1. They enter as
CONTEXT or NULL only. The visualization layers are excluded outright — we take
the *sources*, never the globe.

### Tier D — public AI/agentic-trading systems (lessons, not signals)

A weekly agent job harvests publicly documented agentic trading systems (GitHub,
papers, X) and writes a *lessons* record — never a feature, never a signal.

Evidence bar, applied before anything is recorded:
- **Accept** only if: forward-only / time-consistent splits, stated transaction
  costs, out-of-sample window ≥ 1 full market cycle, and reproducible artifacts.
- **Record as hype** (and keep, as a negative example) anything reporting gross
  returns, in-sample Sharpe, sub-1-year windows, or no cost model.
- Mandatory both-sided extraction: every accepted item must yield a *pattern* and
  a *failure mode*. Known failure modes seeded at Phase 0: over-trading,
  size-on-losses, regime blindness, uncalibrated confidence, lookahead via
  publication timestamps, episodic-memory outcome leakage ("oracle fallacy"),
  crowding/alpha decay, and evaluating gross of costs.
- Output: `research-home/lessons/lessons.jsonl` — the offline research/evaluation
environment, NOT the trading tree. The research plane's only trading-tree
output stays `features.jsonl` (R11 exact, no exceptions). Reviewed weekly by
a human. A lesson can only ever become a
  code or threshold change through doc 11's promotion gate. **Lessons never reach
  the live decision path automatically.**

### Data license matrix (locked 2026-09-18, extended v3 — "free" is not a license)

| Source | Access | Commercial/auto use | Redistribution | Storage/derived |
|---|---|---|---|---|
| SEC EDGAR | free, no key, 10 req/s fair-access max | public filings; automated collection within fair access | no bulk resale; derived features ours | 90-day prune of raw; derived kept |
| FRED/ALFRED | free, key required | allowed with attribution; some series carry third-party copyright (e.g. ICE BofA indices) — check per series before use | no bulk redistribution | vintages kept for replay |
| Treasury/BLS/BEA/Fed/ECB | free | public data, automated use allowed | link, don't mirror | same prune |
| Alpaca market data (v3) | free with account (Basic) | per Alpaca data terms for account holders; re-verify before G1 | never | research datasets stay local, manifest-hashed; never committed |
| Broker account data | account required | per broker terms | never | journal keeps fills, not depth |
| USGS/FIRMS/Open-Meteo | free (FIRMS token) | allowed | attribution | same prune |
| X | EXCLUDED v1 | n/a | n/a | history only |

## 9.1a Research datasets (v3)

Every dataset used by a pre-registration is a manifest: source, endpoint,
query, time range, feed (`sip`), adjustment mode, row count, content hash,
fetch time. Runs name their manifest hashes; a run that cannot is void.

- **History limit:** the free Alpaca feed serves bars from 2016-01-04 only
  (about 10.6 years). Evidence on it covers one full cycle at most; a
  longer sample needs a second, manifested source before any sleeve is
  called robust.
- **SIP daily bars** for the doc 02 ETF universes (VTI, VEU, VNQ, IEF, DBC,
  BIL, SPY, QQQ, IWM, 9 SPDR sectors) — split-adjusted for signals,
  raw + dividends for total-return accounting.
- **SIP minute bars + quotes** for SPY/QQQ/IWM (I1) and for `cost_v2`
  spreads on every traded symbol.
- **Single-stock SIP daily bars** for E1/E2 event universes, filtered point
  in time from the bars themselves (price, dollar volume).
- **EDGAR Form 4 XML** (all filers, including since-delisted issuers) and
  **8-K item 2.02 + EX-99.1** with acceptance datetimes.
- **FRED series (initial set, research/context):** DGS3MO, DGS2, DGS10,
  T10Y2Y, T10Y3M, DFII10, T10YIE, BAA10Y, NFCI, VIXCLS, DTWEXBGS,
  FEDFUNDS; FX research (X1): DEXUSEU, DEXJPUS, DEXUSUK, DEXSZUS, DEXUSAL,
  DEXCAUS, DEXUSNZ, DEXSDUS, DEXNOUS plus OECD 3-month interbank rates.
  ALFRED vintages whenever a series is revised.
- **Corporate actions and dividends** from the broker's corporate-actions
  data where available, cross-checked against EDGAR 8-K; a symbol with an
  unresolved action is excluded for the affected window.

Data-quality rules (v3):
- **Survivorship:** the free feed may lack history for delisted symbols.
  Every run reports excluded-event counts; > 5% excluded voids an event
  sleeve run. ETF sleeves are chosen partly because this bias is minimal.
- **Point-in-time S&P-500 membership is not freely available**; no sleeve
  may depend on it (doc 12 §12.1). Universes come from ETFs, EDGAR filer
  lists, and point-in-time price/volume filters.
- **Signal vs execution data:** signals from SIP; IEX only for order
  pricing (doc 04 §4.1). A backtest never uses a price the live sleeve
  could not have had at its signal time.
- **Timestamps:** the timestamp a sleeve acts on is the source's
  availability time (EDGAR acceptance, FRED release time, bar close + 15
  min delay), never the period the data describes.

## 9.2 Ingestion rules (all sources)

- **Boundary law (same in README, 00, 04, 08, 09):** research feeds the hot
  path typed, validated, bounded features only (`features.jsonl`, bundle
  transactions). Research prose goes to `research_digest.jsonl`, outside the
  trading boundary — never into C++, never into JEV state.
- **Primary sources only.** If the regulator, the central bank, or the exchange
  publishes it, we read it there. Aggregators are excluded — they add latency and
  an unlogged editorial layer.
- **APIs first.** Playwright only where there is no API and the page is JS-heavy;
  authenticated CDP only where a login is unavoidable. No Selenium anywhere
  (doc 02, locked). Every browser-based source needs a named fallback, because
  browser scrapers break silently.
- **Provider limits are ceilings, not measurements.** "10 req/s" is SEC's
  published fair-access maximum; our operating rate, p50/p99 latency, and
  availability are MEASURED from this deployment and recorded in §9.4 —
  never assume the provider's number is our performance. Licensing
  ("free to access" ≠ "commercial automated use permitted") is rechecked
  per source before G1/G2, not once at freeze.
- **Polite by construction (measured, not assumed):** declared User-Agent with contact, per-source rate
  limiter, jittered backoff (3 retries, ~15 s base, ±20% jitter — same semantics
  as the archived doc 02 §2.5 — `appendix/02-x-lists-archive.md`), and an on-disk cache keyed by source ETag/Last-Modified. A 429
  halves that source's poll rate for an hour.
- **EDGAR specifics (LOCKED 2026-09-18):** UA `MiroHedge/phase0 contact=<human fills
  at build>`, hard ceiling 10 req/s (SEC limit), submissions JSON + companyfacts
  only — no full-text crawl beyond the filing index. Zero 403s over the observed
  ~33 h / 133-cycle soak (shortened from 7 d on evidence; collector/
  SOAK_REPORT.md) or the poller does not ship (§9.4).
- **Timestamps:** `observed_at_ns` comes from the source's own publication field
  when it exists; when it does not, the feature is marked `observed_at_estimated`
  and is CONTEXT-capped forever. Publication-time-vs-availability-time mismatch is
  a documented lookahead vector; an estimated timestamp never triggers a trade.
- **Storage:** append-only JSONL per source per day + SQLite index, pruned at 90
  days, atomic temp-file rename (the archived doc 02 §2.5 semantics — `appendix/02-x-lists-archive.md` — apply to every source).
  DURABLE-FIRST commit ordering (frozen, pass-5): the signals file is the
  commit point — fetch → parse → append+fsync → THEN persist ETag/
  Last-Modified validators → THEN advance schedule. A failed sink banks
  nothing downstream (next poll re-fetches with old validators: no 304
  masking the loss; PK-dedupe in classify absorbs redelivery). Post-commit
  metadata failures abort loudly (exit 2, audited repair) with the already
  durable signals kept valid. There is no filesystem transaction across
  three files; this ordering plus the recovery rule is the transaction.
- **Key handling:** free-tier keys (AISStream, FIRMS, FRED, TomTom) live in the
  research-plane user's env only. The trading user never sees them; the research
  user never sees broker credentials. Redaction verified by grep before any log
  leaves the machine (doc 03 §3.5).

## 9.3 Source health and failure defaults

- Each source has a declared TTL and heartbeat. Missed heartbeat > 3×
  cadence → `stale=true` → features expire → reported absent, never
  neutral. **Absent and neutral are never conflated.**
- A source failing > 50% of polls for 24 h is auto-disabled and alerted;
  re-enable is manual.
- **No source outage may block an exit.** Ever.
- The session/holiday calendar is the one fail-closed source.

## 9.4 What "done" means

- [ ] Every Tier A source has a working poller or fetcher, a TTL, a
      heartbeat, and a measured p50/p99 latency recorded here.
- [ ] EDGAR poller honors the UA requirement and rate limit (observed
      133-cycle soak, zero 403s — `collector/SOAK_REPORT.md`).
- [ ] ALFRED vintage path proven: a revised series replays with the
      original vintage for any historical decision.
- [ ] (v3) SIP bars + quotes fetcher with manifests; the S2 rerun uses it.
- [ ] (v3) Form 4 parser (transaction codes, reporter roles, 10b5-1 flag)
      with fixture tests; 8-K 2.02 + EX-99.1 locator with acceptance times.
- [ ] Every source classified TRIGGER / CONTEXT / NULL, no blanks.
- [ ] `lessons.jsonl` ≥ 10 graded entries, each with pattern + failure mode.
- [ ] Fail-closed calendar test: remove the calendar → zero entries, exits
      normal.

## Locked decisions

- Free tiers only for core operation. Load-bearing: broker feed + session
  calendar.
- Every non-price source starts CONTEXT or NULL; TRIGGER needs measured
  incremental edge + human sign-off (doc 11). Never automatic.
- Research datasets are manifest-hashed and never committed; SIP history
  for signals and costs; IEX real-time for order pricing only.
- No sleeve depends on data that is not freely available point in time.
- No God's-Eye-View layer is TRIGGER-class. Visualization layers excluded.
- Primary sources only; estimated timestamps permanently CONTEXT-capped.
- Public-system "lessons" are research-factory input, never a live signal.
