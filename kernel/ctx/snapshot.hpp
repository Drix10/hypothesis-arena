// Slice G — frozen Snapshot + context_hash (doc 04 sec. 4.2.3).
// Pure data + canonical serialization. This slice DEFINES the shape
// and the digest; provider sections (marks/session from F, portfolio
// from H1, indicators/regime from future providers) fill it through
// checked setters. Unset sections are explicit via present_mask —
// never silent, never defaulted into authority. context_hash is
// SHA-256 over the canonical bytes of ALL of it, presence bits
// included: a partial snapshot hashes differently from a complete
// one, so replay with a different completeness can never collide.
// context_hash != state_hash (frozen distinction, doc 03 sec. 3.5a).
//
// RESOURCE BOUNDARY (doc 04 sec. 4.3): Snapshot assembly, canonical
// serialization, and hashing are CYCLE path (once per decision cycle,
// bounded output <= 4KiB asserted in test). They are NOT tick-hot and
// never claimed zero-alloc. The zero-alloc path is the tick path:
// feed TickRing::Push + gap Notes + session marking, proven by
// feed/test_noalloc_feed (wrapped-malloc counter reads zero). H1 must
// not place ContextHash on the per-tick path without its own proof.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ctx {

// Frozen vocabularies (mirror P3.3/jev_state + doc 09 sec. 9.3).
inline bool IsRegime(const std::string& s) {
    return s == "trend" || s == "range" || s == "volatile";
}
inline bool IsCalib(const std::string& s) {
    return s == "pass" || s == "insufficient" || s == "breach";
}
inline bool IsSourceState(const std::string& s) {
    return s == "fresh" || s == "stale" || s == "absent" ||
           s == "invalid";
}

// Presence bits: which provider sections are actually filled.
enum Present : uint32_t {
    kMarks = 1u << 0,
    kSession = 1u << 1,
    kIndicators = 1u << 2,
    kRegime = 1u << 3,
    kSentiment = 1u << 4,
    kVarCorr = 1u << 5,
    kPortfolio = 1u << 6,
    kFeatures = 1u << 7,
    kSources = 1u << 8,
    kStage = 1u << 9,
    kResearch = 1u << 10,
    kCalib = 1u << 11,
};

struct Mark {
    std::string symbol;  // [A-Z0-9.]{1,12}
    int64_t mark_ud = 0;
    int64_t bid_ud = 0;
    int64_t ask_ud = 0;
};

struct SymInd {
    std::string symbol;
    int64_t rsi_d6 = 0;   // D6 fixed point
    int64_t z_d6 = 0;
    int64_t vwap_ud = 0;
    int64_t atr_d6 = 0;
};

struct SourceStatus {
    std::string name;   // [a-z0-9_]{1,32}
    std::string state;  // IsSourceState
};

struct Snapshot {
    std::vector<Mark> marks;          // <= 5, kMarks
    std::string session;              // open|closed|holiday|early_close
    std::vector<SymInd> indicators;   // <= 5, kIndicators
    std::string regime;               // IsRegime, kRegime
    int64_t sentiment_d6[4] = {0, 0, 0, 0};  // kSentiment
    uint32_t var_corr_flags = 0;      // kVarCorr (bit0 var, bit1 corr)
    int64_t equity_ud = 0;            // kPortfolio
    int64_t exposure_ud = 0;
    int64_t buying_power_ud = 0;
    uint32_t pending_count = 0;
    uint64_t feature_bundle_id = 0;   // kFeatures (last COMPLETE bundle)
    std::string feature_bundle_hash;  // 64 hex
    std::vector<SourceStatus> sources;  // <= 8, kSources
    std::string stage;                // Slice E vocabulary, kStage
    uint64_t research_revision = 0;   // kResearch
    std::string calib;                // IsCalib, kCalib
    int64_t brier_d6 = 0;             // trailing-200 Brier, D6
    uint32_t present_mask = 0;
};

// Session vocabulary (mirrors feed::Session names).
inline bool IsSession(const std::string& s) {
    return s == "open" || s == "closed" || s == "holiday" ||
           s == "early_close";
}

// Structural validation: vocabulary, bounds, charset, mask coherence
// (a set section bit with empty content is malformed). Returns "" on
// valid, else a frozen reason code. Never throws.
std::string ValidateSnapshot(const Snapshot& s);

// Canonical bytes (FROZEN recipe): JSON object, top-level keys sorted
// ASCII-betically, separators "," and ":" with no whitespace, strings
// JSON-escaped (quote/backslash/C0 as \u00XX), integers plain decimal,
// arrays in listed order. Field order is fixed by this recipe; any
// change is a PROTOCOL change requiring a version bump.
std::string CanonicalSnapshot(const Snapshot& s);

// context_hash = sha256_hex(canonical bytes). Mismatched recomputation
// downstream is HOLD (done by the consumer, not here).
std::string ContextHash(const Snapshot& s);

}  // namespace ctx
