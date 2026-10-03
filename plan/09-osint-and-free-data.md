# 09 - OSINT, Free Data, and Source Ranking

Every source used for core operation is free at the tier used; some need
a free signup key (KEY). Paid data enters only on the §9.1b trigger, for
research, never as a live dependency. If a source starts charging, the
system loses that feature and keeps trading; nothing is load-bearing
except the broker feed and the session calendar.

## 9.0 The prior (read before adding a source)

- Information diffusion across linked firms is documented and slow (doc 01
  §1.1). The data the fund needs is the data that reveals links and dated
  events: filings, ownership, news co-mentions, prices.
- End-to-end LLM trading evidence is poor: leakage-safe evaluations reject
  LLM-discovered strategies; most published LLM-trading studies lack
  time-consistent splits or costs; apparent alpha largely dissolves once
  look-ahead is controlled; live benchmarks find model rankings do not
  predict trading results. Headline-reading signals decayed as adoption
  rose (Lopez-Lira-Tang).
- Social media is polluted by coordinated inauthentic behavior and
  pump-and-dump bots; a signal built on it without corroboration trades
  phantom events.
- Published anomalies decay about 58% after publication (McLean-Pontiff);
  new factors need t ≥ 3 (Harvey-Liu-Zhu).

Consequences:
1. **No source is assumed to have edge.** Every non-price source enters as
   CONTEXT or NULL and is promoted only by incremental edge in a sleeve
   that pre-registered it (doc 11).
2. **Sleeves carry the edge hypothesis** (doc 02); sources serve sleeves.
3. **Costs are modeled before edge is claimed** (`cost_v3`, doc 14 §14.10).
4. **Model-derived evidence is contamination-controlled** (doc 11 §11.0c).

## 9.1 Ranking

`TRIGGER` = may feed a feature a sleeve acts on · `CONTEXT` = informs only ·
`NULL` = declared null hypothesis, measured, never used until promoted.

### Tier A - primary, TRIGGER-eligible (or veto-side)

| Source | Gives | Cadence | Cost | Role | Failure default |
|---|---|---|---|---|---|
| Alpaca real-time IEX | quotes/trades/bars (IEX venue only) | streaming | free w/ account | order pricing, staleness/spread vetoes | stale > 30 s → entries vetoed |
| Alpaca SIP history | consolidated bars/trades/quotes, ≥ 15 min delayed | on request | free (Basic) | every signal, backtest, `cost_v3` spreads | missing bar → signal UNAVAILABLE → HOLD |
| Alpaca account/positions/orders/assets | account state, settled cash, margin, `shortable`/`easy_to_borrow` flags | streaming + REST | free | execution authority, R18/R20 inputs | outage → entries stop (S9) |
| SEC EDGAR submissions, filing index, documents | 10-K/10-Q/8-K full text, exhibits, former names, acceptance times | < 1 s index | free, UA required | MLG `sc`/`tx` edges, events, L2 | source `stale` after 15 min → features expire |
| SEC EDGAR XBRL (`companyfacts`, financial-statement sets) | actuals, shares outstanding | per filing | free | SUE, point-in-time market cap | last value, marked stale |
| SEC EDGAR Form 4 / 13F | insider trades; quarterly institutional holdings | per filing / quarterly | free | MLG `ow` edges; insider events | as above |
| FRED/ALFRED KEY, Treasury, BLS, BEA KEY | rates, curve, credit, macro releases, vintages | per release | free | macro context, event calendar | last vintage, marked stale |
| Exchange session/holiday calendars | sessions, early closes, settlement days | static | free | R9/R18 veto input; load-bearing | missing calendar = no entries |
| Earnings calendar (EDGAR-derived) | scheduled event risk | daily | free | suppress entries into known events | unknown → event-present → no entry |

### Tier B - news and world events, CONTEXT by default

| Source | Gives | Cadence | Cost | Role |
|---|---|---|---|---|
| GDELT GKG 2.0 + Events | organizations, themes, tone and locations per article, worldwide, 100+ languages | 15 min | free; cite with link | MLG `nw` co-mention edges; `news_burst` events; event corroboration |
| Official RSS (Fed, Treasury, SEC press, exchange notices) | primary statements | minutes | free | macro and regulatory events |
| USGS earthquakes, OpenFEMA disaster declarations, NASA FIRMS KEY | dated disasters with locations | minutes-hours | free | corroboration for `disaster` events named in news; exogenous-shock tests (doc 14 §14.7) |
| FINRA equity short interest (twice monthly) and Reg SHO daily short volume | short interest, days to cover | per publication | free API (5 rolling years; older files downloadable) | R20 short-crowding filter; short-side diagnostics |
| GitHub public API | repository activity (stars, releases, commits) | hourly | free (rate-limited) | NULL: developer-activity bursts for software and AI firms, measured before any use |
| Wikipedia pageviews API | daily page views per firm | daily | free | NULL: attention measure (Focke-Ruenzi-Ungeheuer) |

