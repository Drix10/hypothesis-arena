// G0 paper runner (doc 06 6.1/6.2a/6.5, doc 10 10.1/10.3/10.5, doc 13 13.5).
//
// RouteStep stays the pure decision core (no clock, no I/O, no allocation).
// Everything else lives at this caller seam: durable journal, snapshots,
// freeze set, broker transport, stream framing, S2 cadence, HALT/kill,
// alerts, retention/backup/summary, emergency buffer.
//
// Transport, stream, clock and kill status are injected. With a null
// transport the adapter refuses every send. The startup gate requires a
// human-created, chain-verified STAGE file naming G0_PAPER with capital 0;
// otherwise entries are refused, while exits of open machines still
// reconcile. No sizing here: intents arrive authorized, exits size from
// intent.qty - closed.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "../broker/alpaca_paper.hpp"
#include "../exec/router.hpp"
#include "../kill/switch.hpp"
#include "events.hpp"
#include "store.hpp"

namespace jev {
namespace runner {

// Authoritative broker position (signed shares; +long/-short).
struct Position {
    char symbol[16]{};
    long long qty = 0;
};
// Injected seams.
struct RunnerDeps {
    broker::HttpTransport transport = nullptr;  // null = fail closed
    // Stream bytes: >0 = bytes read, 0 = none available, <0 = error.
    int (*stream_read)(void* ctx, char* buf, int n) = nullptr;
    void* stream_ctx = nullptr;
    const char* stream_endpoint = nullptr;  // config label (evidence)
    long long (*now_ns)(void* ctx) = nullptr;  // required
    void* clock_ctx = nullptr;
    // Monotonic clock for S2 cadence and timeouts. Null = follow now_ns.
    long long (*mono_ns)(void* ctx) = nullptr;
    void* mono_ctx = nullptr;
    void (*kill_inputs)(void* ctx, kill::KillInputs* out) = nullptr;
    void* kill_ctx = nullptr;
    bool restart_flag = false;  // operator restart-with-flag (sec. 6.4)
    long long s2_seconds = 900;  // REST reconcile period (doc 01)
    // Fills out[cap], returns count (0 = flat), <0 = lookup failed. Null =
    // seam absent: S2 reconciles known orders only, MEDIUM flattens local slots.
    int (*list_positions)(void* ctx, Position* out, int cap) = nullptr;
    void* positions_ctx = nullptr;
    // Gate for the MEDIUM position sweep: market open and spread normal.
    // False = unknown/closed: no sweep, retry next cycle.
    bool (*venue_gate)(void* ctx, bool* open, bool* spread_ok) =
        nullptr;
    void* venue_ctx = nullptr;
    // Optional pause between repair attempts. The venue releases shares held
    // by a cancelled bracket asynchronously, so an immediate repair POST can
    // be refused; null = no pause (tests).
    void (*sleep_ms)(void* ctx, int ms) = nullptr;
    void* sleep_ctx = nullptr;
};

struct RunnerConfig {
    std::string dir;  // journal-YYYYMMDD.jsonl, snap-<intent>.txt, freeze.txt,
                      // STAGE, HALT, alerts.jsonl, emergency.jsonl, backup/
    exec::VenueCtx venue;  // broker/account/context (caller-supplied)
    long long max_slots = 16;
};

// Per-intent durable slot: router machine plus follow-up inbox. The snapshot
// is persisted after every state change; the inbox is memory-only (recovery
// re-derives it via reconcile-first, never a resend). Stream events queue per
// slot (bounded FIFO) and are stamped one at a time, so several events for
// one order are never collapsed. Duplicates drop at the seam; overflow forces
// a REST lookup and an alert.
struct StreamEvt {
    char id[33]{};
    StreamKind kind = StreamKind::NONE;
    std::int64_t cumulative = 0;  // FILL: order.filled_qty
    bool force = false;           // LIFE/BUST: REST once stamped
};
struct Slot {
    exec::OrderIntent intent;
    exec::RouteMachine m;
    bool active = false;
    bool done = false;
    // Follow-up results from the last dispatch, fed next iteration.
    bool has_journal = false;
    bool journal_ok = false;
    bool has_ack = false;
    broker::OrderAck ack;
    bool has_query = false;
    broker::OrderQuery query;
    bool query_due = false;
    bool has_exit = false;
    broker::CloseResult exit_ack;
    bool has_cancel_result = false;
    bool cancel_accepted = false;
    bool cancel_failed = false;
    bool has_repair = false;
    bool repair_ok = false;
    bool executed_flag = false;
    // Forced REST answer (S2 / bust / life-event): consumed when the machine
    // reaches a state that reads it, else held (one deep). Failed lookups
    // refresh on the next due trigger.
    bool has_forced_q = false;
    broker::OrderQuery forced_q;
    // ESTABLISH_PROTECTION uses its own deterministic sub-id (the venue
    // rejects a duplicate client_order_id). Re-derived on recovery, so the
    // router snapshot format is unchanged.
    bool has_repair_id = false;
    char repair_coid[65]{};
    // Stream queue: arrival FIFO, one stamped per drive iteration.
    enum { kStreamQ = 8 };
    StreamEvt sev_[kStreamQ];
    int sev_n_ = 0;
    // A stamped FILL waits here as cumulative qty for the shaping step.
    bool has_shaping = false;
    std::int64_t shaping_qty = 0;
    bool stream_overflow_ = false;  // queue full: REST + alert
    bool intent_rowed = false;  // journal already holds the intent row (crash
                                // before first persist)
    bool frozen = false;  // durability failed across a mutating send: never
                          // drive blind; recovery then refuses
    // CANCEL_SENT re-checks are budget-free in the router; the runner bounds them.
    int confirm_tries = 0;
    bool absent_cancel = false;  // client-ID lookup proved absent
    bool cancel_via_query = false;  // final-cancel via lookup
    bool flatten_armed = false;  // MEDIUM flatten already issued
    char quar_[32]{};  // quarantine status already rowed (doc 06); runtime-only
    long long last_s2_ns = 0;
};

class G0Runner {
   public:
    G0Runner(const RunnerConfig& cfg, const RunnerDeps& deps);
    // Non-copyable: two objects on one journal/ownership token would fork it
    // (doc 06 6.1b).
    G0Runner(const G0Runner&) = delete;
    G0Runner& operator=(const G0Runner&) = delete;
    G0Runner(G0Runner&&) = delete;
    G0Runner& operator=(G0Runner&&) = delete;
    // Releases this instance's directory lock (close + unregister).
    ~G0Runner();
    // STAGE gate -> journal load+verify (break = HARD, alert, refuse) ->
    // snapshot+intent load per unterminated intent -> drain emergency buffer ->
    // reconcile-first (first cycle forces a broker lookup; sends pre-flight by
    // stable id). False = refuse to run (reason static).
    bool Recover(const char** reason);
    // Submit an authorized intent. ENTRY is gated on bad-id / cap / kill /
    // HALT / stage / freeze / universe-cap. EXIT bypasses freeze, stage and the
    // entry slot cap (old risk stays managed) and stops only at the 2x hard
    // ceiling behind the no-realloc guarantee. An intent id is immutable:
    // reuse with different economics, or re-registering a journaled intent,
    // is refused. False = refused (reason static).
    bool SubmitIntent(const exec::OrderIntent& in, const char** reason);
    // One full cycle: stream drain -> slots (bounded iterations) ->
    // S2 -> HALT/kill/stage re-check. Returns false on HARD stop.
    bool Cycle(long long now_ns);
    // Summary from the journal alone.
    bool Summarize(Summary* out) const;
    std::size_t slots() const { return slots_.size(); }
    const Slot* Find(const char* intent_id) const;
    const std::string& cursor() const { return cursor_; }
    // Durable stream cursor: last processed venue ULID, "" when none. Every
    // parsed event advances it, matched to a slot or not (the SSE stream is
    // account-level); foreign events move only the cursor. Live SSE resumes
    // with it as since_id. A failed cursor write fails the cycle and keeps the
    // dirty bit for retry.
   private:
    RunnerConfig cfg_;
    RunnerDeps deps_;
    broker::AlpacaPaperAdapter adapter_;
    std::vector<Slot> slots_;
    std::uint64_t next_seq_ = 0;
    std::string prev_hash_;
    // Take list of the last successful AttributeClosedQty, used only by the
    // UnattributeClosedQty rollback when the dependent chain note fails
    // (doc 06 6.1b).
    struct AttrTake {
        std::size_t slot;
        long long take;
    };
    AttrTake attr_takes_[64];
    std::size_t n_attr_takes_ = 0;
    bool stage_ok_ = false;
    bool halt_announced_ = false;
    long long last_cycle_ns_ = 0;
    SseParser sse_;
    long long sse_seen_ = 0;  // parser errors already acted on
    // Sticky HARD latch: set when the HALT write fails so a process that could
    // not durably halt never resumes entries. Across a restart the HALT file
    // is the authority.
    bool hard_latched_ = false;
    std::string cursor_;      // last stamped ULID (durable)
    bool cursor_dirty_ = false;
    // Directory-lock take by this instance; a second live object per
    // directory is refused in TakeDirLock.
    bool lock_took_ = false;
    std::string lock_path_;  // directory taken (empty if none)
    // Set only by a successful Recover; SubmitIntent and Cycle refuse without
    // it (doc 06 6.1b).
    bool recovered_ = false;
    long long last_pos_ns_ = 0;   // account position check clock
    long long last_ops_day_ = 0;  // 6.3 rhythm clock (0 = run now)

