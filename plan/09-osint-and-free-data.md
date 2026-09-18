# 09 — OSINT, Free Data, and Source Ranking

Every source here is free at the tier we use it. Some require a free signup key
(marked 🔑). None require a paid subscription for core operation. If a source
starts charging, the system loses that feature and keeps trading — no source is
load-bearing except the broker feed and the session calendar.

## 9.0 The honest prior (read before adding a source)

Published evidence on LLM-driven trading is bad, and the plan is built to assume
it is bad:

- A leakage-safe, search-aware evaluation rejected **every** LLM-discovered
  strategy tested — two frontier models, search budgets up to 100 candidates,
  five repeated runs, 453 stocks and 39 ETFs, realistic costs. A contrived oracle
  with Sharpe 35 passed conventional Deflated-Sharpe and PBO tests, so those tests
  do not protect you.
- An evidence map of 77 studies found that of 19 primary empirical LLM-trading
  studies, 2 reported time-consistent splits, 1 specified transaction costs, and
  **0** were reproducible.
- Foreknowledge of news is not edge: participants given next-day *WSJ* headlines
  achieved a 51.5% hit rate and 45% of them lost money.
- Instruction-tuned LLMs are measurably overconfident, and post-training makes
  calibration worse (ECE +13.1%, Brier +6.5% vs base models). Overconfidence does
  not go away with scale.

Consequences, baked into this plan rather than noted and ignored:
1. **No source is assumed to have edge.** Every non-price source enters as CONTEXT
   (doc 02 §2.4 semantics) and can only be promoted to TRIGGER by measured
   hit-rate over a full paper window, human-reviewed (doc 11).
2. **The statistical layer is the primary edge**, not the LLM. Indicators, regime
   detection, and the risk table do the work; JEV supplies a calibrated gate; the
   research plane supplies context and disconfirmation.
3. **Costs are modeled before edge is claimed.** A 10 bp execution drag turns a
   113%/yr gross path into 65%. Any source-derived signal is evaluated net of the
   paper fill model (doc 06 §6.5), never gross.

## 9.1 Ranking (locked classes; weights tuned only per doc 11)

**Class** is the doc 02 §2.4 contract, extended to all sources:
`TRIGGER` = may place a feature that can lead to an entry ·
`CONTEXT` = informs regime only, can never trigger an entry ·
`NULL` = carried as a declared null hypothesis, measured, never used in a decision
until promoted.

### Tier A — real, usable, TRIGGER-eligible

| Source | Gives | Latency / cadence | Cost | Class | Edge | Noise | Failure default |
|---|---|---|---|---|---|---|---|
| Broker feed (forex + US equities) | Quotes, trades, account state | ms–s, streaming | free w/ account | TRIGGER | The edge. Everything else decorates it. | low | doc 04 §4.2; stale >30 s → entries vetoed |
| **SEC EDGAR** submissions + XBRL `companyfacts`/`frames` + full-text search | 8-K/10-Q/10-K/Form 4 events, fundamentals | submissions <1 s processing delay; XBRL <1 min | free, UA header required | TRIGGER (equities) | Genuine, event-shaped, timestamped by the regulator — the cleanest free event source that exists | low | Source `stale` after 15 min → features expire |
| **FRED / ALFRED** | Rates, CPI, unemployment, release calendar, **vintages** | per release | free 🔑 | TRIGGER (macro) | Real macro state; ALFRED vintages give point-in-time correctness, which kills a whole leakage class | low | Last known vintage, marked stale |
| US Treasury *FiscalData*, BLS, BEA | Auctions, yields, CPI/NFP detail | per release | free | TRIGGER (macro) | Direct release data, no vendor interpretation | low | as above |
| Exchange + venue session/holiday calendars | `session`, PDT counting, early closes | static + updates | free | TRIGGER (veto side) | Not alpha — a hard veto input (R9). Load-bearing. | none | **Missing calendar = no entries.** Fail closed. |
| Earnings calendar (free tier / EDGAR-derived) | Scheduled event risk | daily | free | TRIGGER (veto side) | Used to *suppress* entries into known events, not to predict them | low | Unknown → treat as event-present → no entry |
| X-Lists sentiment tail (doc 02) | Text tail, TRIGGER-eligible lists | best-effort, mirror-dependent | free (RSS/mirror only — **no X API of any kind**; the free API tier does not exist as of 2026 and metered pay-per-use is excluded as a paid subscription, doc 02 §2.5) | per doc 02, R12-capped by transport | Unproven; kept because doc 02 already gates it hard | high | stale >6 h → **absent** (never neutral — doc 02 §2.5, doc 09 §9.3) |

