// Feature ingest validation + retention (doc 04 4.2.2a, doc 08 8.5 f2, R12;
// P3.5 Slice C). Pure per-record gate + fixed arena.
//
// Scope: validates one parsed feature record against the f2 shape and R12
// timestamp rules, and retains accepted records newest-first in a fixed arena
// (64 slots, 16-record payload view). It does not tail files, parse JSON,
// touch SQLite, read the entity map, check calendars or assemble bundles: the
// caller parses with ParseJson, canonicalizes with CanonJson and passes both.
// Slice G owns bundle envelope/commit/watermarks, DB lineage, entity binding,
// feed history, session checks and TRIGGER eligibility.
//
// Check order mirrors P1.5 check_feature (first failure wins) so reason codes
// stay comparable. Steps needing I/O or map/calendar state are skipped here
// and owned by Slice G: a record accepted here can still be rejected there.
//
// Zero-malloc: IngestRecord allocates nothing (fixed arena slots, stack
// buffers, incremental Sha256, ASCII-direct u32 compares, no U8() key
// temporaries). IngestState owns no std:: types; ParseJson/CanonJson allocate
// in the caller, off the validation path. Proven at runtime by
// ingest/test_noalloc.cpp (wrapped-malloc counter) as well as the grep gate.
#pragma once
#include <cstddef>
#include <cstdint>
#include <type_traits>
#include "../jev_wire.hpp"

namespace jev {
namespace ingest {

// f2 bounds (doc 08 8.5, mirrored from P1.5).
constexpr int kRetainMax = 64;    // snapshot carries 64, newest first
constexpr int kPayloadMax = 16;   // JEV payload takes the first 16
constexpr size_t kSlotBytes = 4096;  // canonical-record arena slot
constexpr int kMaxSymbols = 16;
constexpr int kMaxHashes = 16;
constexpr int64_t kTtlMaxS = 604800;  // 7 days: emitters grant no more
constexpr int64_t kHourNs = 3600LL * 1000000LL * 1000LL;

// Reject codes. Shared checks reuse the P1.5 reason strings verbatim;
// Slice-C bounds use the over-* codes (counted).
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
// "code[:detail]" string (unknown-field / schema-missing / primitive-type name
// the field, P1.5-identical); accepted records report "ok" or
// "inference-capped".
struct IngestOutcome {
    bool accepted = false;
    bool context_only = false;  // evidence == inference: CONTEXT-only
    RejectCode code = RejectCode::OK;
    char reason[4096];
};
static_assert(std::is_trivially_copyable<IngestOutcome>::value,
              "outcome must stay fixed storage");

// Ingest state: fixed arena + counters + rate window; owns no std:: types.
// 64 x 4KB slots = 256KB: own statically or on the heap, never as a tick-stack
// local.
struct IngestState {
    struct Slot {
        char bytes[kSlotBytes];
        uint32_t len = 0;
        int64_t observed_ns = 0;
        bool context_only = false;
    };
    Slot slots[kRetainMax];
    int n = 0;  // retained count; slots[0..n) newest-first by observed_ns
    // Per-bundle counters (one IngestState per bundle; the hourly rejection
    // rate lives in RateWindow). rejected and dropped are disjoint: rejected =
    // validation + over-size failures; dropped = valid but too old for a full
    // arena, so one drop is exactly one bad event in the rate math.
    uint64_t accepted = 0;
    uint64_t rejected = 0;
    uint64_t dropped = 0;
    uint64_t per_reason[kRejectCount] = {};
};

// Hourly rejection-rate window, fed once per bundle via RateAdd (hour roll
// resets). Alert emission (alerts.jsonl) is Phase 2.5 ops.
struct RateWindow {
    uint64_t accepted = 0;
    uint64_t rejected = 0;
    uint64_t dropped = 0;
    uint64_t per_reason[kRejectCount] = {};
    int64_t window_start_ns = 0;
    bool window_set = false;
};

// Pure entry points (features.cpp). snapshot_ns: decision time, >= 0.
// canon/canonical_len: the caller's CanonJson bytes of rec (retained verbatim
// on accept).
IngestOutcome IngestRecord(IngestState& st, const JVal& rec,
                           const char* canon, size_t canon_len,
                           int64_t snapshot_ns);
// Rejection rate over the current one-hour window (tumbling, anchored at the
// first RateAdd, reset on hour roll): strictly above 5% (20*bad > total,
// __int128). RateAdd: call once per bundle with a non-negative monotonic
// now_ns; clock rollback keeps the current window; counters saturate.
void RateAdd(RateWindow& w, const IngestState& st, int64_t now_ns);
bool ShouldAlert(const RateWindow& w);
// Payload view: first min(16, n) slots, newest first. TRIGGER-first ordering
// is Slice G's pass.
int PayloadCount(const IngestState& st);
const IngestState::Slot& PayloadSlot(const IngestState& st, int i);

}  // namespace ingest
}  // namespace jev
