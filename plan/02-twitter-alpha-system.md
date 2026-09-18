# 02 — Twitter Alpha System (knowledge / sentiment feed)

Ported from `Twitter-Gemini-GitHub-MVP`. This doc is the full spec so the old
repo is never re-read during the build.

## 2.1 What the old system did (all of it)

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

## 2.4 Universe (from old config — verify IDs before build)

Port the full `folders[]` table from `Twitter-Gemini-GitHub-MVP/config/index.js`.
Columns: domain name → list ID(s) → class (TRIGGER or CONTEXT) → polling weight.
TRIGGER lists are macro/FX/earnings-native and may place texts into JEV state; CONTEXT lists
inform regime only and never trigger entries (locked, §2.4 rule). Classification
is a Phase-0 exit item — every list gets a class before any build. Polling weight
starts equal; reweight only with 2 weeks of measured hit-rate data.

Macro relevance overlay (locked): lists about AI/infra/dev are REGIME context
(risk-on, tech sentiment); they never directly trigger a symbol entry. Only
macro/FX/earnings-native lists + calendar events (Fed/ECB, CPI, NFP, earnings for
covered names) + price feeds can trigger entries. This prevents
"AI hype tweet → long EURUSD" nonsense.

## 2.5 Collector design (sidecar, not C++)

- **Transport (locked, corrected from an earlier draft of this doc): there is
  no free X API tier to build on.** As of 2026, X eliminated the free and
  legacy Basic/Pro tiers for new developers; the default is metered pay-per-use
  (charged per read and per post), with unmetered access granted only
  case-by-case to approved "public good" applications. Paying per call is a
  paid data subscription in substance even if billed as usage, and doc 01
  forbids that for core operation — so the API is **not used**, full stop, not
  "used carefully."
  - Transport is therefore **public RSS/mirror feeds only, best-effort**, at
    whatever cadence the mirror publishes (no 15-min SLA can be assumed against
    a source we do not control). This is a real reduction in freshness and
    coverage from the original scrape-based pipeline, accepted deliberately in
    exchange for zero cost and zero fragility to a scraper breaking.
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

## 2.6 What "done" means for this part

- [ ] List-ID table verified (every ID resolves).
- [ ] 7-day soak: collector runs, dedupe holds, zero dupes emitted, noise sample
      manually graded <10% off-topic leakage.
- [ ] `signals.jsonl` schema frozen and consumed by a stub context reader.
- [ ] Rotation + prune proven: no lost/duped rows across a midnight rollover.

## Locked decisions

- Output = filtered signal JSONL. No scores, no trades, no posts.
- No Selenium anywhere in the fund.
- Macro/FX/earnings lists trigger; tech lists contextualize. Never the reverse.
- No X API of any kind — free tier does not exist as of 2026, and metered
  pay-per-use is a paid subscription in substance and is excluded by doc 01.
  Transport is public RSS/mirror only, timestamp-gated by R12 independently of
  list classification, no browser automation, and no dependency: the system
  trades normally with this feed entirely absent.
