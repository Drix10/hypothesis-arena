# Kernel

The C++ kernel owns every decision that can lose money. Its under-1-ms local
budget buys determinism, auditability and reliable exits, not market-latency
advantage. Venue feeds are seconds-scale, the broker API is internet REST (200
requests a minute) and the strategies hold for days to months (`vision.md`).
Nothing here assumes high-frequency capability.

Built from scratch, with one direction of trust.

## Topology

```
Broker feed -> feed/ -> ctx/ -> snapshot -> risk/ -> exec/ -> transport -> broker
                                    ^
candidates.jsonl (strategy engine) -+
features.jsonl (engine, engine.md) -+
stage files (human-signed, stages.md)+
jurisdiction allowlist (stages.md) -+
```

- **Kernel** (C++, user `mirotrade`): feed, context snapshot, candidate
  admission, risk gates, sizing, execution, kill switches, stage enforcement
  and the settlement ledger.
- **Strategy engine** (Python, deterministic, user `mirostrat`): reads market
  data and validated features and writes `candidates.jsonl` and nothing else.
  No model calls, no broker credentials, no write to the journal, `HALT` or
  stage files. Replayable from logged inputs. It proposes; the kernel disposes.
- **Engine** (Python, user `miroresearch`, `engine.md`): writes `features.jsonl`
  and nothing else in this tree.
- Trust flows one way: research to context, strategy to candidate admission to
  risk to execution. Nothing downstream calls upstream and nothing upstream can
  relax a downstream rule.
- **Cadence:** a snapshot on every feed update; decision cycles on each
  strategy's schedule (link strategies monthly, event strategies on signal)
  plus a 60-second housekeeping cycle for exits, reconcile and watchdogs.
- **Execution universe:** at most 5 symbols under the India set, and the
  strategy's registered count (at most 50) under the US set. The kernel mints
  the universe from the champion's candidates and open positions; it is the end
  of a funnel.
- **Boundary law:** `features.jsonl` is the only research artifact that may
  cross into the kernel and `candidates.jsonl` is the only strategy artifact.
  `research_digest.jsonl`, thesis prose and raw text are never consumed,
  attached or used as snapshot material. The context module rejects any row
  carrying text fields (quarantine, alert, HOLD).
- **Files, not sockets:** features and candidates are tailed with atomic
  rename and inode tracking. Missing or stale beyond the TTL means absent, a
  distinct state from neutral. A missing candidate is simply no trade.
- The stage files are re-read at each cycle boundary with signatures verified;
  unverifiable means the paper stage (`stages.md`).
- **Signal data versus order data:** strategy signals are computed from
  consolidated SIP bars (15-minute delayed on the free plan, which every
  strategy schedule tolerates), the same data the backtests used. Real-time IEX
  quotes are used only to price orders and to run staleness and spread vetoes.
  A strategy whose signal needs real-time SIP is not supported on the free plan
  and is not pre-registered.

## Modules

Each is one directory with one responsibility.

1. **`core/types.h`:** `Side`, `Candidate`, `Snapshot`, `OrderIntent`, `Fill`.
   Plain structs; risk numbers are `constexpr` (`risk.md`).
2. **`feed/feed.cpp`:** the broker quote and trade stream into a fixed
   lock-free ring (65536 ticks, overwrite-oldest with `gap=true`), sequence-gap
   detection and reconnect with backoff; REST alongside for exits and reconcile
   only. Session-aware (`session=closed` is normal). The paper account streams
   `wss://paper-api.alpaca.markets/stream` with `trade_updates` (WebSocket
   frames, an auth and listen handshake, resume by re-subscribing); the
   Broker-API SSE contract is a different product and is not assumed
   interchangeable. The runner stays wire-agnostic: `RouteStep` consumes shaped
   observations only.
3. **`ingest/features.cpp`:** tails `features.jsonl`; checks schema version,
   bounds (at most 64 retained), enum and bucket types, and drops
   `observed_at_ns` in the future or past its TTL. Rejections are counted;
   more than 5% an hour alerts. Zero allocation on the tick path.
4. **`ingest/candidates.cpp`:** tails `candidates.jsonl` and validates the
   candidate record (below). Candidates are low-rate and validated off the tick
   path, so this gate may allocate; the caller bounds each line to 4 KiB and
   the tick-path zero-allocation gate is unchanged.
