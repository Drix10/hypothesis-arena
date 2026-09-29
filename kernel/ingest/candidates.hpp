// candidates.jsonl per-record gate (doc 04 2b). Pure: the caller supplies the
// parsed record, the approved-sleeve/allowlist/held tables and the clock.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "../jev_wire.hpp"

namespace jev {
namespace ingest {

enum class CandReject {
    OK = 0,
    SHAPE,        // not an object / unknown key / wrong type
    SCHEMA,       // schema != "c1"
    CID,          // recompute mismatch or malformed cid
    SLEEVE,       // strategy_version not approved
    ALLOWLIST,    // symbol not on the R19 allowlist
    FRESHNESS,    // future stamp or older than the sleeve window
    SIDE,         // BUY-to-open / SELL-to-close-held only
    N
};
inline const char* CandRejectStr(CandReject c) {
    switch (c) {
        case CandReject::SHAPE: return "cand-shape";
        case CandReject::SCHEMA: return "cand-schema";
        case CandReject::CID: return "cand-cid-mismatch";
        case CandReject::SLEEVE: return "cand-sleeve-unapproved";
        case CandReject::ALLOWLIST: return "cand-not-allowlisted";
        case CandReject::FRESHNESS: return "cand-stale-or-future";
        case CandReject::SIDE: return "cand-side-policy";
        default: return "ok";
    }
}

struct ApprovedSleeve {
    std::string id;       // == candidate.strategy_version
    int64_t window_s = 0;  // freshness window, must be > 0
};
struct CandidateTables {
    std::vector<ApprovedSleeve> sleeves;
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
    std::string exit_profile;  // exit_profile_version, as sent
};

CandOutcome ValidateCandidate(const JVal& rec, const CandidateTables& t,
                              int64_t now_ns);

}  // namespace ingest
}  // namespace jev
