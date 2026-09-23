// Slice E gate [correctness]: STAGE chain verify, corruption fails to
// G0_PAPER. Usage: ./test_stage
#include <cstdio>
#include <string>
#include <vector>

#include "stage.hpp"
#include "../jev_validate.hpp"  // Sha256Hex for fixture construction

static int g_fail = 0;

static void Check(bool cond, const char* name) {
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

static std::string Make(const std::string& st, const std::string& by,
                        const std::string& at, const std::string& cap,
                        const std::string& prev = "GENESIS") {
    std::string attest = jev::Sha256Hex(st + "|" + by + "|" + at + "|" +
                                     cap + "|" + prev);
    return "stage: " + st + "\napproved_by: " + by + "\napproved_at: " +
           at + "\ncapital_usd: " + cap + "\nattest_hash: " + attest +
           "\n";
}

int main() {
    using stage::VerifyStageContents;
    // 1. valid G0 bootstrap
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", "2026-09-23T12:00:00Z", "0"),
            "GENESIS");
        Check(r.ok && r.effective == "G0_PAPER" && r.reason == "ok",
              "valid-g0");
    }
    // 2. all four stages verify when the chain is correct
    for (const char* st : {"G0_PAPER", "G1_TINY", "G2_SCALED",
                           "G3_FULL"}) {
        auto r = VerifyStageContents(
            Make(st, "op", "2026-09-23T12:00:00+00:00", "25000"),
            "GENESIS");
        Check(r.ok && r.effective == st, st);
    }
    // 3. tampered capital -> G0_PAPER chain-mismatch
    {
        std::string good = Make("G1_TINY", "op",
                                "2026-09-23T12:00:00Z", "25000");
        std::string bad = good;
        bad.replace(bad.find("25000"), 5, "99000");
        auto r = VerifyStageContents(bad, "GENESIS");
        Check(!r.ok && r.effective == "G0_PAPER" &&
                  r.reason == "chain-mismatch",
              "tampered-capital");
    }
    // 4. unknown stage value
    {
        auto r = VerifyStageContents(
            Make("G9_MOON", "op", "2026-09-23T12:00:00Z", "0"),
            "GENESIS");
        Check(!r.ok && r.reason == "unknown-stage", "unknown-stage");
    }
    // 5. missing field
    {
        std::string good = Make("G0_PAPER", "op",
                                "2026-09-23T12:00:00Z", "0");
        std::string cut =
            good.substr(0, good.find("capital_usd"));
        auto r = VerifyStageContents(cut, "GENESIS");
        Check(!r.ok && r.reason == "missing-field", "missing-field");
    }
    // 6. extra field
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", "2026-09-23T12:00:00Z", "0") +
                "promo: yes\n",
            "GENESIS");
        Check(!r.ok && r.reason == "unknown-or-duplicate-key",
              "extra-field");
    }
    // 7. duplicate key
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", "2026-09-23T12:00:00Z", "0") +
                "stage: G0_PAPER\n",
            "GENESIS");
        Check(!r.ok, "duplicate-key");
    }
    // 8. bad attest shape
    {
        std::string good = Make("G0_PAPER", "op",
                                "2026-09-23T12:00:00Z", "0");
        std::string bad = good;
        bad.replace(bad.find("attest_hash: ") + 13, 64,
                    std::string(64, 'z'));
        auto r = VerifyStageContents(bad, "GENESIS");
        Check(!r.ok && r.reason == "bad-attest-shape",
              "bad-attest-shape");
    }
    // 9. non-numeric / negative capital
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", "2026-09-23T12:00:00Z", "12x") +
                "",
            "GENESIS");
        // hash recomputed over "12x" would verify; capital check must
        // fire first.
        Check(!r.ok && r.reason == "bad-capital", "bad-capital-alpha");
        std::string neg = Make("G0_PAPER", "op",
                               "2026-09-23T12:00:00Z", "0", "GENESIS");
        neg.replace(neg.find("capital_usd: 0"), 14, "capital_usd: -5");
        auto r2 = VerifyStageContents(neg, "GENESIS");
        Check(!r2.ok && r2.reason == "bad-capital",
              "bad-capital-negative");
    }
    // 10. wrong predecessor
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", "2026-09-23T12:00:00Z", "0"),
            "NOTGENESIS");
        Check(!r.ok && r.reason == "chain-mismatch", "wrong-prev");
    }
    // 11. pipe in approved_by
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "a|b", "2026-09-23T12:00:00Z", "0"),
            "GENESIS");
        Check(!r.ok && r.reason == "bad-field", "pipe-in-field");
    }
    // 12. malformed timestamps
    for (const char* bad :
         {"2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z",
          "2026-09-23 12:00:00", "not-a-date", "2023-02-29T00:00:00Z",
          "2026-09-23T12:00:00+99:99", "2026-09-23T12:00:001234",
          "2026-09-23T12:00:00+1401", "2026-09-23T12:00:00-05:60",
          "2026-09-23T12:00:00+5:00", "2026-09-23T12:00:00++05:00",
          "2026-09-23T12:00:00+05-00", "2026-09-23T12:00:00Z+05:00"}) {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", bad, "0"), "GENESIS");
        Check(!r.ok && r.reason == "bad-field", bad);
    }
    // 12b. valid boundary offsets accepted
    for (const char* good :
         {"2026-09-23T12:00:00+14:00", "2026-09-23T12:00:00-05:00",
          "2026-09-23T12:00:00+0530", "2026-09-23T12:00:00Z",
          "2026-09-23T12:00:00"}) {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", good, "0"), "GENESIS");
        Check(r.ok, good);
    }
    // 13. leap day accepted
    {
        auto r = VerifyStageContents(
            Make("G0_PAPER", "op", "2024-02-29T00:00:00Z", "0"),
            "GENESIS");
        Check(r.ok, "leap-day");
    }
    // 14. re-read determinism: same bytes twice, same verdict
    {
        std::string good = Make("G0_PAPER", "op",
                                "2026-09-23T12:00:00Z", "0");
        auto a = VerifyStageContents(good, "GENESIS");
        auto b = VerifyStageContents(good, "GENESIS");
        Check(a.ok == b.ok && a.effective == b.effective &&
                  a.reason == b.reason,
              "re-read-determinism");
    }
    // 15. empty file
    {
        auto r = VerifyStageContents("", "GENESIS");
        Check(!r.ok && r.effective == "G0_PAPER", "empty-file");
    }
    if (g_fail == 0) std::printf("STAGE SUITE: ALL PASS\n");
    return g_fail ? 1 : 0;
}
