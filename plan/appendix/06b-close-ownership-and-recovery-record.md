# Appendix 06b — Close ownership, incident identity, and recovery record (frozen)

Moved VERBATIM from doc 06 §6.1b in the freeze-v3 rebaseline (2026-09-28).
This is the H1 implementation contract as accepted through the audit
audit rounds (Addendums 108–131, in git history).
Doc 06 keeps the one-paragraph contract; this file keeps every rule.
Nothing here was edited; a change to any rule is a doc edit + version
bump + fresh paper window, exactly as before the move.

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
- Order-identity determinism: the frozen id recipe reads
length-bounded field inputs (broker 32 / account 32 / context
64 / symbol 16 / intent 64). A full-width unterminated field
truncates instead of hashing stack garbage — nondeterministic
ids across restarts would break pre-flight dedupe and risk
re-sends under forked identities.
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
journal rows, so durable books that claim LIVE risk with no
covering journal intent row are torn state — recovery refuses
for human recovery, never success-with-zero-slots. Live risk
means a snapshot past the pre-send states (anything but
IDLE / JOURNAL_PENDING / recovery-terminal) or a snapshot
with no matching intent file. Intent-only pre-send leftovers
(the submit-before-first-cycle crash window) and terminal
books keep their established ignore/resume paths, and a
virgin directory (no journal AND no slot books) still
initializes as genesis.
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
- Per-book orphan coverage (round-5): orphan coverage is PER
DURABLE BOOK, never global. Every snap book that claims live
risk needs its OWN covering journal intent row; a live book
with no covering row refuses recovery
(`recover-orphaned-state`) even when the journal holds
legitimate rows for OTHER books (a mixed journal must not
launder an orphan into success). Journaled books keep their
existing refusal rules (corrupt/half/missing durable state),
and the intent-only pre-first-cycle window, terminal-book
paths, and virgin-genesis initialization are unchanged.
- Recovery revokes authority on entry (round-5): `Recover()`
clears mutation authority FIRST, before any path can fail —
any failed recovery leaves the object with NO mutation
authority, even after an earlier success. Only a FULL success
(validation + rebuild + attribution) sets it. Same-object
repeated Recover stays idempotent, success-after-fix restores
authority, and the held lock alone never implies recovery
authority.
- Terminal attribution is never dropped (round-5): a
terminal EXIT whose closed quantity cannot be durably
attributed keeps its accounting obligation. Recovery
re-attribution failure refuses recovery (no `recovered_`);
the in-cycle path retains the EXIT (never done, never
reclaimable) so the next cycle retries deterministically
(two-phase rollback inside the attribution makes the retry
exact). No replacement close is submitted for an attribution
persistence failure, and no broker-derived local accounting
is manufactured.
