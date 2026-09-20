// P3.5 Slice C — runtime proof of the zero-malloc contract.
//
// The grep gate in build.sh is policy only: it cannot see allocations
// hidden behind helpers defined elsewhere (the U8() incident). This
// binary counts real malloc/calloc/realloc calls (linker --wrap) while
// the validation path runs: parse + canonicalize happen with counting
// OFF (caller-owned, allowed to allocate), then 65 retains (64 fill +
// 1 over-count drop), 100 rejects, and 10 lineage-combine accepts run
// with counting ON. Any heap allocation on the validation path fails.
//
// Link: -static-libstdc++ -static-libgcc so operator new resolves to
// the wrapped malloc; glibc-internal allocation stays uncounted.
#include <cstdio>
#include <cstring>

#include "../jev_validate.hpp"
#include "features.hpp"

extern "C" {
void* __real_malloc(size_t n);
void* __real_calloc(size_t a, size_t b);
void* __real_realloc(void* p, size_t n);
}
static bool g_counting = false;
static unsigned long g_allocs = 0;
extern "C" {
void* __wrap_malloc(size_t n) {
    if (g_counting) g_allocs++;
    return __real_malloc(n);
}
void* __wrap_calloc(size_t a, size_t b) {
    if (g_counting) g_allocs++;
    return __real_calloc(a, b);
}
void* __wrap_realloc(void* p, size_t n) {
    if (g_counting) g_allocs++;
    return __real_realloc(p, n);
}
}

using namespace jev;
using namespace jev::ingest;

static const int64_t SNAP = 1800000000000000000LL;
static const int64_t OBS = SNAP - 100LL * 1000000000LL;
static IngestState g_st;  // 256KB static: never a tick-stack local

static bool Parse(const std::string& json, JVal& v, std::string& canon) {
    std::string err;
    if (!ParseJson(json, v, err)) {
        printf("FAIL setup-parse: %s\n", err.c_str());
        return false;
    }
    canon = CanonJson(v);
    return true;
}

int main() {
    int fails = 0;
    char acc[2048];
    snprintf(acc, sizeof(acc),
             "{\"schema_version\":\"f2\",\"kind\":\"filing_event\","
             "\"symbols\":[\"AAPL\"],"
             "\"observed_at_ns\":%lld,\"ingested_at_ns\":%lld,"
             "\"ttl_s\":3600,"
             "\"value\":{\"type\":\"enum\",\"v\":\"8-K:item-2.02\"},"
             "\"effect\":\"bullish\",\"evidence\":\"source\","
             "\"confidence_bucket\":\"high\",\"source_id\":\"edgar_8k\","
             "\"provenance_url\":\"https://example.invalid/x\","
             "\"canonical_hash\":\"%s\",\"feature_id\":\"f1\"}",
             (long long)OBS, (long long)OBS,
             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    std::string acc_s(acc);
    // corrupt the kind (keeps the two-key value shape intact):
    // bogus_event is not a frozen kind -> schema-enum.
    std::string bad_s = acc_s;
    size_t at = bad_s.find("\"filing_event\"");
    if (at == std::string::npos) {
        printf("FAIL setup-mutate\n");
        return 1;
    }
    bad_s.replace(at, 14, "\"bogus_event\"");
    JVal va;
    std::string ca;
    JVal vb;
    std::string cb;
    if (!Parse(acc_s, va, ca) || !Parse(bad_s, vb, cb)) return 1;
    // Warm up (counting OFF): any lazy init must not pollute the count.
    IngestOutcome w0 =
        IngestRecord(g_st, va, ca.data(), ca.size(), SNAP);
    IngestRecord(g_st, vb, cb.data(), cb.size(), SNAP);
    if (!w0.accepted) {
        printf("FAIL setup-accept\n");
        return 1;
    }
    g_st = IngestState();  // reset counters/arena after warm-up
    g_counting = true;
    for (int i = 0; i < 64; i++) {
        IngestOutcome o = IngestRecord(g_st, va, ca.data(), ca.size(), SNAP);
        if (!o.accepted) {
            g_counting = false;
            printf("FAIL retain-%d: %s\n", i, o.reason);
            return 1;
        }
    }
    IngestOutcome drop =
        IngestRecord(g_st, va, ca.data(), ca.size(), SNAP);  // arena full
    if (drop.accepted || drop.code != RejectCode::OVER_COUNT) {
        g_counting = false;
        printf("FAIL drop: %s\n", drop.reason);
        return 1;
    }
    for (int i = 0; i < 100; i++) {
        IngestOutcome o = IngestRecord(g_st, vb, cb.data(), cb.size(), SNAP);
        if (o.accepted) {
            g_counting = false;
            printf("FAIL reject-accept\n");
            return 1;
        }
    }
    g_counting = false;
    printf("allocs-during-validation: %lu\n", g_allocs);
    if (g_allocs != 0) {
        printf("FAIL zero-malloc violated\n");
        fails++;
    }
    if (g_st.accepted != 64 || g_st.dropped != 1 || g_st.rejected != 100) {
        printf("FAIL counters acc=%llu rej=%llu drop=%llu\n",
               (unsigned long long)g_st.accepted,
               (unsigned long long)g_st.rejected,
               (unsigned long long)g_st.dropped);
        fails++;
    }
    if (fails == 0) printf("NOALLOC: PASS\n");
    return fails ? 1 : 0;
}
