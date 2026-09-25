// H1 — durable journal (doc 05 sec. 5.5, doc 06 sec. 6.1/6.5).
//
// Append-only decision/order rows chained by prev_hash; nothing trades
// without a row (journal-before-order), except the frozen emergency-exit
// exception (execute first, then append through the durable emergency
// buffer — a delayed exit is worse than a delayed row, and the row
// still lands). Hash chains detect accidents, not attackers (checkpoint
// signing + off-host storage is Phase-4 ops). Timestamps arrive as
// inputs (no clock reads in here); file I/O and retention/rotation are
// the caller's job. Cycle path: std::string is allowed (same class as
// Slice E), but every function is pure and bounded.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace jev {
namespace journal {

// Frozen row kinds (append-only vocabulary; unknown kinds never verify).
inline bool IsKnownKind(const char* k) {
    if (!k) return false;
    const char* known[] = {"intent",        "fill",      "partial",
                           "cancel",        "unknown",   "exit",
                           "drift-directive", "demotion", "reconcile",
                           "repair"};
    for (std::size_t i = 0; i < sizeof(known) / sizeof(known[0]); ++i) {
        const char* a = k;
        const char* b = known[i];
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*a == *b) return true;
    }
    return false;
}

// A row as written: sequence + wall time + kind + intent identity +
// payload digest + chain link + row digest (all hashes lowercase hex).
struct Row {
    std::uint64_t seq = 0;
    std::int64_t ts_ns = 0;
    std::string kind;
    std::string intent_id;
    std::string payload_hash;  // hex64 over the kind-specific body
    std::string prev_hash;     // hex64 ("GENESIS" * 2 + ... see below)
    std::string row_hash;      // hex64 over seq|ts|kind|intent|payload|prev
};

inline std::string GenesisPrev() {
    return std::string(64, '0');  // seq-0 rows link to 64 zeros
}

// Formats + hashes a row. Returns false (row untouched) on unknown
// kind, empty intent, non-hex payload/prev, or non-positive ts.
bool FormatRow(std::uint64_t seq, std::int64_t ts_ns, const char* kind,
               const char* intent_id, const char* payload_hash_hex,
               const char* prev_hash_hex, Row* out);
// Recomputes the digest and checks every field rule. False = broken.
bool VerifyRow(const Row& r);
// Chain rule: rows link seq+1, prev_hash == previous row_hash, every
// row verifies. False = broken (caller HARD-kills per doc 10).
bool VerifyChain(const Row* rows, std::size_t n);

// Redaction gate (doc 06 sec. 6.5: grep-clean retention). Payload
// bodies must already be redacted upstream (texts <= 280 chars); this
// gate refuses bodies carrying credential-shaped tokens or overlong
// text so a violation fails at write time, not at audit time.
bool RedactionOk(const char* body);

}  // namespace journal
}  // namespace jev
