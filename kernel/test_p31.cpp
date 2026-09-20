// P3.1 acceptance suite. Every check maps to the authorization bar:
// 21 checks exercised, canonical artifact accepted, malformed classes
// rejected, tamper/wrong-key/state-mutation/expiry/bool/NaN/pins covered,
// typed object produced, no raw-JSON downstream (see build.sh grep gate).
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
    std::string dkey = fx("decision_key.txt");
    double created = atof(fx("created_unix.txt").c_str());

    auto req = [&](const std::string& raw, jev::Mode m, double now) {
        jev::ValidationRequest q;
        q.raw_json = raw;
        q.trusted_key = key;
        q.state_canon_json = state_canon;
        q.expected_decision_key = dkey;
        q.now_unix = now;
        q.mode = m;
        return q;
    };
    double fresh = created + 10.0;

    // 2. positive canonical artifact accepted; 13. typed object produced
    {
        jev::ValidationResult r = jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, fresh));
        CHECK("valid-live-ok", r.ok && r.reason == "ok");
        CHECK("typed-symbol", r.value.symbol() == "EURUSD");
        CHECK("typed-epoch", r.value.snapshot_epoch() == 7);
        CHECK("typed-enter", r.value.enter() == 0.9);
        CHECK("typed-latent", r.value.latent_risk() == 0.1);
        CHECK("typed-family", r.value.family() == jev::EdgeFamily::MOMENTUM);
        CHECK("typed-conviction", r.value.conviction() == jev::Conviction::STRONG);
        CHECK("typed-hashes",
              r.value.state_hash() == jev::Sha256Hex(state_canon) &&
              r.value.decision_key() == dkey);
    }
    // 1+3. every malformed class rejected with its own reason
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
        {"bad_expires_window.json", "expires-window"},
        {"bad_answers_extra.json", "answers-keys"},
        {"bad_enter_bool.json", "enter-shape"},
        {"bad_enter_range.json", "enter-shape"},
        {"bad_enter_nan.json", "parse-error"},
        {"bad_family.json", "family-shape"},
        {"bad_conviction.json", "conviction-shape"},
        {"bad_response_hash.json", "response-hash-mismatch"},
        {"bad_sig.json", "signature-invalid"},
    };
    for (auto& c : cases) {
        jev::ValidationResult r = jev::validate_jev(req(fx(c.file), jev::Mode::LIVE, fresh));
        char name[128];
        snprintf(name, sizeof(name), "reject-%s", c.file);
        CHECK(name, !r.ok && r.reason == c.reason);
    }
    // parse-level
    {
        jev::ValidationResult r = jev::validate_jev(req("{truncated", jev::Mode::LIVE, fresh));
        CHECK("reject-truncated", !r.ok && r.reason == "parse-error");
        r = jev::validate_jev(req("[1,2]", jev::Mode::LIVE, fresh));
        CHECK("reject-nonobject", !r.ok && r.reason == "parse-error");
    }
    // 5. wrong trusted key rejected
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.trusted_key.fill(0xAB);
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-wrong-key", !r.ok && r.reason == "signature-invalid");
    }
    // 6. artifact-carried key cannot substitute for configured trust
    {
        jev::ValidationResult r =
            jev::validate_jev(req(fx("pubkey_mutated.json"), jev::Mode::LIVE, fresh));
        CHECK("artifact-key-ignored", r.ok);
    }
    // 7+8. state / decision-key mutation rejected
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.state_canon_json = "{\"tampered\":true}";
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-state-mutation", !r.ok && r.reason == "state-binding");
    }
    {
        jev::ValidationRequest q = req(fx("valid.json"), jev::Mode::LIVE, fresh);
        q.expected_decision_key = std::string(64, '0');
        jev::ValidationResult r = jev::validate_jev(q);
        CHECK("reject-dkey-mutation", !r.ok && r.reason == "decision-binding");
    }
    // 9. expiry differs between LIVE and REPLAY
    {
        double expired_now = created + 600.0;
        jev::ValidationResult r =
            jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, expired_now));
        CHECK("live-expired-hold", !r.ok && r.reason == "expired");
        r = jev::validate_jev(req(fx("valid.json"), jev::Mode::REPLAY, expired_now));
        CHECK("replay-expired-ok", r.ok);
        // future-created artifact is not-yet-valid live, fine in replay
        jev::ValidationResult r2 =
            jev::validate_jev(req(fx("valid.json"), jev::Mode::LIVE, created - 1000.0));
        CHECK("live-future-hold", !r2.ok && r2.reason == "not-yet-valid");
    }
    printf("%d checks, %d failures\n", count, fails);
    return fails ? 1 : 0;
}
