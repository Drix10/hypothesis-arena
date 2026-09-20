// P3.5 Slice C — feature ingest validation + retention (doc 04 sec. 4.2.2a,
// doc 08 sec. 8.5 f2, R12). Pure per-record gate + fixed arena.
//
// SCOPE (pure-first): this file validates ONE parsed feature record against
// the frozen f2 shape + R12 timestamp rules and retains accepted records
// newest-first in a fixed arena (64 slots, 16-record payload view). It does
// NOT tail files, parse JSON, touch SQLite, read the entity map, check
// calendars, or assemble bundles — the caller parses with the frozen P3.1
// ParseJson, canonicalizes with the frozen P3.2 CanonJson, and passes both.
// Slice G owns: bundle envelope/commit/watermarks, DB lineage resolution,
// entity binding, frozen-feed history, session checks, TRIGGER eligibility.
//
// CHECK ORDER mirrors P1.5 check_feature exactly (first failure wins) so
// reason codes stay comparable across implementations. Steps needing I/O
// or map/calendar state (DB lineage, entity resolution, history, session)
// are SKIPPED here and owned by Slice G — this gate is necessary but not
// sufficient; a record accepted here can still be rejected there.
//
// ZERO-MALLOC CONTRACT: IngestRecord allocates nothing (fixed arena
// slots, stack buffers, incremental Sha256, ASCII-direct u32 compares —
// notably NO U8() key temporaries, which would heap-allocate through
// std::string/u32string construction). IngestState owns no std:: types.
// ParseJson/CanonJson allocate in the CALLER, off the validation path.
// Proven at runtime by kernel/ingest/test_noalloc.cpp (wrapped-malloc
// counter around the validation path), not only by the grep gate.
#pragma once
#include <cstddef>
#include <cstdint>
#include <type_traits>
#include "../jev_validate.hpp"

