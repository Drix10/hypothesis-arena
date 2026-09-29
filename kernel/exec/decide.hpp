// Candidate -> order intent. Composes the candidate gate, position sizing
// (doc 03 3.3) and the deterministic veto. Pure: account, market and clock
// arrive as inputs; nothing here touches a file, a socket or a model.
#pragma once
#include <cstdint>
#include <map>
#include <string>

#include "../ingest/candidates.hpp"
#include "../jev_validate.hpp"
#include "../risk/veto.hpp"
#include "router.hpp"

namespace jev {
namespace exec {

struct DecideInput {
    const JVal* record = nullptr;        // parsed candidates.jsonl line
    ingest::CandidateTables tables;      // approved sleeves, allowlist, held
    int64_t now_ns = 0;
    risk::RiskSnapshot state;            // account + halt/kill/stage state
    int64_t risk_bp = 25;                // base risk budget (R)
    int64_t liquidity_cap_shares = 0;    // <= 0: none declared
    std::map<std::string, int64_t> held_qty;  // long shares by symbol
};

struct EntryDecision {
    bool proceed = false;
    std::string reason = "bad-inputs";   // frozen reason code when HOLD
    std::string limiter;                 // which sizing term bound the size
    std::string cid;                     // candidate id (also the intent id)
    std::string symbol;                  // candidate symbol once validated
    OrderIntent intent{};                // valid only when proceed
};

// BUY candidates are sized as entries; a SELL candidate for a held symbol
// closes the whole position as an EXIT intent.
EntryDecision Decide(const DecideInput& in);

}  // namespace exec
}  // namespace jev
