// H1 — journal implementation. All hashing through the frozen P3.2
// Sha256Hex (cycle path; the tick path never journals).
#include "journal.hpp"

#include "../jev_validate.hpp"  // Sha256Hex

namespace jev {
namespace journal {

namespace {
bool IsHex64(const char* s) {
    if (!s) return false;
    for (int i = 0; i < 64; ++i) {
        char c = s[i];
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!ok) return false;
    }
    return s[64] == '\0';
}
bool NonEmpty(const char* s) {
    return s && s[0] != '\0';
}
}  // namespace

bool FormatRow(std::uint64_t seq, std::int64_t ts_ns, const char* kind,
               const char* intent_id, const char* payload_hash_hex,
               const char* prev_hash_hex, Row* out) {
    if (!out || !IsKnownKind(kind) || !NonEmpty(intent_id) ||
        !IsHex64(payload_hash_hex) || !IsHex64(prev_hash_hex) ||
        ts_ns <= 0)
        return false;
    Row r;
    r.seq = seq;
    r.ts_ns = ts_ns;
    r.kind = kind;
    r.intent_id = intent_id;
    r.payload_hash = payload_hash_hex;
    r.prev_hash = prev_hash_hex;
    char body[512];
    int w = std::snprintf(body, sizeof(body),
                          "%llu|%lld|%s|%s|%s|%s",
                          (unsigned long long)seq, (long long)ts_ns,
                          kind, intent_id, payload_hash_hex,
                          prev_hash_hex);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return false;
    r.row_hash = jev::Sha256Hex(body);
    *out = r;
    return true;
}

bool VerifyRow(const Row& r) {
    if (!IsKnownKind(r.kind.c_str()) || r.intent_id.empty() ||
        r.ts_ns <= 0)
        return false;
    if (!IsHex64(r.payload_hash.c_str()) ||
        !IsHex64(r.prev_hash.c_str()) || !IsHex64(r.row_hash.c_str()))
        return false;
    Row expect;
    if (!FormatRow(r.seq, r.ts_ns, r.kind.c_str(), r.intent_id.c_str(),
                   r.payload_hash.c_str(), r.prev_hash.c_str(),
                   &expect))
        return false;
    return expect.row_hash == r.row_hash;
}

bool VerifyChain(const Row* rows, std::size_t n) {
    if (!rows) return false;
    for (std::size_t i = 0; i < n; ++i) {
        if (!VerifyRow(rows[i])) return false;
        if (i == 0) {
            if (rows[i].prev_hash != GenesisPrev()) return false;
        } else {
            if (rows[i].seq != rows[i - 1].seq + 1) return false;
            if (rows[i].prev_hash != rows[i - 1].row_hash) return false;
        }
    }
    return true;
}

bool RedactionOk(const char* body) {
    if (!body) return false;
    std::size_t len = 0;
    while (body[len] != '\0') {
        if (len >= 280) return false;  // overlong text never journals
        ++len;
    }
    // Credential-shaped tokens (case-sensitive; the legitimate
    // vocabulary never contains these substrings).
    const char* banned[] = {"ALPACA", "apikey", "api_key", "api-key",
                            "secret", "token", "password", "Bearer "};
    for (std::size_t b = 0;
         b < sizeof(banned) / sizeof(banned[0]); ++b) {
        const char* n = banned[b];
        for (const char* p = body; *p; ++p) {
            const char* a = p;
            const char* c = n;
            while (*a && *c && *a == *c) {
                ++a;
                ++c;
            }
            if (!*c) return false;
        }
    }
    return true;
}

}  // namespace journal
}  // namespace jev
