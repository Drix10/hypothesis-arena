#include "settle.hpp"

namespace jev {
namespace runner {

static bool IsSession(int64_t day, const std::set<int64_t>& holidays) {
    int64_t wd = ((day % 7) + 7 + 4) % 7;  // 0 = Sunday; day 0 was a Thursday
    return wd != 0 && wd != 6 && holidays.count(day) == 0;
}

int64_t NextSessionDay(int64_t day, const std::set<int64_t>& holidays) {
    int64_t d = day + 1;
    while (!IsSession(d, holidays)) ++d;
    return d;
}

void SettleBook::Record(int64_t sell_day, int64_t proceeds_cents,
                        const std::set<int64_t>& holidays) {
    if (proceeds_cents <= 0) return;
    e_.emplace_back(NextSessionDay(sell_day, holidays), proceeds_cents);
}

void SettleBook::Add(int64_t settle_day, int64_t proceeds_cents) {
    if (proceeds_cents > 0) e_.emplace_back(settle_day, proceeds_cents);
}

int64_t SettleBook::UnsettledCents(int64_t today) const {
    __int128 t = 0;
    for (const auto& e : e_)
        if (e.first > today) t += e.second;
    return t > INT64_MAX ? INT64_MAX : (int64_t)t;
}

int64_t SettleBook::SettledCents(int64_t broker_settled_cents,
                                 int64_t today) const {
    int64_t u = UnsettledCents(today);
    int64_t s = broker_settled_cents - u;
    return s > 0 ? s : 0;
}

}  // namespace runner
}  // namespace jev
