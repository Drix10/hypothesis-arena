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

No scores here. Scoring happens in the JEV layer (doc 03). This system only
collects, filters, dedupes, and stores.

## 2.4 Universe (from old config — verify IDs before build)

Port the full `folders[]` table from `Twitter-Gemini-GitHub-MVP/config/index.js`.
Columns: domain name → list ID(s) → polling weight. Polling weight starts equal;
reweight only with 2 weeks of measured hit-rate data. No vibes-based weighting.

Crypto relevance overlay (locked): lists about AI/infra/dev are REGIME context
(risk-on, tech sentiment); they never directly trigger a symbol entry. Only
crypto-native lists + price/liquidation feeds can trigger entries. This prevents
"AI hype tweet → long BTC" nonsense.

## 2.5 Collector design (sidecar, not C++)

- Transport: X API v2 (paid) if budget allows; else Nitter/RSS mirrors + manual
  list curation. Decision made in roadmap phase 0, documented here before build.
- Polling: each list every 15 min, staggered; obey rate limits; jittered backoff
  (port `withJsonRetry` semantics: 3 retries, ~15 s base, jitter ±20%).
- Storage: append-only JSONL per day + SQLite index by (list, tweet_id).
  Dedupe check before write.
- Delivery to C++: sidecar writes `signals.jsonl`; C++ context builder tails it.
  No sockets, no shared memory for this path — 15-min freshness doesn't need it.
- Failure default: stale signals expire after 6 h; context builder marks
  sentiment `stale=true`; JEV questions treat stale sentiment as neutral.

## 2.6 What "done" means for this part

- [ ] List-ID table verified (every ID resolves).
- [ ] 7-day soak: collector runs, dedupe holds, zero dupes emitted, noise sample
      manually graded <10% off-topic leakage.
- [ ] `signals.jsonl` schema frozen and consumed by a stub context reader.

## Locked decisions

- Output = filtered signal JSONL. No scores, no trades, no posts.
- No Selenium anywhere in the fund.
- Crypto lists trigger; tech lists contextualize. Never the reverse.