    std::string P(const char* name) const;
    std::string SnapPath(const char* intent_id) const;
    std::string IntentPath(const char* intent_id) const;
    bool JournalWrite(const char* kind, const char* intent_id,
                      const char* body, long long now_ns);
    bool EmergencyAppend(const journal::Row& r);
    bool DrainEmergency();
    bool PersistSlot(Slot& s);
    // Validated capacities (1..64 entries, 1..128 exits).
    int EntryCap() const;
    int ExitCap() const;
    // Monotonic ns (mono clock when wired, else the wall default).
    long long MonoNs(long long wall_ns) const;
    // Process ownership lock for the state directory.
    bool TakeDirLock();
    // True once a HALT file exists or the in-memory latch fired. Entry gating
    // and kill evaluation use this, not the bare file probe.
    bool HardHalted() const;
    // Fills ps (cap) and sets *n. Any n outside 0..cap is an unavailable
    // snapshot (false).
    bool SnapPositions(Position* ps, int cap, int* n) const;
    bool LoadSlot(Slot& s, const char* intent_id);
    // True when broker-mutating transport fired (POST/DELETE), so the persist
    // that follows is load-bearing.
    bool Dispatch(Slot& s, const exec::RouteOut& o, long long now_ns);
    void MaybeForceQuery(Slot& s, long long now_ns);
    bool FlattenOnMedium(Slot& s, long long now_ns);
    bool EntriesAllowedNow() const;
    // Ops journal row for HARD/MEDIUM/S2/ops events (not order flow).
    bool OpsRow(const char* kind, const char* intent_id,
                const char* text, long long now_ns);
    void HardManageSlot(Slot& s, long long epoch, long long now_ns,
                        bool* owned);
    bool HardStop(long long now_ns, const char* why,
                  bool halt_at_entry);
    // Single close under a stable hard id, pre-flighted with a GET: sufficient
    // fill or live order is adopted, never resent; a short terminal fill
    // leaves a deterministic remainder hard-<epoch>-<SYM>-<qty>; 404 POSTs
    // once (chain noted write-ahead); failure journals and alerts. The
    // remainder derives from the original chain request (hard-chain.txt), not
    // from a burned order's fill, and the broker need caps the send. Shared by
    // the slot path, the slotless-position path and EXIT replacement.
    bool HardCloseOnce(const char* symbol, long long qty,
                       broker::OrderSide eside, const char* hid,
                       long long epoch, const char* scope_intent,
                       long long now_ns);
    // Original hard-order chain (doc 06 6.1b): hard-chain.txt rows
    // `<tag> <requested> <attributed>`, noted write-ahead before every POST.
    // The whole file is validated: requested per tag immutable, attributed
    // nondecreasing and within 0..requested, no malformed or conflicting rows
    // (exact duplicates are crash-retry evidence). HardChainState is true iff
    // the file is valid and the tag has a row; a missing file is valid-empty.
    // HardChainOk reports whole-file validity (404-path gate).
    // NoteHardChain false = row not persisted; the caller must not POST.
    bool HardChainState(const char* tag, long long* req,
                        long long* attr);
    bool HardChainOk();
    bool NoteHardChain(const char* tag, long long requested,
                       long long attributed);
    // Incident epochs (doc 06 6.1b): MEDIUM mints once per medium-enter; HARD
    // mints unless the incident continues (HALT present at entry). Clearing
    // HALT ends the incident. 0 = no incident on file, and also the
    // write-failure return (no epoch file, no new identity).
    long long MediumEpoch() const;
    long long MintMediumEpoch(long long now_ns);
    long long HardEpochFor(long long now_ns, const char* reason,
                           bool halt_at_entry);
    // Single close-owner invariant (doc 06 6.1b): a symbol is covered while an
    // active EXIT/flatten works it or an ENTRY flatten is armed/landed; the
    // broker sweep then reconciles but does not send.
    bool LocalCloseCovers(const char* symbol) const;
    // Covering EXIT slot indices on a symbol and their summed remaining qty.
    // The caller queries every one before computing an uncovered remainder.
    int CollectCoverExits(const char* symbol,
                          std::vector<std::size_t>* idx,
                          long long* total);
    // HARD for one EXIT slot: live or filled-full is adopted; dead or absent
    // is replaced under the incident hard id. Returns the qty still exposed.
    long long HardAdoptExit(Slot& s, long long epoch,
                            long long now_ns);
    // Quarantine sighting (doc 06): the first per slot per status freezes the
    // symbol, journals and alerts; repeats stay silent.
    void NoteQuarantine(Slot& s, const broker::OrderQuery& q,
                        const char* scope, long long now_ns);
    void NoteQuarantineSym(const char* symbol, const char* status,
                           const char* scope, long long now_ns);
    // True when a live incident-sweep close already owns this symbol.
    bool SweepLiveBlocks(const char* symbol,
                         broker::OrderSide local_close_side,
                         long long epoch);
    // True when the entry's flatten EXIT resolved non-closed: ownership
    // lapses to the incident sweep (the intent id is single-use).
    bool FlattenResolvedNotClosed(const Slot& s) const;
    // Signed broker position for one symbol. False when the seam is absent or
    // failing; unknown is never treated as flat.
    bool BrokerQty(const char* symbol, long long* out);
    // A live ENTRY slot with provable open covers its symbol; the position
    // sweep skips it.
    bool CoveredBySlot(const char* symbol) const;
    // Slotless open position under HARD: no economics on file, so flatten
    // once (pre-flighted), journal and alert.
    void HardManagePosition(const char* symbol, long long qty,
                            long long epoch, long long now_ns);
    // Attribute an authoritative close quantity to same-symbol ENTRY slots,
    // oldest first; leftover is dropped. Two-phase: takes are computed, then
    // each slot is mutated and persisted. On any persist failure the takes
    // roll back (and written slots are re-persisted best-effort) and false is
    // returned; the caller must not advance dependent durable state (doc 06
    // 6.1b).
    bool AttributeClosedQty(const char* symbol, long long qty,
                            long long now_ns);
    // Inverse of the last successful AttributeClosedQty; call only right
    // after it when the dependent chain note failed (doc 06 6.1b).
    void UnattributeClosedQty(const char* symbol,
                              long long now_ns);
    // Incident-scoped remainder id hard-<epoch>-<SYM>-<qty>; pure, and
    // distinct from the primary hard id (no qty suffix).
    static std::string HardRemainderTag(long long epoch,
                                        const char* symbol,
                                        long long rem);
    // False when the incident is stranded id-less (double persist failure, or
    // ACTIVE with epoch 0); the caller fails the cycle.
    bool MediumPass(long long now_ns);
    // Broker-confirmed flat (doc 06 6.1b): seam present, query ok, every
    // position zero. A missing or failing seam is unknown (false).
    // LocalFlat is the local-only half.
    bool BrokerConfirmedFlat();
    bool LocalFlat();
    // Live exposure for MEDIUM re-entry: a local ENTRY open or any broker
    // position; an unavailable seam counts as exposure (doc 06 6.1b).
    bool MediumHasExposure();
    // Drops the FSM and epoch files; false = retry next cycle.
    bool ClearMediumFiles();
    bool VenueOk(bool* open, bool* spread_ok);
    int LocalNet(const char* symbol) const;  // signed local open, PROTECTED
                                             // included
    void PositionCheck(long long now_ns);
    bool AllFlat();
    // Terminal slots leave the vector at the next Cycle/Submit; history stays
    // in journal and snapshots.
    void ReclaimDone();
    // 6.3 daily rhythm on day roll (verified chain, dated journal copy, 90-day
    // retention, backup, summary). False = chain break (HARD).
    bool DailyOps(long long now_ns);
};

// Process liveness for the directory lock (lock helper; also a
// unit-tested seam). True for a live pid, false for dead/garbage.
bool PidAlive(long long pid);
}  // namespace runner
}  // namespace jev
