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
    // Stream staging (per-cycle): a pending ULID stamps position
    // first; fills shape per state after the stamp; LIFE/BUST set
    // force_flag (REST now, once stamped).
    char pending_event[33]{};
    bool has_stream_fill = false;
    std::int64_t stream_fill_qty = 0;
    bool force_flag = false;
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
    // Submit an authorized intent (ENTRY gated on kill/HALT/stage/
    // freeze/universe-cap; EXIT always accepted except frozen
    // symbol/stage-refusal). False = refused (reason static).
    bool SubmitIntent(const exec::OrderIntent& in, const char** reason);
    // One full cycle: stream drain -> slots (bounded iterations) ->
    // S2 -> HALT/kill/stage re-check. Returns false on HARD stop.
    bool Cycle(long long now_ns);
    // Summary-from-journal (no live system needed).
    bool Summarize(Summary* out) const;
    std::size_t slots() const { return slots_.size(); }
    const Slot* Find(const char* intent_id) const;

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

    std::string P(const char* name) const;
    std::string SnapPath(const char* intent_id) const;
    std::string IntentPath(const char* intent_id) const;
    bool JournalWrite(const char* kind, const char* intent_id,
                      const char* body, long long now_ns);
    bool EmergencyAppend(const journal::Row& r);
    bool DrainEmergency();
    bool PersistSlot(Slot& s);
    bool LoadSlot(Slot& s, const char* intent_id);
    void Dispatch(Slot& s, const exec::RouteOut& o, long long now_ns);
    void MaybeForceQuery(Slot& s, long long now_ns);
    bool FlattenOnMedium(Slot& s, long long now_ns);
    bool EntriesAllowedNow() const;
};

}  // namespace runner
}  // namespace jev
