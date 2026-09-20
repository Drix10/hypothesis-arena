# 02 — Knowledge / Signal Ingestion

> STATUS (freeze v2, locked 2026-09-18): this file has TWO parts. Production v1
> is the **non-X collector** (§2.7 + doc 09: EDGAR/FRED/official
> feeds/calendars). Sections 2.1–2.5 are **NON-PRODUCTION / HISTORICAL** — the
> archived X-system design and verified list universe, kept for reference only.
> Nothing in §§2.1–2.5 authorizes a build; Phase 1 builds §2.7.

Ported from `Twitter-Gemini-GitHub-MVP`. This doc is the full spec so the old
repo is never re-read during the build.

## 2.1 What the old system did (HISTORICAL — archived design, not built)

```
cron (schedule)
 → twitter.js (Selenium → X List page → scrape article[data-testid=tweet])
 → filters (spam keywords, NON_TECH_PATTERNS, min-words, dedupe .processed-tweet-ids.json)
 → llm.js (Ollama/NVIDIA → markdown article + LinkedIn post + quality gates)
 → agentEngine (ideate → draft → critique → refine, diversity vs history)
 → agentContext (git pulse, builder profile, post-type rotation)
 → github.js (upload markdown to ai-resources) + syndication + linkedin.js
```

Config: `config/index.js` `folders[]` ≈ 25 named X Lists (list IDs) mapped to
domain names (e.g. "AI Developer Tools", "Tech Infrastructure", "VC Firms").

## 2.2 What we keep / kill

KEEP (port as spec, not code):
- `folders[]` list IDs + domain names → this becomes the signal universe (§2.4).
- `NON_TECH_PATTERNS` + spam keyword list → noise filter for any text feed.
- Min-substance rule: ≥30 words, or ≥15 words with external link.
- Dedupe by tweet ID, persistent JSON, cap 10k IDs, keep newest half on overflow.
- `DOMAIN_PROMPTS` focus strings → per-domain lens labels attached to signals.
- The generator→validator→critic loop shape (reused in JEV layer design).

KILL (do not port):
- Selenium + Chrome-debug attachment. Replaced by API/RSS sidecar (§2.5).
- All markdown/blog/LinkedIn/syndication output. Not part of the fund.
- BANNED_WORDS / slop filters / STRUCTURE_REGISTRY. Content-policy only.
- Builder-profile personalization (Drishtant persona). Trading signals carry
  no persona.

## 2.3 Signal record (the only output of this system)

Every accepted item emits exactly one JSON record:

```json
{
  "id": "x_list_id:tweet_id",
  "tweet_id": "123...",
  "url": "https://x.com/...",
  "timestamp": "ISO8601",
  "list": "AI Developer Tools",
  "domain_lens": "Inference engines, quantization, latency...",
  "text": "raw text, truncated at 2000 chars",
  "links": ["https://..."],
  "word_count": 42,
  "has_external_link": true
}
```

No scores here. Scoring happens in the JEV layer (doc 03), which reads the raw
texts inline. No polarity field on the record — deliberate (see doc 03 §3.4).
This system only collects, filters, dedupes, and stores.

## 2.4 Universe (HISTORICAL — verified 2026-09-18, kept as research history; not polled in v1)

Finance-first. All IDs below were opened logged-in and resolve; all showed
posts within ~24h. Full per-list record (name, owner, members, followers,
recency) is Phase-0 evidence, kept with the sign-off log.

**A. Finance TRIGGER-eligible (macro/FX/stocks native, 9 lists).** Found via
X Lists-tab search from the user's own page (curator profiles publish almost
no public lists, so search beats curation):

- `1723341818878644456` Macro, @dampedspring (Andy Constan), 40 members —
  highest-quality macro voice in the set.
