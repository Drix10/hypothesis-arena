#include "bars.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "calendar.hpp"

namespace jev {
namespace runner {

std::string UrlEncode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' ||
            c == '~') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

bool ParseIsoZ(const std::string& s, int64_t* utc_s) {
    int y, mo, d, h, mi, se;
    char z = 0;
    if (s.size() != 20 ||
        std::sscanf(s.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%c", &y, &mo, &d, &h,
                    &mi, &se, &z) != 7 || z != 'Z')
        return false;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60)
        return false;
    *utc_s = DaysFromCivil(y, (unsigned)mo, (unsigned)d) * 86400 + h * 3600 +
             mi * 60 + se;
    return true;
}

std::string FormatIsoZ(int64_t utc_s) {
    if (utc_s < 0) return "";
    int64_t day = utc_s / 86400, rem = utc_s % 86400;
    // inverse of DaysFromCivil
    int64_t z = day + 719468;
    int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097);
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t y = (int64_t)yoe + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned mp = (5 * doy + 2) / 153;
    unsigned d = doy - (153 * mp + 2) / 5 + 1;
    unsigned m = mp < 10 ? mp + 3 : mp - 9;
    y += (m <= 2);
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04lld-%02u-%02uT%02d:%02d:%02dZ",
                  (long long)y, m, d, (int)(rem / 3600), (int)(rem % 3600 / 60),
                  (int)(rem % 60));
    return buf;
}

namespace {

// Minimal bounded JSON scanner for the market-data reply. The frozen P3.1
// parser caps array length for model payloads and is not used here.
struct Scan {
    const char* p;
    const char* end;
    void Ws() {
        while (p < end && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t'))
            ++p;
    }
    bool Eat(char c) {
        Ws();
        if (p < end && *p == c) {
            ++p;
            return true;
        }
        return false;
    }
    bool Str(std::string* out) {
        Ws();
        if (p >= end || *p != '"') return false;
        ++p;
        out->clear();
        while (p < end && *p != '"') {
            if (*p == '\\') {
                if (++p >= end) return false;
            }
            if (out->size() > 256) return false;
            out->push_back(*p++);
        }
        if (p >= end) return false;
        ++p;
        return true;
    }
    bool Num(double* out) {
        Ws();
        char* e = nullptr;
        if (p >= end || !(*p == '-' || (*p >= '0' && *p <= '9'))) return false;
        *out = std::strtod(p, &e);
        if (e == p || e > end) return false;
        p = e;
        return true;
    }
    bool Skip(int depth) {
        Ws();
        if (p >= end || depth > 8) return false;
        if (*p == '"') {
            std::string t;
            return Str(&t);
        }
        if (*p == '{' || *p == '[') {
            char close = *p == '{' ? '}' : ']';
            bool obj = *p == '{';
            ++p;
            if (Eat(close)) return true;
            do {
                std::string k;
                if (obj && (!Str(&k) || !Eat(':'))) return false;
                if (!Skip(depth + 1)) return false;
            } while (Eat(','));
            return Eat(close);
        }
        for (const char* lit : {"true", "false", "null"}) {
            size_t n = std::strlen(lit);
            if ((size_t)(end - p) >= n && std::strncmp(p, lit, n) == 0) {
                p += n;
                return true;
            }
        }
        double d;
        return Num(&d);
    }
};

}  // namespace

bool ParseBars(const std::string& body, BarMap* out, bool* more,
               std::string* token) {
    if (body.empty() || body.size() > (4u << 20)) return false;
    Scan sc{body.data(), body.data() + body.size()};
    BarMap m;
    bool have_bars = false;
    *more = false;
    if (!sc.Eat('{')) return false;
    if (!sc.Eat('}')) {
        do {
            std::string key;
            if (!sc.Str(&key) || !sc.Eat(':')) return false;
            if (key == "next_page_token") {
                sc.Ws();
                std::string tok;
                if (sc.p < sc.end && *sc.p == '"') {
                    if (!sc.Str(&tok)) return false;
                    *more = !tok.empty();
                    if (token) *token = tok;
                } else if (!sc.Skip(1)) {
                    return false;
                }
            } else if (key == "bars") {
                have_bars = true;
                if (!sc.Eat('{')) return false;
                if (!sc.Eat('}')) {
                    do {
                        std::string sym;
                        if (!sc.Str(&sym) || !sc.Eat(':') || !sc.Eat('['))
                            return false;
                        std::vector<Bar>& vec = m[sym];
                        if (!sc.Eat(']')) {
                            do {
                                if (!sc.Eat('{')) return false;
                                Bar b;
                                bool got_c = false, got_t = false;
                                if (!sc.Eat('}')) {
                                    do {
                                        std::string k;
                                        if (!sc.Str(&k) || !sc.Eat(':'))
                                            return false;
                                        if (k == "c") {
                                            got_c = sc.Num(&b.close);
                                            if (!got_c) return false;
                                        } else if (k == "t") {
                                            std::string t;
                                            if (!sc.Str(&t) ||
                                                !ParseIsoZ(t, &b.start_s))
                                                return false;
                                            got_t = true;
                                        } else if (!sc.Skip(2)) {
                                            return false;
                                        }
                                    } while (sc.Eat(','));
                                    if (!sc.Eat('}')) return false;
                                }
                                if (!got_c || !got_t || !(b.close > 0.0) ||
                                    !std::isfinite(b.close))
                                    return false;
                                vec.push_back(b);
                            } while (sc.Eat(','));
                            if (!sc.Eat(']')) return false;
                        }
                    } while (sc.Eat(','));
                    if (!sc.Eat('}')) return false;
                }
            } else if (!sc.Skip(1)) {
                return false;
            }
        } while (sc.Eat(','));
        if (!sc.Eat('}')) return false;
    }
    sc.Ws();
    if (sc.p != sc.end || !have_bars) return false;
    *out = m;
    return true;
}

void KeepRegularSession(std::vector<Bar>* bars,
                        const std::set<int64_t>& holidays) {
    std::vector<Bar> keep;
    for (const Bar& b : *bars) {
        int64_t local = b.start_s + EtOffsetSeconds(b.start_s);
        int64_t day = local / 86400;
        int hour = (int)(local % 86400) / 3600;
        int minute = (int)(local % 3600) / 60;
        if (IsSessionDay(day, holidays) && hour >= 9 && hour <= 15 &&
            minute == 0)
            keep.push_back(b);
    }
    *bars = keep;
}

std::vector<int64_t> ExpectedStarts(int64_t now_s, int n,
                                    const std::set<int64_t>& holidays) {
    std::vector<int64_t> rev;
    int64_t day = (now_s + EtOffsetSeconds(now_s)) / 86400;
    for (int guard = 0; guard < 120 && (int)rev.size() < n; ++guard, --day) {
        if (!IsSessionDay(day, holidays)) continue;
        for (int hour = 15; hour >= 9 && (int)rev.size() < n; --hour) {
            int64_t local = day * 86400 + hour * 3600;
            int64_t start = local - EtOffsetSeconds(local + 18000);
            if (start + 3600 <= now_s) rev.push_back(start);
        }
    }
    return std::vector<int64_t>(rev.rbegin(), rev.rend());
}

void AlignCloses(const std::vector<Bar>& bars,
                 const std::vector<int64_t>& starts, double* out) {
    size_t j = 0;
    for (size_t i = 0; i < starts.size(); ++i) {
        out[i] = NAN;
        while (j < bars.size() && bars[j].start_s < starts[i]) ++j;
        if (j < bars.size() && bars[j].start_s == starts[i])
            out[i] = bars[j].close;
    }
}

}  // namespace runner
}  // namespace jev
