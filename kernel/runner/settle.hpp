// Settlement book (R18): sale proceeds this system generated stay unusable
// for buys until the next exchange session. Days are counted from
// 1970-01-01; weekends and the supplied holidays are not sessions.
#pragma once
#include <cstdint>
#include <set>
#include <vector>

namespace jev {
namespace runner {

int64_t NextSessionDay(int64_t day, const std::set<int64_t>& holidays);

class SettleBook {
   public:
    void Record(int64_t sell_day, int64_t proceeds_cents,
                const std::set<int64_t>& holidays);
    // Proceeds not yet settled at the start of `today`.
    int64_t UnsettledCents(int64_t today) const;
    // Broker-reported settled cash less our own unsettled proceeds.
    int64_t SettledCents(int64_t broker_settled_cents, int64_t today) const;
    size_t size() const { return e_.size(); }
    // Persistence: one "settle_day proceeds" pair per call to Save/Load.
    std::vector<std::pair<int64_t, int64_t>> entries() const { return e_; }
    void Add(int64_t settle_day, int64_t proceeds_cents);

   private:
    std::vector<std::pair<int64_t, int64_t>> e_;  // (settle_day, proceeds)
};

}  // namespace runner
}  // namespace jev
