// P3.3 (corrected) suite: full §3.4 state contract + closed nested schema +
// checked integers + micros internals + hardened kernel + decision table.
// Committed files only (no Python). All fixtures share the P3.1 test key.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#include "decision_table.hpp"
#include "kernel_state.hpp"

namespace {
int fails = 0, total = 0;
#define CHECK(name, cond)                                              \
    do {                                                               \
        total++;                                                       \
        if (!(cond)) {                                                 \
            fails++;                                                   \
            printf("FAIL %s (line %d)\n", name, __LINE__);              \
        } else {                                                       \
            printf("ok %s\n", name);                                   \
        }                                                              \
    } while (0)
std::string read_all(const std::string& p) {
    std::string o;
    char b[4096];
    FILE* f = fopen(p.c_str(), "rb");
    if (!f) return o;
    size_t n;
    while ((n = fread(b, 1, sizeof(b), f)) > 0) o.append(b, n);
    fclose(f);
    return o;
}
std::string fx(const std::string& dir, const char* name) {
    return read_all(dir + "/" + name);
}
uint8_t hexnyb(char c) {
    if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
    return (uint8_t)(c - 'a' + 10);
}
std::array<uint8_t, 32> test_key() {
    std::string kh = read_all("fixtures/trusted_key.txt");
    std::array<uint8_t, 32> k{};
    for (int i = 0; i < 32; i++)
        k[i] = (uint8_t)((hexnyb(kh[2 * i]) << 4) | hexnyb(kh[2 * i + 1]));
    return k;
}
// Engine inputs derived from a parsed artifact STATE (test-side only:
// engines are deterministic inputs, not the state contract). Veto is set
// explicitly per case (production: risk layer, P3.5).
// Fixture artifacts embed the full request "state" beside the signed
// artifact (state-proof). The validator's exact top-level keys exclude
// it, so validation runs on the artifact with "state" stripped — the
// signed payload bytes are untouched (signature covers payload only).
std::string validation_bytes(const std::string& raw) {
    jev::JVal art;
    std::string err;
    if (!jev::ParseJson(raw, art, err)) return "";
    for (auto it = art.o.begin(); it != art.o.end(); ++it)
        if (jev::U32ToUtf8(it->first) == "state") {
            art.o.erase(it);
            break;
        }
    return jev::CanonJson(art);
}
jev::EngineInputs eng_from_state(const jev::JVal& state) {
    jev::EngineInputs e;
    const jev::JVal* cal = jev::ObjGet(state, "calibration");
    const jev::JVal* g =
        cal ? jev::ObjGet(*cal, "gate") : nullptr;
    std::string gs = (g && g->t == jev::JVal::T::STR)
                         ? jev::U32ToUtf8(g->s)
                         : "insufficient";
    e.calibration_gate = (gs == "pass")      ? jev::CalibrationGate::PASS
                         : (gs == "breach") ? jev::CalibrationGate::BREACH
                                            : jev::CalibrationGate::INSUFFICIENT;
    const jev::JVal* dis = jev::ObjGet(state, "disagreement");
    e.disagreement = (dis && dis->t == jev::JVal::T::BOOL && dis->b);
    const jev::JVal* ew = jev::ObjGet(state, "event_window");
    const jev::JVal* bo = ew ? jev::ObjGet(*ew, "blackout") : nullptr;
    e.event_blackout = (bo && bo->t == jev::JVal::T::BOOL && bo->b);
    return e;
}
}  // namespace