5. **`ctx/context.cpp`:** builds the frozen `Snapshot`: marks, spread, session,
   indicators, regime, VaR and correlation flags, the portfolio view (equity,
   settled cash, unsettled proceeds, exposure, pending, buying power), the last
   complete feature bundle, per-source `source_status`, stage and
   `research_revision`; then `context_hash`, SHA-256 over a canonical
   fixed-point serialization of all of it. `source_status` uses the vocabulary
   `healthy`, `stale`, `failed`, `not_scheduled`, `unavailable`, `na`. A
   `change` field and sentiment buckets are deferred: they have no fixed unit,
   reference or horizon, are never inferred, and absence is not zero.
6. **`risk/veto.cpp`:** a pure function from `Snapshot` and `Candidate` to HOLD
   or PROCEED with a reason. Implements every rule in `risk.md` plus the stage
   multiplier after sizing. No I/O.
7. **`kill/switch.cpp`:** SOFT, MEDIUM and HARD (`stages.md`). Pure C++, no
   model, no network dependency for the decision, reachable by file and signal
   in under 5 seconds. Exits, stops and reconcile survive every level.
8. **`exec/router.cpp`:** risk-budget sizing, broker-native protection attach
   (`execution.md`), idempotent client order ids, a durable intent and ack
   machine, reconcile before resend, one attempt and one query, and the
   reconcile state machine. Protection shapes: a bracket (entry, take-profit and
   stop-loss) and an OTO stop-only for signal-exit strategies (`exit_link`,
   `exit_event`, `exit_trend`). MOC exits use `time_in_force=cls` under the
   stop-before-close rule (`execution.md`).
9. **`broker/`:** the `EquityBrokerAdapter` for Alpaca. The adapter declares
   units (whole shares for protected orders), partials, precision, sessions,
   the MOC cutoff and rate limits. There is no FX adapter.
10. **Transport:** a vetted TLS HTTP and WebSocket client behind the transport
    seam: libcurl and system TLS linked into the kernel (`broker/http_curl.cpp`;
    the `trade_updates` WebSocket client in `broker/ws_stream.cpp`).
    `runner/main.cpp` keeps a null transport (every adapter call refuses);
    `runner/paper_loop_main.cpp` wires the real one. Requirements: a small
    audited surface, fail-closed on every TLS or HTTP error, no credential in
    argv or the environment of other users, bounded buffers, rate-limit aware
    (200 a minute). Writing TLS from scratch is forbidden.
11. **Account ledger.** India set: per-lot trade date, settlement date (T+1 by
    the exchange calendar) and funding source (settled or unsettled), supporting
    the account rule: no buy with unsettled funds whose position could be sold
    before settlement, and no sale of a lot bought with unsettled funds before
    that funding settles. US set (after kernel short selling is built): margin
    requirement, maintenance buffer, borrow status, and accrued margin interest
    and short dividends, supporting the account rule and `short_controls`.
    Rebuilt from the journal and broker account on recovery; disagreement means
    HOLD and reconcile.
12. **Universe service:** deterministic eligibility, liquidity, spread and
    allowlist filters give the executable symbols per epoch. Kernel-owned: the
    universe and `snapshot_epoch` are minted by the kernel only.
13. **`log/journal.cpp`:** an append-only per-decision row plus a hash chain.
    Nothing trades without a journal row (emergency exits excepted,
    `execution.md`).

### Candidate record

One JSON object per line with exactly the keys `schema`, `created_ns` (a
decimal string) and `candidate`. The candidate's 11 identity fields (`ID_FIELDS` in
`research/strategy/candidate_wire.py`, in that order) plus `cid` are all JSON
strings holding the exact Python `str()` bytes the id was hashed over, so one
recompute rule serves every consumer. The strategy is
`candidate.strategy_id`; it must appear in the stage manifest's approved list
with its freshness window `window_s`. Checks, first failure wins:

1. shape and unknown keys;
2. schema;
3. id: `sha256("|".join(11 fields))` equals `cid`;
4. the strategy is approved;
5. the symbol is on the allowlist;
6. `snapshot_ts_ns` is at most now, and now minus `snapshot_ts_ns` is at most
   `window_s` (a future stamp is rejected);
7. side policy. India set: `BUY` opens; `SELL` only when the symbol is
   currently held; anything else is rejected. US set (after kernel short
   selling is built): a `SELL` on a symbol not held is a short open and must
   pass `short_controls`, and a `BUY` on a held short is a cover.

`created_ns` is informational and must parse as a non-negative int64. Every
reject is counted per reason and never partially applied.

## Port on promotion

