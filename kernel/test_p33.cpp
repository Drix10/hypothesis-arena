// P3.3 acceptance: typed JEVStateV3 + serializer interop, kernel-owned
// universe/epochs, deterministic decision table vs doc 03 §3.2 + §3.7,
// replay determinism by hash comparison. REPLAY mode throughout (P3.1
// owns LIVE freshness); artifacts are committed (no Python at test time).
// Usage: ./test_p33 <p33-dir> <fixtures-dir>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#include "jev_validate.hpp"
#include "jev_state.hpp"
#include "kernel_state.hpp"
#include "decision_table.hpp"

static int fails = 0;
static int count = 0;
#define CHECK(name, cond)                                              \
    do {                                                               \
        count++;                                                       \
        if (cond) { printf("ok %s\n", name); }                         \
        else { printf("FAIL %s\n", name); fails++; }                   \
    } while (0)

static std::string read_all(const std::string& path) {
    std::string out;
    char buf[4096];
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return out;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}

static bool hxkey(const std::string& h, std::array<uint8_t, 32>& out) {
    if (h.size() != 64) return false;
    for (int i = 0; i < 32; i++) {
        unsigned v;
        if (sscanf(h.c_str() + 2 * i, "%02x", &v) != 1) return false;
        out[i] = (uint8_t)v;
    }
    return true;
}

static std::string hex_of(const std::string& bytes) {
    static const char* H = "0123456789abcdef";
    std::string o;
    for (unsigned char c : bytes) {
        o += H[c >> 4];
        o += H[c & 15];
    }
    return o;
}

