// Snapshot + context_hash. Pure data + canonical serialization. Provider
// sections (marks and session from the feed, portfolio from the router,
// indicators and regime from future providers) fill it through checked setters.
// Unset sections are explicit via present_mask, never defaulted into
// authority. context_hash is SHA-256 over the canonical bytes of all of it,
// presence bits included, so a partial snapshot never collides with a
// complete one. context_hash != state_hash.
//
// Resource boundary: assembly, canonical serialization and
// hashing are cycle path (once per decision cycle, output <= 4KiB asserted in
// test), not tick-hot and not zero-alloc. The zero-alloc tick path (feed
// TickRing::Push, gap Notes, session marking) is proven by
// feed/test_noalloc_feed. the router must not put ContextHash on the tick path
// without its own proof.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ctx {

// Vocabularies.
inline bool IsRegime(const std::string& s) {
    return s == "trend" || s == "range" || s == "volatile";
}
inline bool IsSourceState(const std::string& s) {
    // One vocabulary for source states; no second mapping.
    return s == "healthy" || s == "stale" || s == "failed" ||
           s == "not_scheduled" || s == "unavailable" || s == "na";
}

// Presence bits: which provider sections are filled. With kSettlement clear
// the canonical bytes omit the settlement section.
// Deferred (no bit, no field, no placeholder): `change` (no frozen
// representation) and sentiment/signal buckets. Absence is not zero.
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
    kSettlement = 1u << 10,  // settled-cash section (account rule)
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
    std::string stage;                // vocabulary, kStage
    uint64_t research_revision = 0;   // kResearch (0 IS absent)
    int64_t settled_cash_ud = 0;      // kSettlement: buyable cash
    int64_t unsettled_ud = 0;         // sale proceeds not yet settled
    int64_t next_settle_day = 0;      // days since 1970-01-01, 0 if none due
    uint32_t present_mask = 0;
};

// Session vocabulary (mirrors feed::Session names).
inline bool IsSession(const std::string& s) {
    return s == "open" || s == "closed" || s == "holiday" ||
           s == "early_close";
}

// Structural validation: vocabulary, bounds, charset, mask coherence (a set
// section bit with empty content is malformed). Returns "" on valid, else a
// fixed reason code. Never throws.
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
