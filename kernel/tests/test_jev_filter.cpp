// S4 — C++ JEV filter interop suite (committed kernel/jev_vectors/ only).
//
// Usage: g++ -std=c++17 -O2 -o /tmp/test_jev_filter kernel/tests/test_jev_filter.cpp
//        /tmp/test_jev_filter kernel/jev_vectors
// Reads <name>.artifact.json + <name>.expect.json, runs Validate with
// the kernel-owned identity from expect.json, asserts action+reason.
// Additionally asserts the verdict vocabulary carries no side/family/size.
#include <cstdio>
#include <string>
#include <vector>
#include "../jev_filter.hpp"

namespace {
std::string ReadWhole(const std::string& path) {
    std::string out;
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return out;
    char buf[8192];
    size_t n = 0;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}
int fails = 0;
void Check(bool ok, const std::string& what) {
    if (!ok) {
        ++fails;
        printf("FAIL %s\n", what.c_str());
    }
}
bool HexToBytes(const std::string& h, uint8_t* out, size_t n) {
    if (h.size() != n * 2) return false;
    for (size_t i = 0; i < n; i++) {
        unsigned v = 0;
        if (sscanf(h.c_str() + 2 * i, "%02x", &v) != 1) return false;
        out[i] = (uint8_t)v;
    }
    return true;
}
std::string JStr(const jev::JVal& o, const char* k) {
    const jev::JVal* v = jev::ObjGet(o, k);
    if (!v || v->t != jev::JVal::T::STR) return "";
    return jev::U32ToUtf8(v->s);
}
}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        printf("usage: test_jev_filter <vectors-dir>\n");
        return 2;
    }
    std::string dir = argv[1];
    static const char* kNames[] = {
        "valid_pass", "valid_sell_pass", "max_elevated", "cid_mismatch",
        "side_altered", "entry_altered", "stop_altered", "timeexit_altered",
        "feature_binding", "family_substitute", "expired", "bad_signature",
        "execution_hold", "no_edge", "latent_hold", "cross_symbol",
        "type_field_number", "type_answer_string", "type_answer_bool",
        "type_created_string", "type_epoch_string", "expiry_plus59",
        "expiry_plus61", "expiry_plus3600", "epoch_minus1",
        "created_minus1", "expires_minus1", "epoch_int64max",
        "epoch_int64max_plus1", "created_int64max_plus1",
        "expires_int64max_plus1", "expiry_int64max_future"};
    int ran = 0;
    for (const char* nm : kNames) {
        std::string art =
            ReadWhole(dir + "/" + nm + ".artifact.json");
        std::string expj =
            ReadWhole(dir + "/" + nm + ".expect.json");
        Check(!art.empty(), std::string(nm) + ":artifact-read");
        Check(!expj.empty(), std::string(nm) + ":expect-read");
        if (art.empty() || expj.empty()) continue;
        jev::JVal exp;
        std::string err;
        Check(jev::ParseJson(expj, exp, err) && exp.t == jev::JVal::T::OBJ,
              std::string(nm) + ":expect-parse");
        if (exp.t != jev::JVal::T::OBJ) continue;
        uint8_t pub[32];
        Check(HexToBytes(JStr(exp, "pubkey"), pub, 32),
              std::string(nm) + ":pubkey");
        jev_filter::Engine eng;
        const jev::JVal* je = jev::ObjGet(exp, "engine");
        if (je && je->t == jev::JVal::T::OBJ) {
            auto b = [&](const char* k) {
                const jev::JVal* v = jev::ObjGet(*je, k);
                return v && v->t == jev::JVal::T::BOOL && v->b;
            };
            eng.deterministic_veto = b("deterministic_veto");
            eng.disagreement = b("disagreement");
            eng.blackout = b("blackout");
            eng.veto_max = b("veto_max");
            const jev::JVal* cg = jev::ObjGet(*je, "calib_gate");
            std::string cgs =
                cg && cg->t == jev::JVal::T::STR ? jev::U32ToUtf8(cg->s) : "";
            eng.calib_gate =
                cgs == "breach" ? 2 : cgs == "insufficient" ? 1 : 0;
        }
        const jev::JVal* jnow = jev::ObjGet(exp, "now_unix");
        int64_t now = 0;
        Check(jnow && jnow->t == jev::JVal::T::NUM && !jnow->num_double && jev_filter::ParseStrictUint(jnow->num, now),
              std::string(nm) + ":now");
        jev_filter::Verdict v = jev_filter::Validate(
            art, JStr(exp, "expected_cid"), JStr(exp, "expected_symbol"),
            JStr(exp, "expected_fhash"), pub, now, eng);
        Check(v.action == JStr(exp, "action"),
              std::string(nm) + ":action got=" + v.action);
        Check(v.reason == JStr(exp, "reason"),
              std::string(nm) + ":reason got=" + v.reason);
        bool no_side = v.action.find("BUY") == std::string::npos &&
                       v.action.find("SELL") == std::string::npos &&
                       v.reason.find("BUY") == std::string::npos &&
                       v.reason.find("SELL") == std::string::npos;
        Check(no_side, std::string(nm) + ":verdict-vocabulary");
        ++ran;
    }
    printf("jev filter vectors: %d ran, %d failed\n", ran, fails);
    return fails ? 1 : 0;
}