Before real capital, the champion's signal logic is re-implemented in C++
inside the kernel and proven bit-identical to the Python reference on the full
backtest history through committed cross-language vectors. The port covers the
strategy's deterministic rule, not the engine: its inputs stay engine features
(`link_signal` ranks or the link-matrix snapshot hash, `ripple_hypothesis`
records) plus prices. At the tiny stage and beyond, the kernel recomputes the
champion's candidates from those inputs itself and `candidates.jsonl` becomes
a cross-check (a mismatch means HOLD and an alert). For Event Ripple the
direction originates in a verified hypothesis; the kernel decides whether and
how much to trade.

## Data rules

- **Snapshot isolation:** decisions read the frozen snapshot, never live state.
- Nanosecond timestamps on snapshot, candidate admission, decision and intent.
- **Canonical serialization:** fixed field order, scaled-integer fixed-point,
  UTF-8, no whitespace variance. A hash mismatch is a bug and halts paper
  trading.
- **Integer money:** shares and cents; floats only inside indicators.
- **Resources:** static allocation at startup; zero malloc on the tick path;
  fixed rings; SQLite only in sidecars (pruned after 90 days); the journal rolls
  daily and is retained 90 days. The live journal's unbounded growth is a
  tracked paper-trading operational item, never a silent rotation. A 24-hour
  soak must show flat RSS or the build fails.

## Latency budget (local, excluding network and API)

| Stage | Budget |
|---|---|
| WebSocket tick to ring buffer | under 20 µs |
| Snapshot build | under 200 µs |
| Candidate admission (per cycle, off the tick path) | under 200 µs |
| Risk veto | under 50 µs |
| Feature ingest and validation (per cycle, off the tick path) | under 500 µs |
| Order intent to transport | under 200 µs |
| Total local | under 1 ms |

The network (a broker round trip of tens to hundreds of milliseconds,
rate-limited) dominates end-to-end latency and is irrelevant to multi-day
strategies. Exits are always local and immediate, and broker-native stops
protect positions even if the host is gone.

## Build order

Each slice is pure-first (no I/O in decision logic), fixture-tested, and green
before the next starts. Gate classes: *correctness* (unit and fixture suites,
deterministic, minutes), *drill* (fault injection or procedure runs against
built slices) and *soak* or *operational* (wall-clock evidence).

1. **Request authority.** `ValidationRequest` is private-immutable: const
   fields, no setters, no mutable accessors; `request_for()` is the sole
   construction authority. Gate: the existing suites pass unchanged, grep gates
   in `build.sh` (no public constructor, no setters, exact friend list), and a
   compile-test harness proving the boundary with compile-fail snippets for
   direct construction, direct field mutation and mutable-accessor acquisition,
   and compile-pass snippets for the sanctioned path.
2. **Risk veto.** `risk/veto.cpp` implementing `risk.md`. Gate: a veto unit
   suite from the risk cases.
3. **Feature ingest.** `ingest/features.cpp`. Gate: the rejection tests below.
4. **Kill switch.** `kill/switch.cpp`. Gate: kill drills.
5. **Stage files.** Re-read per cycle boundary, hash-chain verification,
   unverifiable means paper. Gate: a corruption test.
6. **Feed.** `feed/feed.cpp`. Gate: a 24-hour soak with flat RSS and a
   kill-and-reconnect test.
7. **Context.** `ctx/context.cpp` with `context_hash` over everything, features
   included. Gate: 10k identical inputs give one hash.
8. **Router and journal.** `exec/router.cpp` and `log/journal.cpp`: the sizing
   hierarchy, broker-native protected attach, idempotent order ids, the durable
   intent and ack machine, retry once, journal before order, the reconcile
   state machine, fault-injection outage tests, the paper fill rule,
   summary-from-journal, retention and redaction tests, and kill-switch and
   reconcile drills with exits proven alive. This slice closes the kernel build.
9. **Operational evidence** (not part of the kernel build): the live paper
   loop, 30 clean days, zero rule violations, real outage drills with exits
   alive, and an out-of-band notification actually received. It runs after the
   kernel build closes and never blocks it retroactively.

A slice's correctness and drill gates must be green before the next slice's
correctness work starts; soak and operational gates attach to their slice but
may complete overlapped with later slices.

### Test coverage map

Every reliability property has one owner and one measurable test; a lesson with
an existing gate is cited, not rebuilt.