### Tier B — situational, event-driven, CONTEXT by default

These fire rarely and are worth carrying only because their rare firings are
large. Each is a *risk-off / exposure-reduction* input first and an entry input
never, until promoted.

| Source | Gives | Latency | Cost | Class | Honest assessment |
|---|---|---|---|---|---|
| **USGS earthquakes** (GEV) | Global M≥4.5, 24 h | ~minutes | free | CONTEXT | Only a major quake in a major economy moves JPY or an insurer. ~Handful of relevant events per year. Cheap to carry; used to *widen stops / block entries*, not to enter. |
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
- Output: `lessons.jsonl`, human-reviewed weekly. A lesson can only ever become a
  code or threshold change through doc 11's promotion gate. **Lessons never reach
  the live decision path automatically.**

## 9.2 Ingestion rules (all sources)

- **Primary sources only.** If the regulator, the central bank, or the exchange
  publishes it, we read it there. Aggregators are excluded — they add latency and
  an unlogged editorial layer.
- **APIs first.** Playwright only where there is no API and the page is JS-heavy;
  authenticated CDP only where a login is unavoidable. No Selenium anywhere
  (doc 02, locked). Every browser-based source needs a named fallback, because
  browser scrapers break silently.
- **Polite by construction:** declared User-Agent with contact, per-source rate
  limiter, jittered backoff (3 retries, ~15 s base, ±20% jitter — same semantics
  as doc 02 §2.5), and an on-disk cache keyed by source ETag/Last-Modified. A 429
  halves that source's poll rate for an hour.
- **EDGAR specifics (LOCKED 2026-09-18):** UA `MiroHedge/phase0 contact=<human fills
  at build>`, hard ceiling 10 req/s (SEC limit), submissions JSON + companyfacts
  only — no full-text crawl beyond the filing index. Zero 403s over the 7-day
  soak or the poller does not ship (§9.4).
- **Timestamps:** `observed_at_ns` comes from the source's own publication field
  when it exists; when it does not, the feature is marked `observed_at_estimated`
  and is CONTEXT-capped forever. Publication-time-vs-availability-time mismatch is
  a documented lookahead vector; an estimated timestamp never triggers a trade.
- **Storage:** append-only JSONL per source per day + SQLite index, pruned at 90
  days, atomic temp-file rename (doc 02 §2.5 semantics apply to every source).
- **Key handling:** free-tier keys (AISStream, FIRMS, FRED, TomTom) live in the
  research-plane user's env only. The trading user never sees them; the research
  user never sees broker credentials. Redaction verified by grep before any log
  leaves the machine (doc 03 §3.5).

## 9.3 Source health and failure defaults

- Each source has a declared TTL and a heartbeat. Missed heartbeat > 3× cadence →
  `stale=true` → features expire → JEV state shows the source as absent, not as
  neutral-valued. **Absent and neutral are different and are never conflated.**
- A source failing > 50% of polls for 24 h is auto-disabled and alerted. Re-enable
  is manual (same friction as the HALT file, doc 06 §6.4).
- **No source outage may block an exit.** Ever. Exits are local (doc 06, locked).
- Session/holiday calendar is the one fail-closed source: unavailable → no entries.

## 9.4 What "done" means

- [ ] Every Tier A source has a working poller, a TTL, a heartbeat, and a measured
      p50/p99 latency recorded in this doc.
- [ ] EDGAR poller honors the UA requirement and rate limit; 7-day soak, zero 403s.
- [ ] ALFRED vintage path proven: a revised series replays with the *original*
      vintage for any historical decision.
- [ ] Every source classified TRIGGER / CONTEXT / NULL in the table above, with no
      blanks. (Phase-0 exit item.)
- [ ] `lessons.jsonl` has ≥ 10 entries, each with a pattern and a failure mode, and
      each graded accept/hype against §9.1 Tier D's bar.
- [ ] Fail-closed calendar test: remove the calendar → zero entries, exits normal.

## Locked decisions

- Free tiers only. No source is load-bearing except the broker feed and the
  session calendar.
- Every non-price source starts CONTEXT or NULL. Promotion to TRIGGER requires
  measured hit-rate + human sign-off (doc 11). Never automatic.
- No God's-Eye-View layer is TRIGGER-class in v1. Visualization layers excluded.
- Primary sources only; estimated timestamps are permanently CONTEXT-capped.
- Public-system "lessons" are review input, never a live signal.
