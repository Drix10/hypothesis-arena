// H1 integration — G0 paper runner (doc 06 sec. 6.1/6.2a/6.5,
// doc 10 sec. 10.1/10.3/10.5, doc 13 sec. 13.5 Slice H1).
//
// Ownership boundary (frozen): RouteStep REMAINS the pure decision
// core — same state + same observation = same action, no clock, no
// I/O, no allocation on that path. EVERYTHING else lives here at
// the caller seam: durable journal + snapshots + freeze set, broker
// transport calls, stream framing/mapping, S2 cadence, HALT/kill,
// alerts, retention/backup/summary, emergency buffer. std::string /
// std::vector are allowed here (cycle path, never tick-hot).
//
// Transport/stream/clock/kill-status are INJECTED (fakes in tests;
// live HTTPS + socket wiring is Phase 4 — with a null transport the
// adapter refuses every send, so this binary CANNOT order by
// construction until Phase 4 wires it). G0_PAPER only: the startup
// gate requires a human-created, chain-verified STAGE file naming
// G0_PAPER with capital 0; anything else refuses to drive entries
// (exits of already-open machines still reconcile — old risk stays
// managed). No sizing lives here: intents arrive authorized (risk
// path owns size); exits size from intent.qty - closed only.
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
// Injected seams (deterministic under test, live in Phase 4).
struct RunnerDeps {
    broker::HttpTransport transport = nullptr;  // null = fail closed
    // Stream bytes: >0 = bytes read, 0 = none available, <0 = error.
    int (*stream_read)(void* ctx, char* buf, int n) = nullptr;
    void* stream_ctx = nullptr;
    const char* stream_endpoint = nullptr;  // config label (evidence)
    long long (*now_ns)(void* ctx) = nullptr;  // REQUIRED (no clock in core)
    void* clock_ctx = nullptr;
    void (*kill_inputs)(void* ctx, kill::KillInputs* out) = nullptr;
    void* kill_ctx = nullptr;
    bool restart_flag = false;  // operator restart-with-flag (sec. 6.4)
    long long s2_seconds = 900;  // 15-min REST reconcile (doc 01)
    // Authoritative position list: fills out[cap], returns count
    // (0 = flat), <0 = lookup failed. Null = seam absent (Phase 4:
    // S2 is known-order reconciliation only, MEDIUM flattens local
    // slots only — documented bootstrap limits).
    int (*list_positions)(void* ctx, Position* out, int cap) = nullptr;
    void* positions_ctx = nullptr;
    // Venue gate for the MEDIUM position sweep: open + spread
    // normal. False = unknown/closed (fail closed: no sweep,
    // protection stays, retry next cycle). Null = seam absent.
    bool (*venue_gate)(void* ctx, bool* open, bool* spread_ok) =
        nullptr;
    void* venue_ctx = nullptr;
};

struct RunnerConfig {
    std::string dir;  // flat layout (created by the operator):
                      // journal-YYYYMMDD.jsonl, snap-<intent>.txt,
                      // freeze.txt, STAGE, HALT, alerts.jsonl,
                      // emergency.jsonl, backup/
    exec::VenueCtx venue;  // broker/account/context (caller-supplied)
    long long max_slots = 16;
};

// Per-intent durable slot (machine + follow-up inbox). Snapshot file
// persists m after every state-changing step; inbox is memory-only
// (a crash re-derives it via reconcile-first — never a resend).
// Stream events queue per slot (bounded FIFO, arrival order): every
// event is stamped individually — the seam never collapses several
// same-order events into one observation (40+30 stays 70, never the
// last write winning). Duplicates (id == applied ULID, or already
// queued) drop at the seam; overflow forces REST + alerts instead
// of silently losing position.
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
    // Follow-up results from the last dispatch (fed next iteration).
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
    // Forced REST answer (S2 / bust / life-event): consumed when the
    // machine reaches a state that reads it, else held (one deep).
    // Failed lookups refresh on the next due trigger (never a stale
    // failure blocking fresh reconciliation).
    bool has_forced_q = false;
    broker::OrderQuery forced_q;
    // Stream queue (arrival FIFO, one stamped per drive iteration).
    enum { kStreamQ = 8 };
    StreamEvt sev_[kStreamQ];
    int sev_n_ = 0;
    // A stamped FILL waits here as cumulative qty for the shaping
    // iteration (stamp and shape are separate RouteSteps).
    bool has_shaping = false;
    std::int64_t shaping_qty = 0;
    bool stream_overflow_ = false;  // queue full: REST + alert
    bool intent_rowed = false;  // journal holds the intent row
                                // (crash pre-first-persist): IDLE skips
                                // WRITE, JOURNAL_PENDING attests it
    bool frozen = false;  // durability failed across a mutating
                          // send: never drive blind (fail closed +
                          // loud); crash recovery then refuses rather
                          // than risk a double-send
    // Confirm-loop guard (CANCEL_SENT re-checks are budget-free in
    // the router; the runner bounds them and fails explicitly).
    int confirm_tries = 0;
    bool absent_cancel = false;  // client-ID lookup proved absent
    bool cancel_via_query = false;  // final-cancel via lookup
    bool flatten_armed = false;  // MEDIUM flatten already issued
    long long last_s2_ns = 0;
};

