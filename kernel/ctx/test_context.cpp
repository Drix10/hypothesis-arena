// Slice G gate [correctness]: frozen Snapshot validation, canonical
// determinism (10k identical -> 1 hash), mutation sensitivity, golden
// canonical bytes. Usage: ./test_context
#include <cstdio>
#include <string>

#include "snapshot.hpp"

static int g_fail = 0;

static void Check(bool cond, const char* name) {
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

static ctx::Snapshot Full() {
    ctx::Snapshot s;
    ctx::Mark m;
    m.symbol = "AAPL";
    m.mark_ud = 337220000LL;
    m.bid_ud = 337120000LL;
    m.ask_ud = 337220000LL;
    s.marks.push_back(m);
    s.session = "open";
    ctx::SymInd in;
    in.symbol = "AAPL";
    in.rsi_d6 = 55000000LL;
    in.z_d6 = 1200000LL;
    in.vwap_ud = 337000000LL;
    in.atr_d6 = 2500000LL;
    s.indicators.push_back(in);
    s.regime = "trend";
    s.sentiment_d6[0] = 100000LL;
    s.var_corr_flags = 0;
    s.equity_ud = 100000000000LL;
    s.exposure_ud = 0;
    s.buying_power_ud = 400000000000LL;
    s.pending_count = 0;
    s.feature_bundle_id = 42;
    s.feature_bundle_hash = std::string(64, 'a');
    ctx::SourceStatus src;
    src.name = "edgar";
    src.state = "fresh";
    s.sources.push_back(src);
    s.stage = "G0_PAPER";
    s.research_revision = 7;
    s.calib = "pass";
    s.brier_d6 = 210000LL;
    s.present_mask = 0xFFFu;
    return s;
}

int main() {
    using namespace ctx;
    // 1. full snapshot validates
    Check(ValidateSnapshot(Full()) == "", "valid-full");
    // 2. empty snapshot validates (nothing claimed, nothing incoherent)
    Check(ValidateSnapshot(Snapshot()) == "", "valid-empty");
    // 3. bound + vocab rejections
    {
        Snapshot s = Full();
        s.marks.push_back(s.marks[0]);
        s.marks.push_back(s.marks[0]);
        s.marks.push_back(s.marks[0]);
        s.marks.push_back(s.marks[0]);
        s.marks.push_back(s.marks[0]);
        Check(ValidateSnapshot(s) == "marks-bound", "marks-bound");
    }
    {
        Snapshot s = Full();
        s.regime = "moon";
        Check(ValidateSnapshot(s) == "regime", "regime-vocab");
    }
    {
        Snapshot s = Full();
        s.stage = "G9_MOON";
        Check(ValidateSnapshot(s) == "stage", "stage-vocab");
    }
    {
        Snapshot s = Full();
        s.marks[0].symbol = "aapl";
        Check(ValidateSnapshot(s) == "mark-symbol", "symbol-charset");
    }
    {
        Snapshot s = Full();
        s.marks[0].ask_ud = s.marks[0].bid_ud - 1;
        Check(ValidateSnapshot(s) == "mark-quote", "crossed-quote");
    }
    {
        Snapshot s = Full();
        s.sources[0].state = "maybe";
        Check(ValidateSnapshot(s) == "source-row", "source-state");
    }
    {
        Snapshot s = Full();
        s.present_mask |= (1u << 12);
        Check(ValidateSnapshot(s) == "mask-reserved", "mask-reserved");
    }
    {
        Snapshot s = Full();
        s.present_mask = kMarks;
        s.marks.clear();
        Check(ValidateSnapshot(s) == "marks-incoherent",
              "mask-incoherent");
    }
    {
        Snapshot s = Full();
        s.feature_bundle_hash = "xyz";
        Check(ValidateSnapshot(s) == "features-incoherent",
              "bundle-hash");
    }
    // 4. 10k identical inputs -> 1 hash
    {
        std::string h0 = ContextHash(Full());
        bool same = true;
        for (int i = 0; i < 10000; ++i) {
            if (ContextHash(Full()) != h0) {
                same = false;
                break;
            }
        }
        Check(same && h0.size() == 64, "hash-10k-deterministic");
        std::printf("INFO context_hash=%s\n", h0.c_str());
    }
    // 5. mutation sensitivity: one field flip changes the hash
    {
        std::string h0 = ContextHash(Full());
        Snapshot a = Full();
        a.brier_d6 += 1;
        Snapshot b = Full();
        b.present_mask &= ~kCalib;
        Snapshot c = Full();
        c.sources[0].state = "stale";
        Check(ContextHash(a) != h0, "mut-brier");
        Check(ContextHash(b) != h0, "mut-mask");
        Check(ContextHash(c) != h0, "mut-source");
    }
    // 6. golden canonical bytes (pins the frozen recipe)
    {
        std::string canon = CanonicalSnapshot(Full());
        Check(canon ==
                  "{\"brier_d6\":210000,\"buying_power_ud\":400000000000,"
                  "\"calib\":\"pass\",\"equity_ud\":100000000000,"
                  "\"exposure_ud\":0,\"features\":{\"bundle_hash\":\"" +
                  std::string(64, 'a') +
                  "\",\"bundle_id\":42},\"indicators\":[{\"atr_d6\":"
                  "2500000,\"rsi_d6\":55000000,\"symbol\":\"AAPL\","
                  "\"vwap_ud\":337000000,\"z_d6\":1200000}],\"marks\":[{"
                  "\"ask_ud\":337220000,\"bid_ud\":337120000,\"mark_ud\":"
                  "337220000,\"symbol\":\"AAPL\"}],\"pending_count\":0,"
                  "\"present_mask\":4095,\"regime\":\"trend\","
                  "\"research_revision\":7,\"sentiment_d6\":[100000,0,0,"
                  "0],\"session\":\"open\",\"sources\":[{\"name\":"
                  "\"edgar\",\"state\":\"fresh\"}],\"stage\":\"G0_PAPER\","
                  "\"var_corr_flags\":0}",
              "golden-canonical");
    }
    if (g_fail == 0) std::printf("CONTEXT SUITE: ALL PASS\n");
    return g_fail ? 1 : 0;
}
