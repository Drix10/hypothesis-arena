// Slice E implementation. See stage.hpp for the contract.
#include "stage.hpp"

#include <cctype>

#include "../jev_validate.hpp"  // Sha256Hex (P3.1 primitive, reused)

namespace stage {
namespace {

bool IsHex64(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s) {
        if (!std::isdigit(static_cast<unsigned char>(c)) &&
            (c < 'a' || c > 'f') && (c < 'A' || c > 'F'))
            return false;
    }
    return true;
}

std::string Strip(const std::string& s) {
    size_t a = 0;
    while (a < s.size() &&
           (s[a] == ' ' || s[a] == '\t' || s[a] == '\r'))
        ++a;
    size_t b = s.size();
    while (b > a &&
           (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r'))
        --b;
    return s.substr(a, b - a);
}

// Checked unsigned decimal, no atoll/strtol wraparound: digits only,
// bounded length, accumulates with overflow guard.
bool ParseCapital(const std::string& s, long long* out) {
    if (s.empty() || s.size() > 18) return false;
    long long v = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        int d = c - '0';
        if (v > (9000000000000000000LL - d) / 10) return false;
        v = v * 10 + d;
    }
    *out = v;
    return true;
}

// Structural ISO-8601 check: YYYY-MM-DDTHH:MM:SS with optional Z or
// numeric offset. Calendar-validated (leap years, month lengths).
bool ValidIso8601(const std::string& s) {
    // Minimal length "YYYY-MM-DDTHH:MM:SS" = 19.
    if (s.size() < 19) return false;
    for (int i : {0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18}) {
        if (s[static_cast<size_t>(i)] < '0' ||
            s[static_cast<size_t>(i)] > '9')
            return false;
    }
    if (s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' ||
        s[16] != ':')
        return false;
    int y = std::stoi(s.substr(0, 4));
    int mo = std::stoi(s.substr(5, 2));
    int d = std::stoi(s.substr(8, 2));
    int h = std::stoi(s.substr(11, 2));
    int mi = std::stoi(s.substr(14, 2));
    int se = std::stoi(s.substr(17, 2));
    if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || h > 23 || mi > 59 ||
        se > 59)
        return false;
    static const int kDays[12] = {31, 28, 31, 30, 31, 30,
                                  31, 31, 30, 31, 30, 31};
    int dim = kDays[mo - 1];
    bool leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    if (mo == 2 && leap) dim = 29;
    if (d < 1 || d > dim) return false;
    std::string rest = s.substr(19);
    if (rest.empty() || rest == "Z") return true;
    // Numeric offset "+HH:MM" / "-HHMM" / "+HHMM".
    size_t i = 0;
    if (rest[0] == '+' || rest[0] == '-') ++i;
    std::string digits;
    for (; i < rest.size(); ++i) {
        if (rest[i] == ':' && digits.size() == 2) continue;
        if (rest[i] < '0' || rest[i] > '9') return false;
        digits += rest[i];
    }
    return digits.size() == 4;
}

bool CleanValue(const std::string& s) {
    if (s.empty() || s.size() > 128) return false;
    for (char c : s) {
        if (c == '|' || c == '\n' || static_cast<unsigned char>(c) < 32 ||
            static_cast<unsigned char>(c) > 126)
            return false;
    }
    return true;
}

}  // namespace

VerifyResult VerifyStageContents(const std::string& contents,
                                 const std::string& prev_attest) {
    VerifyResult r{false, "G0_PAPER", "parse-error"};
    // Split lines; a single terminal newline is tolerated, interior
    // blanks are rejected.
    std::string stage, by, at, cap, attest;
    int seen = 0;
    size_t pos = 0;
    auto fail = [&](const char* code) {
        r.reason = code;
        r.effective = "G0_PAPER";
        r.ok = false;
        return r;
    };
    while (pos <= contents.size()) {
        size_t nl = contents.find('\n', pos);
        std::string line = (nl == std::string::npos)
                               ? contents.substr(pos)
                               : contents.substr(pos, nl - pos);
        bool last = (nl == std::string::npos);
        pos = (nl == std::string::npos) ? contents.size() + 1 : nl + 1;
        if (line.empty()) {
            if (last) break;  // terminal newline only
            return fail("blank-line");
        }
        size_t colon = line.find(':');
        if (colon == std::string::npos) return fail("no-colon");
        std::string key = Strip(line.substr(0, colon));
        std::string val = Strip(line.substr(colon + 1));
        if (key == "stage" && stage.empty()) {
            stage = val;
        } else if (key == "approved_by" && by.empty()) {
            by = val;
        } else if (key == "approved_at" && at.empty()) {
            at = val;
        } else if (key == "capital_usd" && cap.empty()) {
            cap = val;
        } else if (key == "attest_hash" && attest.empty()) {
            attest = val;
        } else {
            return fail("unknown-or-duplicate-key");
        }
        ++seen;
        if (last) break;
    }
    if (seen != 5 || stage.empty() || by.empty() || at.empty() ||
        cap.empty() || attest.empty())
        return fail("missing-field");
    if (!IsKnownStage(stage)) return fail("unknown-stage");
    if (!CleanValue(by) || !ValidIso8601(at)) return fail("bad-field");
    long long capital = 0;
    if (!ParseCapital(cap, &capital)) return fail("bad-capital");
    if (!IsHex64(attest)) return fail("bad-attest-shape");
    std::string expect =
        jev::Sha256Hex(stage + "|" + by + "|" + at + "|" + cap + "|" +
                       prev_attest);
    // Case-insensitive compare (hex); recompute is lowercase.
    std::string lo = attest;
    for (char& c : lo)
        if (c >= 'A' && c <= 'F') c = static_cast<char>(c + 32);
    if (lo != expect) return fail("chain-mismatch");
    r.ok = true;
    r.effective = stage;
    r.reason = "ok";
    return r;
}

}  // namespace stage
