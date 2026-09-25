// H1 — broker recipe implementations (pure; transport only inside
// the Alpaca adapter methods, which fail closed without one).
#include "adapter.hpp"

#include "../jev_validate.hpp"  // Sha256Hex (cycle path only)

namespace jev {
namespace broker {

bool MakeClientOrderId(const char* broker, const char* account,
                       const char* context_hash_hex,
                       const char* symbol, OrderSide side,
                       const char* intent_id, char* out65) {
    if (!broker || !broker[0] || !account || !account[0] ||
        !context_hash_hex || !context_hash_hex[0] || !symbol ||
        !symbol[0] || !intent_id || !intent_id[0] || !out65)
        return false;
    std::string joined;
    joined += broker;
    joined += '\x1f';
    joined += account;
    joined += '\x1f';
    joined += context_hash_hex;
    joined += '\x1f';
    joined += symbol;
    joined += '\x1f';
    joined += (side == OrderSide::BUY) ? "BUY" : "SELL";
    joined += '\x1f';
    joined += intent_id;
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
