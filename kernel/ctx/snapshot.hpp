// Snapshot + context_hash (Slice G, doc 04 4.2.3). Pure data + canonical
// serialization. Provider sections (marks/session from F, portfolio from H1,
// indicators/regime from future providers) fill it through checked setters.
// Unset sections are explicit via present_mask, never defaulted into
// authority. context_hash is SHA-256 over the canonical bytes of all of it,
// presence bits included, so a partial snapshot never collides with a
// complete one. context_hash != state_hash (doc 03 3.5a).
//
// Resource boundary (doc 04 4.3): assembly, canonical serialization and
// hashing are cycle path (once per decision cycle, output <= 4KiB asserted in
// test), not tick-hot and not zero-alloc. The zero-alloc tick path (feed
// TickRing::Push, gap Notes, session marking) is proven by
// feed/test_noalloc_feed. H1 must not put ContextHash on the tick path
// without its own proof.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ctx {

// Vocabularies (mirror P3.3/jev_state + doc 09 9.3).
inline bool IsRegime(const std::string& s) {
    return s == "trend" || s == "range" || s == "volatile";
}
inline bool IsCalib(const std::string& s) {
    return s == "pass" || s == "insufficient" || s == "breach";
}
inline bool IsSourceState(const std::string& s) {
    // JEV vocabulary (doc 03 3.5); no G-local second ontology, no lossy
    // mapping at H1.
    return s == "healthy" || s == "stale" || s == "failed" ||
           s == "not_scheduled" || s == "unavailable" || s == "na";
}

// Presence bits: which provider sections are filled. v1: 11 sections.
// Deferred (no bit, no field, no placeholder): `change` (no frozen
// representation) and sentiment/signal buckets (doc 03 forbids numeric
// sentiment; the discrete schema is not frozen). Absence is not zero.
enum Present : uint32_t {
    kMarks = 1u << 0,
    kSession = 1u << 1,
    kIndicators = 1u << 2,
    kRegime = 1u << 3,
    kVarCorr = 1u << 4,
    kPortfolio = 1u << 5,
    kFeatures = 1u << 6,
    kSources = 1u << 7,
    kStage = 1u << 8,
    kResearch = 1u << 9,
    kCalib = 1u << 10,
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
    uint32_t var_corr_flags = 0;      // kVarCorr (bit0 var, bit1 corr)
    int64_t equity_ud = 0;            // kPortfolio
    int64_t exposure_ud = 0;
    int64_t buying_power_ud = 0;
    uint32_t pending_count = 0;
    uint64_t feature_bundle_id = 0;   // kFeatures (last complete bundle)
    std::string feature_bundle_hash;  // 64 hex
    std::vector<SourceStatus> sources;  // <= 8, kSources
    std::string stage;                // Slice E vocabulary, kStage
    uint64_t research_revision = 0;   // kResearch (0 IS absent)
    std::string calib;                // IsCalib, kCalib
    int64_t brier_d6 = 0;             // trailing-200 Brier, D6
    uint32_t present_mask = 0;
};

// Session vocabulary (mirrors feed::Session names).
inline bool IsSession(const std::string& s) {
    return s == "open" || s == "closed" || s == "holiday" ||
           s == "early_close";
}

// Structural validation: vocabulary, bounds, charset, mask coherence (a set
// section bit with empty content is malformed). Returns "" on valid, else a
// frozen reason code. Never throws.
std::string ValidateSnapshot(const Snapshot& s);

// Canonical bytes: JSON object, top-level keys sorted ASCII-betically,
// separators "," and ":" with no whitespace, strings JSON-escaped
// (quote/backslash/C0 as \u00XX), integers plain decimal, arrays in listed
// order. Any change to this recipe is a protocol change needing a version
// bump.
std::string CanonicalSnapshot(const Snapshot& s);

// context_hash = sha256_hex(canonical bytes). A mismatched recomputation
// downstream is HOLD (the consumer checks).
std::string ContextHash(const Snapshot& s);

}  // namespace ctx
