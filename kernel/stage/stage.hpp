// STAGE file read + hash-chain verify. Paper-stage bootstrap format only. Pure string logic (file I/O is the caller's); any
// unverifiable content resolves to PAPER, never to capital. ParseError is a
// returned reason, not a throw.
#pragma once
#include <cstdint>
#include <string>

namespace stage {

// effective stage values (fixed vocabulary)
inline bool IsKnownStage(const std::string& s) {
    return s == "PAPER" || s == "TINY" || s == "SCALED" ||
           s == "FULL";
}

struct VerifyResult {
    bool ok;               // chain verifies
    std::string effective; // parsed stage if ok, else "PAPER"
    std::string reason;    // "ok" or fixed failure code
};

// Strict parse of the 5-field legacy file: exact keys, none missing, extra or
// duplicated; values stripped of surrounding ASCII whitespace. attest =
// sha256_hex("stage|approved_by|approved_at|capital_usd|prev_attest") over the
// file's own value strings; prev_attest = "GENESIS" for the bootstrap file.
VerifyResult VerifyStageContents(const std::string& contents,
                                 const std::string& prev_attest);

}  // namespace stage
