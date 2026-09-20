// P3.1 JEVAnswerSetV3 boundary validator. Self-contained, C++17, no deps.
// Pipeline: parse -> schema/type -> crypto -> state/freshness -> typed object.
// Construction of ValidatedJEVAnswerSetV3 is possible ONLY via validate().
#pragma once
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace jev {

enum class Mode { LIVE, REPLAY };
enum class EdgeFamily { MEAN_REVERSION, MOMENTUM, MACRO, EXECUTION };
enum class Conviction { FLAT, LEAN, STRONG, MAX };

// ---- small utils ----
inline bool IsHex64(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}
inline std::array<uint8_t, 32> Unhex32(const std::string& s) {
    std::array<uint8_t, 32> out{};
    auto v = [](char c) -> uint8_t {
        if (c >= '0' && c <= '9') return uint8_t(c - '0');
        return uint8_t(c - 'a' + 10);
    };
    for (int i = 0; i < 32; i++) out[i] = uint8_t((v(s[2 * i]) << 4) | v(s[2 * i + 1]));
    return out;
}

// ---- SHA-256 (FIPS 180-4) ----
struct Sha256 {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint64_t len = 0;
    uint8_t buf[64] = {};
    size_t nbuf = 0;
    static uint32_t R(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void block(const uint8_t* p) {
        static const uint32_t K[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
            0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
            0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
            0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; i++)
            w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
                   (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
        for (int i = 16; i < 64; i++) {
            uint32_t s0 = R(w[i - 15], 7) ^ R(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = R(w[i - 2], 17) ^ R(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5],
                 g = h[6], hh = h[7];
        for (int i = 0; i < 64; i++) {
            uint32_t S1 = R(e, 6) ^ R(e, 11) ^ R(e, 25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = hh + S1 + ch + K[i] + w[i];
            uint32_t S0 = R(a, 2) ^ R(a, 13) ^ R(a, 22);
            uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + mj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d;
        h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    void update(const uint8_t* p, size_t n) {
        len += n;
        while (n) {
            size_t k = 64 - nbuf < n ? 64 - nbuf : n;
            memcpy(buf + nbuf, p, k);
            nbuf += k; p += k; n -= k;
            if (nbuf == 64) { block(buf); nbuf = 0; }
        }
    }
    void update(const std::string& s) {
        update(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }
    std::array<uint8_t, 32> final() {
        uint64_t bitlen = len * 8;
        uint8_t one = 0x80;
        update(&one, 1);
        uint8_t zero = 0;
        while (nbuf != 56) update(&zero, 1);
        uint8_t lb[8];
        for (int i = 0; i < 8; i++) lb[i] = uint8_t(bitlen >> (56 - 8 * i));
        // feed length without disturbing len accounting
        for (int i = 0; i < 8; i++) {
            buf[nbuf++] = lb[i];
            if (nbuf == 64) { block(buf); nbuf = 0; }
        }
        std::array<uint8_t, 32> out{};
        for (int i = 0; i < 8; i++) {
            out[i * 4] = uint8_t(h[i] >> 24); out[i * 4 + 1] = uint8_t(h[i] >> 16);
            out[i * 4 + 2] = uint8_t(h[i] >> 8); out[i * 4 + 3] = uint8_t(h[i]);
        }
        return out;
    }
};
inline std::string Sha256Hex(const std::string& s) {
    Sha256 sh;
    sh.update(s);
    auto d = sh.final();
    static const char* H = "0123456789abcdef";
    std::string out;
    for (auto b : d) { out += H[b >> 4]; out += H[b & 15]; }
    return out;
}
// ---- minimal strict JSON ----
struct JVal {
    enum class T { NUL, BOOL, NUM, STR, ARR, OBJ } t = T::NUL;
    bool b = false;
    std::string num;
    bool num_double = false;
    double dval = 0;
    std::u32string s;
    std::vector<JVal> a;
    std::vector<std::pair<std::u32string, JVal>> o;
    const JVal* find(const std::u32string& k) const {
        if (t != T::OBJ) return nullptr;
        for (auto& kv : o)
            if (kv.first == k) return &kv.second;
        return nullptr;
    }
};
inline std::u32string U8(const char* s) {
    std::string t(s);
    return std::u32string(t.begin(), t.end());
}
struct JParse {
    const char* p;
    const char* end;
    int depth = 0;
    std::string err;
    // Resource bounds: artifacts are tiny; fail closed before big allocation.
    static constexpr size_t MAX_STR = 1024;   // string characters
    static constexpr size_t MAX_MEMB = 64;    // object members
    static constexpr size_t MAX_ARR = 64;     // array elements
    static constexpr size_t MAX_NUM = 64;     // numeric token bytes
    static constexpr size_t MAX_RAW = 65536;  // raw JSON bytes (checked first)
    JParse(const std::string& s) : p(s.data()), end(s.data() + s.size()) {}
    void ws() {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
    }
    bool lit(const char* w, JVal& out, JVal::T tt, bool bv) {
        size_t n = strlen(w);
        if (size_t(end - p) < n || strncmp(p, w, n)) { err = "bad-literal"; return false; }
        p += n; out.t = tt; out.b = bv; return true;
    }
    bool hex4(uint32_t& cp) {
        if (end - p < 4) return false;
        cp = 0;
        for (int i = 0; i < 4; i++, p++) {
            cp <<= 4;
            if (*p >= '0' && *p <= '9') cp |= uint32_t(*p - '0');
            else if (*p >= 'a' && *p <= 'f') cp |= uint32_t(*p - 'a' + 10);
            else if (*p >= 'A' && *p <= 'F') cp |= uint32_t(*p - 'A' + 10);
            else return false;
        }
        return true;
    }
    bool str(std::u32string& out) {
        if (p >= end || *p != '"') { err = "bad-string"; return false; }
        p++;
        while (true) {
            if (p >= end) { err = "bad-string"; return false; }
            char c = *p++;
            if (c == '"') return true;
            if (c == '\\') {
                if (p >= end) { err = "bad-string"; return false; }
                char e = *p++;
                if (e == '"' || e == '\\' || e == '/') {
                    if (out.size() >= MAX_STR) { err = "too-long-string"; return false; }
                    out += char32_t(e);
                }
                else if (e == 'b' || e == 'f' || e == 'n' || e == 'r' || e == 't') {
                    if (out.size() >= MAX_STR) { err = "too-long-string"; return false; }
                    out += char32_t(e == 'b' ? 8 : e == 'f' ? 12 : e == 'n' ? 10 : e == 'r' ? 13 : 9);
                }
                else if (e == 'u') {
                    uint32_t cp;
                    if (!hex4(cp)) { err = "bad-escape"; return false; }
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        if (end - p < 6 || p[0] != '\\' || p[1] != 'u') {
                            err = "bad-surrogate"; return false;
                        }
                        p += 2;
                        uint32_t lo;
                        if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF) {
                            err = "bad-surrogate"; return false;
                        }
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    if (out.size() >= MAX_STR) { err = "too-long-string"; return false; }
                    out += char32_t(cp);
                } else { err = "bad-escape"; return false; }
            } else if ((uint8_t)c < 0x20) { err = "bad-string"; return false; }
            else if ((uint8_t)c < 0x80) {
                if (out.size() >= MAX_STR) { err = "too-long-string"; return false; }
                out += char32_t(c);
            }
            else { err = "bad-utf8-raw"; return false; }
        }
    }
    bool number(JVal& out) {
        const char* s = p;
        if (p < end && (*p == '-')) p++;
        if (p >= end) { err = "bad-number"; return false; }
        if (*p == '0') p++;
        else if (*p >= '1' && *p <= '9') {
            while (p < end && *p >= '0' && *p <= '9') p++;
        } else { err = "bad-number"; return false; }
        bool isd = false;
        if (p < end && *p == '.') {
            isd = true; p++;
            if (p >= end || *p < '0' || *p > '9') { err = "bad-number"; return false; }
            while (p < end && *p >= '0' && *p <= '9') p++;
        }
        if (p < end && (*p == 'e' || *p == 'E')) {
            isd = true; p++;
            if (p < end && (*p == '+' || *p == '-')) p++;
            if (p >= end || *p < '0' || *p > '9') { err = "bad-number"; return false; }
            while (p < end && *p >= '0' && *p <= '9') p++;
        }
        if (size_t(p - s) > MAX_NUM) { err = "too-long-number"; return false; }
        out.t = JVal::T::NUM; out.num = std::string(s, p); out.num_double = isd;
        if (isd) {
            char* e = nullptr;
            out.dval = strtod(out.num.c_str(), &e);
            if (e == nullptr || *e != 0) { err = "bad-number"; return false; }
            if (!(out.dval == out.dval)) { err = "bad-number"; return false; }
            // finite only: reject overflow-to-inf, allow up to DBL_MAX
            if (std::isinf(out.dval)) { err = "bad-number"; return false; }
        }
        return true;
    }
    bool val(JVal& out) {
        if (++depth > 64) { err = "too-deep"; return false; }
        ws();
        if (p >= end) { err = "eof"; return false; }
        bool ok = false;
        char c = *p;
        if (c == '{') {
            p++; out.t = JVal::T::OBJ; ok = true;
            ws();
            if (p < end && *p == '}') { p++; }
            else while (true) {
                ws();
                if (out.o.size() >= MAX_MEMB) {
                    err = "too-many-members"; ok = false; break;
                }
                std::u32string k;
                if (!str(k)) { ok = false; break; }
                for (auto& kv : out.o)
                    if (kv.first == k) { err = "duplicate-keys"; ok = false; break; }
                if (!ok) break;
                ws();
                if (p >= end || *p != ':') { err = "bad-object"; ok = false; break; }
                p++;
                JVal v;
                if (!val(v)) { ok = false; break; }
                out.o.emplace_back(k, std::move(v));
                ws();
                if (p >= end) { err = "bad-object"; ok = false; break; }
                if (*p == ',') { p++; continue; }
                if (*p == '}') { p++; break; }
                err = "bad-object"; ok = false; break;
            }
        } else if (c == '[') {
            p++; out.t = JVal::T::ARR; ok = true;
            ws();
            if (p < end && *p == ']') { p++; }
            else while (true) {
                if (out.a.size() >= MAX_ARR) {
                    err = "too-many-elements"; ok = false; break;
                }
                JVal v;
                if (!val(v)) { ok = false; break; }
                out.a.push_back(std::move(v));
                ws();
                if (p >= end) { err = "bad-array"; ok = false; break; }
                if (*p == ',') { p++; continue; }
                if (*p == ']') { p++; break; }
                err = "bad-array"; ok = false; break;
            }
        } else if (c == '"') {
            std::u32string s; ok = str(s);
            out.t = JVal::T::STR; out.s = s;
        } else if (c == 't') ok = lit("true", out, JVal::T::BOOL, true);
        else if (c == 'f') ok = lit("false", out, JVal::T::BOOL, false);
        else if (c == 'n') ok = lit("null", out, JVal::T::NUL, false);
        else if (c == '-' || (c >= '0' && c <= '9')) ok = number(out);
        else { err = "bad-value"; }
        depth--;
        return ok;
    }
};
inline bool ParseJson(const std::string& s, JVal& out, std::string& err) {
    JParse j(s);
    if (!j.val(out)) { err = j.err; return false; }
    j.ws();
    if (j.p != j.end) { err = "trailing"; return false; }
    return true;
}
// ---- canonical JSON (P3.1-INTERNAL, NOT the frozen P3.2 contract) ----
// Used for response_hash recompute + signature message. Byte-equality with
// the sidecar is demonstrated per-fixture (valid passes, tampered fails),
// NOT proven in general: float formatting edge cases are P3.2's job.
// Do not cite this serializer as cross-language canonical until P3.2.
// Python repr()-compatible double formatting (needed NOW: response_hash and
// decision_key must reproduce sidecar bytes for ordinary magnitudes; the
// full cross-language contract + committed vector is still P3.2's job).
// Rule: shortest digits (to_chars), scientific iff decimal exponent < -4
// or >= 16, else positional; integral values carry ".0".
inline std::string PyFloatRepr(double d) {
    char b[32];
    auto r = std::to_chars(b, b + sizeof(b), d);
    std::string s(b, r.ptr);
    size_t epos = s.find('e');
    if (epos == std::string::npos) {
        if (s.find('.') == std::string::npos) s += ".0";
        return s;
    }
    bool neg = !s.empty() && s[0] == '-';
    size_t ds = neg ? 1 : 0;
    std::string digits;
    for (size_t i = ds; i < epos; i++)
        if (s[i] != '.') digits += s[i];
    int E = 0;
    {
        // bounded compiler-generated text, never attacker input
        bool eneg = s[epos + 1] == '-';
        for (size_t i = epos + 2; i < s.size(); i++) E = E * 10 + (s[i] - '0');
        if (eneg) E = -E;
    }
    std::string out = neg ? "-" : "";
    if (E < -4 || E >= 16) {
        out += digits[0];
        if (digits.size() > 1) {
            out += '.';
            out += digits.substr(1);
        }
        out += 'e';
        int ae = E < 0 ? -E : E;
        out += E < 0 ? '-' : '+';
        if (ae < 10) out += '0';
        out += std::to_string(ae);
        return out;
    }
    if (E >= 0) {
        std::string ip = digits.substr(0, (size_t)E + 1);
        std::string fp =
            digits.size() > (size_t)E + 1 ? digits.substr((size_t)E + 1) : "";
        while (ip.size() < (size_t)E + 1) ip += '0';
        out += ip;
        out += fp.empty() ? ".0" : "." + fp;
        return out;
    }
    out += "0.";
    for (int i = 0; i < -E - 1; i++) out += '0';
    out += digits;
    return out;
}
inline std::string CanonDouble(double d) { return PyFloatRepr(d); }
inline std::string CanonInt(const std::string& tok) {
    size_t i = 0; bool neg = false;
    if (i < tok.size() && (tok[i] == '-' || tok[i] == '+')) {
        neg = tok[i] == '-'; i++;
    }
    while (i + 1 < tok.size() && tok[i] == '0') i++;
    std::string m = tok.substr(i);
    if (m == "0") return "0";
    return neg ? "-" + m : m;
}
inline void AppendEscaped(std::string& out, const std::u32string& s) {
    static const char* H = "0123456789abcdef";
    out += '"';
    for (char32_t c : s) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == 8) out += "\\b";
        else if (c == 9) out += "\\t";
        else if (c == 10) out += "\\n";
        else if (c == 12) out += "\\f";
        else if (c == 13) out += "\\r";
        else if (c >= 0x20 && c < 0x7F) out += char(c);
        else {
            uint32_t v = c;
            if (v > 0xFFFF) {
                v -= 0x10000;
                uint32_t hi = 0xD800 + (v >> 10), lo = 0xDC00 + (v & 0x3FF);
                out += "\\u";
                for (int k = 3; k >= 0; k--) out += H[(hi >> (4 * k)) & 15];
                v = lo;
            }
            out += "\\u";
            for (int k = 3; k >= 0; k--) out += H[(v >> (4 * k)) & 15];
        }
    }
    out += '"';
}
inline void CanonAppend(std::string& out, const JVal& v);
inline void CanonAppend(std::string& out, const JVal& v) {
    switch (v.t) {
        case JVal::T::NUL: out += "null"; break;
        case JVal::T::BOOL: out += v.b ? "true" : "false"; break;
        case JVal::T::NUM:
            out += v.num_double ? CanonDouble(v.dval) : CanonInt(v.num);
            break;
        case JVal::T::STR: AppendEscaped(out, v.s); break;
        case JVal::T::ARR:
            out += '[';
            for (size_t i = 0; i < v.a.size(); i++) {
                if (i) out += ',';
                CanonAppend(out, v.a[i]);
            }
            out += ']';
            break;
        case JVal::T::OBJ: {
            out += '{';
            std::vector<const std::pair<std::u32string, JVal>*> ks;
            for (auto& kv : v.o) ks.push_back(&kv);
            std::sort(ks.begin(), ks.end(),
                      [](auto* x, auto* y) { return x->first < y->first; });
            for (size_t i = 0; i < ks.size(); i++) {
                if (i) out += ',';
                AppendEscaped(out, ks[i]->first);
                out += ':';
                CanonAppend(out, ks[i]->second);
            }
            out += '}';
            break;
        }
    }
}
inline std::string CanonJson(const JVal& v) {
    std::string out;
    CanonAppend(out, v);
    return out;
}
// ---- SHA-512 (FIPS 180-4) ----
struct Sha512 {
    uint64_t h[8] = {0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL,
                     0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
                     0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
                     0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL};
    __int128 dummy = 0;
    uint64_t len = 0;
    uint8_t buf[128] = {};
    size_t nbuf = 0;
    static uint64_t R(uint64_t x, int n) { return (x >> n) | (x << (64 - n)); }
    void block(const uint8_t* p) {
        static const uint64_t K[80] = {
            0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL, 0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL, 0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL, 0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL, 0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL, 0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL, 0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL, 0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL, 0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL, 0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL, 0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL, 0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL, 0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL, 0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL, 0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL, 0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL, 0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL, 0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL, 0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL, 0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL};
        uint64_t w[80];
        for (int i = 0; i < 16; i++) {
            w[i] = 0;
            for (int k = 0; k < 8; k++) w[i] = (w[i] << 8) | p[i * 8 + k];
        }
        for (int i = 16; i < 80; i++) {
            uint64_t s0 = R(w[i-15],1) ^ R(w[i-15],8) ^ (w[i-15] >> 7);
            uint64_t s1 = R(w[i-2],19) ^ R(w[i-2],61) ^ (w[i-2] >> 6);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint64_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
        for (int i = 0; i < 80; i++) {
            uint64_t S1 = R(e,14) ^ R(e,18) ^ R(e,41);
            uint64_t ch = (e & f) ^ (~e & g);
            uint64_t t1 = hh + S1 + ch + K[i] + w[i];
            uint64_t S0 = R(a,28) ^ R(a,34) ^ R(a,39);
            uint64_t mj = (a & b) ^ (a & c) ^ (b & c);
            uint64_t t2 = S0 + mj;
            hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    void update(const uint8_t* p, size_t n) {
        len += n;
        while (n) {
            size_t k = 128 - nbuf < n ? 128 - nbuf : n;
            memcpy(buf + nbuf, p, k);
            nbuf += k; p += k; n -= k;
            if (nbuf == 128) { block(buf); nbuf = 0; }
        }
    }
    void update(const std::string& s) {
        update(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }
    std::array<uint8_t, 64> final() {
        uint64_t bitlen = len * 8;
        uint8_t one = 0x80, zero = 0;
        update(&one, 1);
        while (nbuf != 112) update(&zero, 1);
        uint8_t lb[16] = {};
        for (int i = 0; i < 8; i++) lb[8 + i] = uint8_t(bitlen >> (56 - 8 * i));
        for (int i = 0; i < 16; i++) {
            buf[nbuf++] = lb[i];
            if (nbuf == 128) { block(buf); nbuf = 0; }
        }
        std::array<uint8_t, 64> out{};
        for (int i = 0; i < 8; i++)
            for (int k = 0; k < 8; k++) out[i * 8 + k] = uint8_t(h[i] >> (56 - 8 * k));
        return out;
    }
};

// ---- GF(2^255-19): 8x32-bit limbs, __int128 intermediates ----
struct F {
    uint32_t l[8] = {};
    static F zero() { return F(); }
    static F one() { F f; f.l[0] = 1; return f; }
    bool operator==(const F& o) const {
        for (int i = 0; i < 8; i++)
            if (l[i] != o.l[i]) return false;
        return true;
    }
};
// lat (limb array, 16 wide, __int128) -> reduced F
inline F Reduce16(unsigned __int128 t[16]) {
    for (int i = 0; i < 15; i++) {
        t[i + 1] += t[i] >> 32;
        t[i] &= 0xFFFFFFFF;
    }
    // V = lo + 2^256*hi, 2^256 = 38 mod p
    unsigned __int128 r[9] = {};
    for (int i = 0; i < 8; i++) r[i] = t[i];
    for (int i = 0; i < 8; i++) r[i] += (unsigned __int128)38 * t[i + 8];
    for (int i = 0; i < 8; i++) {
        r[i + 1] += r[i] >> 32;
        r[i] &= 0xFFFFFFFF;
    }
    // r[8] is value * 2^256 = value * 38: fold until nothing remains above limb 7
    while (r[8] != 0) {
        unsigned __int128 c = r[8];
        r[8] = 0;
        r[0] += (unsigned __int128)38 * c;
        for (int i = 0; i < 8; i++) {
            r[i + 1] += r[i] >> 32;
            r[i] &= 0xFFFFFFFF;
        }
    }
    F out;
    for (int i = 0; i < 8; i++) out.l[i] = uint32_t(r[i]);
    static const uint32_t P[8] = {0xFFFFFFED, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF,
                                  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0x7FFFFFFF};
    for (int k = 0; k < 64; k++) {
        bool ge = true;
        for (int i = 7; i >= 0; i--) {
            if (out.l[i] < P[i]) { ge = false; break; }
            if (out.l[i] > P[i]) break;
        }
        if (!ge) break;
        uint32_t borrow = 0;
        for (int i = 0; i < 8; i++) {
            uint64_t sub = uint64_t(P[i]) + borrow;
            if (uint64_t(out.l[i]) >= sub) {
                out.l[i] = uint32_t(uint64_t(out.l[i]) - sub);
                borrow = 0;
            } else {
                out.l[i] = uint32_t((uint64_t(1) << 32) + out.l[i] - sub);
                borrow = 1;
            }
        }
    }
    return out;
}
inline F Fadd(const F& a, const F& b) {
    unsigned __int128 t[16] = {};
    for (int i = 0; i < 8; i++) t[i] = (unsigned __int128)a.l[i] + b.l[i];
    return Reduce16(t);
}
inline F Fsub(const F& a, const F& b) {
    // a - b = a + (p - b); p - b is exact since b < p.
    static const uint32_t P[8] = {0xFFFFFFED, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF,
                                  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0x7FFFFFFF};
    F nb;
    uint32_t borrow = 0;
    for (int i = 0; i < 8; i++) {
        uint64_t sub = uint64_t(P[i]) - b.l[i] - borrow;
        // P >= b overall so chain ends clean; per-limb wrap is fine unsigned
        nb.l[i] = uint32_t(sub & 0xFFFFFFFF);
        borrow = (uint64_t(b.l[i]) + borrow > uint64_t(P[i])) ? 1 : 0;
    }
    return Fadd(a, nb);
}
inline F Fmul(const F& a, const F& b) {
    unsigned __int128 t[16] = {};
    for (int i = 0; i < 8; i++)
        for (int j = 0; j < 8; j++) t[i + j] += (unsigned __int128)a.l[i] * b.l[j];
    return Reduce16(t);
}
inline F FpowBits(F a, const std::vector<int>& bits) {
    F r = F::one();
    for (int bit : bits) {
        r = Fmul(r, r);
        if (bit) r = Fmul(r, a);
    }
    return r;
}
inline std::vector<int> ExpBits(unsigned long long e) {
    std::vector<int> b;
    for (int i = 63; i >= 0; i--) b.push_back((e >> i) & 1);
    size_t k = 0;
    while (k + 1 < b.size() && b[k] == 0) k++;
    return std::vector<int>(b.begin() + k, b.end());
}
// x^((p-5)/8)... generic big-exponent helper via binary string
inline F FpowStr(F a, const char* bitstr) {
    F r = F::one();
    for (const char* p = bitstr; *p; p++) {
        r = Fmul(r, r);
        if (*p == '1') r = Fmul(r, a);
    }
    return r;
}

// ---- ed25519 group (extended coords), verify-only ----
struct Pt { F X, Y, Z, T; };
inline F FfromLE(const uint8_t b[32]) {
    F f;
    for (int i = 0; i < 8; i++)
        f.l[i] = (uint32_t(b[i * 4]) | (uint32_t(b[i * 4 + 1]) << 8) |
                  (uint32_t(b[i * 4 + 2]) << 16) | (uint32_t(b[i * 4 + 3]) << 24));
    return f;
}
inline void FtoLE(const F& f, uint8_t b[32]) {
    for (int i = 0; i < 8; i++) {
        b[i * 4] = uint8_t(f.l[i]); b[i * 4 + 1] = uint8_t(f.l[i] >> 8);
        b[i * 4 + 2] = uint8_t(f.l[i] >> 16); b[i * 4 + 3] = uint8_t(f.l[i] >> 24);
    }
}
// d = -121665 * inv(121666)
inline const F& EdD() {
    // Function-local static: thread-safe initialization (C++11).
    static const F d = [] {
        F n, e;
        n.l[0] = 121665;
        e.l[0] = 121666;
        // e^(p-2): exponent bits of p-2 (p = 2^255-19)
        F inv = F::one();
        F base = e;
        // p-2 = 2^255 - 21: bits 254..5 = 1, low 5 bits = 11 = 0b01011
        for (int i = 254; i >= 0; i--) {
            inv = Fmul(inv, inv);
            int bit = (i >= 5) ? 1 : ((0x0B >> i) & 1);
            if (bit) inv = Fmul(inv, base);
        }
        (void)n;
        return Fsub(F::zero(), Fmul(n, inv));
    }();
    return d;
}
inline Pt PtAdd(const Pt& p, const Pt& q, const F& d) {
    F A = Fmul(Fsub(p.Y, p.X), Fsub(q.Y, q.X));
    F B = Fmul(Fadd(p.Y, p.X), Fadd(q.Y, q.X));
    F C = Fmul(p.T, Fmul(Fadd(d, d), q.T));
    F D = Fmul(p.Z, Fadd(q.Z, q.Z));
    F E = Fsub(B, A);
    F Ff = Fsub(D, C);
    F G = Fadd(D, C);
    F H = Fadd(B, A);
    Pt r;
    r.X = Fmul(E, Ff); r.Y = Fmul(G, H); r.Z = Fmul(Ff, G); r.T = Fmul(E, H);
    return r;
}
inline Pt PtDbl(const Pt& p, const F& d) { return PtAdd(p, p, d); }
inline Pt PtMul(const Pt& p, const bool bits[256], const F& d) {
    Pt q;
    q.X = F::zero(); q.Y = F::one(); q.Z = F::one(); q.T = F::zero();
    for (int i = 255; i >= 0; i--) {
        q = PtDbl(q, d);
        if (bits[i]) q = PtAdd(q, p, d);
    }
    return q;
}
inline void ScalarBitsLE(const uint8_t s[32], bool bits[256]) {
    for (int i = 0; i < 32; i++)
        for (int k = 0; k < 8; k++) bits[i * 8 + k] = (s[i] >> k) & 1;
}
inline const Pt& BasePoint() {
    // Function-local static: thread-safe initialization (C++11).
    static const Pt b = [] {
        Pt b;
        // Bx, By true values (oracle-proven via Python sidecar vectors)
        const uint8_t xb[32] = {0x1a, 0xd5, 0x25, 0x8f, 0x60, 0x2d, 0x56, 0xc9,
                                0xb2, 0xa7, 0x25, 0x95, 0x60, 0xc7, 0x2c, 0x69,
                                0x5c, 0xdc, 0xd6, 0xfd, 0x31, 0xe2, 0xa4, 0xc0,
                                0xfe, 0x53, 0x6e, 0xcd, 0xd3, 0x36, 0x69, 0x21};
        const uint8_t yb[32] = {0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
                                0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
                                0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
                                0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66};
        b.X = FfromLE(xb); b.Y = FfromLE(yb);
        b.Z = F::one(); b.T = Fmul(b.X, b.Y);
        return b;
    }();
    return b;
}
// decode compressed point per RFC 8032 §5.1.3: canonical y, x^2 == target
// re-checked after the sqrt(-1) adjustment, x==0 with sign bit rejected.
inline bool PtDecode(const uint8_t enc[32], Pt& out) {
    uint8_t cp[32];
    memcpy(cp, enc, 32);
    int sign = (cp[31] >> 7) & 1;
    cp[31] &= 0x7F;
    F y = FfromLE(cp);
    // reject y >= p (FfromLE loads raw limbs, so compare explicitly)
    {
        static const uint8_t P[32] = {
            0xED, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
            0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
            0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F};
        bool ge = true;
        for (int i = 31; i >= 0; i--) {
            if (cp[i] < P[i]) {
                ge = false;
                break;
            }
            if (cp[i] > P[i]) break;
        }
        if (ge) return false;
    }
    // NOTE: no y==0/sign rejection here. x == 0 occurs for y == +/-1, not
    // y == 0 (x^2 = (y^2-1)/(d*y^2+1)); the x==0/sign check below examines
    // the RECOVERED x per RFC 8032 s5.1.3.
    F d = EdD();
    F y2 = Fmul(y, y);
    F u = Fsub(y2, F::one());
    F v = Fadd(Fmul(d, y2), F::one());
    // x = sqrt(u/v): x = (u * inv(v))^((p+5)/8), adjust
    F vinv = F::one(), vb = v;
    // v^(p-2) via bits of p-2: bits 254..5 = 1, low5 = 01011
    for (int i = 254; i >= 0; i--) {
        vinv = Fmul(vinv, vinv);
        int bit = (i >= 5) ? 1 : ((0x0B >> i) & 1);
        if (bit) vinv = Fmul(vinv, vb);
    }
    F x = Fmul(u, vinv);
    // x = xx^((p+3)//8); (p+3)//8 = 2^252 - 2: bits 251..1 set (matches sidecar)
    F e = F::one();
    for (int i = 252; i >= 0; i--) {
        e = Fmul(e, e);
        int bit = (i >= 1 && i <= 251) ? 1 : 0;
        if (bit) e = Fmul(e, x);
    }
    F x2 = Fmul(e, e);
    // if e^2 != xx, multiply by sqrt(-1) (matches sidecar _xrecover)
    F diff = Fsub(x2, x);
    bool iszero = true;
    for (int i = 0; i < 8; i++)
        if (diff.l[i] != 0) iszero = false;
    if (!iszero) {
        // sqrtm1 = 2^((p-1)/4): bits: (p-1)/4 = 2^253 - 5: bits 252..3=1, low3=011
        F s = F::one();
        F two; two.l[0] = 2;
        for (int i = 252; i >= 0; i--) {
            s = Fmul(s, s);
            int bit = (i >= 3) ? 1 : ((0x03 >> i) & 1);
            if (bit) s = Fmul(s, two);
        }
        e = Fmul(e, s);
        // RFC 8032: if x^2 still != target after adjustment, decoding FAILS.
        F x2b = Fmul(e, e);
        F diffb = Fsub(x2b, x);
        for (int i = 0; i < 8; i++)
            if (diffb.l[i] != 0) return false;
    }
    // RFC 8032 s5.1.3: if the recovered x == 0 and the sign bit is 1, FAIL.
    // (x == 0 for y == +/-1; y == 0/sign == 1 is a VALID point.)
    {
        bool xzero = true;
        for (int i = 0; i < 8; i++)
            if (e.l[i] != 0) xzero = false;
        if (xzero && sign) return false;
    }
    if ((e.l[0] & 1u) != (uint32_t)sign) e = Fsub(F::zero(), e);
    out.X = e; out.Y = y; out.Z = F::one(); out.T = Fmul(e, y);
    return true;
}
inline void PtEncode(const Pt& p, uint8_t enc[32]) {
    F zinv = F::one(), zb = p.Z;
    for (int i = 254; i >= 0; i--) {
        zinv = Fmul(zinv, zinv);
        int bit = (i >= 5) ? 1 : ((0x0B >> i) & 1);
        if (bit) zinv = Fmul(zinv, zb);
    }
    F x = Fmul(p.X, zinv), y = Fmul(p.Y, zinv);
    FtoLE(y, enc);
    enc[31] |= uint8_t((x.l[0] & 1) << 7);
}
// order L = 2^252 + 27742317777372353535851937790883648493
// AMENDMENT (P3.3 integration found it): the LE table below was wrong from
// byte 5 on (top bytes read 0x10/0x0F instead of 0x00/0x10), false-rejecting
// ~6% of VALID signatures (S[31]==0x0F, S[30]>=0x10) as S>=L. Never
// false-accepted (direction was fail-closed: the wrong table is STRICTER).
// Corrected bytes cross-checked against Python integers AND Reduce512's LB
// limbs; full P3.1/P3.2/fuzz gates re-run green. Pending human re-sign.
inline bool ScalarLessL(const uint8_t s[32]) {
    static const uint8_t L[32] = {0xED, 0xD3, 0xF5, 0x5C, 0x1A, 0x63, 0x12, 0x58,
                                  0xD6, 0x9C, 0xF7, 0xA2, 0xDE, 0xF9, 0xDE, 0x14,
                                  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10};
    for (int i = 31; i >= 0; i--) {
        if (s[i] < L[i]) return true;
        if (s[i] > L[i]) return false;
    }
    return false;  // equal is not less
}
// 512-bit LE mod L -> 32-byte LE. Bit-by-bit double-and-reduce:
// invariant r < L, so r*2+bit < 2L+1 and one conditional subtract suffices.
inline void Reduce512(const uint8_t x[64], uint8_t out[32]) {
    static const uint64_t LB[5] = {0x5812631A5CF5D3EDULL, 0x14DEF9DEA2F79CD6ULL,
                                   0x0000000000000000ULL, 0x1000000000000000ULL,
                                   0x0000000000000000ULL};
    uint64_t r[5] = {};
    for (int i = 511; i >= 0; i--) {
        uint64_t carry = (uint64_t)((x[i >> 3] >> (i & 7)) & 1);
        for (int k = 0; k < 5; k++) {
            uint64_t top = r[k] >> 63;
            r[k] = (r[k] << 1) | carry;
            carry = top;
        }
        bool ge = true;
        for (int k = 4; k >= 0; k--) {
            if (r[k] < LB[k]) { ge = false; break; }
            if (r[k] > LB[k]) break;
        }
        if (ge) {
            uint64_t borrow = 0;
            for (int k = 0; k < 5; k++) {
                unsigned __int128 sub = (unsigned __int128)LB[k] + borrow;
                unsigned __int128 cur = r[k];
                r[k] = (uint64_t)(cur - sub);
                borrow = (cur < sub) ? 1 : 0;
            }
        }
    }
    for (int k = 0; k < 4; k++)
        for (int b = 0; b < 8; b++) out[k * 8 + b] = (uint8_t)(r[k] >> (8 * b));
}
inline bool EdVerify(const uint8_t pub[32], const uint8_t msg[], size_t msglen,
                      const uint8_t sig[64]) {
    if (!ScalarLessL(sig + 32)) return false;
    Pt A, R;
    if (!PtDecode(pub, A)) return false;
    uint8_t renc[32];
    memcpy(renc, sig, 32);
    if (!PtDecode(renc, R)) return false;
    Sha512 h;
    h.update(sig, 32);
    h.update(pub, 32);
    h.update(msg, msglen);
    auto digest = h.final();
    uint8_t hr[64];
    memcpy(hr, digest.data(), 64);
    uint8_t hreduced[32];
    Reduce512(hr, hreduced);
    F d = EdD();
    Pt B = BasePoint();
    bool sbits[256], hbits[256];
    ScalarBitsLE(sig + 32, sbits);
    ScalarBitsLE(hreduced, hbits);
    Pt sB = PtMul(B, sbits, d);
    Pt hA = PtMul(A, hbits, d);
    // check sB == R + hA: compare R+hA re-encoded with sig R
    Pt sum = PtAdd(R, hA, d);
    uint8_t enc[32], enc2[32];
    PtEncode(sum, enc);
    PtEncode(sB, enc2);
    // S*B == R + h*A  <=>  identical canonical encodings
    return memcmp(enc, enc2, 32) == 0;
}

// ---- ISO-8601 -> unix seconds (requires explicit timezone) ----
inline int64_t DaysFromCivil(int y, int m, int d) {
    y -= m <= 2;
    int era = (y >= 0 ? y : y - 399) / 400;
    int yoe = y - era * 400;
    int mp = (m + 9) % 12;
    int doy = (153 * mp + 2) / 5 + d - 1;
    int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return (int64_t)era * 146097 + doe - 719468;
}
inline bool ParseIso8601(const std::u32string& in, double& out) {
    std::string s;
    for (char32_t c : in) {
        if (c > 127) return false;
        s += (char)c;
    }
    if (s.size() < 19) return false;
    auto num = [&](int pos, int len, int& v) -> bool {
        v = 0;
        for (int i = 0; i < len; i++) {
            char c = s[pos + i];
            if (c < '0' || c > '9') return false;
            v = v * 10 + (c - '0');
        }
        return true;
    };
    int Y, M, D, h, mi, se;
    if (!num(0, 4, Y) || s[4] != '-' || !num(5, 2, M) || s[7] != '-' ||
        !num(8, 2, D) || s[10] != 'T' || !num(11, 2, h) || s[13] != ':' ||
        !num(14, 2, mi) || s[16] != ':' || !num(17, 2, se))
        return false;
    size_t p = 19;
    double frac = 0;
    if (p < s.size() && s[p] == '.') {
        p++;
        double place = 0.1;
        bool any = false;
        while (p < s.size() && s[p] >= '0' && s[p] <= '9') {
            frac += (s[p] - '0') * place;
            place *= 0.1;
            p++;
            any = true;
        }
        if (!any) return false;
    }
    int off = 0;
    if (p < s.size() && (s[p] == 'Z' || s[p] == 'z')) {
        p++;
    } else if (p + 5 < s.size() + 1 && (s[p] == '+' || s[p] == '-')) {
        int oh, om;
        int sign = (s[p] == '-') ? -1 : 1;
        if (!num(p + 1, 2, oh) || s[p + 3] != ':' || !num(p + 4, 2, om))
            return false;
        off = sign * (oh * 3600 + om * 60);
        p += 6;
    } else {
        return false;
    }
    if (p != s.size()) return false;
    if (M < 1 || M > 12 || h > 23 || mi > 59 || se > 59) return false;
    // strict calendar: real month lengths incl. leap years; no leap seconds.
    {
        int dim = 31;
        if (M == 4 || M == 6 || M == 9 || M == 11) dim = 30;
        else if (M == 2) {
            bool leap = (Y % 4 == 0 && Y % 100 != 0) || (Y % 400 == 0);
            dim = leap ? 29 : 28;
        }
        if (D < 1 || D > dim) return false;
    }
    // contractually constrained year range for a signed expiry boundary
    if (Y < 1970 || Y > 2100) return false;
    out = (double)DaysFromCivil(Y, M, D) * 86400.0 + h * 3600 + mi * 60 + se +
          frac - off;
    return true;
}

// ---- ValidatedJEVAnswerSetV3: constructible ONLY via validate() ----
struct ValidationRequest;
struct ValidationResult;
ValidationResult validate_jev(const ValidationRequest&);
class ValidatedJEVAnswerSetV3 {
   public:
    const std::string& symbol() const { return symbol_; }
    int64_t snapshot_epoch() const { return epoch_; }
    const std::string& state_hash() const { return state_hash_; }
    const std::string& decision_key() const { return decision_key_; }
    double created_at() const { return created_; }
    double expires_at() const { return expires_; }
    double enter() const { return enter_; }
    double latent_risk() const { return latent_; }
    EdgeFamily family() const { return family_; }
    Conviction conviction() const { return conviction_; }
    const std::string& response_hash() const { return response_hash_; }
    // NOTE: no confidence accessor. P3.4 default is (b) quarantine: confidence
    // is structurally validated for artifact compatibility but never stored
    // in, and never readable from, the decision-facing object.

   private:
    ValidatedJEVAnswerSetV3() = default;
    std::string symbol_, state_hash_, decision_key_, response_hash_;
    int64_t epoch_ = 0;
    double created_ = 0, expires_ = 0, enter_ = 0, latent_ = 0;
    EdgeFamily family_ = EdgeFamily::MACRO;
    Conviction conviction_ = Conviction::FLAT;
    friend struct ValidationResult;
    friend ValidationResult validate_jev(const ValidationRequest&);
};

struct ValidationRequest {
    std::string raw_json;
    std::array<uint8_t, 32> trusted_key;
    std::string state_canon_json;     // kernel-owned canonical snapshot bytes
    std::vector<std::string> allowed_symbols;  // kernel-owned exec universe
    bool has_previous_epoch = false;  // kernel-owned last accepted epoch
    int64_t previous_epoch = 0;       // (per symbol; unset = first artifact)
    double now_unix = 0;              // live clock; ignored in REPLAY
    Mode mode = Mode::LIVE;
};
struct ValidationResult {
    // The validated object exists ONLY on success: get() is null on HOLD.
    bool ok() const { return ok_; }
    const std::string& reason() const { return reason_; }  // "ok" or HOLD
    const ValidatedJEVAnswerSetV3* get() const {
        return ok_ ? &value_ : nullptr;
    }

   private:
    ValidationResult() = default;
    bool ok_ = false;
    std::string reason_;
    ValidatedJEVAnswerSetV3 value_;
    friend ValidationResult validate_jev(const ValidationRequest&);
};

inline std::string U32ToUtf8(const std::u32string& s) {
    std::string out;
    for (char32_t c : s) {
        if (c < 0x80) out += (char)c;
        else if (c < 0x800) {
            out += (char)(0xC0 | (c >> 6));
            out += (char)(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            out += (char)(0xE0 | (c >> 12));
            out += (char)(0x80 | ((c >> 6) & 0x3F));
            out += (char)(0x80 | (c & 0x3F));
        } else {
            out += (char)(0xF0 | (c >> 18));
            out += (char)(0x80 | ((c >> 12) & 0x3F));
            out += (char)(0x80 | ((c >> 6) & 0x3F));
            out += (char)(0x80 | (c & 0x3F));
        }
    }
    return out;
}

// Python str() mirror for decision-key parts (frozen sidecar semantics):
// str->itself, int->decimal, float->shortest repr, bool->True/False,
// null->None, missing->"?". Composites use canonical JSON (documented
// deviation: the sidecar never emits composite parts, so any divergence
// fails closed at the decision-binding comparison).
inline std::string PyStr(const JVal& v) {
    switch (v.t) {
        case JVal::T::STR:
            return U32ToUtf8(v.s);
        case JVal::T::NUM:
            if (v.num_double) return CanonDouble(v.dval);
            if (v.num.size() > 1 && v.num[0] == '-') {
                bool allz = true;
                for (size_t i = 1; i < v.num.size(); i++)
                    if (v.num[i] != '0') allz = false;
                if (allz) return "0";  // JSON -0 == Python 0
            }
            return v.num;
        case JVal::T::BOOL:
            return v.b ? "True" : "False";
        case JVal::T::NUL:
            return "None";
        default:
            return CanonJson(v);
    }
}
inline const JVal* ObjGet(const JVal& o, const char* k) {
    if (o.t != JVal::T::OBJ) return nullptr;
    return o.find(U8(k));
}
inline std::string ComputeDecisionKey(const JVal& state) {
    // Mirrors frozen collector/jev.py decision_key() field-for-field.
    static const JVal EMPTY_OBJ = [] {
        JVal v;
        v.t = JVal::T::OBJ;
        return v;
    }();
    const JVal* ind = ObjGet(state, "indicators");
    const JVal* pf = ObjGet(state, "portfolio");
    const JVal* ew = ObjGet(state, "event_window");
    if (!ind) ind = &EMPTY_OBJ;
    if (!pf) pf = &EMPTY_OBJ;
    if (!ew) ew = &EMPTY_OBJ;
    auto part = [&](const JVal* o, const char* k) -> std::string {
        const JVal* v = ObjGet(*o, k);
        return v ? PyStr(*v) : "?";
    };
    // feature_revision = sha256_hex(",".join(sorted ids, non-dicts skipped))
    std::string frev;
    {
        std::vector<std::string> ids;
        const JVal* feats = ObjGet(state, "features");
        if (feats && feats->t == JVal::T::ARR) {
            for (auto& f : feats->a) {
                if (f.t != JVal::T::OBJ) continue;  // sidecar skips non-dicts
                const JVal* id = ObjGet(f, "feature_id");
                if (!id || id->t != JVal::T::STR)
                    ids.push_back("?");
                else
                    ids.push_back(U32ToUtf8(id->s));
            }
        }
        std::sort(ids.begin(), ids.end());
        std::string joined;
        for (size_t i = 0; i < ids.size(); i++) {
            if (i) joined += ",";
            joined += ids[i];
        }
        frev = Sha256Hex(joined);
    }
    std::string parts =
        part(&state, "symbol") + "|" + part(&state, "snapshot_epoch") + "|" +
        part(ind, "price_return_bucket") + "|" + part(&state, "spread_bps") +
        "|" + part(ind, "atr_bucket") + "|" + part(ind, "zscore") + "|" +
        part(ind, "regime") + "|" + part(ew, "phase") + "|" +
        part(pf, "exposure_pct") + "|" + frev + "|" +
        part(&state, "research_revision") + "|v3";
    return Sha256Hex(parts);
}

inline ValidationResult validate_jev(const ValidationRequest& q) {

    ValidationResult r;
    auto fail = [&](const char* why) -> ValidationResult {
        r.ok_ = false;
        r.reason_ = why;
        return r;
    };
    // 1. size bound first: fail closed before any allocation
    if (q.raw_json.size() > JParse::MAX_RAW) return fail("too-large");
    // 1. parse
    JVal root;
    std::string perr;
    if (!ParseJson(q.raw_json, root, perr)) {
        if (perr == "duplicate-keys") return fail("duplicate-keys");
        return fail("parse-error");
    }
    if (root.t != JVal::T::OBJ) return fail("parse-error");
    // 2. exact top-level schema (+ optional informational pubkey, never trusted)
    {
        bool has_payload = false, has_rh = false, has_sig = false;
        for (auto& kv : root.o) {
            std::string k = U32ToUtf8(kv.first);
            if (k == "payload") has_payload = true;
            else if (k == "response_hash") has_rh = true;
            else if (k == "signature") has_sig = true;
            else if (k == "pubkey") {
                if (kv.second.t != JVal::T::STR) return fail("top-level-keys");
                std::string pk = U32ToUtf8(kv.second.s);
                if (pk.size() != 64) return fail("top-level-keys");
                for (char c : pk)
                    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                          (c >= 'A' && c <= 'F')))
                        return fail("top-level-keys");
            } else return fail("top-level-keys");
        }
        if (!has_payload || !has_rh || !has_sig) return fail("top-level-keys");
    }
    const JVal* payload = root.find(U8("payload"));
    const JVal* rh = root.find(U8("response_hash"));
    const JVal* sig = root.find(U8("signature"));
    if (!payload || payload->t != JVal::T::OBJ) return fail("top-level-keys");
    // payload: exact 12 fields (check 2/3)
    if (payload->o.size() != 12) return fail("payload-keys");
    for (auto& kv : payload->o) {
        std::string k = U32ToUtf8(kv.first);
        if (k != "schema_version" && k != "question_set_version" && k != "model" &&
            k != "revision" && k != "provider" && k != "symbol" &&
            k != "snapshot_epoch" && k != "state_hash" && k != "decision_key" &&
            k != "created_at" && k != "expires_at" && k != "answers")
            return fail("payload-keys");
    }
    // 3-14. payload pins and shapes
    auto getstr = [&](const char* k, std::string& out) -> bool {
        const JVal* v = payload->find(U8(k));
        if (!v || v->t != JVal::T::STR) return false;
        out = U32ToUtf8(v->s);
        return true;
    };
    std::string sv, qv, model, rev, prov, symbol, sth, dk;
    if (!getstr("schema_version", sv) || sv != "answerset_v1")
        return fail("schema-version");
    if (!getstr("question_set_version", qv) || qv != "v3")
        return fail("qversion");
    if (!getstr("model", model) || model != "typesafe/jev-1.13")
        return fail("model");
    if (!getstr("revision", rev) || rev != "typesafe/jev-1.13-20260917")
        return fail("revision");
    if (!getstr("provider", prov) || prov != "TypeSafe")
        return fail("provider");
    if (!getstr("symbol", symbol) || symbol.empty() || symbol.size() > 16)
        return fail("symbol");
    for (char c : symbol)
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
              c == '/'))
            return fail("symbol");
    // exec-universe membership: kernel-owned set, syntax alone never suffices
    {
        bool member = false;
        for (auto& a : q.allowed_symbols)
            if (a == symbol) {
                member = true;
                break;
            }
        if (!member) return fail("symbol-universe");
    }
    const JVal* ep = payload->find(U8("snapshot_epoch"));
    if (!ep || ep->t != JVal::T::NUM || ep->num_double) return fail("snapshot-epoch");
    int64_t epoch = 0;
    {
        const std::string& tok = ep->num;
        size_t i = 0;
        bool neg = false;
        if (i < tok.size() && (tok[i] == '-' || tok[i] == '+')) {
            neg = tok[i] == '-';
            i++;
        }
        if (i >= tok.size()) return fail("snapshot-epoch");
        for (; i < tok.size(); i++) {
            char c = tok[i];
            if (c < '0' || c > '9') return fail("snapshot-epoch");
            if (epoch > (INT64_MAX - 9) / 10) return fail("snapshot-epoch");
            epoch = epoch * 10 + (c - '0');
        }
        if (neg) return fail("snapshot-epoch");
    }
    // monotonic per symbol: strictly greater than the last accepted epoch.
    // (Frozen rule, plan/13 check 9. Applies in LIVE and REPLAY alike.)
    if (q.has_previous_epoch && !(epoch > q.previous_epoch))
        return fail("epoch-not-monotonic");
    if (!getstr("state_hash", sth) || !IsHex64(sth)) return fail("state-hash-shape");
    if (!getstr("decision_key", dk) || !IsHex64(dk)) return fail("decision-key-shape");
    const JVal* ca = payload->find(U8("created_at"));
    double created = 0;
    if (!ca || ca->t != JVal::T::STR || !ParseIso8601(ca->s, created))
        return fail("created-at");
    const JVal* ea = payload->find(U8("expires_at"));
    if (!ea || ea->t != JVal::T::NUM) return fail("expires-at");
    double expires = 0;
    if (ea->num_double) {
        expires = ea->dval;  // finite: enforced by the parser
    } else {
        // checked integer conversion: no atoll on attacker-controlled input
        int64_t whole = 0;
        const char* b = ea->num.c_str();
        const char* e = b + ea->num.size();
        auto res = std::from_chars(b, e, whole);
        if (res.ptr != e || res.ec != std::errc()) return fail("expires-at");
        expires = (double)whole;
    }
    if (!(expires == expires) || expires > 1e18 || expires < -1e18)
        return fail("expires-at");
    if (!(expires >= created + 59.999 && expires <= created + 60.001))
        return fail("expires-window");
    std::string rhs;
    {
        // response_hash lives at top level, next to the signature
        if (!rh || rh->t != JVal::T::STR) return fail("response-hash-shape");
        rhs = U32ToUtf8(rh->s);
    }
    if (!IsHex64(rhs)) return fail("response-hash-shape");
    std::string sighex;
    if (!sig || sig->t != JVal::T::STR) return fail("signature-shape");
    sighex = U32ToUtf8(sig->s);
    if (sighex.size() != 128) return fail("signature-shape");
    for (char c : sighex)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
            return fail("signature-shape");
    // 15-16. answers
    const JVal* ans = payload->find(U8("answers"));
    if (!ans || ans->t != JVal::T::OBJ) return fail("answers-keys");
    if (ans->o.size() != 4) return fail("answers-keys");
    const JVal* e = ans->find(U8("enter"));
    const JVal* l = ans->find(U8("latent_risk"));
    const JVal* f = ans->find(U8("edge_family"));
    const JVal* c = ans->find(U8("conviction"));
    if (!e || !l || !f || !c) return fail("answers-keys");
    auto getnoul = [&](const JVal* v, double& out) -> bool {
        if (!v || v->t != JVal::T::OBJ || v->o.size() != 2) return false;
        const JVal* t = v->find(U8("type"));
        const JVal* n = v->find(U8("noul"));
        if (!t || t->t != JVal::T::STR || U32ToUtf8(t->s) != "noul") return false;
        if (!n || n->t != JVal::T::NUM || !n->num_double) return false;
        double dval = n->dval;
        if (!(dval == dval) || dval < 0.0 || dval > 1.0) return false;
        out = dval;
        return true;
    };
    double enter = 0, latent = 0;
    if (!getnoul(e, enter)) return fail("enter-shape");
    if (!getnoul(l, latent)) return fail("latent-shape");
    EdgeFamily fam;
    // confidence (P3.4/b quarantine): validated for structural integrity only
    // (must be a JSON number if present), never stored, never exposed.
    auto checkconf = [&](const JVal* cf) -> bool {
        if (!cf) return true;
        return cf->t == JVal::T::NUM && cf->num_double;
    };
    {
        if (!f || f->t != JVal::T::OBJ) return fail("family-shape");
        // allowed keys: type, choice (+ optional probabilities, confidence)
        for (auto& kv : f->o) {
            std::string k = U32ToUtf8(kv.first);
            if (k != "type" && k != "choice" && k != "probabilities" &&
                k != "confidence")
                return fail("family-shape");
        }
        const JVal* t = f->find(U8("type"));
        const JVal* ch = f->find(U8("choice"));
        if (!t || t->t != JVal::T::STR || U32ToUtf8(t->s) != "choice")
            return fail("family-shape");
        if (!ch || ch->t != JVal::T::STR) return fail("family-shape");
        std::string cs = U32ToUtf8(ch->s);
        if (cs == "mean_reversion") fam = EdgeFamily::MEAN_REVERSION;
        else if (cs == "momentum") fam = EdgeFamily::MOMENTUM;
        else if (cs == "macro") fam = EdgeFamily::MACRO;
        else if (cs == "execution") fam = EdgeFamily::EXECUTION;
        else return fail("family-shape");
        const JVal* pr = f->find(U8("probabilities"));
        if (pr) {
            // Bounded map: at most the four edge families, values in [0,1].
            // Never used for authorization (P3.1); bounded to deny DoS surface.
            if (pr->t != JVal::T::OBJ || pr->o.size() > 4) return fail("family-shape");
            for (auto& kv : pr->o) {
                std::string k = U32ToUtf8(kv.first);
                if (k != "mean_reversion" && k != "momentum" && k != "macro" &&
                    k != "execution")
                    return fail("family-shape");
                if (kv.second.t != JVal::T::NUM || !kv.second.num_double)
                    return fail("family-shape");
                double dval = kv.second.dval;
                if (!(dval == dval) || dval < 0.0 || dval > 1.0)
                    return fail("family-shape");
            }
        }
        const JVal* cf = f->find(U8("confidence"));
        if (!checkconf(cf)) return fail("family-shape");
    }
    Conviction conv;
    {
        if (!c || c->t != JVal::T::OBJ) return fail("conviction-shape");
        for (auto& kv : c->o) {
            std::string k = U32ToUtf8(kv.first);
            if (k != "type" && k != "score" && k != "confidence")
                return fail("conviction-shape");
        }
        const JVal* t = c->find(U8("type"));
        const JVal* sc = c->find(U8("score"));
        if (!t || t->t != JVal::T::STR || U32ToUtf8(t->s) != "score")
            return fail("conviction-shape");
        if (!sc || sc->t != JVal::T::STR) return fail("conviction-shape");
        std::string ss = U32ToUtf8(sc->s);
        if (ss == "flat") conv = Conviction::FLAT;
        else if (ss == "lean") conv = Conviction::LEAN;
        else if (ss == "strong") conv = Conviction::STRONG;
        else if (ss == "max") conv = Conviction::MAX;
        else return fail("conviction-shape");
        const JVal* cf = c->find(U8("confidence"));
        if (!checkconf(cf)) return fail("conviction-shape");
    }
    // 17. response_hash recomputation over canonical payload bytes
    std::string canon = CanonJson(*payload);
    if (Sha256Hex(canon) != rhs) return fail("response-hash-mismatch");
    // 18. signature over canonical bytes with the CONFIGURED key only
    {
        uint8_t sigraw[64];
        for (int i = 0; i < 64; i++) {
            unsigned v;
            sscanf(sighex.c_str() + 2 * i, "%02x", &v);
            sigraw[i] = (uint8_t)v;
        }
        if (!EdVerify(q.trusted_key.data(),
                      reinterpret_cast<const uint8_t*>(canon.data()), canon.size(),
                      sigraw))
            return fail("signature-invalid");
    }
    // 20. freshness (LIVE only)
    if (q.mode == Mode::LIVE) {
        if (!(q.now_unix <= expires)) return fail("expired");
        if (!(created <= q.now_unix + 300.0)) return fail("not-yet-valid");
    }
    // 21. state binding: BOTH keys recomputed from kernel-owned bytes.
    // state_hash = sha256(canonical snapshot); decision_key recomputed
    // field-for-field from the parsed snapshot (frozen sidecar recipe).
    // No trusted-string comparison anywhere on this path.
    if (q.state_canon_json.size() > JParse::MAX_RAW) return fail("too-large");
    JVal snap;
    std::string serr;
    if (!ParseJson(q.state_canon_json, snap, serr) || snap.t != JVal::T::OBJ)
        return fail("state-shape");
    if (Sha256Hex(q.state_canon_json) != sth) return fail("state-binding");
    if (ComputeDecisionKey(snap) != dk) return fail("decision-binding");
    r.ok_ = true;
    r.reason_ = "ok";
    r.value_.symbol_ = symbol;
    r.value_.epoch_ = epoch;
    r.value_.state_hash_ = sth;
    r.value_.decision_key_ = dk;
    r.value_.created_ = created;
    r.value_.expires_ = expires;
    r.value_.enter_ = enter;
    r.value_.latent_ = latent;
    r.value_.family_ = fam;
    r.value_.conviction_ = conv;
    r.value_.response_hash_ = rhs;
    return r;
}

// __APPEND__

}  // namespace jev
