#include "approved.hpp"

#include <cstdio>
#include <cstdlib>

#include "../jev_validate.hpp"
#include "calendar.hpp"

namespace jev {
namespace runner {
namespace {

const JVal* Get(const JVal& o, const std::string& k) {
    std::u32string key;
    for (char c : k) key.push_back((char32_t)(unsigned char)c);
    return o.find(key);
}

bool SafeSymbol(const std::string& s) {
    if (s.empty() || s.size() > 15) return false;
    for (char c : s)
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
              c == '-'))
            return false;
    return true;
}

bool IsoDay(const std::string& s, int64_t* day) {
    int y, m, d;
    char tail = 0;
    if (s.size() != 10 || std::sscanf(s.c_str(), "%4d-%2d-%2d%c", &y, &m, &d,
                                      &tail) != 3 ||
        m < 1 || m > 12 || d < 1 || d > 31)
        return false;
    int64_t z = DaysFromCivil(y, (unsigned)m, (unsigned)d);
    // Reject dates the calendar normalises (Feb 31 and the like).
    int64_t next = m == 12 ? DaysFromCivil(y + 1, 1, 1)
                           : DaysFromCivil(y, (unsigned)m + 1, 1);
    if (z >= next) return false;
    *day = z;
    return true;
}

}  // namespace

bool ReadFile(const std::string& path, std::string* out) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    out->clear();
    char buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) {
        out->append(buf, n);
        if (out->size() > (1u << 20)) {
            std::fclose(f);
            return false;
        }
    }
    std::fclose(f);
    return true;
}

bool ParseApproved(const std::string& json, ingest::CandidateTables* out) {
    JVal v;
    std::string err;
    if (!ParseJson(json, v, err) || v.t != JVal::T::OBJ) return false;
    const JVal* sl = Get(v, "sleeves");
    const JVal* al = Get(v, "allowlist");
    if (!sl || sl->t != JVal::T::ARR || !al || al->t != JVal::T::ARR)
        return false;
    ingest::CandidateTables t;
    for (const JVal& e : sl->a) {
        const JVal* id = Get(e, "id");
        const JVal* w = Get(e, "window_s");
        if (e.t != JVal::T::OBJ || !id || id->t != JVal::T::STR || !w ||
            w->t != JVal::T::NUM || w->num_double)
            return false;
        ingest::ApprovedSleeve a;
        a.id = U32ToUtf8(id->s);
        a.window_s = std::strtoll(w->num.c_str(), nullptr, 10);
        if (a.id.empty() || a.window_s <= 0 || a.window_s > 7 * 86400)
            return false;
        t.sleeves.push_back(a);
    }
    for (const JVal& e : al->a) {
        if (e.t != JVal::T::STR) return false;
        std::string s = U32ToUtf8(e.s);
        if (!SafeSymbol(s)) return false;
        t.allowlist.push_back(s);
    }
    if (t.sleeves.empty() || t.allowlist.empty()) return false;
    *out = t;
    return true;
}

bool ParseCalendar(const std::string& json, std::set<int64_t>* holidays) {
    JVal v;
    std::string err;
    if (!ParseJson(json, v, err) || v.t != JVal::T::OBJ) return false;
    std::set<int64_t> h;
    bool any = false;
    for (const auto& kv : v.o) {
        std::string k = U32ToUtf8(kv.first);
        if (k.rfind("holidays_", 0) != 0) continue;
        if (kv.second.t != JVal::T::ARR) return false;
        for (const JVal& e : kv.second.a) {
            int64_t day = 0;
            if (e.t != JVal::T::STR || !IsoDay(U32ToUtf8(e.s), &day))
                return false;
            h.insert(day);
            any = true;
        }
    }
    if (!any) return false;
    *holidays = h;
    return true;
}

}  // namespace runner
}  // namespace jev