A GDELT-derived feature is `derived` evidence about what the news says,
never about what happened. Firm-moving facts are confirmed against Tier A
before any TRIGGER use.

### Tier C - social media, quarantined

| Source | Access | Status |
|---|---|---|
| Bluesky (AT Protocol Jetstream) | free public WebSocket, ~850 MB/day of posts | NULL: cashtag and firm-name counts and buckets only |
| Reddit | API; commercial use needs a paid agreement | excluded until terms are verified in writing |
| X | official pay-per-use API ($0.005 per post read, $0.010 per user object, no free tier, 2026) | NULL: the `xcorr_v1` corroboration test only (§9.1c); the earlier X-lists signal system is HISTORICAL / NON-PRODUCTION (`appendix/02-x-lists-archive.md`) |

Quarantine rules (locked):
- A social signal never triggers alone. It may only attach to an existing
  Tier A or Tier B event as corroboration, as a count or bucket.
- Bot and manipulation filters run before counting: accounts younger than
  90 days, posting rates above the 99th percentile, near-duplicate text
  clusters (MinHash, Jaccard ≥ 0.8) and synchronized bursts from new
  accounts are dropped and counted.
- Firms below $500M market cap or $10M daily dollar volume are never
  scored from social data (pump-and-dump territory).
- Sentiment, where measured, comes from a pinned FinBERT model and is
  emitted as a bucket, never a float.
- Noise rules ported from the X-lists archive and the operator's earlier
  scraper (`twitter-gemini-github-mvp`, `src/services/twitter.js`): the
  off-topic pattern list (sports, fashion, celebrity, giveaway/airdrop,
  "comment YES" engagement bait, passive-income spam), the minimum-
  substance rule (≥ 30 words, or ≥ 15 words with an external link), and
  dedupe by post id with a capped set (10k ids, keep the newest half on
  overflow).

### Tier D - public AI-trading systems (lessons, not signals)

A weekly job harvests publicly documented AI-trading systems and papers
and writes `lessons.jsonl`, never a feature. Accepted only with
time-consistent splits, stated costs, an out-of-sample window of at least
one market cycle and reproducible artifacts; anything reporting gross
returns or in-sample Sharpe is recorded as a negative example. Every
accepted item yields a pattern and a failure mode.

### Excluded

Terrestrial AIS vessels, ADS-B flights, satellite catalogs, CCTV, traffic
and other visualization layers: no mechanism for our instruments, or
legal risk, or coverage gaps. Never person-linked features.

### Data license matrix ("free" is not a license)

| Source | Commercial/automated use | Redistribution | Storage |
|---|---|---|---|
| SEC EDGAR | public filings; automated within fair access (10 req/s) | no bulk resale; derived features ours | raw pruned at 90 days except the research corpus (manifest-hashed, local) |
| GDELT | free use including in products, with citation and link | cite GDELT | derived features kept; raw batches pruned at 90 days |
| FRED/ALFRED | allowed with attribution; some series carry third-party copyright (check per series) | no bulk redistribution | vintages kept |
| Treasury/BLS/BEA/Fed/USGS/OpenFEMA | public data | link, don't mirror | pruned at 90 days |
| Alpaca market data | per Alpaca data terms; re-verify before G1 | never | local, manifest-hashed, never committed |
| Ken French data library | free for research use | cite | local |
| Bluesky | public protocol data; respect user deletions | never | counts only; raw posts not retained |
| GitHub, Wikipedia pageviews | per API terms | cite | counts only |
| Third-party derived sets (e.g. published text-peer files) | per license, checked before use | per license | per license |
| X, Reddit | paid / excluded | n/a | n/a |

## 9.1a Research datasets

Every dataset used by a pre-registration is a manifest: source, endpoint,
query, time range, feed, adjustment mode, row count, content hash, fetch
time. Runs name their manifest hashes; a run that cannot is void.

- **SIP daily bars** (2016-01-04 onward on the free feed) for the
  universe, split-adjusted for signals and raw + dividends for total-return
  accounting; **SIP minute bars and quotes** for `cost_v3` spreads and the
  intraday/overnight split.
- **EDGAR corpus:** 10-K/10-Q/8-K full text since 1993, section-parsed,
  with acceptance datetimes; submissions and former names for CIK/ticker
  mapping; XBRL financial-statement sets (2009+); Form 4; 13F (2013 Q2+
  in XML).