| Property | Test | Owner |
|---|---|---|
| Rejection-shape matrix | feature and candidate rejection suites | ingest |
| Veto behavior | veto unit battery | risk |
| Decision determinism | veto composition suite and replay | risk |
| Simulated market-feed delay and drop | feed-gap and transport-drop injection against the outage playbook | feed |
| Provider timeout and drop | provider-timeout injection against the outage playbook | router |
| Randomized event ordering | an order-permuted reconcile test: arrival order is randomized while broker event identity and sequence metadata is preserved, and reconciliation must converge to the same broker-consistent final state across permutations and duplicate deliveries. Where a venue supplies no usable sequence metadata, the design fixes an explicit deterministic tie-break (broker timestamp, then event id) rather than assuming order is irrelevant | router |
| Feature-bundle version skew | a bundle with an unknown schema version gives a loud reject at the context boundary, no silent pass | engine |
| Chaos restart, kernel | `kill -9` mid-cycle: the journal chain verifies, the epoch is monotonic and no order id repeats | router |
| Chaos restart, research | `kill -9` at a random node: resume with no duplicate features and no partial bundle | engine |
| Kill-switch levels | kill drills with exits alive at all three | kill |
| Outage defaults | every outage playbook row drilled with exits proven alive | router |
| Feed soak | 24 hours, flat RSS, kill and reconnect | feed |
| 30-day operation | operational evidence (never blocks the build retroactively) | operations |

## Remaining scope

The kernel through the router and journal is built: `kernel/runner/main.cpp` is
the read-only entry and `paper_loop` places paper orders through the libcurl
transport (`broker/http_curl.cpp`, verified TLS to the paper host only,
credentials from the process environment, bounded bodies) and the
`trade_updates` WebSocket client (`broker/ws_stream.cpp`). Remaining, in order,
each tracked in `TODO.md`:

- **MOC smoke test:** a MOC fill and reconcile with a held position
  (`broker/live_drill.cpp`).
- **Stop-before-close fix:** Alpaca rejects MOC and market sells while an OTO
  stop is live, so the router cancels the stop, confirms, then closes. Mock
  drill first.
- **24-hour soak** on the real transport.
- **Live-paper drills:** every outage playbook row (`execution.md`) drilled on
  live paper.
- **Kernel short selling** (the US-set account path): side policy for short
  opens and covers, the US-set limits with a raised universe maximum, the
  margin account ledger, borrow checks from the broker's asset flags, buy-stop
  protection, BUY-to-cover flatten, and new vectors, with every existing
  verdict reproduced bit-identically. `scripts/check-manifest.sh` pins the
  execution maximum at 5, so the pin and the manifest change in the same
  commit.
- **Port on promotion** (before real capital).

The kernel build closes when the MOC smoke test, the stop-before-close fix and
the live-paper drills are green. The 24-hour soak is soak evidence and never
blocks retroactively. Kernel short selling waits for a US-set strategy to pass
its backtest gate.

## Non-goals

- No engine work inside the kernel: the engine feeds `features.jsonl` only,
  through the pinned schema.
- No stage above paper and no venue beyond Alpaca paper until `stages.md`
  allows it.

## Done when

- All modules compile with `-Wall -Wextra -Werror` with zero warnings.
- The snapshot hash is stable: 10k identical inputs give 1 hash, features and
  settlement fields included.
- Feature ingest rejects a bad schema, a future timestamp, an expired TTL, an
  over-count and a float where an enum belongs, each proven by test.
- Candidate ingest rejects a forged id, an unapproved strategy, a
  non-allowlisted symbol, a stale candidate and a SELL-to-open live, each
  proven by test.
- The settlement ledger HOLDs on good-faith-violation and free-riding
  scenarios, by test.
- The transport is wired and proven against Alpaca paper: submit, protect,
  query, cancel, reconcile, MOC and 429 back-off.
- Isolation is proven: research and strategy users cannot write the journal,
  `HALT` or stage files, and cannot read broker credentials.
- Kill-switch levels are drilled and exits are unaffected at all three.
- A 24-hour feed soak shows flat RSS, zero unhandled gaps and a reconnect by
  kill test.

## Decisions

- Three processes (the C++ kernel, the strategy engine and the research
  plane), JSON over files between identities. No gRPC and no sockets between
  planes: files make the boundary auditable. The transport (broker network I/O)
  is part of the kernel's identity, not a separate plane.
- Research features and strategy candidates are validated, bounded, TTL'd and
  hashed into the decision record. Absent is not neutral.
- Real-money candidates are recomputed by the kernel from engine features and
  prices (port on promotion before the tiny stage); no model output reaches
  sizing.
- Signals come from SIP data; IEX real-time only for order pricing and vetoes.
- The network never gates an exit.
- Integer money, hashed snapshots, journal before order, and the account rule
  checked before every order.