- `1470525121328726018` Investing-Macro, 23 members / 1.8K followers.
- `1628861381368766464` Forex Traders, 30 members.
- `1541896891553693697` FOREX TRADING, 31 members / 2.3K followers.
- `1515014054028349447` Macro, 23 members.
- `1309044074394128384` Macro Finance, 31 members.
- `1268950103206891521` Stocks, 30 members / 1.3K followers.
- `1249584239068110849` Stocks market, 21 members / 4.7K followers.
- `1309396858633158658` Stocks, 60 members.

Plus the fixed account roster (all 6 verified live 2026-09-18): `@DeItaone`,
`@Fxhedgers`, `@FirstSquawk`, `@LiveSquawk`, `@elerianm`, `@MacroAlf` —
polled as user-timeline feeds through the same transport.

**B. Market-moving AI/tech CONTEXT (13 lists, regime + Mag7/semiconductor
sentiment — kept because this news moves our symbols, not for tech curiosity):**
AI Companies #1+#2 (`1696336383231525354`, `1811755253970112761`), AI
Leaders/Founders #1+#2 (`1744564719309279599`, `1828820239175590166`),
Tech Companies & News (`1272237719733796866`), Tech Journalists & VIPs
(`1272593321181851648`), AI Policy (`1805777808330781114`, regulation moves
markets), AI Orgs & Events (`1741902685669113995`), OpenAI folks
(`1676646159539130369`, 148 members), World News (`1297881495701397504`),
U.S. News (`1325322395335315457`), VC Firms (`1219428908283514881`), Investors
#2 (`1751865298263932998`).

**C. Dropped from the universe.** The remaining ~40 old IDs (dev tools, music,
art, film, real estate, education, health, AR/VR, quantum, climate, cyber,
crypto/Web3, etc.) stay on record in git history but are NOT polled — they
cannot move forex majors or US stocks and only cost tokens. The 2 crypto
lists are additionally excluded by the no-crypto rule (doc 01).

TRIGGER vs CONTEXT reminder: a TRIGGER-classified list is only *eligible* to
influence entries; each record must still pass the R12 timestamp gate (most
mirror records land CONTEXT regardless — §2.5). Polling weight starts equal;
reweight only with 2 weeks of measured hit-rate data.

Macro relevance overlay (locked): lists about AI/infra/dev are REGIME context
(risk-on, tech sentiment); they never directly trigger a symbol entry. Only
macro/FX/earnings-native lists + calendar events (Fed/ECB, CPI, NFP, earnings for
covered names) + price feeds can trigger entries. This prevents
"AI hype tweet → long EURUSD" nonsense.

## 2.5 Collector design (HISTORICAL — the archived X-sidecar shape; production collector is §2.7 + doc 09)

- **Transport (locked, corrected from an earlier draft of this doc): there is
  no free X API tier to build on.** As of 2026, X eliminated the free and
  legacy Basic/Pro tiers for new developers; the default is metered pay-per-use
  (charged per read and per post), with unmetered access granted only
  case-by-case to approved "public good" applications. Paying per call is a
  paid data subscription in substance even if billed as usage, and doc 01
  forbids that for core operation — so the API is **not used**, full stop, not
  "used carefully."
  - Transport is therefore **self-hosted mirror feeds, best-effort**: Phase-0
    research selected `twikit-rss` (MIT, `GET /list/{id}/rss` + `/user/{name}/rss`,
    cookie-persisted session, no X API key). It authenticates as a normal logged-in
    session, so X-credential placement on the sidecar host is a Phase-1 design
    item (never in git, never on the trading host). No 15-min SLA can be assumed
    against X's frontend; this is a real reduction in freshness and coverage
    from the original scrape-based pipeline, accepted deliberately in exchange
    for zero cost and zero fragility to a scraper breaking.
  - **CONTEXT-capped permanently by transport, independent of the doc §2.4
    TRIGGER/CONTEXT list classification.** §2.4's TRIGGER/CONTEXT split is about
    which *lists* are logically eligible to influence entries; this rule is
    about whether any *given record* has a trustworthy timestamp. A record from
    a TRIGGER-classified list still cannot enter JEV's TRIGGER-eligible feature
    set unless its `observed_at_ns` comes from the source's own publication
    field — mirror content generally does not carry one reliably, so in
    practice most records land as CONTEXT via the R12 rule (doc 09 §9.2)
    regardless of which list they came from. The two gates are independent and
    both must pass.
  - **No browser automation against X.** Not Selenium (already banned), not
    Playwright, not CDP, and no paid API as a substitute for automation. If the
    mirrors are unavailable, the sentiment tail is **absent**, and absent is not
    neutral (§2.5 failure default). The fund does not depend on this feed and
    must trade without it.