- **GDELT GKG 2.0** (2015-02 onward) organization lists, aggregated to
  daily firm co-mention counts after entity resolution. The raw history is
  terabytes: the backfill streams one 15-minute file at a time, keeps only
  the firm-pair counts, and deletes the raw file; its download volume and
  run time are measured on one month before the full run (A15). Querying
  the BigQuery public copy instead must stay inside the free monthly
  query allowance, chunked by month.
- **Ken French data library:** daily FF5 + momentum factors and industry
  portfolios.
- **FRED series** for macro context; ALFRED vintages whenever a series is
  revised.
- **Corporate actions and dividends** from the broker's data, cross-checked
  against EDGAR; a symbol with an unresolved action is excluded for the
  affected window.

Data-quality rules:
- **Survivorship:** the free feed may lack history for delisted symbols.
  Every run reports excluded-event counts; more than 5% excluded voids an
  event or single-stock sleeve run.
- **Point-in-time S&P-500 membership is not freely available**; no sleeve
  depends on it (doc 12 §12.1). Universes come from point-in-time
  price/volume/market-cap filters over EDGAR filers.
- **Signal vs execution data:** signals from SIP; IEX only for order
  pricing. A backtest never uses a price the live sleeve could not have had
  at its signal time.
- **Timestamps:** the availability time (EDGAR acceptance, GDELT batch
  time, FRED release time, bar close + 15 min), never the period described.

## 9.1b Data phases

- **D1 (free, now):** everything in §9.1 Tier A/B and §9.1a.
- **D2 (paid, research only):** bought only on a written trigger, by an
  amendment to this section naming the trigger, dataset, license and cost:
  - survivorship-free US daily prices with delisting returns (late 1990s+,
    ≤ $100/month) when a sleeve's A-gate is void or underpowered for a data
    reason (excluded events > 5%, or history shorter than MinTRL) and its
    point estimate clears the haircut bar;
  - X pay-per-use reads for `xcorr_v1` (§9.1c), capped at $50/month,
    once `ripple_det_v1` candidates run forward and the test is
    pre-registered;
  - a news archive with entity tags only if the GDELT co-mention source
    passes edge validation (doc 14 §14.7) and its coverage is the binding
    limit.
  A failure with an economic cause never triggers D2.
- Live operation never depends on D2 data.

## 9.1c X corroboration test (`xcorr_v1`)

Question: does a bot-filtered burst of X posts about a firm, seen before
the decision, make a ripple candidate more likely to resolve in its
predicted direction? X is tested only as corroboration of an event that
already exists (doc 08 §8.3); it never creates an event or a candidate.

- **Acquisition:** the official X API only. The operator's Selenium
  scraper is not integrated: it automates a logged-in session (against X's
  terms and doc 01 §1.6), keeps no post archive and captures no author
  metadata. Its filters, record shape (`id, url, text, quoted_text,
  created_at, links`) and curated list ids are reused as specification.
- **What is read:** for each tested event, posts from the 24 hours before
  the decision time that mention the source firm's cashtag or resolved
  name, at most 50 posts per event, with author objects cached by id.
  Two strata are kept apart: open search, and the curated expert lists
  (`appendix/02-x-lists-archive.md` §2.4), which are human-chosen and carry
  little bot traffic.
- **Bot filter (before anything is counted):** drop posts from accounts
  younger than 90 days, with a default profile, with a follower/following
  ratio below 0.1 and more than 1,000 following, or posting more than 100
  times a day; drop near-duplicate text clusters (MinHash, Jaccard ≥ 0.8)
  and bursts where more than half the posts come from accounts created in
  the same 30-day window (coordination); apply the noise rules above. The
  share of posts removed is reported per event; an event where more than
  half were removed is tagged `manipulation_suspect` and counts as not
  corroborated.
- **Corroboration flag (deterministic, class A):** at least 10 surviving
  posts from at least 5 distinct accounts, and a surviving count at least
  3× the firm's trailing 30-day daily mean. The flag is a bool feature; no
  model reads post text in this test.
- **Design:** a filter test on `ripple_det_v1` candidates (and L3
  candidates once running), forward only, because no free point-in-time X
  history exists. Arm 1 = all candidates; arm 2 = candidates whose source
  event is corroborated. Judged as a doc 11 §11.3b filter: the corroborated
  arm's daily return beats all-candidates net of the X API cost, at the
  pre-registered minimum sample from a power analysis.
  `manipulation_suspect` events are scored as a third group: if they
  underperform, that is evidence for the bot filter's value.
- **Budget:** X lookups for the 3 largest events per day only, about
  $1.65/day (50 post reads + about 30 new author objects per event), under
  a $50/month D2 cap approved in the sign-off log. At that rate the test
  needs on the order of a year; a larger budget is a separate decision.
