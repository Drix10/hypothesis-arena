# 04 — C++ Deterministic Core (low-latency execution, not HFT alpha)

The <1 ms local budget buys determinism and reliable execution, not market
latency advantage (venue feeds are seconds-scale). Nothing here assumes HFT
market-making capability.

From scratch. No TS port. Three processes, one direction of trust.

## 4.1 Topology

```
Broker feed ──→ feed/ ──→ ctx/ ──→ snapshot ──┬──→ risk/ ──→ exec/ ──→ broker orders
                                           │
signals.jsonl (sidecar) ──────────────────┤
features.jsonl (research plane, doc 08) ──┤   ← validated + bounded + TTL'd by ctx/
STAGE (human-signed, doc 10) ─────────────┤
                                           └──→ jev sidecar (async, cached) ──→ answers ──→ risk/ (table 03 §3.2)
```

- `hft` (C++): feed, context snapshot, risk gates, execution, kill switches, stage
  enforcement. Owns the hot path and owns every decision that can lose money.
- `research/` (Python, separate OS user, doc 08): writes `features.jsonl` and
  nothing else in this tree. No broker credentials, no journal write, no `HALT`
  write, no `STAGE` write. Enforced by filesystem permissions.
- Trust flows one way: research → ctx → risk → exec. Nothing downstream ever calls
  back upstream, and nothing upstream can relax a downstream rule.
- `sidecar/jev.py`: reads snapshot JSON, calls Decisions API, atomically writes
  `answers.json`. C++ holds answers in memory (never re-reads the file hot path).
  Stale/missing file (>60 s) → HOLD new entries; exits continue locally.
- Cadence: snapshot builds every tick; one decision cycle per symbol every 60 s,
  staggered. JEV is called at most once per symbol per cycle, and only on slow-key
  change or TTL expiry — not per tick.
- Watchlist ≤ 5 symbols in v1. More symbols = more JEV calls = cost without proof.
- Boundary law: `features.jsonl` is the ONLY research artifact that may cross
  into C++. `research_digest.jsonl`, thesis prose, critique prose, raw texts —
  never consumed, never attached, never snapshot material. `ctx/` rejects any
  row carrying text fields instead of consuming it (quarantine, alert, HOLD).
- Feature file: `features.jsonl` is tailed like `signals.jsonl` (same atomic
  rename + inode-tracking rules, doc 02 §2.5). Missing or stale beyond TTL → the
  features are **absent**, which is a distinct snapshot state from neutral.
- `STAGE` is re-read at each cycle boundary, its hash chain verified; an
  unverifiable chain forces G0_PAPER (doc 10 §10.1).

## 4.2 Modules (each = one directory, one responsibility)

1. `core/types.h` — `Side`, `Signal`, `Snapshot`, `AnswerSet`, `OrderIntent`,
   `Fill`. Plain structs, no logic. Risk numbers as `constexpr` (from doc 05).
2. `feed/broker.cpp` — broker quote/trade stream (WS or poll, whichever the Phase-0
   venue supports), fixed lock-free ring (65536 ticks, overwrite-oldest + `gap=true`
   flag), sequence-gap detection, reconnect with backoff. REST client lives alongside
   for exits + reconcile only. Session-aware: marks snapshot `session=closed` outside
   venue hours; closed feed is normal, not an alert.
2a. `ingest/features.cpp` — tails `features.jsonl`; validates schema version,
   bounds (≤64 retained, ≤16 into the JEV payload), enum/bucket types, and the
   **R12 timestamp rule**: drop anything with `observed_at_ns` in the future
   relative to the snapshot, or past its declared TTL. Rejections are counted;
   a rejection rate >5%/h is an alert. No allocation on the tick path — fixed
   arena, overwrite-oldest.
3. `ctx/context.cpp` — builds the frozen `Snapshot` (full intended
   shape; v1 contract below scopes the frozen subset): mark prices, spread, session,
   change, indicator values (RSI/z-score/VWAP/ATR ported from
   `TechnicalIndicatorService`), regime (ported `RegimeDetector`), sentiment tail
   signal buckets, VaR/correlation flags per doc 05 §5.1a,
   portfolio view (equity, exposure, pending, buying power), the last complete
   feature bundle from `ingest/` (never partials), per-source `source_status`,
   the current stage, research_revision, and the rolling
   calibration summary (doc 11), then `context_hash` (SHA-256 of canonical
   serialization over **all** of it — features included, or replay is a lie).
   No raw texts, no prose: the digest is not snapshot material.
   Frozen G Snapshot v1 contract (audit ruling 2026-09-24): IN: marks,
   session, indicators, regime, VaR/correlation flags, portfolio, last
   complete feature bundle, per-source source_status (frozen JEV
   vocabulary, doc 03 sec. 3.5: healthy|stale|failed|not_scheduled|
   unavailable|na), stage, research_revision, calibration summary.
   EXPLICITLY DEFERRED: `change` — no frozen numeric unit, reference
   point, or horizon exists, so v1 excludes it from the Snapshot and
   context_hash entirely; a future versioned contract must freeze
   representation, unit/scale, reference point, time horizon, and
   missing/invalid semantics first. H1 must not reconstruct or infer
   `change` from another field and must not treat its absence as zero.
   Also DEFERRED: sentiment/signal-bucket representation — doc 03
   forbids numeric sentiment scores; the future representation is the
   discrete `signal_buckets` concept (trigger_6h/context_6h) whose
   exact C++ typed schema is not yet frozen. Never substitute a
   numeric score. context_hash covers exactly the v1 IN set;
   absence is not zero.
   `context_hash` ≠ JEV `state_hash` (frozen distinction, doc 03 §3.5a):
   context_hash is the kernel's Snapshot digest; state_hash is the digest
   of the full JEV request state (which embeds context_hash as one field).
   C++ verifies both — Snapshot against context_hash, sent-state against
   state_hash — and either mismatch is HOLD.
