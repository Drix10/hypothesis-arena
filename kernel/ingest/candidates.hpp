// candidates.jsonl per-record gate. Pure: the caller supplies the
// parsed record, the approved-strategy/allowlist/held tables and the clock.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "../wire.hpp"

namespace kernel {
namespace ingest {

enum class CandReject {
    OK = 0,
    SHAPE,        // not an object / unknown key / wrong type
    SCHEMA,       // schema != "candidate"
    CID,          // recompute mismatch or malformed cid
    STRATEGY,       // strategy_id not approved
    ALLOWLIST,    // symbol not on the R19 allowlist
    FRESHNESS,    // future stamp or older than the strategy window
    SIDE,         // BUY-to-open / SELL-to-close-held only
    N
};
inline const char* CandRejectStr(CandReject c) {
    switch (c) {
        case CandReject::SHAPE: return "cand-shape";
        case CandReject::SCHEMA: return "cand-schema";
        case CandReject::CID: return "cand-cid-mismatch";
        case CandReject::STRATEGY: return "cand-strategy-unapproved";
        case CandReject::ALLOWLIST: return "cand-not-allowlisted";
        case CandReject::FRESHNESS: return "cand-stale-or-future";
        case CandReject::SIDE: return "cand-side-policy";
        default: return "ok";
    }
}

struct ApprovedStrategy {
    std::string id;       // == candidate.strategy_id
    int64_t window_s = 0;  // freshness window, must be > 0
};
struct CandidateTables {
    std::vector<ApprovedStrategy> strategies;
    std::vector<std::string> allowlist;  // exact symbols
    std::vector<std::string> held;       // symbols currently long
};
struct CandOutcome {
    bool accepted = false;
    CandReject code = CandReject::OK;
    std::string cid;     // set when the CID recomputed OK
    std::string symbol;  // set when accepted
    std::string side;    // "BUY" | "SELL" when accepted
    int64_t entry_cents = 0;  // parsed from the exact price strings
    int64_t stop_cents = 0;
    int64_t tp_cents = 0;
    std::string exit_rule;  // as sent
};

CandOutcome ValidateCandidate(const JVal& rec, const CandidateTables& t,
                              int64_t now_ns);

}  // namespace ingest
}  // namespace kernel
