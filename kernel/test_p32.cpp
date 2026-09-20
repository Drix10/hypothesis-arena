// P3.2 interop suite: committed Python->C++ vectors for canonical bytes,
// SHA-256, Ed25519. Reads ONLY committed files (kernel/vectors/); never
// invokes Python. Ends at the interoperable cryptographic artifact (P3.3
// owns the typed decision layer).
#include <cstdio>
#include <cstring>
#include <string>
#include "jev_validate.hpp"
#include "kernel_state.hpp"

static int fails = 0;
static int count = 0;
#define CHECK(name, cond)                                              \
    do {                                                               \
        count++;                                                       \
        if (cond) { printf("ok %s\n", name); }                         \
        else { printf("FAIL %s\n", name); fails++; }                   \
    } while (0)

static std::string read_all(const char* path) {
    std::string out;
    char buf[4096];
    FILE* f = fopen(path, "rb");
    if (!f) return out;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}

static bool unhex(const std::string& h, std::string& out) {
    if (h.size() % 2) return false;
    out.clear();
    for (size_t i = 0; i < h.size(); i += 2) {
        unsigned v;
        if (sscanf(h.c_str() + i, "%02x", &v) != 1) return false;
        out += (char)v;
    }
    return true;
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

static bool hxsig(const std::string& h, uint8_t out[64]) {
    if (h.size() != 128) return false;
    for (int i = 0; i < 64; i++) {
        unsigned v;
        if (sscanf(h.c_str() + 2 * i, "%02x", &v) != 1) return false;
        out[i] = (uint8_t)v;
    }
    return true;
}

int main(int argc, char** argv) {
    const char* dir = argc > 1 ? argv[1] : "vectors";
    auto fx = [&](const char* n) { return read_all((std::string(dir) + "/" + n).c_str()); };
    std::array<uint8_t, 32> pub{};
    if (!hxkey(fx("pubkey.txt"), pub)) { printf("FAIL key-load\n"); return 1; }

    for (int v = 1; v <= 2; v++) {
        char tag[8];
        snprintf(tag, sizeof(tag), "v%d", v);
        std::string payload_raw = fx((std::string(tag) + "_payload.json").c_str());
        std::string canon_hex = fx((std::string(tag) + "_canonical.hex").c_str());
        std::string want_hash = fx((std::string(tag) + "_response_hash.txt").c_str());
        std::string want_sig = fx((std::string(tag) + "_signature.txt").c_str());
        std::string canon;
        if (!unhex(canon_hex, canon)) {
            printf("FAIL %s-hex-decode\n", tag);
            fails++;
            count++;
            continue;
        }
        // 1. byte-for-byte canonical equality (C++ re-serializes the payload)
        jev::JVal payload;
        std::string perr;
        bool parsed = jev::ParseJson(payload_raw, payload, perr);
        char n1[64], n2[64], n3[64], n4[64], n5[64], n6[64], n7[64];
        snprintf(n1, sizeof(n1), "%s-parse", tag);
        CHECK(n1, parsed);
        if (!parsed) continue;
        std::string mine = jev::CanonJson(payload);
        snprintf(n2, sizeof(n2), "%s-canon-bytes", tag);
        CHECK(n2, mine == canon);
        // 2. SHA-256 equality over the committed bytes
        snprintf(n3, sizeof(n3), "%s-sha256", tag);
        CHECK(n3, jev::Sha256Hex(canon) == want_hash);
        // 3. signature verification over the committed bytes
        uint8_t sig[64];
        snprintf(n4, sizeof(n4), "%s-sig-shape", tag);
        CHECK(n4, hxsig(want_sig, sig));
        snprintf(n5, sizeof(n5), "%s-verify", tag);
        CHECK(n5, jev::EdVerify(pub.data(), (const uint8_t*)canon.data(),
                                canon.size(), sig));
        // 4. one-byte payload mutation -> hash AND signature failure
        {
            std::string mut = canon;
            mut[mut.size() / 2] ^= 0x01;
            snprintf(n6, sizeof(n6), "%s-mutbyte-hash", tag);
            CHECK(n6, jev::Sha256Hex(mut) != want_hash);
            snprintf(n7, sizeof(n7), "%s-mutbyte-sig", tag);
            CHECK(n7, !jev::EdVerify(pub.data(), (const uint8_t*)mut.data(),
                                     mut.size(), sig));
        }
        // 6. signature mutation -> verification failure
        {
            uint8_t bad[64];
            memcpy(bad, sig, 64);
            bad[0] ^= 0x01;
            char nm[64];
            snprintf(nm, sizeof(nm), "%s-mutsig-fails", tag);
            CHECK(nm, !jev::EdVerify(pub.data(), (const uint8_t*)canon.data(),
                                     canon.size(), bad));
        }
        // 7. key mismatch -> failure
        {
            std::array<uint8_t, 32> wrong = pub;
            wrong[0] ^= 0x01;
            char nm[64];
            snprintf(nm, sizeof(nm), "%s-wrongkey-fails", tag);
            CHECK(nm, !jev::EdVerify(wrong.data(), (const uint8_t*)canon.data(),
                                     canon.size(), sig));
        }
        // 13. timestamp fields present exactly as serialized
        if (v == 1) {
            CHECK("v1-created-exact",
                  canon.find("\"created_at\":\"2026-09-21T00:00:00+00:00\"") !=
                  std::string::npos);
            // expires == created + 60, exact rendering (read from payload)
            {
                const jev::JVal* ea = payload.find(jev::U8("expires_at"));
                std::string expfrag = "\"expires_at\":" +
                                      jev::CanonJson(ea ? *ea : payload);
                CHECK("v1-expires-exact",
                      ea && canon.find(expfrag) != std::string::npos);
            }
            CHECK("v1-negzero", canon.find("\"noul\":-0.0") != std::string::npos);
            CHECK("v1-floatedge",
                  canon.find("0.30000000000000004") != std::string::npos);
        }
        if (v == 2) {
            // 9. nested key ordering by code point: a < m < z; "" sorts first
            size_t pa = canon.find("\"awy\":{\"a\"");
            size_t pm = canon.find("\"m\":1");
            size_t pz = canon.find("\"z\":{");
            CHECK("v2-order-amz", pa != std::string::npos && pm > pa && pz > pm);
            CHECK("v2-empty-first", canon.compare(0, 15, "{\"\":\"empty-key\"") == 0);
            // 8. non-ASCII escaped as \\uXXXX (ensure_ascii contract)
            CHECK("v2-e-acute", canon.find("caf\\u00e9") != std::string::npos);
            CHECK("v2-astral-surrogate",
                  canon.find("\\ud83d\\ude00 key") != std::string::npos);
            CHECK("v2-euro", canon.find("\\u20ac") != std::string::npos);
            // 10. int/float boundaries
            CHECK("v2-bigint", canon.find("1267650600228229401496703205376") !=
                                   std::string::npos);
            CHECK("v2-1e15-fixed",
                  canon.find("1000000000000000.0") != std::string::npos);
            CHECK("v2-5e-324", canon.find("5e-324") != std::string::npos);
            CHECK("v2-maxdouble",
                  canon.find("1.7976931348623157e+308") != std::string::npos);
            // 12. no NaN/Infinity vocabulary anywhere in committed bytes
            CHECK("v2-no-nan", canon.find("NaN") == std::string::npos);
            CHECK("v2-no-inf", canon.find("Infinity") == std::string::npos);
        }
    }
    // 5. response_hash is a recomputation-checked claim, NOT signature-covered:
    // flipping it breaks the hash check while the signature over the payload
    // bytes still verifies (frozen sidecar scope, recorded in plan/13.2).
    {
        std::string canon;
        unhex(fx("v1_canonical.hex"), canon);
        std::string want_hash = fx("v1_response_hash.txt");
        std::string flipped = want_hash;
        flipped[0] = (flipped[0] != '0') ? '0' : '1';
        CHECK("v1-hashclaim-fails", jev::Sha256Hex(canon) != flipped);
        uint8_t sig[64];
        hxsig(fx("v1_signature.txt"), sig);
        CHECK("v1-sig-scope-bytes",
              jev::EdVerify(pub.data(), (const uint8_t*)canon.data(), canon.size(),
                            sig));
    }
    // V1 is a genuine artifact: the frozen P3.1 validator accepts it
    // (uses P3.1 as a tool; modifies nothing). Request via the sole
    // authority (Slice A); vector and expectation unchanged.
    {
        jev::KernelState kern;
        std::string kwhy;
        if (!jev::KernelState::Create({"EURUSD"}, kwhy, kern)) {
            printf("FAIL kernel-setup\n");
            return 1;
        }
        jev::ValidationRequest q = kern.request_for(
            fx("v1_artifact.json"), pub, fx("v1_state_canon.json"),
            "EURUSD", 1789948810.0, jev::Mode::LIVE);  // created + 10 s
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("v1-genuine-artifact", r.ok());
        const auto* o = r.get();
        CHECK("v1-latent-negzero", o && o->latent_risk() == 0.0);
    }
    printf("%d checks, %d failures\n", count, fails);
    return fails ? 1 : 0;
}
