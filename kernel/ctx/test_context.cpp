// Snapshot validation, canonical
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
    s.var_corr_flags = 0;
    s.equity_ud = 100000000000LL;
    s.exposure_ud = 0;
    s.buying_power_ud = 400000000000LL;
    s.pending_count = 0;
    s.feature_bundle_id = 42;
    s.feature_bundle_hash = std::string(64, 'a');
    ctx::SourceStatus src;
    src.name = "edgar";
    src.state = "healthy";
    s.sources.push_back(src);
    s.stage = "PAPER";
    s.research_revision = 7;
    s.present_mask = 0x3FFu;
    return s;
}

static ctx::Snapshot Bare() { return ctx::Snapshot(); }

int main(int argc, char** argv) {
    using namespace ctx;
    const char* vec_dir = argc > 1 ? argv[1] : nullptr;
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
    // 3b. bidirectional mask coherence: every bit set-valid,
    // set-empty rejection, clear-nondefault (ghost) rejection.
    // Full() with all 12 bits set is valid (test 1 proves it).
    {
        Snapshot empty;
        Check(ValidateSnapshot(empty) == "", "mask-all-clear-valid");
    }
    {
        Snapshot s;  // ghost marks
        Mark m;
        m.symbol = "AAPL";
        m.mark_ud = m.bid_ud = m.ask_ud = 1;
        s.marks.push_back(m);
        Check(ValidateSnapshot(s) == "marks-ghost", "ghost-marks");
    }
    {
        Snapshot s;
        s.session = "open";
        Check(ValidateSnapshot(s) == "session-ghost", "ghost-session");
    }
    {
        Snapshot s;
        SymInd in;
        in.symbol = "AAPL";
        in.vwap_ud = 1;
        s.indicators.push_back(in);
        Check(ValidateSnapshot(s) == "indicators-ghost",
              "ghost-indicators");
    }
    {
        Snapshot s;
        s.regime = "trend";
        Check(ValidateSnapshot(s) == "regime-ghost", "ghost-regime");
    }
    // the source-state vocabulary is fixed; other spellings are rejected,
    // never mapped.
    {
        Snapshot s = Full();
        s.sources[0].state = "fresh";
        Check(ValidateSnapshot(s) == "source-row", "source-no-fresh");
    }
    {
        Snapshot s = Full();
        s.sources[0].state = "absent";
        Check(ValidateSnapshot(s) == "source-row", "source-no-absent");
    }
    {
        Snapshot s = Full();
        s.sources[0].state = "invalid";
        Check(ValidateSnapshot(s) == "source-row", "source-no-invalid");
    }
    {
        // every source state validates
        const char* states[] = {"healthy", "stale", "failed",
                                "not_scheduled", "unavailable", "na"};
        bool ok = true;
        for (int i = 0; i < 6; ++i) {
            Snapshot s = Full();
            s.sources[0].state = states[i];
            if (ValidateSnapshot(s) != "") ok = false;
        }
        Check(ok, "source-all-six");
    }
    {
        Snapshot s;
        s.var_corr_flags = 1;
        Check(ValidateSnapshot(s) == "varcorr-ghost", "ghost-varcorr");
    }
    {
        Snapshot s;
        s.equity_ud = 100;
        Check(ValidateSnapshot(s) == "portfolio-ghost",
              "ghost-portfolio");
    }
    {
        Snapshot s;
        s.feature_bundle_id = 9;
        s.feature_bundle_hash = std::string(64, 'b');
        Check(ValidateSnapshot(s) == "features-ghost",
              "ghost-features");
    }
    {
        Snapshot s;
        SourceStatus src;
        src.name = "edgar";
        src.state = "healthy";
        s.sources.push_back(src);
        Check(ValidateSnapshot(s) == "sources-ghost",
              "ghost-sources");
    }
    {
        Snapshot s;
        s.stage = "PAPER";
        Check(ValidateSnapshot(s) == "stage-ghost", "ghost-stage");
    }
    {
        Snapshot s;
        s.research_revision = 3;
        Check(ValidateSnapshot(s) == "research-ghost",
              "ghost-research");
    }
    // set-but-empty rejections for every section whose empty state is
    // distinct from a valid zero (8 of 10; the 2 pure-integer sections
    // below have no such distinction by design). Bare()+solo-bit
    // proves the failure is the target section, not a ghost elsewhere.
    {
        Snapshot s = Bare();
        s.present_mask = kMarks;
        Check(ValidateSnapshot(s) == "marks-incoherent",
              "set-empty-marks");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kSession;
        Check(ValidateSnapshot(s) == "session-incoherent",
              "set-empty-session");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kIndicators;
        Check(ValidateSnapshot(s) == "indicators-incoherent",
              "set-empty-indicators");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kRegime;
        Check(ValidateSnapshot(s) == "regime-incoherent",
              "set-empty-regime");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kFeatures;
        Check(ValidateSnapshot(s) == "features-incoherent",
              "set-empty-features");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kSources;
        Check(ValidateSnapshot(s) == "sources-incoherent",
              "set-empty-sources");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kStage;
        Check(ValidateSnapshot(s) == "stage-incoherent",
              "set-empty-stage");
    }
    {
        Snapshot s = Bare();
        s.present_mask = kResearch;
        Check(ValidateSnapshot(s) == "research-incoherent",
              "set-empty-research");
    }
    // The 2 pure-integer sections: all-zero is both the empty state
    // and a legitimate present value, so set+zero is VALID (solo-bit
    // masks prove no ghost trip either).
    {
        Snapshot s;
        s.present_mask = kVarCorr;
        Check(ValidateSnapshot(s) == "", "set-zero-varcorr");
        s.var_corr_flags = 0x3u;
        Check(ValidateSnapshot(s) == "", "set-docbits-varcorr");
    }
    {
        Snapshot s;
        s.present_mask = kPortfolio;
        Check(ValidateSnapshot(s) == "", "set-zero-portfolio");
        s.equity_ud = 500;
        Check(ValidateSnapshot(s) == "", "set-nonzero-portfolio");
    }
    // legitimate present zeros stay valid: flat book, zero flags.
    {
        Snapshot s = Full();
        s.exposure_ud = 0;
        s.pending_count = 0;
        s.var_corr_flags = 0;
        Check(ValidateSnapshot(s) == "", "present-zeros-valid");
    }
    // 3c. duplicates rejected (no discriminator exists)
    {
        Snapshot s = Full();
        s.marks.push_back(s.marks[0]);
        Check(ValidateSnapshot(s) == "mark-duplicate", "dup-mark");
    }
    {
        Snapshot s = Full();
        s.indicators.push_back(s.indicators[0]);
        Check(ValidateSnapshot(s) == "ind-duplicate", "dup-ind");
    }
    {
        Snapshot s = Full();
        s.sources.push_back(s.sources[0]);
        Check(ValidateSnapshot(s) == "source-duplicate", "dup-source");
    }
    // 3d. uppercase feature hash rejected (contract)
    {
        Snapshot s = Full();
        s.feature_bundle_hash = std::string(64, 'A');
        Check(ValidateSnapshot(s) == "features-incoherent",
              "hash-upper");
    }
    // 3e. reserved var/corr bits rejected
    {
        Snapshot s = Full();
        s.var_corr_flags = 0xFFFFFFFCu;
        Check(ValidateSnapshot(s) == "varcorr-reserved",
              "varcorr-reserved");
        Snapshot t = Full();
        t.var_corr_flags = 0x3u;
        Check(ValidateSnapshot(t) == "", "varcorr-docbits-valid");
    }
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
        a.pending_count += 1;
        Snapshot b = Full();
        b.present_mask &= ~kResearch;
        Snapshot c = Full();
        c.sources[0].state = "stale";
        Check(ContextHash(a) != h0, "mut-pending");
        Check(ContextHash(b) != h0, "mut-mask");
        Check(ContextHash(c) != h0, "mut-source");
    }
    // 6. golden canonical bytes (pins the fixed recipe)
    std::string canon0 = CanonicalSnapshot(Full());
    Check(canon0.size() <= 4096, "canonical-bounded");
    {
        std::string canon = CanonicalSnapshot(Full());
        Check(canon ==
                  "{\"buying_power_ud\":400000000000,"
                  "\"equity_ud\":100000000000,"
                  "\"exposure_ud\":0,\"features\":{\"bundle_hash\":\"" +
                  std::string(64, 'a') +
                  "\",\"bundle_id\":42},\"indicators\":[{\"atr_d6\":"
                  "2500000,\"rsi_d6\":55000000,\"symbol\":\"AAPL\","
                  "\"vwap_ud\":337000000,\"z_d6\":1200000}],\"marks\":[{"
                  "\"ask_ud\":337220000,\"bid_ud\":337120000,\"mark_ud\":"
                  "337220000,\"symbol\":\"AAPL\"}],\"pending_count\":0,"
                  "\"present_mask\":1023,\"regime\":\"trend\","
                  "\"research_revision\":7,\"session\":\"open\",\"sources\":[{\"name\":"
                  "\"edgar\",\"state\":\"healthy\"}],\"stage\":\"PAPER\","
                  "\"var_corr_flags\":0}",
              "golden-canonical");
    }
    // 7. settlement section.
    {
        Snapshot base = Full();
        Snapshot v2 = Full();
        v2.present_mask |= kSettlement;
        v2.settled_cash_ud = 25000000000LL;
        v2.unsettled_ud = 75000000000LL;
        v2.next_settle_day = 20726;
        Check(ValidateSnapshot(v2) == "", "settlement-valid");
        Check(CanonicalSnapshot(base) == canon0, "base-bytes-unchanged");
        Check(ContextHash(base) != ContextHash(v2), "settlement-changes-hash");
        std::string h = ContextHash(v2);
        bool stable = true;
        for (int i = 0; i < 10000 && stable; ++i) stable = ContextHash(v2) == h;
        Check(stable, "settlement-hash-stable-10k");
        Snapshot m = v2;
        m.settled_cash_ud += 1;
        Check(ContextHash(m) != h, "settlement-mut-settled");
        m = v2;
        m.unsettled_ud += 1;
        Check(ContextHash(m) != h, "settlement-mut-unsettled");
        m = v2;
        m.next_settle_day += 1;
        Check(ContextHash(m) != h, "settlement-mut-day");
        Check(CanonicalSnapshot(v2).size() <= 4096, "settlement-bounded");
        m = base;
        m.settled_cash_ud = 5;
        Check(ValidateSnapshot(m) == "settlement-ghost", "settlement-ghost-check");
        m = v2;
        m.settled_cash_ud = -1;
        Check(ValidateSnapshot(m) == "settlement-negative", "settlement-negative-check");
        m = v2;
        m.next_settle_day = 0;
        Check(ValidateSnapshot(m) == "settlement-incoherent", "settlement-pending-needs-day");
        m = v2;
        m.unsettled_ud = 0;
        Check(ValidateSnapshot(m) == "settlement-incoherent", "settlement-day-needs-pending");
        m = v2;
        m.unsettled_ud = 0;
        m.next_settle_day = 0;
        Check(ValidateSnapshot(m) == "", "settlement-all-settled-ok");
        Check(CanonicalSnapshot(v2).find(",\"settlement\":{\"next_settle_day\":"
                                         "20726,\"settled_cash_ud\":25000000000,"
                                         "\"unsettled_ud\":75000000000},"
                                         "\"sources\"") !=
                  std::string::npos,
              "settlement-golden-fragment");
        if (vec_dir) {
            auto slurp = [&](const char* name) {
                std::string txt;
                std::FILE* f = std::fopen((std::string(vec_dir) + "/" + name).c_str(), "rb");
                char b[8192];
                size_t n;
                while (f && (n = std::fread(b, 1, sizeof(b), f)) > 0) txt.append(b, n);
                if (f) std::fclose(f);
                while (!txt.empty() && (txt.back() == '\n' || txt.back() == '\r')) txt.pop_back();
                return txt;
            };
            std::string hex = slurp("snapshot_canonical.hex"), bytes;
            for (size_t i = 0; i + 1 < hex.size(); i += 2)
                bytes.push_back((char)std::stoi(hex.substr(i, 2), nullptr, 16));
            Check(!bytes.empty() && bytes == CanonicalSnapshot(v2), "settlement-vector-canonical");
            Check(slurp("snapshot_context_hash.txt") == h, "settlement-vector-hash");
        }
    }
    if (g_fail == 0) std::printf("CONTEXT SUITE: ALL PASS\n");
    return g_fail ? 1 : 0;
}
