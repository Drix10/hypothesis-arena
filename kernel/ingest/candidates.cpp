#include "candidates.hpp"

namespace jev {
namespace ingest {
namespace {
const char* kIdFields[12] = {
    "strategy_version", "symbol", "snapshot_ts_ns", "proposed_side",
    "proposed_family", "entry_px", "stop_px", "tp_px", "time_exit_ns",
    "exit_profile_version", "cost_model_version", "feature_revision"};

const JVal* Get(const JVal& o, const char* k) {
    std::u32string key;
    for (const char* p = k; *p; ++p) key.push_back((char32_t)(unsigned char)*p);
    return o.find(key);
}
bool Str(const JVal& o, const char* k, std::string& out) {
    const JVal* v = Get(o, k);
    if (!v || v->t != JVal::T::STR) return false;
    out = U32ToUtf8(v->s);
    return true;
}
bool U32IsAscii(const std::u32string& s, const char* lit) {
    size_t i = 0;
    for (; lit[i]; ++i)
        if (i >= s.size() || s[i] != (char32_t)(unsigned char)lit[i])
            return false;
    return i == s.size();
}
// Non-negative int64 from a decimal string (no sign, no leading zeros
// except "0", no whitespace); false on anything else or overflow.
bool ParseNonNegI64(const std::string& s, int64_t& out) {
    if (s.empty() || s.size() > 19) return false;
    if (s.size() > 1 && s[0] == '0') return false;
    __int128 v = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        v = v * 10 + (c - '0');
    }
    if (v > (__int128)INT64_MAX) return false;
    out = (int64_t)v;
    return true;
}
bool In(const std::vector<std::string>& v, const std::string& s) {
    for (auto& x : v)
        if (x == s) return true;
    return false;
}
CandOutcome Rej(CandReject c) {
    CandOutcome o;
    o.code = c;
    return o;
}
}  // namespace

CandOutcome ValidateCandidate(const JVal& rec, const CandidateTables& t,
                              int64_t now_ns) {
    if (rec.t != JVal::T::OBJ || rec.o.size() != 3) return Rej(CandReject::SHAPE);
    const JVal* sch = Get(rec, "schema");
    const JVal* cr = Get(rec, "created_ns");
    const JVal* c = Get(rec, "candidate");
    if (!sch || !cr || !c) return Rej(CandReject::SHAPE);
    if (sch->t != JVal::T::STR || cr->t != JVal::T::STR ||
        c->t != JVal::T::OBJ || c->o.size() != 13)
        return Rej(CandReject::SHAPE);
    if (!U32IsAscii(sch->s, "c1")) return Rej(CandReject::SCHEMA);
    int64_t created = 0;
    if (!ParseNonNegI64(U32ToUtf8(cr->s), created))
        return Rej(CandReject::SHAPE);

    std::string f[12], joined;
    for (int i = 0; i < 12; i++) {
        // '|' is the join separator: a field containing it makes the CID
        // preimage ambiguous, so it is refused outright.
        if (!Str(*c, kIdFields[i], f[i]) || f[i].find('|') != std::string::npos)
            return Rej(CandReject::SHAPE);
        if (i) joined += "|";
        joined += f[i];
    }
    std::string cid;
    if (!Str(*c, "cid", cid) || !IsHex64(cid)) return Rej(CandReject::CID);
    if (Sha256Hex(joined) != cid) return Rej(CandReject::CID);

    const std::string& sleeve = f[0];
    const std::string& symbol = f[1];
    const std::string& side = f[3];
    const ApprovedSleeve* sl = nullptr;
    for (auto& a : t.sleeves)
        if (a.id == sleeve && a.window_s > 0) sl = &a;
    if (!sl) return Rej(CandReject::SLEEVE);
    if (!In(t.allowlist, symbol)) return Rej(CandReject::ALLOWLIST);

    int64_t snap = 0;
    if (!ParseNonNegI64(f[2], snap)) return Rej(CandReject::SHAPE);
    if (snap > now_ns) return Rej(CandReject::FRESHNESS);
    __int128 age = (__int128)now_ns - snap;
    if (age > (__int128)sl->window_s * 1000000000LL)
        return Rej(CandReject::FRESHNESS);

    if (side == "BUY") {
        // BUY-to-open only
    } else if (side == "SELL") {
        if (!In(t.held, symbol)) return Rej(CandReject::SIDE);
    } else {
        return Rej(CandReject::SIDE);
    }
    CandOutcome o;
    o.accepted = true;
    o.cid = cid;
    o.symbol = symbol;
    o.side = side;
    return o;
}

}  // namespace ingest
}  // namespace jev
