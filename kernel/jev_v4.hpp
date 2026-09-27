// S4 — JEV v4 candidate-bound validation + table (ADDITIVE; v3 untouched).
//
// JEV evaluates an already-constructed c1 Candidate, never originates side
// or economics. Kernel-owned identity (expected cid/symbol/feature-hash,
// supplied by the engine, never the artifact) is the trust anchor.
//
// Identity path has ZERO float rendering: the artifact carries the exact
// CID strings Python hashed (ints as decimal, floats as Python repr);
// C++ joins them in _ID_FIELDS order and hashes. The same strings are
// parsed to doubles for coherence (full-consumption strtod, finite,
// positive, side-consistent). Floats elsewhere in the payload (answer
// probabilities) ride the frozen CanonDouble==PyFloatRepr contract.
//
// v4 decision_key (frozen here; Python mirrors field-for-field):
//   sha256_hex(cid|symbol|snapshot_epoch|price_s|spread_bps_s|session|
//              regime|feature_snapshot_hash|v4)
// Table: doc 03 §3.2 rows with candidate-specific enter. Verdicts carry
// no side, no family, no size — PASS_BASE / PASS_ELEVATED_ELIGIBLE /
// HOLD+reason only.
//
// Build (explicit; build.sh untouched — frozen gate):
//   g++ -std=c++17 -O2 -o /tmp/test_v4 tests/test_v4.cpp && /tmp/test_v4 v4
// Vectors: kernel/v4/*.json (committed, Python-generated, stable).
#pragma once
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>
#include "jev_validate.hpp"

