# 04 - C++ Deterministic Core (low-latency execution, not HFT alpha)

The < 1 ms local budget buys determinism, auditability, and reliable exits -
not market-latency advantage. Venue feeds are seconds-scale, the broker API
is internet REST (200 requests/min), and the strategies are latency tier
T2/T3 (doc 01 §1.4). Nothing here assumes HFT market-making capability.

From scratch. No TS port. One direction of trust.

## 4.1 Topology

```
Broker feed ──→ feed/ ──→ ctx/ ──→ snapshot ──┬──→ risk/ ──→ exec/ ──→ transport ──→ broker
                                              │     ▲
candidates.jsonl (strategy identity) ───────┤     │ (optional filter)
features.jsonl (engine, doc 08) ─────────────┤     │
stage chain (human-signed, doc 10) ───────────┤     │
jurisdiction allowlist (doc 10 §10.1a) ─────┤     │
                                              └──→ jev sidecar (async, cached) ──→ answers
```

- `hft` (C++, `mirotrade`): feed, context snapshot, candidate admission,
  risk gates, sizing, execution, kill switches, stage enforcement,
  settlement ledger. Owns every decision that can lose money.
- `strategy/` (Python, deterministic, `mirostrat` identity): the sleeve
  engine. Reads market data + validated features, writes
  `candidates.jsonl` (c1 records) and nothing else. No LLM calls, no broker
  credentials, no journal/`HALT`/stage write. Replayable from logged
  inputs. It proposes; the kernel disposes.
- the engine (Python, `miroresearch`, doc 08): writes `features.jsonl`
  and nothing else in this tree.
- `collector/jev.py` (`mirojev`): optional (doc 03 §3.0). Stale/missing
  answers only matter for sleeves whose champion config is
  `filter = jev`; exits never read them.
- Trust flows one way: research → ctx; strategy → candidate admission →
  risk → exec. Nothing downstream calls upstream; nothing upstream can
  relax a downstream rule.
- Cadence: snapshot on every feed update; decision cycles on each sleeve's
  schedule (link sleeves monthly, event sleeves on signal) plus a 60 s
  housekeeping cycle for exits/reconcile/watchdogs.