namespace jev {
namespace ingest {

// Frozen f2 bounds (doc 08 sec. 8.5, mirrored from P1.5, not redefined).
constexpr int kRetainMax = 64;    // snapshot carries 64, newest first
constexpr int kPayloadMax = 16;   // JEV payload takes the first 16
constexpr size_t kSlotBytes = 4096;  // canonical-record arena slot
constexpr int kMaxSymbols = 16;
constexpr int kMaxHashes = 16;
constexpr int64_t kTtlMaxS = 604800;  // 7 days: emitters grant no more
constexpr int64_t kHourNs = 3600LL * 1000000LL * 1000LL;

// Reject codes. Shared checks reuse the P1.5 reason strings verbatim;
// Slice-C-native bounds use the over-* codes (documented, counted).
enum class RejectCode {
    OK = 0,
    PROSE,
    UNKNOWN_FIELD,
    MISSING_FIELD,
    VERSION,
    SOURCE_UNKNOWN,
    PRIMITIVE_TYPE,
    ENUM,
    NO_EMITTER,
    SCHEMA_VALUE,
    VALUE_SHAPE,
    SYMBOLS_TYPE,
    SYMBOLS_CARD,
    OBSERVED_TYPE,
    OBSERVED_RANGE,
    TTL_TYPE,
    HASH_FORMAT,
    LINEAGE_MISMATCH,
    FUTURE,
    EXPIRED,
    INGESTED_TYPE,
    INGESTED_RANGE,
    INGESTED_FUTURE,
    INGESTED_BEFORE,
    PROVENANCE_TYPE,
    ENTITY_REF_SHAPE,
    FEATURE_ID,
    OVER_SIZE,
    OVER_COUNT,
    N_CODES
};
constexpr int kRejectCount = (int)RejectCode::N_CODES - 1;  // excludes OK
inline const char* RejectCodeStr(RejectCode c) {
    switch (c) {
        case RejectCode::PROSE:
            return "prose-quarantined";
        case RejectCode::UNKNOWN_FIELD:
            return "unknown-field";
        case RejectCode::MISSING_FIELD:
            return "schema-missing";
        case RejectCode::VERSION:
            return "schema-version";
        case RejectCode::SOURCE_UNKNOWN:
            return "source-unknown";
        case RejectCode::PRIMITIVE_TYPE:
            return "primitive-type";
        case RejectCode::ENUM:
            return "schema-enum";
        case RejectCode::NO_EMITTER:
            return "kind-no-emitter";
        case RejectCode::SCHEMA_VALUE:
            return "schema-value";
        case RejectCode::VALUE_SHAPE:
            return "value-shape";
        case RejectCode::SYMBOLS_TYPE:
            return "symbols-type";
        case RejectCode::SYMBOLS_CARD:
            return "symbols-cardinality";
        case RejectCode::OBSERVED_TYPE:
            return "observed-type";
        case RejectCode::OBSERVED_RANGE:
            return "observed-range";
        case RejectCode::TTL_TYPE:
            return "ttl-type";
        case RejectCode::HASH_FORMAT:
            return "hash-format";
        case RejectCode::LINEAGE_MISMATCH:
            return "lineage-mismatch";
        case RejectCode::FUTURE:
            return "future-timestamp";
        case RejectCode::EXPIRED:
            return "ttl-expired";
        case RejectCode::INGESTED_TYPE:
            return "ingested-type";
        case RejectCode::INGESTED_RANGE:
            return "ingested-range";
        case RejectCode::INGESTED_FUTURE:
            return "ingested-future";
        case RejectCode::INGESTED_BEFORE:
            return "ingested-before-observed";
        case RejectCode::PROVENANCE_TYPE:
            return "provenance-type";
        case RejectCode::ENTITY_REF_SHAPE:
            return "entity-ref-shape";
        case RejectCode::FEATURE_ID:
            return "feature-id-shape";
        case RejectCode::OVER_SIZE:
            return "over-size";
        case RejectCode::OVER_COUNT:
            return "over-count";
        default:
            return "ok";
    }
}

// Outcome: fixed storage (trivially copyable). reason holds the full
// "code[:detail]" string (unknown-field / schema-missing / primitive-type
// name the field, P1.5-identical); accepted records report "ok" or
// "inference-capped".
struct IngestOutcome {
    bool accepted = false;
    bool context_only = false;  // evidence == inference: CONTEXT-only
    RejectCode code = RejectCode::OK;
    char reason[4096];
};
static_assert(std::is_trivially_copyable<IngestOutcome>::value,
              "outcome must stay fixed storage");

// Ingest state: fixed arena + counters + rate window. Owns no std::
// types. 64 x 4KB slots = 256KB: own statically or heap-allocate,
// never as a tick-stack local.
struct IngestState {
    struct Slot {
        char bytes[kSlotBytes];
        uint32_t len = 0;
        int64_t observed_ns = 0;
        bool context_only = false;
    };
    Slot slots[kRetainMax];
    int n = 0;  // retained count; slots[0..n) newest-first by observed_ns
    // Per-bundle counters (one IngestState per bundle ingest; the hourly
    // rejection rate lives in RateWindow below, fed once per bundle).
    // rejected and dropped are DISJOINT: rejected = validation +
    // over-size failures; dropped = valid but too old for a full arena
    // (over-count). One drop is exactly one bad event in the rate math.
    uint64_t accepted = 0;
    uint64_t rejected = 0;
    uint64_t dropped = 0;
    uint64_t per_reason[kRejectCount] = {};
};

// Hourly rejection-rate window: fed ONCE per bundle via RateAdd (hour
// roll resets). Alert emission (alerts.jsonl) is Phase 2.5 ops; Slice C
// computes the rate only.
struct RateWindow {
    uint64_t accepted = 0;
    uint64_t rejected = 0;
    uint64_t dropped = 0;
    uint64_t per_reason[kRejectCount] = {};
    int64_t window_start_ns = 0;
    bool window_set = false;
};

// Pure entry points (features.cpp). snapshot_ns: frozen decision time;
// caller contract snapshot_ns >= 0. canon/canonical_len: the caller's
// P3.2 CanonJson bytes of rec (retained verbatim on accept).
IngestOutcome IngestRecord(IngestState& st, const JVal& rec,
                           const char* canon, size_t canon_len,
                           int64_t snapshot_ns);
// Rejection rate over the trailing hour window: (rejected + dropped) /
// total, strictly above 5% (20*bad > total, __int128 throughout).
// RateAdd contract: call ONCE per bundle with a non-negative monotonic
// now_ns. Hour roll resets the window; clock rollback keeps the current
// window (never erases accumulated bad counts); counters saturate.
// Alert emission (alerts.jsonl) is Phase 2.5 ops; Slice C computes.
void RateAdd(RateWindow& w, const IngestState& st, int64_t now_ns);
bool ShouldAlert(const RateWindow& w);
// Payload view: first min(16, n) slots, newest first. Eligibility
// (TRIGGER-first) ordering is Slice G's pass over retained records.
int PayloadCount(const IngestState& st);
const IngestState::Slot& PayloadSlot(const IngestState& st, int i);

}  // namespace ingest
}  // namespace jev
