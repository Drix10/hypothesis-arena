# 04 — C++ HFT Architecture

From scratch. No TS port. Two processes, one wire.

## 4.1 Topology

```
WEEX WS ──→ feed/ ──→ ctx/ ──→ snapshot ──┬──→ risk/ ──→ exec/ ──→ WEEX orders
                                           │
signals.jsonl (sidecar) ──────────────────┘
                                           └──→ jev sidecar (async, cached) ──→ answers ──→ risk/ (table 03 §3.2)
Gemini thesis (5-min, file) ───────────────┘
```

- `hft` (C++): feed, context snapshot, risk gates, execution. Owns the hot path.
- `sidecar/jev.py`: reads snapshot JSON, calls Decisions API, returns answers.
  Async: hot path uses last cached answers if fresh (<60 s), else HOLDs new
  entries but still manages exits locally.
- Thesis file: Gemini loop drops `thesis.json` every 5 min; context includes it
  verbatim or empty. Never blocks.

## 4.2 Modules (each = one directory, one responsibility)

1. `core/types.h` — `Side`, `Signal`, `Snapshot`, `AnswerSet`, `OrderIntent`,
   `Fill`. Plain structs, no logic. Risk numbers as `constexpr` (from doc 05).
2. `feed/weex_ws.cpp` — WS connect, subscribe orderbook+trades, lock-free ring
   buffer, sequence-gap detection, reconnect with backoff. No allocations hot path.
3. `ctx/context.cpp` — builds the frozen `Snapshot`: mark prices, indicator
   values (RSI/z-score/vwap ported from `TechnicalIndicatorService`), sentiment
   tail (last N signals + staleness flag), portfolio view, thesis text attach,
   `context_hash` (SHA-256 of canonical serialization).
4. `risk/veto.cpp` — pure functions `Snapshot+AnswerSet → HOLD/PROCEED + reason`.
   Implements doc 05 limits + doc 03 §3.2 table. No I/O, fully unit-tested.
5. `exec/router.cpp` — sizing (from conviction), stop calc (from leverage table),
   idempotent client-order-IDs (`hash(context_hash, attempt)`), retry-once,
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

## Locked decisions

- Two processes (C++ + Python sidecar), JSON over stdio/files. No gRPC in v1.
- Cached-JEV + local-risk. Network never gates an exit.
- Integer money, hashed snapshots, journal-before-order.
