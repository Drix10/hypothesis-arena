# 06 — Execution and Ops

## 6.1 Order lifecycle (locked, v2: broker-native protection)

Local C++ stops are the active controller, never the disaster protection. A
position the broker cannot protect on its own is a position the process cannot
survive losing — so protection is established broker-side first:

```
intent (risk PASS) → re-check HALT file → journal row → send entry +
  protective SL/TP through a broker-specific protected mode (E1: entry is
  permitted ONLY through an order mode whose adapter implementation
  positively establishes the entry↔protection relationship — OANDA
  stopLossOnFill/takeProfitOnFill; Alpaca bracket legs with adapter-proven
  semantics). Each adapter proves: entry ack, protection ack, partial-fill
  behavior, cancel/replace behavior, double-trigger behavior — including
  fast-market edge behavior. "Atomic" is the requirement (no naked entry),
  not a cross-broker primitive claim. → ack/timeout → query once:
   filled + protection acked → journal fill → PROTECTED → track
   filled, protection missing → PROTECTIVE_ORDER_MISSING: establish now or
     flatten immediately; never hold naked awaiting a retry loop
   partial (0% < filled < 100%) → journal partial with filled qty →
     protection covers filled qty ONLY → cancel remainder → confirm
     cancelled → journal cancel. Protection never covers unfilled qty;
     a partial never becomes PROTECTED on the full intended size.
   nothing         → cancel → confirm cancelled → journal cancel
   cancel failed   → UNKNOWN_EXECUTION (never "filled"): freeze new orders
     for the symbol, query broker, reconcile per §5.4 S2, preserve or
     establish protection first
 → exit (stop, TP, calendar time_exit, or flip rule below) → journal + reflection row
```

- Durable order state machine (survives restarts): intent_id + client order ID
  + send_attempt + broker_ack_state persisted before send. After any crash the
  process reconciles ack state with the broker BEFORE issuing anything new —
  a restart must never double-send what the dead process already sent.
- Client order ID = typed intent fingerprint + broker/account namespace +
  persisted intent_id, hashed: `hex(sha256(broker ‖ account ‖ context_hash ‖
  symbol ‖ side ‖ intent_id))`, truncated only if the broker requires it —
  one intent, one ID, no attempt counter, no delimiter ambiguity, no
  cross-account collision. (An `attempt` field in the hash was a
  duplicate-order bug: every retry would mint a fresh ID and double-fill.
  Retries reuse the ID.)
- One send attempt + one status query. No martingale re-sends.
- Stops are attached at entry or the entry is rejected. exit_profile_v1
  (doc 03 §3.3): fixed stop + fixed 2R take-profit + mandatory calendar
  time_exit (E4): time_exit = actual exchange close − frozen exit buffer
  (30 min default), from the validated IANA/exchange calendar — never a
  hard-coded 15:55 ET, which is wrong on early closes.
  Stop floor 0.1% ⇒ min TP 0.2% (20bp), which must EXCEED all-in modeled
  cost + safety margin under the frozen cost stress — 20bp clears
  fees/slippage only if the cost model says so, never by construction.
  Entry requires: expected gross edge > all-in modeled cost + margin.
- Journal-before-order is absolute for NORMAL entries. Emergency exits carry
  an explicit exception: if the journal write fails mid-emergency, execute
  first, then append through the durable emergency-exit buffer — a delayed
  exit is worse than a delayed row, and the row still lands. (This supersedes
  any "no exceptions" wording: the exception is this paragraph.)
- Discretionary exit is REMOVED from live actuation (E3): `enter.noul < 0.3`
  twice is logged and researched, but never market-exits a position. Live
  exits are: stop, TP, time_exit, deterministic risk/kill exit, broker
  reconciliation logic. Exits never depend on JEV — the hard stop/TP always
  stand regardless; stale/missing JEV never forces, and never blocks, an exit.
