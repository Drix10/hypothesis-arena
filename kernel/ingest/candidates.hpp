// K6 — candidates.jsonl per-record gate (doc 04 §2b, c1 wire record).
// Pure validation: the caller parses with the frozen ParseJson and passes
// the manifest-derived approved-sleeve and allowlist tables plus a held-
// symbol predicate. No I/O, no clock reads (now_ns is an input), no state.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "../jev_validate.hpp"

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
};

CandOutcome ValidateCandidate(const JVal& rec, const CandidateTables& t,
                              int64_t now_ns);

}  // namespace ingest
}  // namespace jev