int main(int argc, char** argv) {
    std::string dir = argc > 1 ? argv[1] : "p33";
    std::string fix = argc > 2 ? argv[2] : "fixtures";
    auto key = test_key();
    {
        // Sanity: committed test key equals the generator identity.
        std::string kh = read_all("fixtures/trusted_key.txt");
        CHECK("test-key-identity",
              kh == "43046bfe4092b3e94994eada15dcc20d8aaa07b658fd3954eb"
                    "8e0efb8bdca5de");
    }

    // ---- A. Full-state interop vector vs Python ground truth ----
    {
        std::string raw = fx(dir, "state_vector.json");
        jev::JVal st;
        std::string err;
        CHECK("vector-parses", jev::ParseJson(raw, st, err));
        jev::JEVStateV3 s;
        std::string why;
        CHECK("vector-accepts-full-state",
              jev::JEVStateV3::FromJVal(st, s, why));
        if (!s.StateHash().empty()) {
            std::string ser = s.Serialize();
            std::string hex = fx(dir, "state_vector_canon.hex");
            std::string want;
            for (size_t i = 0; i + 1 < hex.size(); i += 2)
                want += (char)((hexnyb(hex[i]) << 4) | hexnyb(hex[i + 1]));
            if (!want.empty() && want[want.size() - 1] == '\n') want.clear();
            CHECK("vector-canon-bit-equal", ser == want);
            std::string h = fx(dir, "state_vector_hash.txt");
            if (!h.empty() && h[h.size() - 1] == '\n')
                h.resize(h.size() - 1);
            CHECK("vector-hash-match", s.StateHash() == h);
            std::string dk = fx(dir, "state_vector_dkey.txt");
            if (!dk.empty() && dk[dk.size() - 1] == '\n')
                dk.resize(dk.size() - 1);
            CHECK("vector-dkey-match", s.DecisionKey() == dk);
        }
    }

    // ---- B. Closed nested schema (blocker #2) ----
    {
        jev::JEVStateV3 s;
        std::string why;
        auto parse_state = [&](const std::string& body) {
            jev::JVal st;
            std::string err, w;
            jev::JEVStateV3 o;
            if (!jev::ParseJson(body, st, err)) return std::string("parse:") + err;
            if (!jev::JEVStateV3::FromJVal(st, o, w)) return w;
            return std::string("ok");
        };
        std::string good = fx(dir, "state_vector.json");
        CHECK("closed-accepts-good", parse_state(good) == "ok");
        // unknown nested key inside indicators
        {
            std::string bad = good;
            size_t p = bad.find("\"regime\"");
            bad.insert(p, "\"evil_field\":123,");
            CHECK("closed-rejects-nested-unknown",
                  parse_state(bad) == "state-shape:indicators-keys");
        }
        // missing required container
        {
            jev::JVal st;
            std::string err;
            jev::ParseJson(good, st, err);
            for (auto it = st.o.begin(); it != st.o.end(); ++it)
                if (jev::U32ToUtf8(it->first) == "portfolio") {
                    st.o.erase(it);
                    break;
                }
            std::string w;
            jev::JEVStateV3 o;
            CHECK("closed-requires-portfolio",
                  !jev::JEVStateV3::FromJVal(st, o, w) &&
                      w == "state-shape:missing");
        }
        // non-object feature member (bracket-matched: symbols[] nest)
        {
            std::string bad = good;
            size_t p = bad.find("\"features\":[");
            size_t q = p + 12;
            int depth = 1;
            while (depth > 0 && q < bad.size()) {
                if (bad[q] == '[') depth++;
                if (bad[q] == ']') depth--;
                q++;
            }
            bad.replace(p + 12, q - p - 13, "7");
            CHECK("closed-rejects-scalar-feature",
                  parse_state(bad) == "state-shape:feature-not-object");
        }
        // feature with an extra member
        {
            std::string bad = good;
            size_t p = bad.find("\"age_s\"");
            bad.insert(p, "\"smuggled\":1,");
            CHECK("closed-rejects-feature-extra",
                  parse_state(bad) == "state-shape:feature-keys");
        }
        // bad value shape (count with string payload)
        {
            std::string bad = good;
            size_t p = bad.find("\"v\":3");
            if (p != std::string::npos) {
                bad.replace(p, 5, "\"v\":\"three\"");
                CHECK("closed-rejects-value-shape",
                      parse_state(bad) == "state-shape:value-v");
            } else {
                CHECK("closed-rejects-value-shape-setup", false);
            }
        }
        // unknown top-level key
        {
            std::string bad = good;
            while (!bad.empty() &&
                   (bad.back() == '\n' || bad.back() == ' '))
                bad.pop_back();
            bad.insert(bad.size() - 1, ",\"cycle_id\":\"x\"");
            CHECK("closed-rejects-top-unknown",
                  parse_state(bad).find("state-shape:unknown-key") == 0);
        }
        // bad enum value
        {
            std::string bad = good;
            size_t p = bad.find("\"range\"");
            size_t w = 7;
            if (p == std::string::npos) {
                p = bad.find("\"volatile\"");
                w = 10;
            }
            if (p == std::string::npos) {
                CHECK("closed-rejects-bad-enum-setup", false);
            } else {
                bad.replace(p, w, "\"trending\"");
                CHECK("closed-rejects-bad-enum",
                      parse_state(bad) == "state-shape:regime");
            }
        }
    }

    // ---- C. Checked integers (blocker #3) ----
    {
        int64_t v = 0;
        CHECK("int64-zero", jev::ParseNonNegInt64("0", v) && v == 0);
        CHECK("int64-max",
              jev::ParseNonNegInt64("9223372036854775807", v) &&
                  v == 9223372036854775807LL);
        CHECK("int64-max-plus-1-rejects",
              !jev::ParseNonNegInt64("9223372036854775808", v));
        CHECK("int64-64digit-rejects",
              !jev::ParseNonNegInt64(
                  "999999999999999999999999999999999999999999999999999999999999"
                  "9999",
                  v));
        CHECK("int64-negative-rejects",
              !jev::ParseNonNegInt64("-1", v));
        CHECK("int64-empty-rejects", !jev::ParseNonNegInt64("", v));
        // End to end: epoch overflow through FromJVal (no UB, state-shape).
        std::string good = fx(dir, "state_vector.json");
        auto epoch_case = [&](const std::string& ep) {
            std::string bad = good;
            size_t p = bad.find("\"snapshot_epoch\":999");
            bad.replace(p, 20, std::string("\"snapshot_epoch\":") + ep);
            jev::JVal st;
            std::string err, w;
            jev::JEVStateV3 o;
            jev::ParseJson(bad, st, err);
            return jev::JEVStateV3::FromJVal(st, o, w) ? std::string("ok") : w;
        };
        CHECK("epoch-max-accepts",
              epoch_case("9223372036854775807") == "ok");
        CHECK("epoch-max-plus-1-rejects",
              epoch_case("9223372036854775808") == "state-shape:epoch");
    }

    // ---- D. Micros internals (blocker #4) ----
    {
        int64_t us = 0;
        CHECK("micros-zero", jev::UnixMicros(0.0, us) && us == 0);
        CHECK("micros-known",
              jev::UnixMicros(1789862400.0, us) && us == 1789862400000000LL);
        CHECK("micros-rejects-huge",
              !jev::UnixMicros(1e30, us));
        CHECK("micros-rejects-inf",
              !jev::UnixMicros(std::numeric_limits<double>::infinity(),
                               us));
        CHECK("micros-rejects-nan",
              !jev::UnixMicros(std::numeric_limits<double>::quiet_NaN(),
                               us));
        // Artifact stores integer micros matching the frozen wire instants.
        std::string raw = fx(dir, "t_veto.json");
        jev::KernelState k;
        std::string w;
        CHECK("d-kernel", jev::KernelState::Create({"EURUSD"}, w, k));
        // state canon: the artifact embeds the full request state.
        jev::JVal art;
        std::string err;
        CHECK("d-artifact-parses", jev::ParseJson(raw, art, err));
        const jev::JVal* state = jev::ObjGet(art, "state");
        CHECK("d-state-present", state && state->t == jev::JVal::T::OBJ);
        jev::JEVStateV3 s;
        std::string dwhy;
        CHECK("d-state-accepts",
              jev::JEVStateV3::FromJVal(*state, s, dwhy));
        jev::ValidationRequest q =
            k.request_for(validation_bytes(raw), key, s.Serialize(), "EURUSD", 0.0,
                          jev::Mode::REPLAY);
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("d-valid", r.ok());
        if (r.ok()) {
            CHECK("d-created-us",
                  r.get()->created_us() == 1789862400000000LL);
            CHECK("d-expires-us",
                  r.get()->expires_us() == 1789862460000000LL);
        }
        // Unrepresentable kernel clock HOLDs (LIVE only).
        jev::ValidationRequest qb =
            k.request_for(validation_bytes(raw), key, s.Serialize(), "EURUSD", 1e30,
                          jev::Mode::LIVE);
        jev::ValidationResult rb = jev::validate_jev(qb
);
        CHECK("d-clock-unrepresentable",
              !rb.ok() && rb.reason() == "clock-unrepresentable");
    }

    // ---- E. ScalarLessL regression (P3.1 amendment locks) ----
    {
        uint8_t zero[32] = {};
        CHECK("lessL-zero", jev::ScalarLessL(zero));
        uint8_t band[32] = {};
        band[31] = 0x0F;
        band[30] = 0xA2;
        CHECK("lessL-band-accept", jev::ScalarLessL(band));
        uint8_t Leq[32] = {0xED, 0xD3, 0xF5, 0x5C, 0x1A, 0x63, 0x12, 0x58,
                           0xD6, 0x9C, 0xF7, 0xA2, 0xDE, 0xF9, 0xDE, 0x14,
                           0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                           0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10};
        CHECK("lessL-L-rejects", !jev::ScalarLessL(Leq));
        uint8_t Lm1[32];
        memcpy(Lm1, Leq, 32);
        for (int i = 0; i < 32; i++) {  // subtract 1
            if (Lm1[i]-- != 0) break;
        }
        CHECK("lessL-Lminus1-accepts", jev::ScalarLessL(Lm1));
    }

    // ---- F. KernelState hardening (#5, #7) ----
    {
        jev::KernelState k;
        std::string w;
        CHECK("universe-default-not-ok", !k.ok());
        CHECK("universe-empty-rejects",
              !jev::KernelState::Create({}, w, k) &&
                  w == "kernel-state:empty-universe" && !k.ok());
        CHECK("universe-too-large-rejects",
              !jev::KernelState::Create({"A", "B", "C", "D", "E", "F"}, w,
                                        k) &&
                  w == "kernel-state:universe-too-large");
        CHECK("universe-dupe-rejects",
              !jev::KernelState::Create({"EURUSD", "EURUSD"}, w, k) &&
                  w == "kernel-state:duplicate-symbol");
        CHECK("universe-bad-utf8-rejects",
              !jev::KernelState::Create(
                  {std::string("EUR\xffUSD")}, w, k) &&
                  w == "kernel-state:bad-symbol-utf8");
        CHECK("universe-five-accepts",
              jev::KernelState::Create(
                  {"EURUSD", "GBPUSD", "USDJPY", "AAPL", "MSFT"}, w, k) &&
                  w == "ok" && k.ok());
        CHECK("universe-membership",
              k.is_executable("AAPL") && !k.is_executable("XXX"));
        // try_accept: sole compare-and-advance gate (#5).
        CHECK("accept-first",
              k.try_accept("EURUSD", -1, 10) && k.last_epoch("EURUSD") == 10);
        CHECK("accept-stale-prev-rejects",
              !k.try_accept("EURUSD", -1, 11) &&
                  k.last_epoch("EURUSD") == 10);
        CHECK("accept-nonmonotonic-rejects",
              !k.try_accept("EURUSD", 10, 10) &&
                  k.last_epoch("EURUSD") == 10);
        CHECK("accept-advance",
              k.try_accept("EURUSD", 10, 11) &&
                  k.last_epoch("EURUSD") == 11);
        CHECK("accept-foreign-symbol-rejects",
              !k.try_accept("XXX", -1, 0));
        CHECK("accept-negative-rejects",
              !k.try_accept("EURUSD", 11, -1) &&
                  k.last_epoch("EURUSD") == 11);
    }

    // ---- G. Targeted §3.7 table cases over full states ----
    {
        jev::KernelState k;
        std::string w;
        CHECK("g-kernel", jev::KernelState::Create({"EURUSD"}, w, k));
        auto targeted = [&](const char* name, const char* want_action,
                            const char* want_reason,
                            jev::VetoReason veto) {
            std::string raw = fx(dir, name);
            jev::JVal art;
            std::string err;
            if (!jev::ParseJson(raw, art, err)) {
                CHECK(name, false);
                return;
            }
            const jev::JVal* state = jev::ObjGet(art, "state");
            jev::JEVStateV3 s;
            std::string why;
            if (!state ||
                !jev::JEVStateV3::FromJVal(*state, s, why)) {
                CHECK(name, false);
                return;
            }
            // Closed loop per artifact: C++ canonical bytes hash to the
            // sidecar-computed state_hash, and the C++ decision_key
            // equals the artifact's (frozen "?" feature_revision incl).
            const jev::JVal* pay = jev::ObjGet(art, "payload");
            std::string sh =
                jev::U32ToUtf8(jev::ObjGet(*pay, "state_hash")->s);
            std::string dk =
                jev::U32ToUtf8(jev::ObjGet(*pay, "decision_key")->s);
            if (s.StateHash() != sh || s.DecisionKey() != dk) {
                CHECK(name, false);
                return;
            }
            jev::ValidationRequest q =
                k.request_for(validation_bytes(raw), key, s.Serialize(), "EURUSD", 0.0,
                              jev::Mode::REPLAY);
            jev::ValidationResult r = jev::validate_jev(q);
            if (!r.ok()) {
                printf("  !! %s invalid: %s\n", name, r.reason().c_str());
                CHECK(name, false);
                return;
            }
            bool admitted = k.try_accept(
                "EURUSD",
                q.has_previous_epoch ? q.previous_epoch : -1,
                r.get()->snapshot_epoch());
            if (!admitted) {
                CHECK(name, false);
                return;
            }
            jev::EngineInputs e = eng_from_state(*state);
            if (veto != jev::VetoReason::NONE) {
                e.deterministic_veto = true;
                e.veto_reason = veto;
            }
            // t_veto carries veto state-side too (risk_flags mirror).
            const jev::JVal* rf = jev::ObjGet(*state, "risk_flags");
            const jev::JVal* dv =
                rf ? jev::ObjGet(*rf, "deterministic_veto") : nullptr;
            if (dv && dv->t == jev::JVal::T::BOOL && dv->b &&
                veto == jev::VetoReason::NONE) {
                e.deterministic_veto = true;
            }
            jev::Decision d =
                jev::EvaluateDecision(*r.get(), e);
            CHECK(name, d.action == want_action && d.reason == want_reason);
        };
        targeted("t_veto.json", "HOLD", "engine-veto:r5-loss-cap",
                 jev::VetoReason::LOSS_CAP_R5);
        // Coded veto reason propagates (countable paper-trail, #9).
        // Fresh kernel: an ADMITTED epoch re-validates as non-monotonic
        // (correct), so admission history must not be reused here.
        {
            jev::KernelState k2;
            std::string w2;
            jev::KernelState::Create({"EURUSD"}, w2, k2);
            std::string raw = fx(dir, "t_veto.json");
            jev::JVal art;
            std::string err;
            jev::ParseJson(raw, art, err);
            const jev::JVal* state = jev::ObjGet(art, "state");
            jev::JEVStateV3 s;
            std::string why;
            jev::JEVStateV3::FromJVal(*state, s, why);
            jev::ValidationRequest q = k2.request_for(
                validation_bytes(raw), key, s.Serialize(), "EURUSD", 0.0,
                jev::Mode::REPLAY);
            jev::ValidationResult r = jev::validate_jev(q);
            // No admission here — one winner per epoch (#5); the decision
            // layer only needs the validated object.
            CHECK("veto-code-valid", r.ok());
            if (r.ok()) {
                jev::EngineInputs e = eng_from_state(*state);
                e.deterministic_veto = true;
                e.veto_reason = jev::VetoReason::SESSION_CLOSED;
                jev::Decision d = jev::EvaluateDecision(*r.get(), e);
                CHECK("veto-code-propagates",
                      d.reason == "engine-veto:session-closed");
            }
        }
        targeted("t_latent.json", "HOLD", "latent-risk",
                 jev::VetoReason::NONE);
        targeted("t_disagree.json", "HOLD", "disagreement",
                 jev::VetoReason::NONE);
        targeted("t_blackout.json", "HOLD", "event-blackout",
                 jev::VetoReason::NONE);
        targeted("t_calib.json", "HOLD", "calibration-breach",
                 jev::VetoReason::NONE);
        targeted("t_noedge.json", "HOLD", "no-edge",
                 jev::VetoReason::NONE);
        targeted("t_bound_E50.json", "BASE", "base-1R",
                 jev::VetoReason::NONE);
        targeted("t_bound_E50_lean.json", "HOLD", "mid-band",
                 jev::VetoReason::NONE);
        targeted("t_bound_E79.json", "BASE", "base-1R",
                 jev::VetoReason::NONE);
        targeted("t_bound_E80.json", "BASE", "base-1R",
                 jev::VetoReason::NONE);
        targeted("t_bound_L50.json", "BASE", "base-1R",
                 jev::VetoReason::NONE);
        targeted("t_exec_high.json", "HOLD", "execution-family",
                 jev::VetoReason::NONE);
        targeted("t_flat.json", "HOLD", "conviction-flat",
                 jev::VetoReason::NONE);
        targeted("t_lean_base.json", "BASE", "base-1R",
                 jev::VetoReason::NONE);
        targeted("t_strong_base.json", "BASE", "base-1R",
                 jev::VetoReason::NONE);
        targeted("t_midband_exec.json", "HOLD", "mid-band",
                 jev::VetoReason::NONE);
        targeted("t_midband_lean.json", "HOLD", "mid-band",
                 jev::VetoReason::NONE);
        targeted("t_max_elevated.json", "ELEVATED", "elevated-2R",
                 jev::VetoReason::NONE);
        targeted("t_max_downgrade_L.json", "BASE", "downgrade-strong",
                 jev::VetoReason::NONE);
        targeted("t_max_downgrade_insuf.json", "BASE", "downgrade-strong",
                 jev::VetoReason::NONE);
    }

    // ---- H. 200-AnswerSet replay: SHA-256 decision proof (#8) ----
    {
        auto replay_pass = [&](int& out_n) {
            jev::KernelState k;
            std::string w;
            jev::KernelState::Create({"EURUSD"}, w, k);
            std::string cat;
            out_n = 0;
            for (int i = 0; i < 200; i++) {
                char name[32];
                snprintf(name, sizeof(name), "r_%03d.json", i);
                std::string raw = fx(dir, name);
                jev::JVal art;
                std::string err;
                if (!jev::ParseJson(raw, art, err)) return std::string();
                const jev::JVal* state = jev::ObjGet(art, "state");
                jev::JEVStateV3 s;
                std::string why;
                if (!state || !jev::JEVStateV3::FromJVal(*state, s, why))
                    return std::string();
                jev::ValidationRequest q =
                    k.request_for(validation_bytes(raw), key, s.Serialize(), "EURUSD", 0.0,
                                  jev::Mode::REPLAY);
                jev::ValidationResult r = jev::validate_jev(q);
                if (!r.ok()) {
                    printf("  !! replay %d invalid: %s\n", i,
                           r.reason().c_str());
                    return std::string();
                }
                if (!k.try_accept(
                        "EURUSD",
                        q.has_previous_epoch ? q.previous_epoch : -1,
                        r.get()->snapshot_epoch()))
                    return std::string();
                jev::EngineInputs e = eng_from_state(*state);
                e.calibration_gate = jev::CalibrationGate::PASS;
                jev::Decision d =
                    jev::EvaluateDecision(*r.get(), e);
                out_n++;
                cat += std::to_string(i) + "|" + d.action + "|" +
                       d.reason + "|" + r.get()->decision_key() + ";";
            }
            return jev::Sha256Hex(cat);
        };
        int n1 = 0, n2 = 0;
        std::string h1 = replay_pass(n1);
        std::string h2 = replay_pass(n2);
        CHECK("replay-all-valid", n1 == 200 && n2 == 200);
        CHECK("replay-deterministic",
              !h1.empty() && h1 == h2);
        printf("  replay sha256: %s\n", h1.c_str());
    }
    // Non-degeneracy: every budget class occurs over the sweep.
    {
        jev::KernelState k;
        std::string w;
        jev::KernelState::Create({"EURUSD"}, w, k);
        int n_hold = 0, n_base = 0, n_elev = 0;
        for (int i = 0; i < 200; i++) {
            char name[32];
            snprintf(name, sizeof(name), "r_%03d.json", i);
            std::string raw = fx(dir, name);
            jev::JVal art;
            std::string err;
            if (!jev::ParseJson(raw, art, err)) continue;
            const jev::JVal* state = jev::ObjGet(art, "state");
            jev::JEVStateV3 s;
            std::string why;
            if (!state || !jev::JEVStateV3::FromJVal(*state, s, why))
                continue;
            jev::ValidationRequest q =
                k.request_for(validation_bytes(raw), key, s.Serialize(), "EURUSD", 0.0,
                              jev::Mode::REPLAY);
            jev::ValidationResult r = jev::validate_jev(q);
            if (!r.ok()) continue;
            k.try_accept("EURUSD",
                         q.has_previous_epoch ? q.previous_epoch : -1,
                         r.get()->snapshot_epoch());
            jev::EngineInputs e = eng_from_state(*state);
            e.calibration_gate = jev::CalibrationGate::PASS;
            jev::Decision d = jev::EvaluateDecision(*r.get(), e);
            if (d.budget == jev::Decision::Budget::HOLD) n_hold++;
            if (d.budget == jev::Decision::Budget::BASE_1R) n_base++;
            if (d.budget == jev::Decision::Budget::ELEVATED_2R) n_elev++;
        }
        printf("  distribution hold=%d base=%d elevated=%d\n", n_hold,
               n_base, n_elev);
        CHECK("replay-nondegenerate",
              n_hold > 0 && n_base > 0 && n_elev > 0);
    }

    printf("CHECKS: %d/%d %s\n", total - fails, total,
           fails == 0 ? "PASS" : "FAIL");
    return fails == 0 ? 0 : 1;
}