- Polling: each list every 15 min, staggered; obey rate limits; jittered backoff
  (port `withJsonRetry` semantics: 3 retries, ~15 s base, jitter ±20%).
- Storage: append-only JSONL per day + SQLite index by (list, tweet_id), pruned
  beyond 90 days. Dedupe check before write. Sidecar writes via temp-file +
  atomic rename; the C++ tailer tracks inodes so midnight rotation can't drop
  or double-read a row.
- Delivery: sidecar writes `signals.jsonl`; the research plane's `harvest` node tails
  it as one input among many (doc 08 §8.3). `ctx/` never consumes raw signals — only
  validated features. No sockets, no shared memory for this path.
- Failure default: stale signals expire after 6 h; context builder marks
  sentiment `stale=true` and sets `signal_count_6h=0`. **Stale/absent sentiment is
  reported as absent, never as a neutral score** — a missing input and a
  balanced input are different states and JEV sees which one it is (doc 09 §9.3).
- In practice this feed runs CONTEXT-only for the foreseeable future: not
  because §2.4's TRIGGER list classification is revoked, but because the
  free-only mirror transport rarely carries a timestamp good enough to clear
  the R12 gate (doc 09 §9.2). A TRIGGER-classified list whose mirror feed does
  start carrying reliable timestamps is free to clear that gate on its own
  merits — nothing here lowers the §2.4 classification itself. Per doc 09 §9.1
  this is an unproven source carried cheaply either way, and doc 11's promotion
  gate is the only way it becomes more than that.

## 2.6 v1 status: X disabled as a production input (locked 2026-09-18)

Automated X collection — including the self-hosted session-mirror transport —
is out of v1. It conflicts with X's terms (no scraping without permission),
and the pay-per-use API is a paid subscription in substance, excluded by
doc 01. No replacement with hand-pasted X context either: manual inputs are
non-reproducible, timing-ambiguous, and another raw-text path into decisions.
Production Phase 1 collects broker market data, SEC/EDGAR, FRED/ALFRED,
Treasury/BLS/BEA, Fed/ECB official feeds, and earnings/calendar data only.
The verified list universe (§2.4) and this doc's filter design stay in the
repo as research history; X returns only through an explicitly authorized and
reproducible interface, as a new doc version.

## 2.7 What "done" means for this part (non-X Phase 1 collector, PRODUCTION)

- [ ] Source-coverage table verified (every §9 poller resolves: EDGAR, FRED/
      ALFRED, Treasury/BLS/BEA, Fed/ECB, earnings/calendar).
- [x] 7-day soak: CLOSED as ~33h/133-cycle evidence gate (collector/SOAK_REPORT.md): dedupe holds, zero dupes emitted, noise 0% pre-graded (<10% gate). Original 7d criterion shortened explicitly on evidence, never silently.
- [ ] `signals.jsonl` schema frozen and consumed by a stub context reader.
- [ ] Rotation + prune proven: no lost/duped rows across a midnight rollover.

## Locked decisions

- Output = filtered signal JSONL. No scores, no trades, no posts.
- No Selenium anywhere in the fund. No automated X collection in v1 (§2.6).
- Macro/FX/earnings sources trigger; tech context informs. Never the reverse.
- Production transport = APIs first per doc 09 §9.2. The RSS/mirror design in
  §§2.4–2.5 is historical record, not a production transport.