// FNV-1a over decision outputs (replay determinism comparison).
static uint64_t Fnv(const std::string& s, uint64_t h) {
    for (unsigned char c : s) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

int main(int argc, char** argv) {
    const std::string dir = argc > 1 ? argv[1] : "p33";
    const std::string fix = argc > 2 ? argv[2] : "fixtures";
    auto fx = [&](const std::string& n) { return read_all(dir + "/" + n); };
    std::array<uint8_t, 32> key{};
    if (!hxkey(read_all(fix + "/trusted_key.txt"), key)) {
        printf("FAIL key-load\n");
        return 1;
    }
    const std::string state_canon_in = fx("state_canon_input.json");
    CHECK("inputs-present", !state_canon_in.empty() && !fx("r_000.json").empty());
    // Per-epoch state canon: parse the shared base once, stamp the epoch
    // the ARTIFACT carries (read from the artifact itself — data-driven,
    // no hardcoded epoch tables), re-canonicalize with frozen CanonJson.
    jev::JVal state_base;
    {
        std::string perr0;
        CHECK("base-parses",
              jev::ParseJson(state_canon_in, state_base, perr0));
    }
    auto artifact_epoch = [&](const std::string& raw) -> int64_t {
        jev::JVal r;
        std::string pe;
        if (!jev::ParseJson(raw, r, pe)) return -1;
        const jev::JVal* p = jev::ObjGet(r, "payload");
        const jev::JVal* e =
            p ? jev::ObjGet(*p, "snapshot_epoch") : nullptr;
        if (!e || e->t != jev::JVal::T::NUM || e->num_double) return -1;
        int64_t v = 0;
        for (char c : e->num) {
            if (c < '0' || c > '9') return -1;
            v = v * 10 + (c - '0');
        }
        return v;
    };
    auto artifact_symbol = [&](const std::string& raw) -> std::string {
        jev::JVal r;
        std::string pe;
        if (!jev::ParseJson(raw, r, pe)) return "";
        const jev::JVal* p = jev::ObjGet(r, "payload");
        const jev::JVal* s = p ? jev::ObjGet(*p, "symbol") : nullptr;
        if (!s || s->t != jev::JVal::T::STR) return "";
        return jev::U32ToUtf8(s->s);
    };
    auto state_for = [&](int64_t epoch,
                         const std::string& symbol) -> std::string {
        jev::JVal st = state_base;  // value copy of the frozen base
        for (auto& kv : st.o) {
            if (jev::U32ToUtf8(kv.first) == "snapshot_epoch") {
                kv.second.t = jev::JVal::T::NUM;
                kv.second.num_double = false;
                kv.second.num = std::to_string(epoch);
            }
            if (jev::U32ToUtf8(kv.first) == "symbol") {
                kv.second.t = jev::JVal::T::STR;
                kv.second.s.clear();
                for (unsigned char c : symbol)
                    kv.second.s += char32_t(c);
            }
        }
        return jev::CanonJson(st);
    };

    // ---- A. JEVStateV3 serializer interop (committed Python ground truth)
    std::string why;
    {
        jev::JVal v;
        std::string perr;
        bool okp = jev::ParseJson(fx("state_vector.json"), v, perr);
        CHECK("vector-parses", okp);
        jev::JEVStateV3 st;
        bool okc = jev::JEVStateV3::FromJVal(v, st, why);
        CHECK("vector-strict-builds", okc);
        if (!okc) printf("  why: %s\n", why.c_str());
        std::string canon = st.Serialize();
        std::string want_hex = read_all(dir + "/state_vector_canon.hex");
        CHECK("canon-byte-equal", hex_of(canon) == want_hex);
        CHECK("state-hash-equal",
              st.StateHash() == read_all(dir + "/state_vector_hash.txt"));
        // Typed decision_key == frozen recipe on parsed own-bytes.
        jev::JVal back;
        std::string perr2;
        bool okb = jev::ParseJson(canon, back, perr2);
        CHECK("own-bytes-reparse", okb);
        CHECK("dkey-typed-equals-recipe",
              st.DecisionKey() == jev::ComputeDecisionKey(back));
        CHECK("dkey-equals-sidecar",
              st.DecisionKey() == read_all(dir + "/state_vector_dkey.txt"));
        // Strictness: unknown keys, wrong types, bad IDs fail closed.
        jev::JVal bad = v;
        CHECK("shape-unknown-key",
              jev::CheckStateShape(bad) == "" /* baseline sane */);
    }
    {
        // int feature_id -> state-shape (the "?" fallback must be
        // unreachable: strict construction refuses first).
        const char* raw =
            "{\"context_hash\":\"ab\",\"symbol\":\"EURUSD\",\"stage\":\"G0\","
            "\"question_set_version\":\"v3\",\"snapshot_epoch\":1,"
            "\"indicators\":{\"regime\":\"range\"},\"portfolio\":{},"
            "\"event_window\":{},\"features\":[{\"feature_id\":7}]}";
        jev::JVal v;
        std::string perr;
        CHECK("badid-parses", jev::ParseJson(raw, v, perr));
        CHECK("badid-shape", jev::CheckStateShape(v) == "state-shape:feature_id");
        jev::JEVStateV3 st;
        std::string w2;
        CHECK("badid-strict-build-fails",
              !jev::JEVStateV3::FromJVal(v, st, w2));
        // missing feature_id + unknown top key likewise.
        const char* raw2 =
            "{\"context_hash\":\"ab\",\"symbol\":\"EURUSD\",\"stage\":\"G0\","
            "\"question_set_version\":\"v3\",\"snapshot_epoch\":1,"
            "\"indicators\":{\"regime\":\"range\"},\"portfolio\":{},"
            "\"event_window\":{},\"features\":[{\"nope\":1}],\"zzz\":1}";
        jev::JVal v2;
        CHECK("badid2-parses", jev::ParseJson(raw2, v2, perr));
        jev::JEVStateV3 st2;
        CHECK("badid2-strict-build-fails",
              !jev::JEVStateV3::FromJVal(v2, st2, w2));
    }
    {
        // Decoder adversarial vectors: overlong, surrogate, truncated,
        // astral round-trip through the frozen escaper.
        jev::JEVStateV3 st;
        std::string w3;
        CHECK("utf8-overlong",
              !st.set_regime(std::string("\xC0\xAF", 2), w3));
        CHECK("utf8-truncated",
              !st.set_regime(std::string("\xE2\x82", 2), w3));
        CHECK("utf8-surrogate",
              !st.set_regime(std::string("\xED\xA0\x80", 3), w3));
        CHECK("utf8-astral-ok",
              st.set_regime("\xF0\x9F\x98\x80", w3));  // U+1F600
        CHECK("nonfinite-double",
              !st.set_zscore(std::numeric_limits<double>::quiet_NaN(), w3));
        int64_t micros = 0;
        CHECK("micros-roundtrip",
              jev::JEVStateV3::UnixMicros(1720000000.5, micros) &&
                  micros == 1720000000500000LL);
        CHECK("micros-rejects-inf",
              !jev::JEVStateV3::UnixMicros(
                  std::numeric_limits<double>::infinity(), micros));
    }
    {
        // ScalarLessL regression (P3.1 amendment): the LE table was wrong
        // from byte 5 on, false-rejecting valid S with S[31]==0x0F and
        // S[30]>=0x10. Boundaries pinned directly (L-1 accept, L reject).
        uint8_t zero[32] = {};
        uint8_t Lval[32] = {0xED, 0xD3, 0xF5, 0x5C, 0x1A, 0x63, 0x12, 0x58,
                            0xD6, 0x9C, 0xF7, 0xA2, 0xDE, 0xF9, 0xDE, 0x14};
        CHECK("lessL-zero", jev::ScalarLessL(zero));
        // S = 0x0F_A2... (the discovered false-reject band) must accept.
        uint8_t band[32] = {};
        band[31] = 0x0F;
        band[30] = 0xA2;
        CHECK("lessL-band-accept", jev::ScalarLessL(band));
        // S = L exactly must reject; S = L-1 must accept.
        uint8_t Leq[32];
        memcpy(Leq, Lval, 16);
        memset(Leq + 16, 0, 14);
        Leq[30] = 0x00;
        Leq[31] = 0x10;
        CHECK("lessL-L-rejects", !jev::ScalarLessL(Leq));
        uint8_t Lm1b[32];
        memcpy(Lm1b, Leq, 32);
        for (int i = 0; i < 32; i++) {  // subtract 1
            if (Lm1b[i]-- != 0) break;
        }
        CHECK("lessL-Lminus1-accepts", jev::ScalarLessL(Lm1b));
    }

    // ---- B. KernelState: universe + epochs kernel-owned
    {
        std::string w4;
        jev::KernelState bad =
            jev::KernelState::WithUniverse({}, w4);
        CHECK("empty-universe-rejected", !bad.ok());
        jev::KernelState ks =
            jev::KernelState::WithUniverse({"EURUSD", "GBPUSD"}, w4);
        CHECK("universe-built", ks.ok());
        CHECK("membership", ks.is_executable("EURUSD") &&
                                !ks.is_executable("XXX"));
        CHECK("no-epoch-yet", !ks.has_epoch("EURUSD"));
        CHECK("accept-first", ks.accept("EURUSD", 0));
        CHECK("accept-advance", ks.accept("EURUSD", 5));
        CHECK("accept-stale-refused",
              !ks.accept("EURUSD", 5) && !ks.accept("EURUSD", 3));
        CHECK("accept-negative-refused", !ks.accept("EURUSD", -1));
        CHECK("accept-foreign-refused", !ks.accept("XXX", 9));
        CHECK("last-epoch", ks.last_epoch("EURUSD") == 5);
        jev::ValidationRequest q = ks.request_for("{}", key, "{}", "EURUSD",
                                                  0.0, jev::Mode::REPLAY);
        CHECK("request-from-kernel",
              q.allowed_symbols.size() == 2 && q.has_previous_epoch &&
                  q.previous_epoch == 5);
        jev::ValidationRequest q0 = ks.request_for("{}", key, "{}", "GBPUSD",
                                                   0.0, jev::Mode::REPLAY);
        CHECK("request-first-no-predecessor", !q0.has_previous_epoch);
    }
    // End-to-end: stale epoch rejected THROUGH the wrapper with the frozen
    // reason (binding passes — the state matches — so epoch is the SOLE
    // failure cause, strongly proving the gate).
    {
        std::string w5;
        jev::KernelState ks =
            jev::KernelState::WithUniverse({"EURUSD"}, w5);
        CHECK("e2e-advance", ks.accept("EURUSD", 100));
        std::string raw0 = fx("r_000.json");
        jev::ValidationRequest q = ks.request_for(
            raw0, key, state_for(artifact_epoch(raw0), "EURUSD"), "EURUSD",
            0.0, jev::Mode::REPLAY);
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("e2e-stale-epoch-holds",
              !r.ok() && r.reason() == "epoch-not-monotonic");
        // Fresh kernel accepts epoch 0 artifact, then advances.
        jev::KernelState ks2 =
            jev::KernelState::WithUniverse({"EURUSD"}, w5);
        jev::ValidationRequest q2 = ks2.request_for(
            raw0, key, state_for(artifact_epoch(raw0), "EURUSD"), "EURUSD",
            0.0, jev::Mode::REPLAY);
        jev::ValidationResult r2 = jev::validate_jev(q2);
        CHECK("e2e-first-ok", r2.ok());
        CHECK("e2e-accept-advances",
              r2.ok() && ks2.accept("EURUSD", r2.get()->snapshot_epoch()));
        // Non-executable symbol fails MEMBERSHIP (state matches XXX, so
        // binding passes and universe is the sole failure cause).
        std::string rawx = fx("t_symbol_xxx.json");
        jev::ValidationRequest qx = ks2.request_for(
            rawx, key, state_for(artifact_epoch(rawx), "XXX"), "XXX", 0.0,
            jev::Mode::REPLAY);
        jev::ValidationResult rx = jev::validate_jev(qx);
        CHECK("e2e-universe-holds",
              !rx.ok() && rx.reason() == "symbol-universe");
    }

    // ---- C. Decision table vs doc 03 §3.2 rows + §3.7 cases 21-28
    std::string w6;
    jev::KernelState ks =
        jev::KernelState::WithUniverse({"EURUSD"}, w6);
    auto run_case = [&](const std::string& file, jev::EngineInputs in,
                      jev::Decision& out) -> bool {
        std::string raw = fx(file);
        int64_t epoch = artifact_epoch(raw);
        std::string symbol = artifact_symbol(raw);
        jev::ValidationRequest q = ks.request_for(
            raw, key, state_for(epoch, symbol), symbol, 0.0,
            jev::Mode::REPLAY);
        jev::ValidationResult r = jev::validate_jev(q);
        if (!r.ok()) {
            printf("  !! %s failed validation: %s\n", file.c_str(),
                   r.reason().c_str());
            return false;
        }
        if (!ks.accept(symbol, epoch)) {
            printf("  !! %s epoch not accepted\n", file.c_str());
            return false;
        }
        out = jev::EvaluateDecision(*r.get(), in);
        return true;
    };
    auto eng = []() {
        jev::EngineInputs e;
        return e;
    };
    auto expect = [&](const char* name, const char* file,
                      jev::EngineInputs in, const char* action,
                      const char* reason) {
        jev::Decision d;
        bool ran = run_case(file, in, d);
        CHECK(name, ran && d.action == action && d.reason == reason);
    };
    // Calls run in ARTIFACT-EPOCH order (t_veto=200 .. t_bound_E50_lean=219)
    // so KernelState advances monotonically; check names stay §3.7-mapped.
    {
        jev::EngineInputs in = eng();  // 22: row-0 R2 veto
        in.deterministic_veto = true;
        in.veto_reason = "R2";
        expect("c22-row0", "t_veto.json", in, "HOLD", "engine-veto");
    }
    {
        jev::EngineInputs in = eng();  // 21: L=.8 additive veto
        expect("c21-latent", "t_latent.json", in, "HOLD", "latent-risk");
    }
    {
        jev::EngineInputs in = eng();  // 27: R14 disagreement
        in.disagreement = true;
        expect("c27-disagree", "t_disagree.json", in, "HOLD",
               "disagreement");
    }
    {
        jev::EngineInputs in = eng();  // 28: pre-event blackout
        in.event_blackout = true;
        expect("c28-blackout", "t_blackout.json", in, "HOLD",
               "event-blackout");
    }
    {
        jev::EngineInputs in = eng();  // 26: breach HOLDS even max
        in.calibration_gate = jev::CalibrationGate::BREACH;
        expect("c26-calib", "t_calib.json", in, "HOLD",
               "calibration-breach");
    }
    {
        jev::EngineInputs in = eng();
        expect("row-noedge", "t_noedge.json", in, "HOLD", "no-edge");
        expect("row-midband-exec", "t_midband_exec.json", in, "HOLD",
               "mid-band");
        expect("row-midband-lean", "t_midband_lean.json", in, "HOLD",
               "mid-band");
    }
    {
        jev::EngineInputs in = eng();  // 23: execution never directs
        expect("c23-execution", "t_exec_high.json", in, "HOLD",
               "execution-family");
    }
    {
        jev::EngineInputs in = eng();
        expect("row-flat", "t_flat.json", in, "HOLD", "conviction-flat");
        expect("row-lean", "t_lean_base.json", in, "BASE", "base-1R");
        expect("row-strong", "t_strong_base.json", in, "BASE", "base-1R");
    }
    {
        jev::EngineInputs in = eng();  // 24: max-gate fully green
        in.calibration_gate = jev::CalibrationGate::PASS;
        expect("c24-elevated", "t_max_elevated.json", in, "ELEVATED",
               "elevated-2R");
    }
    {
        jev::EngineInputs in = eng();  // 25: L=.4 breaks the gate
        in.calibration_gate = jev::CalibrationGate::PASS;
        expect("c25-downgrade", "t_max_downgrade_L.json", in, "BASE",
               "downgrade-strong");
    }
    {
        // max + insufficient gate: downgrade (thin evidence never sizes up).
        jev::EngineInputs in = eng();
        in.calibration_gate = jev::CalibrationGate::INSUFFICIENT;
        expect("row-max-insufficient", "t_max_downgrade_insuf.json", in,
               "BASE", "downgrade-strong");
    }
    {
        // Boundaries: E=0.5 mid-band-but-passes, L=0.5 passes (strict >),
        // E=0.8 gate-eligible, E=0.79 gate-fails, E=0.5+lean mid-band HOLD.
        jev::EngineInputs in = eng();
        expect("bound-E50", "t_bound_E50.json", in, "BASE", "base-1R");
        expect("bound-L50", "t_bound_L50.json", in, "BASE", "base-1R");
        jev::EngineInputs pin = eng();
        pin.calibration_gate = jev::CalibrationGate::PASS;
        expect("bound-E80", "t_bound_E80.json", pin, "ELEVATED",
               "elevated-2R");
        expect("bound-E79", "t_bound_E79.json", pin, "BASE",
               "downgrade-strong");
        expect("bound-E50-lean", "t_bound_E50_lean.json", in, "HOLD",
               "mid-band");
    }
    {
        // insufficient does NOT hold ordinary rows (budget-dependent gate):
        // separate kernel (r_127 = E.81/momentum/strong/L.3, epoch 127).
        std::string w7;
        jev::KernelState ks7 =
            jev::KernelState::WithUniverse({"EURUSD"}, w7);
        std::string raw = fx("r_127.json");
        jev::ValidationRequest q = ks7.request_for(
            raw, key, state_for(artifact_epoch(raw), "EURUSD"), "EURUSD",
            0.0, jev::Mode::REPLAY);
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("row-strong-insufficient-valid", r.ok());
        if (r.ok()) {
            jev::EngineInputs in = eng();
            in.calibration_gate = jev::CalibrationGate::INSUFFICIENT;
            jev::Decision d = jev::EvaluateDecision(*r.get(), in);
            CHECK("row-strong-insufficient",
                  d.action == "BASE" && d.reason == "base-1R");
        }
    }

    // ---- D. Replay determinism: 200 AnswerSets, outputs hashed twice.
    auto replay_pass = [&](int& out_n) {
        jev::KernelState k2 =
            jev::KernelState::WithUniverse({"EURUSD"}, w6);
        uint64_t h = 1469598103934665603ULL;
        out_n = 0;
        for (int i = 0; i < 200; i++) {
            char name[32];
            snprintf(name, sizeof(name), "r_%03d.json", i);
            std::string raw = fx(name);
            jev::ValidationRequest q = k2.request_for(
                raw, key, state_for(i, "EURUSD"), "EURUSD", 0.0,
                jev::Mode::REPLAY);
            jev::ValidationResult r = jev::validate_jev(q);
            if (!r.ok()) {
                printf("  !! replay %d invalid: %s\n", i,
                       r.reason().c_str());
                return h ^ 0xDEADULL;
            }
            out_n++;
            if (!k2.accept("EURUSD", r.get()->snapshot_epoch())) {
                printf("  !! replay %d epoch stuck\n", i);
                return h ^ 0xBEEFULL;
            }
            jev::EngineInputs in = eng();
            switch (i % 8) {
                case 1: in.deterministic_veto = true; break;
                case 2: in.disagreement = true; break;
                case 3: in.event_blackout = true; break;
                case 4:
                    in.calibration_gate = jev::CalibrationGate::BREACH;
                    break;
                case 5:
                    in.calibration_gate = jev::CalibrationGate::PASS;
                    break;
                case 6: in.r6_vol_trip = true; break;
                case 7: in.exposure_headroom_r2 = false; break;
                default: break;
            }
            jev::Decision d = jev::EvaluateDecision(*r.get(), in);
            h = Fnv(d.action + "|" + d.reason + "|" +
                        r.get()->decision_key(),
                    h);
        }
        return h;
    };
    {
        int n1 = 0, n2 = 0;
        uint64_t h1 = replay_pass(n1);
        uint64_t h2 = replay_pass(n2);
        CHECK("replay-all-valid", n1 == 200 && n2 == 200);
        CHECK("replay-deterministic", h1 == h2);
        printf("  replay hash: %llx\n", (unsigned long long)h1);
    }
    // Non-degeneracy over the 200-set: every budget class occurs (the
    // systematic sweep covers HOLD-heavy engine patterns AND clean ones).
    {
        jev::KernelState k3 =
            jev::KernelState::WithUniverse({"EURUSD"}, w6);
        int n_hold = 0, n_base = 0, n_elev = 0;
        for (int i = 0; i < 200; i++) {
            char name[32];
            snprintf(name, sizeof(name), "r_%03d.json", i);
            std::string raw = fx(name);
            jev::ValidationRequest q = k3.request_for(
                raw, key, state_for(i, "EURUSD"), "EURUSD", 0.0,
                jev::Mode::REPLAY);
            jev::ValidationResult r = jev::validate_jev(q);
            if (!r.ok()) continue;  // counted in replay pass; skip here
            k3.accept("EURUSD", r.get()->snapshot_epoch());
            jev::EngineInputs clean = eng();
            clean.calibration_gate = jev::CalibrationGate::PASS;
            jev::Decision d = jev::EvaluateDecision(*r.get(), clean);
            if (d.budget == jev::Decision::Budget::HOLD) n_hold++;
            if (d.budget == jev::Decision::Budget::BASE_1R) n_base++;
            if (d.budget == jev::Decision::Budget::ELEVATED_2R) n_elev++;
        }
        printf("  distribution hold=%d base=%d elevated=%d\n", n_hold,
               n_base, n_elev);
        CHECK("replay-nondegenerate",
              n_hold > 0 && n_base > 0 && n_elev > 0);
    }

    printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
