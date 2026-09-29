// Paper decision loop: candidates.jsonl -> Decide -> SubmitIntent.
// All I/O is injected. Every candidate leaves one line in decisions.jsonl,
// proceed or hold, so the audit trail never depends on the order path.
#pragma once
#include <cstdint>
#include <functional>
#include <set>
#include <string>

#include "../ingest/candidates.hpp"
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

struct LoopConfig {
    std::string dir;
    std::set<int64_t> holidays;
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
    G0Runner& runner_;
    LoopIO io_;
    LoopConfig cfg_;
    LoopStats stats_;
    SettleBook book_;  // proceeds of exits this loop submitted (R18)
};

}  // namespace runner
}  // namespace jev
