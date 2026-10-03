// candidates.jsonl gate suite: shape, CID recompute, strategy,
// allowlist, freshness, side policy. Records are built with the same
// pipe-join recipe research/strategy/candidate_wire.py hashes.
#include <cstdio>
#include <string>

#include "../wire.hpp"
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

using namespace kernel;
using namespace kernel::ingest;

static const int64_t NOW = 1800000000000000000LL;
static const char* PX[3] = {nullptr, nullptr, nullptr};
static const char* BASE[11] = {"etf_trend", "VTI", "", "BUY", "250.5",
                            "230.0", "999.0", "0", "exit_trend", "costs", "1"};

static std::string Rec(std::string ts, std::string side = "BUY",
                       std::string strategy = "etf_trend",
                       std::string sym = "VTI", std::string schema = "candidate",
                       bool badcid = false, std::string extra = "") {
    std::string f[11];
    for (int i = 0; i < 11; i++) f[i] = BASE[i];
    f[0] = strategy; f[1] = sym; f[2] = ts; f[3] = side;
    if (side == "SELL") { f[5] = "999.0"; f[6] = "100.0"; }
    for (int k = 0; k < 3; k++)
        if (PX[k]) f[4 + k] = PX[k];
    std::string joined;
    static const char* K[11] = {"strategy_id","symbol","snapshot_ts_ns","side",
        "entry_px","stop_px","tp_px","time_exit_ns","exit_rule","cost_model",
        "feature_revision"};
    std::string cand;
    for (int i = 0; i < 11; i++) {
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

int main(int argc, char** argv) {
    CandidateTables t;
    t.strategies.push_back({"etf_trend", 3600});
    t.allowlist = {"VTI", "VEU", "SPY"};
    t.held = {"VEU"};
    std::string fresh = std::to_string(NOW - 60LL * 1000000000LL);

    CandOutcome o = Run(Rec(fresh), t);
    CHECK("prices-parsed", Run(Rec(fresh), t).entry_cents == 25050 &&
                               Run(Rec(fresh), t).stop_cents == 23000 &&
                               Run(Rec(fresh), t).tp_cents == 99900);
    CHECK("valid-buy", o.accepted && o.side == "BUY" && o.symbol == "VTI" &&
                           o.cid.size() == 64);
    CHECK("cid-mismatch", Run(Rec(fresh, "BUY", "etf_trend", "VTI", "candidate",
                                  true), t).code == CandReject::CID);
    CHECK("schema", Run(Rec(fresh, "BUY", "etf_trend", "VTI", "other"), t)
                            .code == CandReject::SCHEMA);
    CHECK("strategy", Run(Rec(fresh, "BUY", "rogue"), t).code ==
                        CandReject::STRATEGY);
    CHECK("allowlist", Run(Rec(fresh, "BUY", "etf_trend", "TSLA"), t).code ==
                           CandReject::ALLOWLIST);
    CHECK("stale", Run(Rec(std::to_string(NOW - 3601LL * 1000000000LL)), t)
                       .code == CandReject::FRESHNESS);
    CHECK("window-edge", Run(Rec(std::to_string(NOW - 3600LL * 1000000000LL)),
                             t).accepted);
    CHECK("small-skew-accepted",
          Run(Rec(std::to_string(NOW + 60LL * 1000000000LL)), t).accepted);
    CHECK("future", Run(Rec(std::to_string(NOW + 121LL * 1000000000LL)), t)
                            .code == CandReject::FRESHNESS);
    CHECK("sell-unheld", Run(Rec(fresh, "SELL"), t).code == CandReject::SIDE);
    CHECK("sell-held", Run(Rec(fresh, "SELL", "etf_trend", "VEU"), t)
                           .accepted);
    CHECK("side-other", Run(Rec(fresh, "SHORT"), t).code == CandReject::SIDE);
    CHECK("extra-key", Run(Rec(fresh, "BUY", "etf_trend", "VTI", "candidate",
                               false, ",\"x\":\"1\""), t).code ==
                           CandReject::SHAPE);
    CHECK("pipe-in-field", Run(Rec(fresh, "BUY", "etf|trend"), t).code ==
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
    PX[1] = "999.0"; PX[2] = "100.0";   // SELL ordering: tp < entry < stop
    CHECK("sell-ordering-ok", Run(Rec(fresh, "SELL", "etf_trend", "VEU"), t).accepted);
    PX[1] = "230.0"; PX[2] = "999.0";
    CHECK("sell-wrong-ordering", Run(Rec(fresh, "SELL", "etf_trend", "VEU"), t).code == CandReject::SHAPE);
    PX[0] = PX[1] = PX[2] = nullptr;
    CHECK("bad-ts", Run(Rec("-5"), t).code == CandReject::SHAPE);
    CHECK("ts-leading-zero", Run(Rec("0123"), t).code == CandReject::SHAPE);
    CHECK("not-object", Run("[1]", t).code == CandReject::SHAPE);
    CHECK("empty-tables", Run(Rec(fresh), CandidateTables{}).code ==
                              CandReject::STRATEGY);
    CandidateTables z = t;
    z.strategies[0].window_s = 0;
    CHECK("zero-window", Run(Rec(fresh), z).code == CandReject::STRATEGY);
    if (argc == 2) {
        // Lines written by research/strategy/candidate_wire.py must be
        // judged exactly as intended (cross-language CID and price grammar).
        FILE* f = fopen((std::string(argv[1]) + "/candidate_wire.jsonl").c_str(), "rb");
        std::string all;
        char buf[4096];
        size_t n;
        while (f && (n = fread(buf, 1, sizeof buf, f)) > 0) all.append(buf, n);
        if (f) fclose(f);
        CandidateTables vt;
        vt.strategies.push_back({"etf_trend", 3600});
        vt.allowlist = {"VTI"};
        CandReject want[5] = {CandReject::OK, CandReject::CID,
                              CandReject::FRESHNESS, CandReject::STRATEGY,
                              CandReject::ALLOWLIST};
        size_t at = 0;
        int k = 0;
        for (; k < 5; ++k) {
            size_t nl = all.find('\n', at);
            if (nl == std::string::npos) break;
            CandOutcome o = Run(all.substr(at, nl - at), vt, NOW);
            at = nl + 1;
            CHECK("python-vector", o.code == want[k]);
            if (k == 0)
                CHECK("python-vector-prices", o.accepted &&
                                                  o.entry_cents == 25050 &&
                                                  o.stop_cents == 23000 &&
                                                  o.tp_cents == 99900);
        }
        CHECK("python-vector-count", k == 5);
    }
    printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
