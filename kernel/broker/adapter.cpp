// H1 — broker recipe implementations (pure; transport only inside
// the Alpaca adapter methods, which fail closed without one).
#include "adapter.hpp"

#include "../jev_validate.hpp"  // Sha256Hex (cycle path only)

namespace jev {
namespace broker {

namespace {
// Length-bounded append for the frozen id recipe: valid inputs
// (NUL inside the cap) hash byte-identically to before; a
// full-width unterminated field truncates instead of reading
// stack garbage into the identity (nondeterministic ids across
// restarts would break pre-flight dedupe — doc 06 sec. 6.1b).
void AppendCapped(std::string& out, const char* s,
                  std::size_t cap) {
    if (!s) return;
    for (std::size_t i = 0; i < cap && s[i] != '\0'; ++i)
        out.push_back(s[i]);
}
}  // namespace

bool IsBrokerUuid(const char* s) {
    if (!s || !s[0]) return false;
    for (int i = 0; i < 36; ++i) {
        char c = s[i];
        if (c == '\0') return false;  // short
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return false;
        } else {
            bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!ok) return false;  // uppercase/bad-hyphen/path char
        }
    }
    return s[36] == '\0';  // exact length (overlong refused)
}

bool MakeClientOrderId(const char* broker, const char* account,
                       const char* context_hash_hex,
                       const char* symbol, OrderSide side,
                       const char* intent_id, char* out65) {
    if (!broker || !broker[0] || !account || !account[0] ||
        !context_hash_hex || !context_hash_hex[0] || !symbol ||
        !symbol[0] || !intent_id || !intent_id[0] || !out65)
        return false;
    std::string joined;
    AppendCapped(joined, broker, 32);
    joined += '\x1f';
    AppendCapped(joined, account, 32);
    joined += '\x1f';
    AppendCapped(joined, context_hash_hex, 64);
    joined += '\x1f';
    AppendCapped(joined, symbol, 16);
    joined += '\x1f';
    joined += (side == OrderSide::BUY) ? "BUY" : "SELL";
    joined += '\x1f';
    AppendCapped(joined, intent_id, 64);
    std::string hex = jev::Sha256Hex(joined);
    if (hex.size() != 64) return false;
    for (int i = 0; i < 64; ++i) out65[i] = hex[i];
    out65[64] = '\0';
    return true;
}

std::int64_t PaperFillPrice(OrderSide side, const Quote& q) {
    if (q.mid_cents <= 0 || q.spread_cents < 0) return -1;
    // One full spread adverse, minimum 1bp of mid (1bp = mid/10000,
    // at least 1 cent). Integer math, no floats.
    std::int64_t adverse = q.spread_cents;
    std::int64_t floor = q.mid_cents / 10000;
    if (floor < 1) floor = 1;
    if (adverse < floor) adverse = floor;
    if (side == OrderSide::BUY) return q.mid_cents + adverse;
    return q.mid_cents - adverse;
}

}  // namespace broker
}  // namespace jev
