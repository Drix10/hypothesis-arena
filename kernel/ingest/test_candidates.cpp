// K6 — candidates.jsonl gate suite: c1 shape, CID recompute, sleeve,
// allowlist, freshness, side policy. Records are built with the same
// pipe-join recipe research/strategy/candidate.py hashes.
#include <cstdio>
#include <string>

#include "../jev_validate.hpp"
#include "candidates.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        count++;                       \
        if (!(expr)) {                 \
            printf("FAIL %s\n", name); \
            fails++;                   \
        }                              \
    } while (0)

using namespace jev;
using namespace jev::ingest;

static const int64_t NOW = 1800000000000000000LL;
static const char* PX[3] = {nullptr, nullptr, nullptr};
static const char* BASE[12] = {"trend_etf_v1", "VTI", "", "BUY", "trend",
                            "250.5", "230.0", "999.0", "0",
                            "exit_trend_v1", "cost_v2", "f1"};

static std::string Rec(std::string ts, std::string side = "BUY",
                       std::string sleeve = "trend_etf_v1",
                       std::string sym = "VTI", std::string schema = "c1",
                       bool badcid = false, std::string extra = "") {
    std::string f[12];
    for (int i = 0; i < 12; i++) f[i] = BASE[i];
    f[0] = sleeve; f[1] = sym; f[2] = ts; f[3] = side;
    for (int k = 0; k < 3; k++)
        if (PX[k]) f[5 + k] = PX[k];
    std::string joined;
    static const char* K[12] = {"strategy_version","symbol","snapshot_ts_ns",
        "proposed_side","proposed_family","entry_px","stop_px","tp_px",
        "time_exit_ns","exit_profile_version","cost_model_version",
        "feature_revision"};
    std::string cand;
    for (int i = 0; i < 12; i++) {
        if (i) joined += "|";
        joined += f[i];
        cand += std::string("\"") + K[i] + "\":\"" + f[i] + "\",";
    }
    std::string cid = Sha256Hex(joined);
    if (badcid) cid[0] = cid[0] == 'a' ? 'b' : 'a';
    cand += "\"cid\":\"" + cid + "\"";
    return "{\"schema\":\"" + schema + "\",\"created_ns\":\"5\"" + extra +
           ",\"candidate\":{" + cand + "}}";
}
static CandOutcome Run(const std::string& line, const CandidateTables& t,
                       int64_t now = NOW) {
    JVal v;
    std::string err;
    if (!ParseJson(line, v, err)) {
        CandOutcome o;
        o.code = CandReject::SHAPE;
        return o;
    }
    return ValidateCandidate(v, t, now);
}

int main() {
    CandidateTables t;
    t.sleeves.push_back({"trend_etf_v1", 3600});
    t.allowlist = {"VTI", "VEU", "SPY"};
    t.held = {"VEU"};
    std::string fresh = std::to_string(NOW - 60LL * 1000000000LL);

    CandOutcome o = Run(Rec(fresh), t);
    CHECK("prices-parsed", Run(Rec(fresh), t).entry_cents == 25050 &&
                               Run(Rec(fresh), t).stop_cents == 23000 &&
                               Run(Rec(fresh), t).tp_cents == 99900);
    CHECK("valid-buy", o.accepted && o.side == "BUY" && o.symbol == "VTI" &&
                           o.cid.size() == 64);
    CHECK("cid-mismatch", Run(Rec(fresh, "BUY", "trend_etf_v1", "VTI", "c1",
                                  true), t).code == CandReject::CID);
    CHECK("schema", Run(Rec(fresh, "BUY", "trend_etf_v1", "VTI", "c2"), t)
                            .code == CandReject::SCHEMA);
    CHECK("sleeve", Run(Rec(fresh, "BUY", "rogue_v9"), t).code ==
                        CandReject::SLEEVE);
    CHECK("allowlist", Run(Rec(fresh, "BUY", "trend_etf_v1", "TSLA"), t).code ==
                           CandReject::ALLOWLIST);
    CHECK("stale", Run(Rec(std::to_string(NOW - 3601LL * 1000000000LL)), t)
                       .code == CandReject::FRESHNESS);
    CHECK("window-edge", Run(Rec(std::to_string(NOW - 3600LL * 1000000000LL)),
                             t).accepted);
    CHECK("future", Run(Rec(std::to_string(NOW + 1)), t).code ==
                        CandReject::FRESHNESS);
    CHECK("sell-unheld", Run(Rec(fresh, "SELL"), t).code == CandReject::SIDE);
    CHECK("sell-held", Run(Rec(fresh, "SELL", "trend_etf_v1", "VEU"), t)
                           .accepted);
    CHECK("side-other", Run(Rec(fresh, "SHORT"), t).code == CandReject::SIDE);
    CHECK("extra-key", Run(Rec(fresh, "BUY", "trend_etf_v1", "VTI", "c1",
                               false, ",\"x\":\"1\""), t).code ==
                           CandReject::SHAPE);
    CHECK("pipe-in-field", Run(Rec(fresh, "BUY", "trend|etf_v1"), t).code ==
                               CandReject::SHAPE);
    const char* bad[][3] = {{"250.555", "230.0", "999.0"}, {"1e3", "230.0", "999.0"},
                            {".5", "0.4", "9.0"}, {"05.00", "1.0", "9.0"},
                            {"250.", "230.0", "999.0"}, {"230.0", "230.0", "999.0"},
                            {"250.5", "230.0", "250.5"}, {"0", "0", "0"},
                            {"250.5", "-1", "999"}};
    for (auto& b : bad) {
        PX[0] = b[0]; PX[1] = b[1]; PX[2] = b[2];
        CHECK("bad-price", Run(Rec(fresh), t).code == CandReject::SHAPE);
    }
    PX[0] = PX[1] = PX[2] = nullptr;
    CHECK("bad-ts", Run(Rec("-5"), t).code == CandReject::SHAPE);
    CHECK("ts-leading-zero", Run(Rec("0123"), t).code == CandReject::SHAPE);
    CHECK("not-object", Run("[1]", t).code == CandReject::SHAPE);
    CHECK("empty-tables", Run(Rec(fresh), CandidateTables{}).code ==
                              CandReject::SLEEVE);
    CandidateTables z = t;
    z.sleeves[0].window_s = 0;
    CHECK("zero-window", Run(Rec(fresh), z).code == CandReject::SLEEVE);
    printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