- Execution universe per R1 (`EXEC_UNIVERSE_MAX`: 5 under C1; the
  sleeve's registered count, at most 50, under C2).
  The universe is minted by the kernel from the champion sleeve's
  candidates and open positions; it is the end of a funnel.
- Boundary law: `features.jsonl` is the only research artifact that may
  cross into C++, and `candidates.jsonl` is the only strategy artifact.
  `research_digest.jsonl`, thesis prose, critique prose and raw texts are
  never consumed, attached, or used as snapshot material. `ctx/` rejects any
  row carrying text fields (quarantine, alert, HOLD).
- Files over sockets: features and candidates are tailed with atomic
  rename + inode tracking. Missing or stale beyond TTL → absent, a
  distinct state from neutral. A missing candidate is simply no trade.
- Stage chain re-read at each cycle boundary, signatures verified;
  unverifiable → G0_PAPER (doc 10 §10.1).
- Signal data vs order data: sleeve signals are computed from
  consolidated SIP bars (15-minute-delayed on the free plan, which every
  current sleeve schedule tolerates) - the same data the backtests used.
  Real-time IEX quotes are used only to price orders and to run
  staleness/spread vetoes. A sleeve whose signal needs real-time SIP is
  not supported on the free plan and is not pre-registered.

## 4.2 Modules (each = one directory, one responsibility)

1. `core/types.h` - `Side`, `Candidate`, `Snapshot`, `AnswerSet`,
   `OrderIntent`, `Fill`. Plain structs. Risk numbers `constexpr` (doc 05).
2. `feed/feed.cpp` - broker quote/trade stream, fixed lock-free ring
   (65536 ticks, overwrite-oldest + `gap=true`), sequence-gap detection,
   reconnect with backoff; REST alongside for exits + reconcile only.
   Session-aware (`session=closed` is normal). Transport decision (frozen,
   verified against Alpaca docs): paper account streams
   `wss://paper-api.alpaca.markets/stream` + `trade_updates` (WS frames,
   auth + listen handshake, resume = re-subscribe); the Broker-API SSE
   contract is a different product and is not assumed interchangeable. The
   runner seam stays wire-agnostic: `RouteStep` consumes shaped
   observations only.
2a. `ingest/features.cpp` - tails `features.jsonl`; schema version, bounds
   (≤64 retained, ≤16 into a JEV payload), enum/bucket types, R12:
   drop `observed_at_ns` in the future or past TTL. Rejections counted;
   > 5%/h alerts. Zero allocation on the tick path.
2b. `ingest/candidates.cpp` - tails `candidates.jsonl`; validates the
   c1 schema, recomputes the CID (mismatch = reject), checks the sleeve
   id against the stage manifest's approved-sleeve list, symbol against the
   jurisdiction allowlist (R19), freshness (created within the sleeve's
   declared window of the snapshot), and side policy (C1: BUY-to-open or
   SELL-to-close; C2 adds SELL-short-to-open and BUY-to-cover, K-C2). Candidates are low-rate and validated off the tick
   path, so this gate may allocate (std::string/vector); the caller bounds each line to 4 KiB and
   the tick-path zero-allocation gate is unchanged.
   c1 wire record (K6, frozen with the code): one JSON object per line,
   keys exactly `schema` (`"c1"`), `created_ns` (decimal string), and
   `candidate` - an object whose 12 CID-recipe fields (doc 12 / `candidate.py`
   `_ID_FIELDS`, in that order) plus `cid` are ALL JSON strings holding the
   exact Python `str()` bytes the CID was hashed over (same convention as
   the JEV request, so one recompute rule serves both). The sleeve is
   `candidate.strategy_version`; it must appear in the stage manifest's
   approved-sleeve list with its freshness window `window_s`. Checks, first
   failure wins: shape/unknown-key → schema → CID (`sha256("|".join(12))`
   equals `cid`) → sleeve approved → symbol on the R19 allowlist →
   `snapshot_ts_ns` ≤ now and now − snapshot_ts_ns ≤ `window_s` (a future
   stamp is rejected) → side policy (C1: `BUY` = open; `SELL` only when
   the symbol is currently held; anything else rejected. C2, K-C2: a
   `SELL` on a symbol not held is a short open and must pass R20; a `BUY`
   on a held short is a cover). `created_ns` is
   informational and must parse as a non-negative int64. Every reject is
   counted per reason and never partially applied.
3. `ctx/context.cpp` - builds the frozen `Snapshot`: marks, spread,
   session, indicators, regime, VaR/correlation flags (doc 05 §5.1a),
   portfolio view (equity, **settled cash, unsettled proceeds**, exposure,
   pending, buying power), the last complete feature bundle, per-source
   `source_status`, stage, research_revision, calibration summary; then
   `context_hash` (SHA-256 over canonical fixed-point serialization of all
   of it). Frozen G Snapshot v1 contract (audit ruling 2026-09-24). In:
   marks, session, indicators, regime, VaR/correlation flags, portfolio,
   last complete feature bundle, per-source source_status (frozen
   vocabulary healthy|stale|failed|not_scheduled|unavailable|na), stage,
   research_revision, calibration summary. Deferred: `change`
   (no frozen unit/reference/horizon; never inferred, absence ≠ zero) and
   sentiment/signal-bucket representation (never a numeric score).
   Settled-cash fields enter the Snapshot through a versioned Snapshot v2
   contract (new vectors), never by silent extension of v1.
   `context_hash` ≠ JEV `state_hash` (frozen distinction, doc 03 §3.5a):
   context_hash is the kernel's Snapshot digest; state_hash is the digest
   of the full JEV request state. Either mismatch is HOLD.
4. `risk/veto.cpp` - pure `Snapshot + Candidate (+ optional AnswerSet) →
   HOLD/PROCEED + reason`. Implements R1–R19 + the doc 03 §3.2 table when
   a filter is configured + the stage multiplier after sizing. No I/O.
4a. `kill/switch.cpp` - SOFT / MEDIUM / HARD (doc 10 §10.3). Pure C++, no
   LLM, no network dependency for the decision, file + signal reachable
   in < 5 s. Exits, stops, reconcile survive every level.
4b. Always-take path - `BuildEngineInputs` gains a versioned
   filter-policy input (`none | jev`). With `none`, the decision is
   row-0 veto + R1–R19 + sizing; no AnswerSet is read, required, or
   fabricated. Proven by: identical verdicts to the filtered path on every
   row where the filter would PASS, and by a compile/grep gate that the
   `none` path cannot reach an AnswerSet accessor.
5. `exec/router.cpp` - risk-budget sizing (doc 03 §3.3 hierarchy),
   broker-native protection attach (doc 06 §6.1), idempotent client order
   IDs `hex(sha256(broker ‖ account ‖ context_hash ‖ symbol ‖ side ‖
   intent_id))`, durable intent/ack machine, reconcile-before-resend,
   one-attempt-one-query, S2 reconcile FSM. Protection shapes: bracket
   (entry + TP + SL, `exit_profile_v1`) and OTO stop-only for
   signal-exit sleeves (`exit_trend_v1`, `exit_intraday_v1`,
   `exit_event_v1`); MOC exits via `time_in_force=cls` with the stop/MOC
   ordering rule of doc 06 §6.0.
5a. `broker/` - `EquityBrokerAdapter` (Alpaca). The adapter declares
   units (whole shares for protected orders), partials, precision,
   sessions, MOC cutoff, rate limits. The `FXBrokerAdapter` interface is
   retired from v1 (OANDA BLOCKED, forex not a live target).
5b. Transport (doc 13 P3.5-T) - a vetted TLS HTTP/WebSocket client behind
   the transport seam: libcurl + system TLS linked into the kernel
   (`broker/http_curl.cpp`; the trade_updates WebSocket client in
   `broker/ws_stream.cpp`). `runner/main.cpp` keeps a null transport
   (every adapter call refuses); `runner/paper_loop_main.cpp` wires the real
   one. Requirements: small audited surface, fail-closed on every TLS/HTTP
   error, no credential in argv/env of other users, bounded buffers,
   rate-limit aware (200/min). Writing TLS from scratch is forbidden. An
   alternative gateway process under the same `mirotrade` identity was
   considered and not chosen.
5c. Account ledger - C1: per-lot trade date, settlement date (T+1 by
   the exchange calendar), funding source (settled vs unsettled),
   supporting R18: no buy with unsettled funds whose position could be sold
   before settlement; no sale of a lot bought with unsettled funds before
   that funding settles. C2 (K-C2): margin requirement, maintenance buffer,
   borrow status, accrued margin interest and short dividends, supporting
   R18 (C2) and R20. Rebuilt from the journal + broker account on
   recovery; disagreement = HOLD + reconcile.
5d. Universe service - deterministic eligibility/liquidity/spread/
   allowlist filters → the executable symbols per epoch (R1). Kernel-owned:
   the universe and `snapshot_epoch` are minted by the kernel only.
6. `log/journal.cpp` - append-only per-decision row + hash chain. Nothing
   trades without a journal row (emergency-exit exception: doc 06).

Port-on-promotion rule: a sleeve may drive G0b paper through the
Python sleeve engine. Before G1 (real capital), the champion sleeve's
signal logic is re-implemented in C++ inside the kernel and proven
bit-identical to the Python reference on the full backtest history via
committed cross-language vectors (the `jev_vectors/` precedent). The port
covers the sleeve's deterministic rule, not the engine: its inputs stay
engine features (`link_signal` buckets or the link-matrix snapshot hash,
`ripple_hypothesis` records) plus prices. At G1+ the kernel recomputes the
champion's candidates from those inputs itself; `candidates.jsonl` becomes
a cross-check (mismatch = HOLD + alert). For L3 the direction originates in
a verified hypothesis; the kernel decides whether and how much to trade.

## 4.3 Data rules

- Snapshot isolation: decisions read the frozen snapshot, never live state.
- Nanosecond timestamps on snapshot, candidate admission, decision, intent.
- Canonical serialization: fixed field order, scaled-integer/fixed-point
  (D6), UTF-8, no whitespace variance. Hash mismatch = bug, halt paper.
- Integer money: shares and cents; floats only inside indicators.
- Resource rules: static allocation at startup; zero malloc on the tick
  path; fixed rings; SQLite only in sidecars (pruned > 90 d); journal
  rolls daily, retained 90 d. The canonical live journal's unbounded
  growth is a tracked G0b operational item (doc 13), never a silent
  rotation. A 24 h soak must show flat RSS or the build fails.

## 4.4 Latency budget (local, excl. network/API)

| Stage | Budget |
|---|---|
| WS tick → ring buffer | < 20 µs |
| Snapshot build | < 200 µs |
| Candidate admission (per cycle, off tick) | < 200 µs |
| Risk veto (local) | < 50 µs |
| Feature ingest + validate (per cycle, off tick) | < 500 µs |
| JEV answer read (cached, if configured) | < 100 µs |
| Order intent → transport | < 200 µs |
| Total local | < 1 ms |

The network (broker round trip tens to hundreds of ms from the host,
rate-limited) dominates end-to-end latency and is irrelevant to T2/T3
sleeves. Exits are always local and immediate; broker-native stops
protect positions even if the host is gone.

## 4.5 What "done" means

- [ ] All modules compile with `-Wall -Wextra -Werror`, zero warnings.
- [ ] Snapshot hash stable: 10k identical inputs → 1 hash, features and
      settlement fields included (Snapshot v2 vectors).
- [ ] Feature ingest rejects: bad schema, future timestamp (R12), expired
      TTL, over-count, float-where-enum - each proven by test.
- [ ] Candidate ingest rejects: forged CID, unapproved sleeve,
      non-allowlisted symbol, stale candidate, SELL-to-open live - each
      proven by test.
- [ ] Always-take path proven equal to the filtered path where the filter
      passes, and unable to read an AnswerSet.
- [ ] Settlement ledger: GFV and free-riding scenarios HOLD by test.
- [ ] Transport wired (P3.5-T) and proven against Alpaca paper: submit,
      protect, query, cancel, reconcile, MOC, 429 back-off.
- [ ] Isolation proven: research and strategy users cannot write the
      journal, `HALT`, or stage chain, and cannot read broker credentials.
- [ ] Kill-switch levels drilled; exits unaffected at all three.
- [ ] 24 h feed soak: flat RSS, zero unhandled gaps, reconnect by kill test.

## Locked decisions

- Four processes (C++ kernel + sleeve engine + research plane + optional
  JEV sidecar), JSON over files between identities. No gRPC, no sockets
  between planes in v1 - files make the boundary auditable. The transport
  (broker network I/O) is part of the kernel's identity, not a plane.
- Research features and strategy candidates are validated, bounded,
  TTL'd, and hashed into the decision record. Absent ≠ neutral.
- Always-take is a first-class path; JEV is optional (doc 03 §3.0).
- Real-money candidates are recomputed by C++ from engine features and
  prices (port-on-promotion before G1); no model output reaches sizing.
- Signals from SIP data; IEX real-time only for order pricing and vetoes.
- Cached-JEV (when used) + local risk. Network never gates an exit.
- Integer money, hashed snapshots, journal-before-order, the R18 account
  rule checked before every order.
