// Paper decision loop: candidates.jsonl -> Decide -> SubmitIntent.
// All I/O is injected. Every candidate is logged to decisions.jsonl, proceed
// or hold; a failed log write leaves the line unconsumed for the next tick.
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>

#include "../exec/decide.hpp"
#include "../ingest/candidates.hpp"
#include "account.hpp"
#include "runner.hpp"
#include "settle.hpp"

namespace jev {
namespace runner {

struct LoopIO {
    // Paper trading REST: method, path -> status and body. False = transport
    // failure (treated as no information, never as an empty account).
    std::function<bool(const char* method, const std::string& path,
                       int* status, std::string* body)> rest;
    // Market-data GET: path -> body. False = unavailable.
    std::function<bool(const std::string& path, std::string* body)> data;
};

// Account-level kill signals the loop feeds to the runner's kill gate.
// The owner (main) sets RunnerDeps.kill_inputs = KillFeedInputs and
// kill_ctx = &feed, and hands the same feed to LoopConfig. Only the loop
// writes it, and only ever to true: absent data cannot set it and nothing
// here clears it (an operator removes dd-kill.latch and restarts).
struct KillFeed {
    bool drawdown_r5 = false;  // equity <= -15% from hwm.txt, latched
};
inline void KillFeedInputs(void* ctx, kill::KillInputs* out) {
    if (!ctx || !out) return;
    if (static_cast<const KillFeed*>(ctx)->drawdown_r5)
        out->drawdown_r5 = true;
}

struct LoopConfig {
    std::string dir;
    KillFeed* kill_feed = nullptr;  // optional; null = no drawdown kill wiring
    std::set<int64_t> holidays;
    std::set<int64_t> early_closes;  // 13:00 ET closes (optional)
    ingest::CandidateTables tables;  // approved sleeves + allowlist
    int64_t risk_bp = 25;
    std::string feed = "iex";
};

struct LoopStats {
    int seen = 0, proceeded = 0, held = 0, skipped_long = 0;
    bool account_ok = false;
};

class PaperLoop {
   public:
    PaperLoop(G0Runner& runner, LoopIO io, LoopConfig cfg);
    // One pass: read the account, process new candidate lines, cycle the
    // runner. Returns the runner's Cycle result (false = HARD stop).
    bool Tick(int64_t now_ns);
    const LoopStats& stats() const { return stats_; }

   private:
    void RecordProceeds(const exec::EntryDecision& d, int64_t entry_cents,
                        const std::vector<PositionView>& held, int64_t now_s);
    void RecordInflight(const std::string& sym, int64_t entry_cents);
    std::map<std::string, int64_t> inflight_;  // symbol -> entry ref cents
    std::set<std::string> warned_;             // unprotected-position alerts sent
    std::set<std::string> booked_;             // cids with proceeds booked
    G0Runner& runner_;
    LoopIO io_;
    LoopConfig cfg_;
    LoopStats stats_;
    bool dd_latched_ = false;          // -15% from hwm seen (persisted)
    int64_t daily_loss_day_ = -1;      // session day of a >3% daily-loss trip
    SettleBook book_;  // proceeds of exits this loop submitted (R18)
};

}  // namespace runner
}  // namespace jev