4. `risk/veto.cpp` — pure functions `Snapshot+AnswerSet → HOLD/PROCEED + reason`.
   Implements doc 05 limits (R1–R17) + doc 03 §3.2 table + the stage multiplier
   from doc 10 §10.2. No I/O, fully unit-tested. **The stage multiplier is applied
   here, after sizing** — nothing upstream can widen it.
4a. `kill/switch.cpp` — SOFT / MEDIUM / HARD levels (doc 10 §10.3). Pure C++, no
   LLM, no network dependency for the decision itself, reachable from a file plus
   a signal in < 5 s. Exits, stops, TP, and reconcile survive every level.
5. `exec/router.cpp` — risk-budget sizing (§3.3 hierarchy), broker-native
   protection attach (doc 06 §6.1: no PROTECTED without broker-acked SL/TP),
   idempotent client-order-IDs (canonical recipe in doc 06 §6.1:
   `hex(sha256(broker ‖ account ‖ context_hash ‖ symbol ‖ side ‖
   intent_id))` — namespaced, one intent one ID, no attempt field;
   retries reuse the ID, see doc 06), durable order state machine
   (intent/ack persisted, reconcile-before-resend after crashes), retry-once,
   position reconcile vs broker every 15 min (§5.4 S2 FSM).
5a. `broker/` adapters — `FXBrokerAdapter` / `EquityBrokerAdapter` interface
   (Phase 3 implements; OANDA + Alpaca first): submit_entry,
   attach_protection, cancel/replace/query order, positions, account
   (equity/cash/margin/buying-power), open orders, shortability/borrow,
   corporate-event flags. Each adapter declares its semantics (units, partials,
   precision, sessions); the core never assumes one broker's behavior.
5b. Universe service — deterministic full scan → eligibility/liquidity/spread/
   shortability/event filters → ranked candidates (50 research, 5 executable).
   The 5-symbol execution cap is the end of a funnel, not the start of one.
   Kernel-owned (frozen): the executable universe and `snapshot_epoch` are
   minted by the kernel only. Sidecars never narrow the executable set,
   assign epochs, or filter by venue state — they answer about whatever
   state they are handed. Epoch/allowlist state machine lives in P3.3/P3.5
   per doc 13; the P3.1/P3.2 validator receives them as read-only inputs.
6. `log/journal.cpp` — append-only per-decision row + hash chain (prev_hash).
   Nothing trades without a journal row.

## 4.3 Data rules

- Snapshot isolation: decisions read the frozen snapshot, never live state.
- Nanosecond timestamps on snapshot + decision + order intent.
- Canonical serialization for hashing: fixed field order, scaled-integer /
  fixed-point decimals per D6 (never language float formatting).
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
| Feature ingest + validate (per cycle, off tick) | < 500 µs |
| JEV answer read (cached) | < 100 µs |
| Order intent → socket | < 200 µs |
| **Total local** | **< 1 ms** |

JEV network call is NOT in the hot budget (async + cached). straw-man: entries
may use answers up to 60 s old; exits are always local and immediate.

## 4.5 What "done" means

- [ ] All 6 modules compile with `-Wall -Wextra -Werror`, zero warnings.
- [ ] Feed soak 24 h: zero unhandled gaps, reconnect proven by kill test.
- [ ] Snapshot hash stable: 10k identical inputs → 1 hash, features included.
- [ ] Feature ingest rejects: bad schema, future timestamp (R12), expired TTL,
      over-count, and a float where an enum belongs — each proven by test.
- [ ] Isolation proven: the research user cannot write the journal, `HALT`, or
      `STAGE`, and cannot read broker credentials.
- [ ] Kill-switch levels drilled; exits unaffected at all three.
- [ ] Veto unit suite green (cases from doc 05).
- [ ] 24 h feed soak: flat RSS, zero unhandled gaps, reconnect proven by kill test.

## Locked decisions

- Three processes (C++ hot path + JEV sidecar + research plane), JSON over files.
  No gRPC, no sockets between planes in v1 — files make the boundary auditable.
- Research features are validated, bounded, TTL'd, and hashed into the snapshot.
  Absent ≠ neutral. Stage multiplier applied in `risk/`, after sizing.
- Cached-JEV + local-risk. Network never gates an exit.
- Integer money, hashed snapshots, journal-before-order.