- **Storage:** raw posts are deleted after the counts are computed; only
  per-event counts, filter tallies and post ids are kept, and deletions
  requested through the API are honored.
- **Kill:** the filter fails at its minimum sample, or harms returns in the
  kill-only monitor → X is dropped and the spend stops.

## 9.2 Ingestion rules (all sources)

- **Boundary law:** the engine feeds the hot path typed, validated,
  bounded features only (`features.jsonl`, bundle transactions). Prose goes
  to `research_digest.jsonl`, outside the trading boundary.
- **Primary sources first.** If the regulator, central bank, exchange or
  company publishes it, it is read there. GDELT is used for what it is: a
  machine-readable index of what the world's news says, with links back.
- **APIs first.** Playwright only where there is no API and the page is
  JS-heavy; no Selenium anywhere. Every browser-based source needs a named
  fallback.
- **Provider limits are ceilings, not measurements.** Operating rate,
  p50/p99 latency and availability are measured from this deployment and
  recorded in §9.4. Licensing is rechecked per source before G1/G2.
- **Polite by construction:** declared User-Agent with contact, per-source
  rate limiter, jittered backoff (3 retries, ~15 s base, ±20% jitter), and
  an on-disk cache keyed by ETag/Last-Modified. A 429 halves that source's
  poll rate for an hour.
- **EDGAR specifics (locked):** UA `MiroHedge contact=<operator fills at
  build>`, hard ceiling 10 req/s (SEC limit). The poller reads submissions
  JSON, the filing index and companyfacts; filing documents are fetched
  per accession for the forms the engine parses (10-K, 10-Q, 8-K, Form 4,
  13F), within the same rate ceiling. Zero 403s over a soak or the fetcher
  does not ship (§9.4).
- **Timestamps:** `observed_at_ns` comes from the source's own publication
  field when it exists; otherwise the feature is marked
  `observed_at_estimated` and is CONTEXT-capped permanently.
- **Storage:** append-only JSONL per source per day + SQLite index, pruned
  at 90 days (research corpora excepted), atomic temp-file rename.
  DURABLE-FIRST commit ordering (frozen): the signals file is the
  commit point - fetch → parse → append+fsync → THEN persist ETag/
  Last-Modified validators → THEN advance schedule. A failed sink banks
  nothing downstream (next poll re-fetches with old validators: no 304
  masking the loss; PK-dedupe in classify absorbs redelivery). Post-commit
  metadata failures abort loudly (exit 2, audited repair) with the already
  durable signals kept valid. There is no filesystem transaction across
  three files; this ordering plus the recovery rule replaces one.
- **Key handling:** free-tier keys live in the engine user's environment
  only. The trading user never sees them; the engine user never sees broker
  credentials. Redaction verified by grep before any log leaves the machine.

## 9.3 Source health and failure defaults

- Each source has a declared TTL and heartbeat. Missed heartbeat > 3×
  cadence → `stale=true` → features expire → reported absent, never
  neutral.
- A source failing > 50% of polls for 24 h is auto-disabled and alerted;
  re-enable is manual.
- No source outage may block an exit.
- The session/holiday calendar is the one fail-closed source.

## 9.4 What "done" means

- [ ] Every Tier A source has a poller or fetcher, a TTL, a heartbeat, and
      a measured p50/p99 latency recorded here.
- [ ] EDGAR fetcher honors the UA requirement and rate limit (zero 403s
      over a soak).
- [ ] ALFRED vintage path proven: a revised series replays with the
      original vintage.
- [ ] SIP bars + quotes fetcher with manifests.
- [ ] EDGAR corpus: section parser for 10-K/10-Q with fixture tests;
      8-K item locator with acceptance times; 13F holdings parser.
- [ ] GDELT GKG daily co-mention aggregation with entity resolution and a
      measured resolution rate.
- [ ] Social quarantine filters proven on fixtures (bot clusters dropped,
      no social-only event reaches the brain).
- [ ] Every source classified TRIGGER / CONTEXT / NULL, no blanks.
- [ ] Fail-closed calendar test: remove the calendar → zero entries, exits
      normal.

## Locked decisions

- Free tiers for core operation. Load-bearing: broker feed + session
  calendar.
- Every non-price source starts CONTEXT or NULL; TRIGGER needs measured
  incremental edge in a pre-registered sleeve + human sign-off (doc 11).
- Social signals never trigger alone and pass bot filters first.
- Research datasets are manifest-hashed and never committed.
- No live signal depends on data that is not freely available point in
  time; D2 data only extends research history.
- Primary sources first; estimated timestamps permanently CONTEXT-capped.
- Public-system lessons are research-factory input, never a live signal.