class G0Runner {
   public:
    G0Runner(const RunnerConfig& cfg, const RunnerDeps& deps);
    // Startup: STAGE gate -> journal load+verify (break = HARD,
    // alert, refuse) -> snapshot+intent load per unterminated intent
    // -> drain emergency buffer -> reconcile-first (S2-due forces a
    // real broker lookup on the first cycle; sends pre-flight by
    // stable id, so recovery can never double-send). False =
    // refuse to run (reason static).
    bool Recover(const char** reason);
    // Submit an authorized intent. ENTRY gated on bad-id / cap /
    // kill / HALT / stage / freeze / universe-cap. EXIT bypasses
    // freeze + stage (old risk stays managed when STAGE demotes or
    // a symbol freezes — the frozen operating rule); both need a
    // filesystem-safe id, and an intent id is permanently bound to
    // one immutable intent (reuse with different economics, or any
    // re-registration of a journaled intent, is refused). False =
    // refused (reason static).
    bool SubmitIntent(const exec::OrderIntent& in, const char** reason);
    // One full cycle: stream drain -> slots (bounded iterations) ->
    // S2 -> HALT/kill/stage re-check. Returns false on HARD stop.
    bool Cycle(long long now_ns);
    // Summary-from-journal (no live system needed).
    bool Summarize(Summary* out) const;
    std::size_t slots() const { return slots_.size(); }
    const Slot* Find(const char* intent_id) const;
    const std::string& cursor() const { return cursor_; }
    // Durable stream cursor (last stamped venue ULID, "" when
    // none): the Phase-4 transport resumes live SSE with this as
    // since_id (replay, not re-subscribe-from-now). Missing file =
    // empty cursor (first run); cursor loss only replays more (
    // duplicates drop at the seam), never less.

   private:
    RunnerConfig cfg_;
    RunnerDeps deps_;
    broker::AlpacaPaperAdapter adapter_;
    std::vector<Slot> slots_;
    std::uint64_t next_seq_ = 0;
    std::string prev_hash_;
    bool stage_ok_ = false;
    bool halt_announced_ = false;
    long long last_cycle_ns_ = 0;
    SseParser sse_;
    long long sse_seen_ = 0;  // parser errors already acted on
    std::string cursor_;      // last stamped ULID (durable)
    bool cursor_dirty_ = false;
    long long last_pos_ns_ = 0;  // account position check clock
    long long last_ops_day_ = 0;  // §6.3 rhythm clock (0 = run now)

    std::string P(const char* name) const;
    std::string SnapPath(const char* intent_id) const;
    std::string IntentPath(const char* intent_id) const;
    bool JournalWrite(const char* kind, const char* intent_id,
                      const char* body, long long now_ns);
    bool EmergencyAppend(const journal::Row& r);
    bool DrainEmergency();
    bool PersistSlot(Slot& s);
    bool LoadSlot(Slot& s, const char* intent_id);
    // Dispatch returns true when broker-mutating transport fired
    // (POST/DELETE — the persist that follows is load-bearing).
    bool Dispatch(Slot& s, const exec::RouteOut& o, long long now_ns);
    void MaybeForceQuery(Slot& s, long long now_ns);
    bool FlattenOnMedium(Slot& s, long long now_ns);
    bool EntriesAllowedNow() const;
    // Ops journal row (drift-directive/reconcile/demotion for
    // HARD/MEDIUM/S2/ops — caller-owned events, never order flow).
    bool OpsRow(const char* kind, const char* intent_id,
                const char* text, long long now_ns);
    void HardManageSlot(Slot& s, long long now_ns);
    bool HardStop(long long now_ns, const char* why);
    void MediumPass(long long now_ns);
    bool VenueOk(bool* open, bool* spread_ok);
    int LocalNet(const char* symbol) const;  // signed local open
    void PositionCheck(long long now_ns);
    bool AllFlat();
    // Terminal slots leave the vector at the next Cycle/Submit
    // (history stays in journal + snapshots; capacity is for live
    // work, not memory of the dead). Find-after-terminal within
    // the SAME cycle still sees the slot.
    void ReclaimDone();
    // §6.3 daily rhythm on day roll (verified chain, dated journal
    // copy, 90-day retention, backup, appended summary). False =
    // chain break (HARD, like Recover).
    bool DailyOps(long long now_ns);
};

}  // namespace runner
}  // namespace jev
