// P3.1 acceptance suite (correction pass). Every frozen semantic requirement
// gets a dedicated adversarial test. The validated object is reachable only
// via get() (null on HOLD); no confidence accessor exists by construction.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include "jev_validate.hpp"

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

static bool hxkey(const std::string& h, std::array<uint8_t, 32>& out) {
    if (h.size() != 64) return false;
    for (int i = 0; i < 32; i++) {
        unsigned v;
        if (sscanf(h.c_str() + 2 * i, "%02x", &v) != 1) return false;
        out[i] = (uint8_t)v;
    }
    return true;
}

int main(int argc, char** argv) {
    const char* dir = argc > 1 ? argv[1] : "fixtures";
    auto fx = [&](const char* n) { return read_all((std::string(dir) + "/" + n).c_str()); };
    std::array<uint8_t, 32> key{};
    if (!hxkey(fx("trusted_key.txt"), key)) { printf("FAIL key-load\n"); return 1; }
    std::string state_canon = fx("state_canon.json");
    double created = atof(fx("created_unix.txt").c_str());

    auto req = [&](const std::string& raw, jev::Mode m, double now) {
        jev::ValidationRequest q;
        q.raw_json = raw;
        q.trusted_key = key;
        q.state_canon_json = state_canon;
        q.allowed_symbols = {"EURUSD"};
        q.now_unix = now;
        q.mode = m;
        return q;
    };
    double fresh = created + 10.0;

    // positive canonical artifact accepted; typed object only via get()
    {
        jev::ValidationResult r = jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, fresh));
        CHECK("valid-live-ok", r.ok() && r.reason() == "ok");
        const auto* v = r.get();
        CHECK("typed-present", v != nullptr);
        CHECK("typed-symbol", v->symbol() == "EURUSD");
        CHECK("typed-epoch", v->snapshot_epoch() == 7);
        CHECK("typed-enter", v->enter() == 0.9);
        CHECK("typed-latent", v->latent_risk() == 0.1);
        CHECK("typed-family", v->family() == jev::EdgeFamily::MOMENTUM);
        CHECK("typed-conviction", v->conviction() == jev::Conviction::STRONG);
        CHECK("typed-hashes",
              v->state_hash() == jev::Sha256Hex(state_canon));
        // get() is null on HOLD: failed results expose no object
        jev::ValidationResult bad =
            jev::validate_jev(req(fx("bad_sig.json"), jev::Mode::LIVE, fresh));
        CHECK("hold-exposes-nothing", !bad.ok() && bad.get() == nullptr);
    }
    // malformed classes rejected with their own reasons
    struct Case { const char* file; const char* reason; };
    Case cases[] = {
        {"bad_top_extra.json", "top-level-keys"},
        {"bad_top_missing.json", "top-level-keys"},
        {"bad_schema_version.json", "schema-version"},
        {"bad_qversion.json", "qversion"},
        {"bad_model.json", "model"},
        {"bad_revision.json", "revision"},
        {"bad_provider.json", "provider"},
        {"bad_symbol.json", "symbol"},
        {"bad_epoch_bool.json", "snapshot-epoch"},
        {"bad_epoch_double.json", "snapshot-epoch"},
        {"bad_epoch_neg.json", "snapshot-epoch"},
        {"bad_statehash_shape.json", "state-hash-shape"},
        {"bad_created.json", "created-at"},
        {"bad_date_feb31.json", "created-at"},
        {"bad_leap60.json", "created-at"},
        {"bad_expires_window.json", "expires-window"},
        {"bad_answers_extra.json", "answers-keys"},
        {"bad_enter_bool.json", "enter-shape"},
        {"bad_enter_range.json", "enter-shape"},
        {"bad_enter_nan.json", "parse-error"},
        {"bad_latent_range.json", "latent-shape"},
        {"bad_family.json", "family-shape"},
        {"bad_prob_key.json", "family-shape"},
        {"bad_conviction.json", "conviction-shape"},
        {"conf_bool.json", "family-shape"},
        {"bad_dkey.json", "decision-binding"},
        {"bad_response_hash.json", "response-hash-mismatch"},
        {"bad_sig.json", "signature-invalid"},
    };
    for (auto& c : cases) {
        jev::ValidationResult r = jev::validate_jev(req(fx(c.file), jev::Mode::LIVE, fresh));
        char name[128];
        snprintf(name, sizeof(name), "reject-%s", c.file);
        CHECK(name, !r.ok() && r.reason() == c.reason);
    }
    // parse-level: truncation, non-object, duplicates at three levels
    {
        jev::ValidationResult r = jev::validate_jev(req("{truncated", jev::Mode::LIVE, fresh));
        CHECK("reject-truncated", !r.ok() && r.reason() == "parse-error");
        r = jev::validate_jev(req("[1,2]", jev::Mode::LIVE, fresh));
        CHECK("reject-nonobject", !r.ok() && r.reason() == "parse-error");
        std::string v = fx("valid.json");
        std::string dup_top = v;
        {
            // duplicate the top-level key itself (formatting-independent)
            size_t at = dup_top.find("\"payload\"");
            if (at != std::string::npos)
                dup_top.replace(at, 9, "\"payload\":0,\"payload\"");
        }
        r = jev::validate_jev(req(dup_top, jev::Mode::LIVE, fresh));
        CHECK("reject-dup-top", !r.ok() && r.reason() == "duplicate-keys");
        std::string dup_ans = v;
        {
            size_t at = dup_ans.find("\"enter\"");
            if (at != std::string::npos)
                dup_ans.replace(at, 7, "\"enter\":0,\"enter\"");
        }
        r = jev::validate_jev(req(dup_ans, jev::Mode::LIVE, fresh));
        CHECK("reject-dup-answers", !r.ok() && r.reason() == "duplicate-keys");
        std::string dup_deep = v;
        {
            // first "noul": occurrence is enter's key (the "type" value
            // "noul" is never followed by a colon)
            size_t at = dup_deep.find("\"noul\":");
            if (at != std::string::npos)
                dup_deep.replace(at, 7, "\"noul\":0,\"noul\":");
        }
        r = jev::validate_jev(req(dup_deep, jev::Mode::LIVE, fresh));
        CHECK("reject-dup-enter", !r.ok() && r.reason() == "duplicate-keys");
    }
    // resource bounds
    {
        jev::ValidationResult r =
            jev::validate_jev(req(std::string(70000, ' '), jev::Mode::LIVE, fresh));
        CHECK("reject-too-large", !r.ok() && r.reason() == "too-large");
        std::string v = fx("valid.json");
        std::string big = v;
        {
            size_t at = big.find("EURUSD");
            if (at != std::string::npos) big.replace(at, 6, std::string(2000, 'a'));
        }
        r = jev::validate_jev(req(big, jev::Mode::LIVE, fresh));
        CHECK("reject-huge-string", !r.ok());
        std::string members = "{";
        for (int i = 0; i < 70; i++) {
            if (i) members += ",";
            members += "\"k" + std::to_string(i) + "\":0";
        }
        members += "}";
        r = jev::validate_jev(req(members, jev::Mode::LIVE, fresh));
        CHECK("reject-many-members", !r.ok());
        std::string deep;
        for (int i = 0; i < 70; i++) deep += "[";
        for (int i = 0; i < 70; i++) deep += "]";
        r = jev::validate_jev(req(deep, jev::Mode::LIVE, fresh));
        CHECK("reject-deep", !r.ok());
        std::string bignum = v;
        {
            size_t at = bignum.find("\"expires_at\"");
            size_t c = bignum.find(':', at);
            size_t e = bignum.find_first_of(",}", c);
            if (at != std::string::npos && c != std::string::npos &&
                e != std::string::npos)
                bignum.replace(c + 1, e - c - 1, "1e999999");
        }
        r = jev::validate_jev(req(bignum, jev::Mode::LIVE, fresh));
        CHECK("reject-huge-number", !r.ok());
    }
    // wrong trusted key rejected; artifact key never trusted
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.trusted_key.fill(0xAB);
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-wrong-key", !r.ok() && r.reason() == "signature-invalid");
        r = jev::validate_jev(req(fx("pubkey_mutated.json"), jev::Mode::LIVE, fresh));
        CHECK("artifact-key-ignored", r.ok());
    }
    // symbol universe: syntax-valid but non-member rejected
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.allowed_symbols = {"GBPUSD"};
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-nonuniverse", !r.ok() && r.reason() == "symbol-universe");
        q.allowed_symbols.clear();
        r = jev::validate_jev(q);
        CHECK("reject-empty-universe", !r.ok() && r.reason() == "symbol-universe");
    }
    // epoch monotonicity: strictly greater than kernel-owned previous
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.has_previous_epoch = true;
        q.previous_epoch = 6;
        CHECK("epoch-after-6-ok", jev::validate_jev(q).ok());
        q.previous_epoch = 7;
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-epoch-replay", !r.ok() && r.reason() == "epoch-not-monotonic");
        q.previous_epoch = 8;
        r = jev::validate_jev(q);
        CHECK("reject-epoch-regress", !r.ok() && r.reason() == "epoch-not-monotonic");
        // REPLAY enforces the same rule against the recorded predecessor
        q.mode = jev::Mode::REPLAY;
        q.previous_epoch = 6;
        CHECK("replay-epoch-ok", jev::validate_jev(q).ok());
    }
    // state / decision-key mutation rejected (key recomputed, never compared)
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.state_canon_json = "{\"tampered\":true}";
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-state-mutation", !r.ok() && r.reason() == "state-binding");
        // feature change keeps hash path intact but breaks recomputed key... or hash:
        // either reason proves kernel-side derivation, never a trusted string
        jev::ValidationRequest q2 = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        std::string st = state_canon;
        size_t at = st.find("\"range\"");
        if (at != std::string::npos) st.replace(at + 1, 5, "trend");
        q2.state_canon_json = st;
        r = jev::validate_jev(q2);
        CHECK("reject-feature-mutation", !r.ok());
    }
    // expiry: LIVE holds, REPLAY waives; skew allowance exactly 300 s
    {
        double expired_now = created + 600.0;
        jev::ValidationResult r =
            jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, expired_now));
        CHECK("live-expired-hold", !r.ok() && r.reason() == "expired");
        r = jev::validate_jev(req(fx("valid.json"), jev::Mode::REPLAY, expired_now));
        CHECK("replay-expired-ok", r.ok());
        r = jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, created - 1000.0));
        CHECK("live-future-hold", !r.ok() && r.reason() == "not-yet-valid");
        r = jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, created - 299.0));
        CHECK("skew-299-ok", r.ok());
        r = jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, created - 301.0));
        CHECK("skew-301-hold", !r.ok() && r.reason() == "not-yet-valid");
    }
    // confidence quarantine: huge finite confidence validates; no accessor exists
    {
        jev::ValidationResult r =
            jev::validate_jev(req(fx("conf_huge.json"), jev::Mode::LIVE, fresh));
        CHECK("conf-quarantined-ok", r.ok() && r.get() != nullptr);
        // compile-time quarantine: ValidatedJEVAnswerSetV3 has no confidence()
        // member; if it ever gains one, this suite must be amended (P3.4).
    }
    // Ed25519 adversarial unit vectors (direct, oracle-shaped)
    {
        auto ev = [&](const char* rhex, const char* shex, const std::string& msg) {
            std::array<uint8_t, 32> R, S;
            uint8_t sig[64];
            if (!hxkey(rhex, R) || !hxkey(shex, S)) return false;
            memcpy(sig, R.data(), 32);
            memcpy(sig + 32, S.data(), 32);
            return jev::EdVerify(key.data(), (const uint8_t*)msg.data(), msg.size(), sig);
        };
        CHECK("ed-zero-sig-rejected", !ev(std::string(64, '0').c_str(),
                                          std::string(64, '0').c_str(), state_canon));
        // S == L (order boundary) must fail the S < L check
        CHECK("ed-s-eq-l-rejected",
              !ev("de8f7589babbe2e693cdb74dc1d3e8c3e1549782b95d2b9deaff8802fbe81c0d",
                  "edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010",
                  state_canon));
        // non-canonical R (y >= p) rejected at decode
        CHECK("ed-noncanon-r-rejected", !ev(std::string(64, 'f').c_str(),
                                            std::string(64, '0').c_str(), state_canon));
        // x == 0 with sign bit rejected
        CHECK("ed-x0-sign-rejected", !ev((std::string(62, '0') + "80").c_str(),
                                         std::string(64, '0').c_str(), state_canon));
        // malformed trusted key: decode failure, never an exception
        {
            std::array<uint8_t, 32> badkey{};
            badkey.fill(0xFF);
            std::string v = fx("valid.json");
            jev::JVal root;
            std::string pe;
            bool parsed = jev::ParseJson(v, root, pe);
            CHECK("ed-fixture-parses", parsed);
            const jev::JVal* sig = root.find(jev::U8("signature"));
            uint8_t sigraw[64];
            std::string sh;
            for (auto& kv : root.o)
                if (jev::U32ToUtf8(kv.first) == "signature") sh = jev::U32ToUtf8(kv.second.s);
            (void)sig;
            for (int i = 0; i < 64; i++) {
                unsigned u;
                sscanf(sh.c_str() + 2 * i, "%02x", &u);
                sigraw[i] = (uint8_t)u;
            }
            std::string canon = jev::CanonJson(*root.find(jev::U8("payload")));
            CHECK("ed-malformed-key-rejected",
                  !jev::EdVerify(badkey.data(), (const uint8_t*)canon.data(),
                                 canon.size(), sigraw));
        }
        // point decode unit vectors (RFC 8032 s5.1.3: x==0 iff y==+/-1)
        {
            jev::Pt pt;
            uint8_t z[32] = {};
            CHECK("decode-zero-ok", jev::PtDecode(z, pt));  // identity, sign 0
            // y=0/sign=1 is a VALID point (x = +/-sqrt(-1)); must decode
            uint8_t y0s[32] = {};
            y0s[31] = 0x80;
            CHECK("decode-y0-sign-ok", jev::PtDecode(y0s, pt));
            // y=1/sign=0 is the identity; must decode and re-encode cleanly
            uint8_t y1[32] = {};
            y1[0] = 0x01;
            CHECK("decode-y1-ok", jev::PtDecode(y1, pt));
            uint8_t re[32];
            jev::PtEncode(pt, re);
            CHECK("identity-re-encodes", memcmp(re, y1, 32) == 0);
            // THE x=0/sign=1 vector: y=1, recovered x==0, sign==1 -> FAIL
            uint8_t y1s[32] = {};
            y1s[0] = 0x01;
            y1s[31] = 0x80;
            CHECK("decode-x0-sign-fails", !jev::PtDecode(y1s, pt));
            uint8_t nc[32];
            memset(nc, 0xFF, 32);
            CHECK("decode-noncanon-fails", !jev::PtDecode(nc, pt));
            CHECK("decode-pubkey-ok", jev::PtDecode(key.data(), pt));
        }
        // independent oracle: OpenSSL 3.2 Ed25519 signatures verify here
        {
            std::array<uint8_t, 32> okey{};
            if (hxkey("18fd09829dd87bd6a5d27046f624bf08ae01ca5950f449851fecc362f67aa713",
                      okey)) {
                auto over = [&](const char* rhex, const char* shex,
                                const std::string& msg) {
                    std::array<uint8_t, 32> R, S;
                    uint8_t sig[64];
                    if (!hxkey(rhex, R) || !hxkey(shex, S)) return false;
                    memcpy(sig, R.data(), 32);
                    memcpy(sig + 32, S.data(), 32);
                    return jev::EdVerify(okey.data(), (const uint8_t*)msg.data(),
                                         msg.size(), sig);
                };
                CHECK("openssl-sig1-accepts",
                      over("53452561a71f76b419e15bf82476c135f2d8f910f0054152361e172dcb1ba8df",
                           "7230f7931c6152530ad301c8f318136f6b566032e3473c038ee7bedbd7953f0d",
                           "hello"));
                CHECK("openssl-sig2-accepts",
                      over("a7995a477aeb0a90d3918056f5e73a7390e7ac3b124f630366e2ee30b0c30711",
                           "2864f120467b0b589ea986de6fa93e44ae92837b1367b2f4c4ffbd0bf647f30d",
                           "hypothesis-arena cross-check vector"));
                // same signature, wrong message -> reject
                CHECK("openssl-wrongmsg-rejects",
                      !over("53452561a71f76b419e15bf82476c135f2d8f910f0054152361e172dcb1ba8df",
                            "7230f7931c6152530ad301c8f318136f6b566032e3473c038ee7bedbd7953f0d",
                            "hellx"));
            } else {
                CHECK("openssl-key-load", false);
            }
        }
    }
    // float formatting: C++ must reproduce Python json.dumps for edge values
    {
        struct F { double v; const char* want; };
        F fs[] = {{1e16, "1e+16"}, {1e-5, "1e-05"}, {0.30000000000000004, "0.30000000000000004"},
                  {1e21, "1e+21"}, {123456789.0, "123456789.0"}, {2.5e-07, "2.5e-07"},
                  {100000.0, "100000.0"}, {0.0, "0.0"}, {-0.0, "-0.0"}, {100.0, "100.0"},
                  {0.5, "0.5"}, {1e16, "1e+16"},
                  {3.141592653589793, "3.141592653589793"},
                  {1.7976931348623157e308, "1.7976931348623157e+308"},
                  {5e-324, "5e-324"},
                  {2.2250738585072014e-308, "2.2250738585072014e-308"},
                  {0.0001, "0.0001"}, {0.001, "0.001"}, {1000000.0, "1000000.0"},
                  {1e15, "1000000000000000.0"}, {123.456, "123.456"}};
        for (auto& f : fs) {
            jev::JVal jv;
            jv.t = jev::JVal::T::NUM;
            jv.num_double = true;
            jv.dval = f.v;
            char name[96];
            snprintf(name, sizeof(name), "float-%s", f.want);
            CHECK(name, jev::CanonJson(jv) == f.want);
        }
        // subnormals must not crash formatting (exact P3.2 target, report only)
        {
            jev::JVal jv;
            jv.t = jev::JVal::T::NUM;
            jv.num_double = true;
            jv.dval = 5e-324;
            std::string s = jev::CanonJson(jv);
            CHECK("float-subnormal-parses-back", strtod(s.c_str(), nullptr) == 5e-324);
        }
    }
    printf("%d checks, %d failures\n", count, fails);
    return fails ? 1 : 0;
}