namespace jev_v4 {

struct V4Engine {
    bool deterministic_veto = false;
    bool disagreement = false;
    bool blackout = false;
    int calib_gate = 0;  // 0 pass, 1 insufficient, 2 breach
    bool veto_max = false;
};

struct V4Verdict {
    bool pass = false;
    std::string action;  // PASS_BASE | PASS_ELEVATED_ELIGIBLE | HOLD
    std::string reason;
};

static const char* kIdFields[12] = {
    "strategy_version", "symbol", "snapshot_ts_ns", "proposed_side",
    "proposed_family", "entry_px", "stop_px", "tp_px", "time_exit_ns",
    "exit_profile_version", "cost_model_version", "feature_revision"};
static const char* kDKeyOrder[9] = {
    "cid", "symbol", "snapshot_epoch", "price_s", "spread_bps_s",
    "session", "regime", "feature_snapshot_hash", "question_set_version"};

inline bool IsHex64(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}

inline bool ParseStrictDouble(const std::string& s, double& out) {
    if (s.empty() || s.size() > 64) return false;
    char* end = nullptr;
    out = strtod(s.c_str(), &end);
    if (end != s.c_str() + s.size()) return false;
    if (!(out == out) || out == 1.0 / 0.0 || out == -1.0 / 0.0) return false;
    return true;
}

inline bool ParseStrictUint(const std::string& tok, int64_t& out) {
    if (tok.empty() || tok.size() > 20) return false;
    int64_t v = 0;
    for (char c : tok) {
        if (c < '0' || c > '9') return false;
        if (v > (INT64_MAX - (c - '0')) / 10) return false;
        v = v * 10 + (c - '0');
    }
    out = v;
    return true;
}

inline bool ParseStrictInt(const jev::JVal& v, int64_t& out) {
    if (v.t != jev::JVal::T::NUM || v.num_double) return false;
    return ParseStrictUint(v.num, out);
}

inline V4Verdict Hold(const char* r) {
    V4Verdict v;
    v.action = "HOLD";
    v.reason = r;
    return v;
}

inline V4Verdict ValidateV4(const std::string& artifact_json,
                            const std::string& expected_cid,
                            const std::string& expected_symbol,
                            const std::string& expected_fhash,
                            const uint8_t trusted_pub[32], int64_t now_unix,
                            const V4Engine& eng) {
    if (artifact_json.size() > jev::JParse::MAX_RAW) return Hold("v4_absent");
    jev::JVal root;
    std::string perr;
    if (!jev::ParseJson(artifact_json, root, perr) ||
        root.t != jev::JVal::T::OBJ)
        return Hold("v4_absent");
    using jev::ObjGet;
    using jev::U32ToUtf8;
    const jev::JVal* p = ObjGet(root, "payload");
    const jev::JVal* rhs = ObjGet(root, "response_hash");
    const jev::JVal* sig = ObjGet(root, "signature");
    if (!p || p->t != jev::JVal::T::OBJ || !rhs ||
        rhs->t != jev::JVal::T::STR || !sig || sig->t != jev::JVal::T::STR)
        return Hold("v4_absent");
    auto get = [&](const jev::JVal* o, const char* k) -> const jev::JVal* {
        return o ? ObjGet(*o, k) : nullptr;
    };
    auto getStr = [&](const jev::JVal* o, const char* k,
                      std::string& out) -> bool {
        const jev::JVal* v = get(o, k);
        if (!v || v->t != jev::JVal::T::STR) return false;
        out = U32ToUtf8(v->s);
        return true;
    };
    std::string qv;
    if (!getStr(p, "question_set_version", qv) || qv != "v4")
        return Hold("v4_contract_mismatch");
    const jev::JVal* c = get(p, "candidate");
    if (!c || c->t != jev::JVal::T::OBJ) return Hold("v4_malformed");
    // 1-2. CID recompute from exact strings; kernel-owned binding.
    std::string joined;
    for (int i = 0; i < 12; i++) {
        std::string f;
        if (!getStr(c, kIdFields[i], f)) return Hold("v4_malformed");
        if (i) joined += "|";
        joined += f;
    }
    std::string cid_given;
    if (!getStr(c, "cid", cid_given) || !IsHex64(cid_given))
        return Hold("v4_malformed");
    if (jev::Sha256Hex(joined) != cid_given) return Hold("v4_cid_mismatch");
    if (cid_given != expected_cid) return Hold("v4_cid_mismatch");
    std::string sym, fam, side;
    if (!getStr(c, "symbol", sym) || !getStr(c, "proposed_family", fam) ||
        !getStr(c, "proposed_side", side))
        return Hold("v4_malformed");
    if (sym != expected_symbol) return Hold("v4_symbol_binding");
    if (side != "BUY" && side != "SELL") return Hold("v4_malformed");
    if (fam != "mean_reversion" && fam != "momentum" && fam != "macro" &&
        fam != "execution")
        return Hold("v4_malformed");
    // 3. Economics coherence from the same strings.
    double e = 0, s = 0, t = 0;
    std::string es, ss, ts;
    if (!getStr(c, "entry_px", es) || !getStr(c, "stop_px", ss) ||
        !getStr(c, "tp_px", ts))
        return Hold("v4_malformed");
    if (!ParseStrictDouble(es, e) || !ParseStrictDouble(ss, s) ||
        !ParseStrictDouble(ts, t))
        return Hold("v4_malformed");
    if (!(e > 0 && s > 0 && t > 0)) return Hold("v4_malformed");
    if (side == "BUY" ? !(s < e && e < t) : !(t < e && e < s))
        return Hold("v4_malformed");
    // 4. Feature-hash + symbol binding (kernel-owned values).
    std::string fh;
    if (!getStr(p, "feature_snapshot_hash", fh) || fh.empty() ||
        fh.size() > 256)
        return Hold("v4_malformed");
    if (fh != expected_fhash) return Hold("v4_feature_binding");
    std::string psym;
    if (!getStr(p, "symbol", psym) || psym != expected_symbol)
        return Hold("v4_symbol_binding");
    // 5. Family-fit cannot substitute.
    const jev::JVal* a = get(p, "answers");
    if (!a || a->t != jev::JVal::T::OBJ) return Hold("v4_malformed");
    std::string afam;
    if (!getStr(a, "edge_family", afam) || afam != fam)
        return Hold("v4_family_binding");
    // 6. Decision-key recompute. Wire types are strict per field:
    // snapshot_epoch must be an integer JSON number (never a string,
    // never a double); all other parts must be JSON strings.
    {
        std::string parts;
        for (int i = 0; i < 9; i++) {
            const jev::JVal* v = get(p, kDKeyOrder[i]);
            if (!v) return Hold("v4_malformed");
            std::string part;
            if (i == 2) {  // snapshot_epoch
                if (v->t != jev::JVal::T::NUM || v->num_double)
                    return Hold("v4_malformed");
                int64_t n = 0;
                if (!ParseStrictUint(v->num, n)) return Hold("v4_malformed");
                part = std::to_string(n);
            } else {
                if (v->t != jev::JVal::T::STR) return Hold("v4_malformed");
                part = U32ToUtf8(v->s);
            }
            if (i) parts += "|";
            parts += part;
        }
        std::string dk;
        if (!getStr(p, "decision_key", dk) || dk.size() != 64)
            return Hold("v4_malformed");
        if (jev::Sha256Hex(parts) != dk) return Hold("v4_decision_binding");
    }
    // 7. Response hash + signature over canonical payload bytes.
    std::string canon = jev::CanonJson(*p);
    std::string rh = U32ToUtf8(rhs->s);
    if (jev::Sha256Hex(canon) != rh) return Hold("v4_response_binding");
    std::string sighex = U32ToUtf8(sig->s);
    if (sighex.size() != 128) return Hold("v4_unauthenticated");
    uint8_t sigraw[64];
    for (int i = 0; i < 64; i++) {
        unsigned v = 0;
        if (sscanf(sighex.c_str() + 2 * i, "%02x", &v) != 1)
            return Hold("v4_unauthenticated");
        sigraw[i] = (uint8_t)v;
    }
    if (!jev::EdVerify(trusted_pub,
                       reinterpret_cast<const uint8_t*>(canon.data()),
                       canon.size(), sigraw))
        return Hold("v4_unauthenticated");
    // 8. Freshness (integer seconds; 60 s skew mirrors the sidecar).
    // Frozen artifact rule: expires_at == created_at + 60 exactly.
    int64_t created = 0, expires = 0;
    const jev::JVal* jcr = get(p, "created_at");
    const jev::JVal* jex = get(p, "expires_at");
    if (!jcr || !jex || !ParseStrictInt(*jcr, created) ||
        !ParseStrictInt(*jex, expires))
        return Hold("v4_malformed");
    if (created > INT64_MAX - 60 || expires != created + 60)
        return Hold("v4_malformed");
    if (now_unix < 0 || created > now_unix + 60) return Hold("v4_malformed");
    if (now_unix > expires) return Hold("v4_expired");
    // 9. Answer ranges.
    const jev::JVal* je = get(a, "enter");
    const jev::JVal* jl = get(a, "latent_risk");
    const jev::JVal* jc = get(a, "conviction");
    if (!je || !jl || !jc) return Hold("v4_malformed");
    if (je->t != jev::JVal::T::NUM || !je->num_double ||
        jl->t != jev::JVal::T::NUM || !jl->num_double ||
        jc->t != jev::JVal::T::STR)
        return Hold("v4_malformed");
    double enter = je->dval, latent = jl->dval;
    if (!(enter >= 0.0 && enter <= 1.0 && latent >= 0.0 && latent <= 1.0))
        return Hold("v4_malformed");
    std::string conv = U32ToUtf8(jc->s);
    if (conv != "flat" && conv != "lean" && conv != "strong" &&
        conv != "max")
        return Hold("v4_malformed");
    // 10. v4 table. First HOLD wins.
    if (eng.deterministic_veto) return Hold("engine");
    if (latent > 0.5) return Hold("latent_risk");
    if (eng.disagreement) return Hold("disagreement");
    if (eng.blackout) return Hold("blackout");
    if (eng.calib_gate == 2) return Hold("calibration");
    if (enter < 0.5) return Hold("no_edge");
    if (enter <= 0.8 &&
        (afam == "execution" || conv == "flat" || conv == "lean"))
        return Hold("midband");
    if (afam == "execution") return Hold("execution");
    if (conv == "flat") return Hold("flat");
    V4Verdict v;
    if (conv == "lean") {
        v.pass = true;
        v.action = "PASS_BASE";
        v.reason = "lean";
        return v;
    }
    if (conv == "strong") {
        v.pass = true;
        v.action = "PASS_BASE";
        v.reason = "strong";
        return v;
    }
    if (enter >= 0.8 && latent <= 0.3 && eng.calib_gate == 0 &&
        !eng.veto_max) {
        v.pass = true;
        v.action = "PASS_ELEVATED_ELIGIBLE";
        v.reason = "max_gate";
        return v;
    }
    v.pass = true;
    v.action = "PASS_BASE";
    v.reason = "max_downgrade";
    return v;
}

}  // namespace jev_v4
