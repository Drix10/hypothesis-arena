// STAGE file read + hash-chain verify (Slice E, doc 10 10.1). Legacy G0
// bootstrap format only. Pure string logic (file I/O is the caller's); any
// unverifiable content resolves to G0_PAPER, never to capital. ParseError is a
// returned reason, not a throw.
#pragma once
#include <cstdint>
#include <string>

namespace stage {

// effective stage values (frozen doc 10 vocabulary)
inline bool IsKnownStage(const std::string& s) {
    return s == "G0_PAPER" || s == "G1_TINY" || s == "G2_SCALED" ||
           s == "G3_FULL";
}

struct VerifyResult {
    bool ok;               // chain verifies
    std::string effective; // parsed stage if ok, else "G0_PAPER"
    std::string reason;    // "ok" or frozen failure code
};

// Strict parse of the 5-field legacy file: exact keys, none missing, extra or
// duplicated; values stripped of surrounding ASCII whitespace. attest =
// sha256_hex("stage|approved_by|approved_at|capital_usd|prev_attest") over the
// file's own value strings; prev_attest = "GENESIS" for the bootstrap file.
VerifyResult VerifyStageContents(const std::string& contents,
                                 const std::string& prev_attest);

}  // namespace stage