- Feed stale > 30 s → entries forbidden (veto). Exits go via REST if WS is down.
- Stage multiplier (doc 10 §10.2) is applied to the computed size **after** the
  conviction table and before the R2 check. An order that is legal at G3 and
  illegal at G1 is rejected at G1, with the stage named in the HOLD reason.

## 6.1b Close ownership + incident identity (frozen)

One position, one close. Per (symbol, side) and per incident, exactly one
close identity may be live. Every kill-path close is pre-flighted (GET by
the stable id first — found adopts, 404 sends once, failure waits), and
the pre-flight is the mutual-exclusion mechanism between close owners:

- MEDIUM: the local flatten EXIT owns the close when one is active, armed,
  or landed; otherwise the broker sweep owns it. The sweep reconciles
always (fills attribute back) but SENDS only for uncovered symbols — a
covered symbol waits on its local close. A local flatten never submits
against a live sweep close: it arms and waits, and attribution zeroes
the entry when the sweep lands. A flatten that resolves non-closed hands
ownership back to the sweep (re-arm is forbidden — the intent id is
single-use, so only the incident sweep id can carry the next close).
- HARD: an in-flight EXIT is adopted when live (no cancel to make room)
or replaced when dead/absent — never bypassed with a second identity.
An ENTRY with exit coverage closes only its uncovered remainder. All
hard closes for one (symbol, side) share the incident hard id, so the
slot path, the exit path, and the slotless-position path pre-flight
each other instead of stacking closes.

