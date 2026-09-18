# 04 — C++ HFT Architecture

From scratch. No TS port. Two processes, one wire.

## 4.1 Topology

```
Broker feed ──→ feed/ ──→ ctx/ ──→ snapshot ──┬──→ risk/ ──→ exec/ ──→ broker orders
                                           │
signals.jsonl (sidecar) ──────────────────┘
                                           └──→ jev sidecar (async, cached) ──→ answers ──→ risk/ (table 03 §3.2)
Gemini thesis (5-min, file) ───────────────┘
```

- `hft` (C++): feed, context snapshot, risk gates, execution. Owns the hot path.
- `sidecar/jev.py`: reads snapshot JSON, calls Decisions API, atomically writes
  `answers.json`. C++ holds answers in memory (never re-reads the file hot path).
  Stale/missing file (>60 s) → HOLD new entries; exits continue locally.
- Cadence: snapshot builds every tick; one decision cycle per symbol every 60 s,
  staggered. JEV is called at most once per symbol per cycle, and only on slow-key
  change or TTL expiry — not per tick.
- Watchlist ≤ 5 symbols in v1. More symbols = more JEV calls = cost without proof.
- Thesis file: Gemini loop drops `thesis.json` every 5 min; context includes it
  verbatim or empty. Never blocks.

## 4.2 Modules (each = one directory, one responsibility)

1. `core/types.h` — `Side`, `Signal`, `Snapshot`, `AnswerSet`, `OrderIntent`,
   `Fill`. Plain structs, no logic. Risk numbers as `constexpr` (from doc 05).
2. `feed/broker.cpp` — broker quote/trade stream (WS or poll, whichever the Phase-0
   venue supports), fixed lock-free ring (65536 ticks, overwrite-oldest + `gap=true`
   flag), sequence-gap detection, reconnect with backoff. REST client lives alongside
   for exits + reconcile only. Session-aware: marks snapshot `session=closed` outside
   venue hours; closed feed is normal, not an alert.
3. `ctx/context.cpp` — builds the frozen `Snapshot`: mark prices, spread, session,
   change, indicator values (RSI/z-score/VWAP/ATR ported from
   `TechnicalIndicatorService`), regime (ported `RegimeDetector`), sentiment tail
   (last N TRIGGER signals + staleness flag), VaR/correlation flags per doc 05 §5.1a,
   portfolio view, thesis text attach (fixed 512-byte buffer, missing/corrupt file
   → empty, never a crash), `context_hash` (SHA-256 of canonical serialization).
4. `risk/veto.cpp` — pure functions `Snapshot+AnswerSet → HOLD/PROCEED + reason`.
   Implements doc 05 limits + doc 03 §3.2 table. No I/O, fully unit-tested.
5. `exec/router.cpp` — sizing (from conviction), stop calc (from leverage table),
   idempotent client-order-IDs (`hash(context_hash, symbol, side)` — no attempt
   field; retries reuse the ID, see doc 06), retry-once,
   position reconcile vs broker every 15 min.
6. `log/journal.cpp` — append-only per-decision row + hash chain (prev_hash).
   Nothing trades without a journal row.

## 4.3 Data rules

- Snapshot isolation: decisions read the frozen snapshot, never live state.
- Nanosecond timestamps on snapshot + decision + order intent.
- Canonical serialization for hashing: fixed field order, fixed float precision
  (8 dp), UTF-8, no whitespace variance. Hash mismatch = bug, halt paper.
- No floats for money math in sizing: integer contracts/quote units; floats only
  for indicators.
- Resource rules (the anti-leak section): static allocation at startup; zero malloc
  on the tick path; ring buffer fixed size; SQLite lives in the sidecar only,
  pruned > 90 days; journal rolls daily, retained 90 days. A 24 h soak must show
  flat RSS or the build fails.

## 4.4 Latency budget (phase 1, local, excl. network/API)

| Stage | Budget |
|---|---|
| WS tick → ring buffer | < 20 µs |
| Snapshot build | < 200 µs |
| Risk veto (local) | < 50 µs |
| JEV answer read (cached) | < 100 µs |
| Order intent → socket | < 200 µs |
| **Total local** | **< 1 ms** |

JEV network call is NOT in the hot budget (async + cached). straw-man: entries
may use answers up to 60 s old; exits are always local and immediate.

## 4.5 What "done" means

- [ ] All 6 modules compile with `-Wall -Wextra -Werror`, zero warnings.
- [ ] Feed soak 24 h: zero unhandled gaps, reconnect proven by kill test.
- [ ] Snapshot hash stable: 10k identical inputs → 1 hash.
- [ ] Veto unit suite green (cases from doc 05).
- [ ] 24 h feed soak: flat RSS, zero unhandled gaps, reconnect proven by kill test.

## Locked decisions

- Two processes (C++ + Python sidecar), JSON over stdio/files. No gRPC in v1.
- Cached-JEV + local-risk. Network never gates an exit.
- Integer money, hashed snapshots, journal-before-order.