Kill-path close ids are incident-scoped (Alpaca `client_order_id` is
unique per order — a historical filled id reused for a later incident
would adopt-away a live position's close):

- `medium-<epoch>-<SYM>` (sweep) and `medium-<epoch>-<SYM>-<qty>`
  (remainder), hashed through the §6.1 recipe. The epoch is minted once
per MEDIUM incident at medium-enter (`medium-incident.txt`) and
  overwritten only by a new enter — which BY DEFINITION is a new
incident (a crash mid-incident keeps the FSM file, so it reuses).
- `hard-<epoch>-<SYM>` for every HARD close of that (symbol, side).
The epoch lives in `hard-incident.txt` as `<epoch>` + kill reason. A
crash mid-HARD keeps HALT, so the next HardStop reuses the epoch
(minting new would double the in-flight closes). Clearing HALT ends
the incident (a human owns the interim — the journal shows what flew);
a re-firing HARD is a new incident with a new epoch, and the supersede
is journaled + alerted. A clean non-HARD cycle with no HALT truncates
the file (the incident is over; tidy for forensics).
- Intent-bound ids (`<intent>-repair`, `<intent>-flatten`, exit
sub-identities) need no epoch: intent ids are permanently bound and
single-use (§6.1), so they cannot collide across incidents.
- MEDIUM FSM auto-clear: `medium.txt` is cleared (with the epoch
file) on any non-MEDIUM cycle once the incident is closed (file ==
FLATTENED) or stale (no local open AND no broker position) — a
later automatic MEDIUM trigger re-enters fresh with a NEW epoch;
no operator file edit is ever required. Crash-mid-incident reuses
the files (in-progress state + epoch survive). A FLATTENED file
seen WITH live exposure is stale (clear + fresh enter), never
suppression.
- HARD quantity authority: the SIGNED BROKER POSITION (the position
endpoint is the account's current open-position source) sizes every
HARD close when the seam answers — the slot path closes only the
broker quantity uncovered by reconciled exits, in the broker
direction; local/broker disagreement journals drift but never
changes the qty. Local-open sizing is the fallback ONLY when the
seam is absent/failing (journaled). Position-loop symbols with
ENTRY slots are slot-path-owned; exit-only symbols reconcile ALL
covering exits (every one queried, none assumed) and close only
the remainder. A found-short terminal hard order mints a
deterministic incident-scoped remainder `hard-<epoch>-<SYM>-<qty>`
(pure, pre-flighted, strictly-decreasing chain, never colliding
with the primary id; primary-absent still posts the primary).
- HARD chain truth vs broker gate: the remainder derives from the
ORIGINAL hard-order chain (`hard-chain.txt`: `<tag> <requested>`
`<attributed>`, write-ahead before every POST), never by subtracting
a burned order's historical fill from a CURRENT broker number (settled
fills are gone from the broker — re-subtracting them under-closes).
The broker position independently caps the send (`min(chain-remainder,
broker-need)`; zero need sends nothing). Per-id attribution is exact
(only the not-yet-attributed portion folds, crash-safe via the chain).
EXIT adoption attributes only beyond the slot's own
`exit_counted_qty` (the router's per-current-order memory) and
bumps it — an already-counted cumulative fill never folds twice.
A broker `filled_qty` REGRESSION below chain-attributed quantity
is classified (journal + alert, drift owns the anomaly) and the
remainder floors at the chain (`req - already`, never `req -
regressed-filled`): a regressing observation can never
manufacture a larger replacement remainder.
- HARD chain write-ahead enforcement: `NoteHardChain` returns
success/failure and a failed chain write PREVENTS the POST (freeze
+ alert + refuse — chain truth must exist before the close flies).
A missing/corrupt/unreadable chain for a broker-known hard id is an
integrity failure (freeze + alert + refuse) — NEVER `orig = need`,
never reconstructed from current broker quantity. Crash between
note and POST restarts into a 404 and safely sends the same
identity once; crash after POST restarts into adoption of the
same identity (pre-flight dedupe, never a second identity).
- HARD chain integrity validation: the reader validates the whole
file, not "last row wins" — requested quantity per tag is immutable,
attributed is monotonically nondecreasing, 0 <= attributed <=
requested, no malformed records, no conflicting requested values,
no silent skipping of bad rows (exact-duplicate rows are idempotent
crash-retry evidence, not conflicts). Chain rows parse as strict
single-space `<tag> <requested> <attributed>` with overflow-safe
bounded decimal conversion (never scanf-family conversion on
persisted numeric text). Existence checks mean
regular-file on every platform (stat-converged: a directory in
place of a state file reads as missing/genesis, never as
valid-empty content, on Windows and POSIX alike). `hard-chain.txt`
additionally carries a hard byte envelope (64 KiB): oversized input
refuses before materializing rows, so millions of duplicate rows
can never drive unbounded memory (the live journal keeps its own
lifecycle contract and is tracked separately as an operational
scaling item, never silently rotated). Any violation fails the HARD
path closed (freeze + alert + refuse), never a broker-derived
substitute quantity.
- HARD attribution durability: slot accounting persists BEFORE the
durable chain attribution advances — `AttributeClosedQty` is
two-phase (compute takes, then mutate+persist per slot; any persist
failure rolls back in-memory AND re-persists already-written slots
to their old values, best-effort, then reports failure) and returns
success/failure. The HARD path advances the chain note only when
all slot persists succeeded (and rolls every slot back to old
values when the chain note itself fails); otherwise it journals +
alerts + refuses with books exactly as before the attempt, so the
next pre-flight reconstructs the same portion exactly once. The
un-advanced chain plus the old snapshots ARE the fail-closed
recovery state — no second source, no broker-derived fill-in.
- Seam numeric parsing is overflow-safe everywhere broker or
file text becomes a quantity: stream `filled_qty` accumulates with
a reject-before-overflow bound (inputs above the share cap refuse
before arithmetic can overflow); epoch files parse with the same
checked conversion (oversized/overflowed epoch text refuses).
- Position snapshots are contract-checked: every
`list_positions(..., cap)` return must satisfy `0 <= n <= cap`;
any other count is an unavailable snapshot (unknown/failure down
the caller's existing fail-closed branch), never an index past
the fixed buffer — a bad Phase-4 adapter cannot drive an
over-read.
- Cursor durability fails closed: a failed `cursor.txt` write
journals + alerts, keeps the dirty bit, and fails the cycle
under the same contract as a failed day-roll (never a silent
clear that reports success while losing the replay position).
- Incident epochs are durable-or-nothing: `MintMediumEpoch` and
`HardEpochFor` mint no identity unless the epoch file write
succeeds (failure returns no-epoch; callers stop the incident
path and, for MEDIUM, revert the FSM so the next cycle retries
the mint). The clock-stuck `old + 1` fallback refuses at
`LLONG_MAX` instead of overflowing.
- HARD logical remainder identity: the chain requested quantity
is the LOGICAL remainder, never the broker-capped send (`send =
min(logical, broker_need)`; the chain records `logical`). A 404 on
an existing tag reuses its recorded request/attribution and
appends at most an exact-duplicate row — never a conflicting
request. Stranded partial sends converge by re-pre-flight under
the same identity (never a second identity for one remainder).
- HARD cumulative EXIT crash ordering: durable parent-entry
attribution lands BEFORE the EXIT `exit_counted_qty`/`exit_closed_qty`
persist. A crash between the two replays safely: entries already
authoritative, the leftover drops, counters advance, no double-fold,
no permanently lost attribution.
- HARD incident recovery: durable HALT + missing/corrupt/unreadable
`hard-incident.txt` refuses (never mints a new epoch over a live
HALT). Same-process mint retry is allowed only before any close
flies under that epoch.
- HALT durability: HALT is a durable state write (checked), backed
by a sticky in-memory HARD latch consulted by entry gating — a
failed HALT persist cannot yield entry operation or a false
completed-stop. The stop is claimed only once durably established;
otherwise the process stays latched and retries.
- Recovery terminal-row rule: a journal terminal row never overrides
a nonterminal durable snapshot (rebuild + reconcile), and journal-
terminal + missing snapshot/intent refuses for human recovery.
Terminal EXIT closed quantity re-attributes AFTER entries rebuild
(capped, idempotent).
- MEDIUM flatten certification: `FLATTENED` writes only on
`AllFlat() && BrokerConfirmedFlat()`; missing/failing seam retains
the in-progress FSM. Every FSM/cleanup transition is checked:
persist-fail keeps the previous safe file state + alerts + retries.
- State-file integrity: absent vs corrupt/non-regular are distinct.
A directory/unreadable node never reads as missing (journal: refuse;
HALT: present; freeze: frozen; chains/incidents/FSM: invalid/refuse).
A present-but-unreadable regular freeze file is frozen (ABSENT
reads as the empty set; REGULAR-but-unreadable fails closed).
A present regular MEDIUM FSM whose content is non-empty and
outside the four legal states is corruption: refuse + alert,
never mint a fresh incident over it (absent-or-empty still
takes the fresh/mint-retry path). FSM validation is
centralized and runs at EVERY cycle boundary regardless of
kill level: the non-MEDIUM finalize/clear path validates
before any transition, so a malformed file can never be
rewritten into a legitimate-looking FLATTENED or
PROTECTION_ONLY (corruption is never erased, only refused).
- Broker position values: snapshots validate count AND rows —
NUL-terminated non-empty symbols, no duplicates, qty within
+/-999999999, `LLONG_MIN` refused. Any violation invalidates the
whole snapshot (unknown).
- MEDIUM sweep remainder: never from the stale snapshot after a
terminal-short sweep — re-read authoritative broker position and
send `min(logical_remainder, |fresh|)` (sign agreement required;
unavailable fresh refuses to next cycle). Sweep remainder tags
carry the derived remainder.
- SSE/transport bounds: accumulated SSE `data:` payload is capped
before materializing (oversize rejects + resyncs + counts); the
runner enforces `0 <= stream_read <= buf` with negative/overlong
returns treated as feed faults, never silent no-data.
- Intent-ID permanence: journal history wins — a verified
historical `intent` row for an ID refuses re-registration even when
the intent file is gone (deleted-file re-submit refused).
- Capacity is validated once: `max_slots` clamps to the fixed
architecture limit (1..64; exits 2x) so `*2` arithmetic cannot
overflow and fixed scratch tables cannot be over-indexed.
- Windows durability: `AtomicWrite` uses true replacement semantics
(`MoveFileEx` REPLACE+WRITE_THROUGH) — never remove-then-rename.
- Recovery rebuilds live PROTECTED entries: CANCELLED /
UNKNOWN_FROZEN / CLOSED skip rebuild (recovery-terminal), but
PROTECTED rebuilds as an active slot with its journaled
economics intact — the runner treats PROTECTED as a live
position everywhere else (reclamation guard, flatness,
netting, HARD management), so restart must not demote it to
slotless.
- Recovery never orphans durable books: intents rebuild from
journal rows, so an absent-or-empty journal with `snap-*` or
`intent-*` artifacts on disk is torn state — recovery refuses
for human recovery, never success-with-zero-slots. A virgin
directory (no journal AND no slot books) still initializes as
genesis.
- FSM/epoch files are exact one-line shapes: trailing
non-empty lines are corruption (refuse, never rewrite).
`FileExists` stays the regular-file probe; `StatPath` maps
ENOENT/ENOTDIR to ABSENT and every other stat failure to
CORRUPT (fail closed, absent-vs-corrupt preserved).
- Daily rhythm honesty: the ops-day clock advances only after
the 00:00 chain verification succeeds (a failed verification
retries the next cycle, never skips a day). The clean-cycle
HARD truncations report failed writes instead of ignoring
them.
- Startup parsing is reject-before-overflow: CLI `cycles`
accumulates decimal digits with a checked bound (oversized input
refuses before any signed overflow), then the 0..1000000 window
applies as before.
- HALT lifecycle honesty: a failed HALT write latches HARD
in-memory (entries blocked) and reports the stop as UNPROVEN —
the caller exits nonzero and the supervisor/operator owns
recovery. No comment or log may claim an in-process retry that
the entry point does not perform.
- Clock split: wall clock owns audit timestamps/epochs/day
accounting; a monotonic clock owns S2 cadence/elapsed timeouts.
- Single-process ownership: one live runner per state directory
— Phase-4 prerequisite. The mutual-exclusion mechanism is an OS
process-lifetime ownership primitive held open for the whole
process life (`flock(LOCK_EX|LOCK_NB)` on POSIX, an exclusive
no-share open handle on Windows): a dead holder releases it in
the kernel, so stale takeover has no check-then-act window and
two concurrent takers serialize into exactly one owner. The PID
file is diagnostic only (owner identity for alerts), never the
arbiter. The runner object is non-copyable and non-movable
(mutable journal/slot state cannot be shared), and at most ONE
live mutable runner object may hold a directory: repeated
Recover on the SAME object stays idempotent, but a SECOND live
object for the same directory is refused — two independent
state machines must never share one ownership token (their
separate next_seq_/prev_hash_/slots_ would fork the journal).
A different thread of the same process contends like a foreign
process and loses. The lock-REFUSAL path mutates no shared state: no
journal row, no alert write, no file touch before ownership —
diagnostics go to stderr only (a refusing contender with a
fresh sequence/genesis must never append to a journal it does
not own). Once ownership is established, normal journal/alert
writes are allowed.
- Recovery-before-mutation lifecycle: the constructor alone
confers no mutation authority. `SubmitIntent()` and `Cycle()`
refuse unless a successful `Recover()` established ownership
(recovered AND lock held). Observers (`Find`, `slots`,
`Summarize`) stay unguarded.
- MEDIUM teardown certification: clearing an incident requires
BROKER-CONFIRMED flat (seam present + query ok + all zero) AND
a terminal FSM state successfully persisted AND revalidated
from disk in the same cycle AND a successful `ClearMediumFiles()`.
The `medium-incident-cleared` row is emitted ONLY when the
cleanup actually succeeded — never on a failed transition or a
failed clear. Missing/failing seam =
UNKNOWN/exposure-present: FLATTENED is retained, never cleared;
`AllFlat()` alone never certifies an incident over. The MEDIUM
re-entry path is unchanged (FLATTENED + live exposure clears +
fresh enter — the seam-present case).
- MEDIUM mint atomicity: a failed epoch mint can NEVER leave
`medium.txt = MEDIUM_ACTIVE` with no durable epoch. The mint
failure reverts the FSM so the next cycle retries; the
rollback write itself is checked — if it fails, the cycle
fails HARD and loud (never a successful return from a
stranded ACTIVE+no-epoch state). An ACTIVE file
with epoch 0 on ANY cycle (failed mint, lost incident file) is
never treated as healthy: the cycle fails loud until an
operator removes `medium.txt` for a fresh re-mint (safe: nothing
was ever sent under an unminted epoch). A failed single write
with the FSM still absent-or-empty retries next cycle (no
strand, no sweep: the sweep stays gated on epoch > 0).
- HARD slot-failure fallback: the position loop skips an ENTRY
symbol only when the slot path demonstrably owned it this cycle
(reconciled, not blind, not frozen-waiting); a blind/failed slot
falls through to broker-sized management under the SAME incident
id (the pre-flight keeps one close — the skip is an optimization,
not the mutual-exclusion mechanism). Frozen symbols are never
position-loop-closed (freeze = wait, exits stay alive via slots).

## 6.2 Reflection (after every closed trade)

Row appended: entry context_hash, exit context_hash, PnL, slippage vs intent,
regime, edge_family pick, conviction, what JEV got right/wrong (auto fields only —
no LLM prose in v1). Weekly human review aggregates: per-family hit rate,
per-regime PnL, threshold sensitivity. Threshold changes come from this review,
never from gut feel.

## 6.2a Outage playbook (the unattended cases)

The system runs with nobody watching, so every outage needs a default that is safe
without a human. In all of them: **exits, stops, TP, and reconcile keep working.**

| Failure | Detection | Automatic response | Human needed? |
|---|---|---|---|
| Feed gap / WS down | sequence gap, stale > 30 s | Entries vetoed; exits via REST; reconnect with backoff (S1) | Only if > 5 min |
| Broker outage | auth/API failure | Entries stop; exit attempts via REST; unresolvable drift → HARD kill (S9) | Yes, at HARD |
| JEV / LLM provider outage | timeout, 5xx, malformed | 1 retry → HOLD; S5 streak → SOFT kill | At S5 alert |
| Research plane down or stale | no fresh `features.jsonl` past TTL | Features **absent**; entries needing a TRIGGER feature HOLD (S6) | If > 6 h |
| Runaway research loop | R15 state-machine response (doc 08 §8.4 — per-symbol pause, systemic plane pause only on majority-in-window) | At pause |
| Conflicting agent conclusions | `disagreement=true` | HOLD (R14). Never averaged, never resolved by a tiebreak toward action | No |
| Spend spike | hourly projection | Tier 1 → 2 → 3 (R10), ending in MEDIUM kill + demote | At tier 3 |
| Calibration decay | trailing-200 Brier vs baseline | Entries halt, demote (R13) | Yes |
| Journal chain break | daily verify | HARD kill, forensics before restart | Yes |
| `STAGE` chain unverifiable | startup / cycle boundary | Fall back to G0_PAPER, alert | Yes |

The pattern behind every row: **new risk stops, old risk stays managed, and the
system fails toward paper.**

## 6.3 Daily ops rhythm (paper phase)

| Time (UTC) | Action |
|---|---|
| 00:00 | Roll journal files, verify hash chain, snapshot equity |
| Continuous | Feed + cycles; alerts on R5/S3/S5 |
| Every 15 min | Position reconcile (S2) |
| Hourly | AI spend projection + tier evaluation (R10); spend counter journaled |
| 08:00 | Human-readable daily summary (script-generated, no LLM): trades, PnL, holds by reason, JEV error count, **AI spend + 30-day projection + tier, cost per closed trade, spend/profit ratio (G2+), trailing-200 Brier vs baseline, features ingested/rejected, research cycles aborted, current stage** |
| Weekly | Calibration curves by regime; challenger scoreboard; `lessons.jsonl` review; ≤3 research proposals triaged (doc 11) |
| 23:55 | Replay sample (D1 check), back up journal + signals DB |

## 6.4 Monitoring (minimum viable, no dashboard v1)

- Liveness: heartbeat file touched every cycle in session; stale > 120 s in session
  → alert. Off-session silence is expected.
- Alerts (stdout + log + optional webhook): HALT triggers, reconcile drift,
  JEV error streak, feed gap > 5 min, any R-rule trip.
- Kill switch: `HALT` file in working dir → entries stop within 1 cycle.
  Deleting it does NOT resume (requires restart + flag). Deliberate friction.
  This is the SOFT level; MEDIUM and HARD are defined in doc 10 §10.3 and are
  drilled monthly.
- Because nobody is watching, alerts must reach a human out of band (webhook /
  push). An alert written only to a log file is not an alert in an unattended
  system. At minimum: HARD kill, stage demotion, R13, and spend tier 3.
- Autonomy metric: every human intervention is logged with its cause. The list of
  causes is the roadmap for what to automate next.

## 6.5 What "done" means

- [ ] Kill-switch drill passes (HALT → no entries in ≤1 cycle, exits unaffected).
- [ ] Reconcile drill passes (forced drift detected + synced + logged).
- [ ] Daily summary script runs from journal alone (no live system needed).
- [ ] Paper fill model frozen: BUY at mid + one full spread adverse, SELL at
  mid − one full spread adverse (min 1bp adverse move), full size,
  flagged `simulated` with exact side semantics (no partials in paper — without this, paper PnL is fiction).
- [ ] Journal retention 90 days local + daily backup; redaction verified by grep
  (no keys/tokens, signal texts ≤280 chars).
- [ ] 30 clean paper days with zero R-rule violations.
- [ ] Every row of the §6.2a outage table drilled at least once, with exits proven
      alive in each.
- [ ] Out-of-band alerting proven (a real notification arrives on a HARD kill).

## Locked decisions

- Journal-before-order for normal entries (emergency-exit exception above).
  No row = no send for entries, no exceptions beyond that paragraph.
- Exits never depend on JEV freshness, thesis freshness, or WS health
  (hard stop/TP local; REST fallback). Only entries may wait on data.
- Resume-from-HALT is manual. Always. So is every stage promotion (doc 10).
- Broker-status quarantine (frozen, per current Alpaca order-lifecycle docs):
  `done_for_day` and `calculated` (done for today — no further updates until
  the next session; the order MAY resume) and `replaced` (a replacement order
  under an unknown id may be live) are NEVER routed as generic DEAD. The id
  is burned — never re-sent under the same `client_order_id` — and the filled
  qty is authoritative-for-today but never folded (tomorrow's resumption would
  double-count). First sighting freezes the symbol + journals + alerts; the
  machine waits (UNKNOWN: reconcile, never mint, never terminal). Any
  next-session exposure is a NEW intent under a NEW id, operator-authorized,
  never automatic. (`canceled`/`expired`/`rejected` stay safe-DEAD: nothing
  live can duplicate them, so the normal burned-id remainder path applies.)
- Live-hold statuses (frozen): `held`, `stopped` (trade guaranteed, not yet
  occurred), and `accepted_for_bidding` are PENDING — live working orders.
  The runner waits (the pre-flight finds them under the stable id); it never
  re-issues blind and never terminals on them.
- Every outage default stops new risk and keeps old risk managed.
- Paper fill rule (LOCKED 2026-09-18): BUY at mid + one full spread adverse,
  SELL at mid − one full spread adverse (min 1bp), full size, flagged
  `simulated`, no partials in paper. Without
  this, paper PnL is fiction; G1→G2 compares live slippage against exactly
  this model (doc 10 §10.2).
