// P3.5 Slice C — ingest suite (§4.5 rejection tests + f2 boundaries).
// Reasons mirror P1.5 check_feature verbatim where the check is Slice-C
// owned; DB/entity/history/session steps belong to Slice G (documented
// in features.hpp, never asserted here).
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "../jev_validate.hpp"
#include "features.hpp"

static int fails = 0;
static int count = 0;
#define CHECK(name, expr)                                     \
    do {                                                      \
        count++;                                              \
        if (!(expr)) {                                        \
            printf("FAIL %s\n", name);                        \
            fails++;                                          \
        }                                                     \
    } while (0)

using namespace jev;
using namespace jev::ingest;

// Frozen clock: snapshot 1.8e18 ns (~2027-01), observed 100 s earlier.
static const int64_t SNAP = 1800000000000000000LL;
static const int64_t OBS = SNAP - 100LL * 1000000000LL;
static const char* HEXA =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static const char* HEXB =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Canonical valid record (filing_event/source). %s hooks keep shape
// tests to one-line mutations of this frozen base.
static std::string Base(int64_t obs_ns, int ttl_s) {
    char b[2048];
    snprintf(b, sizeof(b),
             "{\"schema_version\":\"f2\",\"kind\":\"filing_event\","
             "\"symbols\":[\"AAPL\"],"
             "\"observed_at_ns\":%lld,\"ingested_at_ns\":%lld,"
             "\"ttl_s\":%d,"
             "\"value\":{\"type\":\"enum\",\"v\":\"8-K:item-2.02\"},"
             "\"effect\":\"bullish\",\"evidence\":\"source\","
             "\"confidence_bucket\":\"high\",\"source_id\":\"edgar_8k\","
             "\"provenance_url\":\"https://example.invalid/x\","
             "\"canonical_hash\":\"%s\",\"feature_id\":\"f1\"}",
             (long long)obs_ns, (long long)obs_ns, ttl_s, HEXA);
    return b;
}
static std::string Sub(std::string s, const std::string& from, const std::string& to) {
    size_t at = s.find(from);
    if (at != std::string::npos) s.replace(at, from.size(), to);
    return s;
}
// Parse (frozen P3.1) + canonicalize (frozen P3.2) + ingest. Parse is
// caller-side by contract; a parse failure here is a broken test.
static IngestOutcome Feed(IngestState& st, const std::string& json,
                          int64_t snap) {
    JVal v;
    std::string err;
    if (!ParseJson(json, v, err)) {
        printf("FAIL parse: %s\n", err.c_str());
        fails++;
        count++;
        IngestOutcome o;
        return o;
    }
    std::string canon = CanonJson(v);
    return IngestRecord(st, v, canon.data(), canon.size(), snap);
}
static bool Accepted(IngestOutcome& o) { return o.accepted; }
static std::string Reason(IngestOutcome& o) { return o.reason; }

int main() {
    // ---- clean accept + retention shape ----
    {
        static IngestState st;
        IngestOutcome o = Feed(st, Base(OBS, 3600), SNAP);
        CHECK("accept", Accepted(o) && Reason(o) == "ok" && !o.context_only);
        CHECK("retained-one", st.n == 1 && st.accepted == 1);
        CHECK("payload-one", PayloadCount(st) == 1);
        CHECK("slot-bytes",
              PayloadSlot(st, 0).len > 0 &&
                  PayloadSlot(st, 0).observed_ns == OBS &&
                  !PayloadSlot(st, 0).context_only);
        // inference evidence: accepted but CONTEXT-only (never TRIGGER).
        std::string inf = Sub(Base(OBS, 3600), "\"evidence\":\"source\"",
                              "\"evidence\":\"inference\"");
        o = Feed(st, inf, SNAP);
        CHECK("inference-capped",
              Accepted(o) && o.context_only &&
                  Reason(o) == "inference-capped");
        CHECK("capped-retained", PayloadSlot(st, 0).context_only == false &&
                                     PayloadSlot(st, 1).context_only == true);
    }
    // ---- §4.5: bad schema (non-object), future, expired, over-count,
    // ---- float-where-enum ----
    {
        static IngestState st;
        IngestOutcome o = Feed(st, "[1,2]", SNAP);
        CHECK("bad-schema-arr", !Accepted(o));
        o = Feed(st, Base(OBS, 3600), SNAP);  // intact control
        CHECK("control-ok", Accepted(o));
        std::string fut = Base(SNAP + 1, 3600);  // 1 ns past snapshot
        o = Feed(st, fut, SNAP);
        CHECK("future", Reason(o) == "future-timestamp");
        o = Feed(st, Base(SNAP, 3600), SNAP);  // observed == snapshot: fresh
        CHECK("observed-eq-snap", Accepted(o));
        // TTL boundary: age == ttl is fresh (P1.5: strictly greater
        // expires); age == ttl + 1 ns expires.
        int64_t obs = SNAP - 3600LL * 1000000000LL;
        o = Feed(st, Base(obs, 3600), SNAP);
        CHECK("ttl-exact-fresh", Accepted(o));
        o = Feed(st, Base(obs - 1, 3600), SNAP);
        CHECK("ttl-expired", Reason(o) == "ttl-expired");
        // float where an enum belongs.
        o = Feed(st, Sub(Base(OBS, 3600), "\"v\":\"8-K:item-2.02\"",
                         "\"v\":1.5"),
                 SNAP);
        CHECK("float-enum", Reason(o) == "value-shape");
    }
    // ---- prose / unknown / missing / version ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o =
            Feed(st, Sub(base, "\"feature_id\":\"f1\"",
                         "\"feature_id\":\"f1\",\"thesis_text\":\"long\""),
                 SNAP);
        CHECK("prose", Reason(o) == "prose-quarantined");
        // nested prose key also quarantines (walk is recursive).
        o = Feed(st, Sub(base, "\"v\":\"8-K:item-2.02\"",
                         "\"v\":\"8-K:item-2.02\",\"narrative\":\"x\""),
                 SNAP);
        CHECK("prose-nested", Reason(o) == "prose-quarantined");
        o = Feed(st, Sub(base, "\"feature_id\":\"f1\"", "\"zz\":1"), SNAP);
        CHECK("unknown", Reason(o) == "unknown-field:zz");
        // first SORTED unknown wins with several present.
        o = Feed(st, Sub(base, "\"feature_id\":\"f1\"", "\"zz\":1,\"aa\":2"),
                 SNAP);
        CHECK("unknown-sorted", Reason(o) == "unknown-field:aa");
        o = Feed(st, Sub(base, ",\"effect\":\"bullish\"", ""), SNAP);
        CHECK("missing", Reason(o) == "schema-missing:effect");
        o = Feed(st, Sub(base, "\"schema_version\":\"f2\"",
                         "\"schema_version\":\"f3\""),
                 SNAP);
        CHECK("version", Reason(o) == "schema-version");
        o = Feed(st, Sub(base, "\"schema_version\":\"f2\"",
                         "\"schema_version\":2"),
                 SNAP);
        CHECK("version-type", Reason(o) == "schema-version");
    }
    // ---- source / primitive / enum / emitter ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o =
            Feed(st, Sub(base, "\"source_id\":\"edgar_8k\"",
                         "\"source_id\":\"x_posts\""),
                 SNAP);
        CHECK("source-unknown", Reason(o) == "source-unknown");
        o = Feed(st, Sub(base, "\"kind\":\"filing_event\"", "\"kind\":5"),
                 SNAP);
        CHECK("primitive", Reason(o) == "primitive-type:kind");
        o = Feed(st, Sub(base, "\"kind\":\"filing_event\"", "\"kind\":\"bogus\""),
                 SNAP);
        CHECK("enum", Reason(o) == "schema-enum");
        // osint/sentiment/regime have no frozen emitter: never admitted
        // on structure alone, even from a known source.
        o = Feed(st, Sub(base, "\"kind\":\"filing_event\"",
                         "\"kind\":\"osint_event\""),
                 SNAP);
        CHECK("no-emitter", Reason(o) == "kind-no-emitter");
        o = Feed(st, Sub(base, "\"kind\":\"filing_event\"",
                         "\"kind\":\"macro_release\""),
                 SNAP);
        CHECK("emitter-mismatch", Reason(o) == "kind-no-emitter");
        // fed source accepts macro_release (registry positive case).
        o = Feed(st, Sub(Sub(base, "\"source_id\":\"edgar_8k\"",
                             "\"source_id\":\"fed_monetary\""),
                         "\"kind\":\"filing_event\"",
                         "\"kind\":\"macro_release\""), SNAP);
        // symbols AAPL are shape-checked here only (binding is Slice G).
        CHECK("emitter-ok", Accepted(o));
    }
    // ---- value shapes ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o = Feed(st, Sub(base, "\"value\":{\"type\":\"enum\",\"v\":\"8-K:item-2.02\"}", "\"value\":5"),
                               SNAP);
        CHECK("value-nondict", Reason(o) == "schema-value");
        o = Feed(st, Sub(base, "\"type\":\"enum\",\"v\":", "\"type\":\"bogus\",\"v\":"), SNAP);
        CHECK("value-badtype", Reason(o) == "schema-value");
        o = Feed(st, Sub(base, "\"type\":\"enum\"", "\"type\":\"enum\",\"extra\":1"), SNAP);
        CHECK("value-extrakey", Reason(o) == "value-shape");
        o = Feed(st, Sub(base, "\"v\":\"8-K:item-2.02\"", "\"v\":true"), SNAP);
        CHECK("value-bool-for-enum", Reason(o) == "value-shape");
        o = Feed(st, Sub(base, "\"type\":\"enum\",\"v\":\"8-K:item-2.02\"",
                         "\"type\":\"bool\",\"v\":\"true\""),
                 SNAP);
        CHECK("value-str-for-bool", Reason(o) == "value-shape");
        // Multi-defect precedence (P1.5 order: unknown type beats key
        // count): unknown type + extra key is schema-value, not
        // value-shape; unknown type + missing v is schema-value too.
        o = Feed(st, Sub(base, "\"type\":\"enum\",\"v\":\"8-K:item-2.02\"",
                         "\"type\":\"bogus\",\"v\":\"x\",\"extra\":1"),
                 SNAP);
        CHECK("value-multidefect-extra", Reason(o) == "schema-value");
        o = Feed(st, Sub(base, "\"type\":\"enum\",\"v\":\"8-K:item-2.02\"",
                         "\"type\":\"bogus\""),
                 SNAP);
        CHECK("value-multidefect-missing", Reason(o) == "schema-value");
        std::string cnt = Sub(base, "\"type\":\"enum\",\"v\":\"8-K:item-2.02\"",
                              "\"type\":\"count\",\"v\":3");
        o = Feed(st, cnt, SNAP);
        CHECK("count-ok", Accepted(o));
        o = Feed(st, Sub(cnt, "\"v\":3", "\"v\":3.0"), SNAP);
        CHECK("count-float", Reason(o) == "value-shape");
        o = Feed(st, Sub(cnt, "\"v\":3", "\"v\":-1"), SNAP);
        CHECK("count-neg", Reason(o) == "value-shape");
        std::string bl = Sub(base, "\"type\":\"enum\",\"v\":\"8-K:item-2.02\"",
                             "\"type\":\"bool\",\"v\":true");
        o = Feed(st, bl, SNAP);
        CHECK("bool-ok", Accepted(o));
    }
    // ---- symbols ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o =
            Feed(st, Sub(base, "[\"AAPL\"]", "[]"), SNAP);
        CHECK("symbols-empty", Reason(o) == "symbols-type");
        o = Feed(st, Sub(base, "[\"AAPL\"]", "[\"AAPL\",5]"), SNAP);
        CHECK("symbols-nonstr", Reason(o) == "symbols-type");
        o = Feed(st, Sub(base, "[\"AAPL\"]", "[\"\"]"), SNAP);
        CHECK("symbols-empty-elem", Reason(o) == "symbols-type");
        std::string many = "[\"AAPL\"";
        for (int i = 0; i < 16; i++) many += ",\"S" + std::to_string(i) + "\"";
        many += "]";
        o = Feed(st, Sub(base, "[\"AAPL\"]", many), SNAP);
        CHECK("symbols-card", Reason(o) == "symbols-cardinality");
        std::string fair = "[\"AAPL\"";
        for (int i = 0; i < 15; i++) fair += ",\"S" + std::to_string(i) + "\"";
        fair += "]";
        o = Feed(st, Sub(base, "[\"AAPL\"]", fair), SNAP);
        CHECK("symbols-16-ok", Accepted(o));
    }
    // ---- observed / ttl exact-int + range ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o =
            Feed(st, Sub(base, "\"observed_at_ns\":", "\"observed_at_ns\":1.5,\"x\":"), SNAP);
        // note: extra key would trip unknown-field first; craft directly:
        o = Feed(st, Sub(base, std::to_string(OBS), "1.5"), SNAP);
        CHECK("observed-float", Reason(o) == "observed-type");
        o = Feed(st, Sub(base, std::to_string(OBS), "-1"), SNAP);
        CHECK("observed-neg", Reason(o) == "observed-range");
        o = Feed(st, Sub(base, std::to_string(OBS), "9223372036854775808"),
                 SNAP);
        CHECK("observed-huge", Reason(o) == "observed-type");  // deliberate: unrepresentable-as-int64 (P1.5 says range; C++ has no such value)
        o = Feed(st, Sub(base, "\"ttl_s\":3600", "\"ttl_s\":0"), SNAP);
        CHECK("ttl-zero", Reason(o) == "ttl-type");
        o = Feed(st, Sub(base, "\"ttl_s\":3600", "\"ttl_s\":604801"), SNAP);
        CHECK("ttl-huge", Reason(o) == "ttl-type");
        o = Feed(st, Sub(base, "\"ttl_s\":3600", "\"ttl_s\":604800"), SNAP);
        CHECK("ttl-max-ok", Accepted(o));
        o = Feed(st, Sub(base, "\"ttl_s\":3600", "\"ttl_s\":1"), SNAP);
        CHECK("ttl-one", Reason(o) == "ttl-expired");  // age 100s > 1s
    }
    // ---- lineage shape + combination ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o = Feed(
            st, Sub(base, HEXA, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            SNAP);
        CHECK("hash-upper", Reason(o) == "hash-format");
        o = Feed(st, Sub(base, HEXA, std::string(HEXA).substr(0, 63)), SNAP);
        CHECK("hash-short", Reason(o) == "hash-format");
        // multi-hash combine: sha256 over sorted pair pinned at authoring.
        // (replace the hash FIELD: appending would duplicate the key and
        // the frozen parser rejects dup keys before validation runs.)
        std::string hashfield = std::string("\"canonical_hash\":\"") + HEXA + "\"";
        std::string multi = std::string("\"canonical_hashes\":[\"") + HEXB +
            "\",\"" + HEXA +
            "\"],\"canonical_hash\":\"" +
            "c679fc9f6e0345d96cfbb33297c0c12dedabe7f524878eacef9f1008a3ecb257\"";
        o = Feed(st, Sub(base, hashfield, multi), SNAP);
        CHECK("lineage-combine", Accepted(o));
        std::string wrong = std::string("\"canonical_hashes\":[\"") + HEXB +
            "\",\"" + HEXA + "\"],\"canonical_hash\":\"" + HEXB + "\"";
        o = Feed(st, Sub(base, hashfield, wrong), SNAP);
        CHECK("lineage-mismatch", Reason(o) == "lineage-mismatch");
        std::string dup = std::string("\"canonical_hashes\":[\"") + HEXA +
            "\",\"" + HEXA + "\"],\"canonical_hash\":\"" + HEXA + "\"";
        o = Feed(st, Sub(base, hashfield, dup), SNAP);
        CHECK("hashes-dup", Reason(o) == "hash-format");
    }
    // ---- ingested / provenance / entity_ref / feature_id ----
    {
        static IngestState st;
        std::string base = Base(OBS, 3600);
        IngestOutcome o = Feed(
            st, Sub(base, "\"ingested_at_ns\":" + std::to_string(OBS),
                    "\"ingested_at_ns\":" + std::to_string(OBS - 1)),
            SNAP);
        CHECK("ingested-before", Reason(o) == "ingested-before-observed");
        o = Feed(st, Sub(base, "\"ingested_at_ns\":" + std::to_string(OBS),
                         "\"ingested_at_ns\":" + std::to_string(SNAP + 1)),
                 SNAP);
        CHECK("ingested-future", Reason(o) == "ingested-future");
        o = Feed(st, Sub(base, "\"ingested_at_ns\":" + std::to_string(OBS),
                         "\"ingested_at_ns\":\"x\""),
                 SNAP);
        CHECK("ingested-type", Reason(o) == "ingested-type");
        // ingested == observed is the boundary: allowed.
        o = Feed(st, base, SNAP);
        CHECK("ingested-eq-ok", Accepted(o));
        o = Feed(st, Sub(base, "\"provenance_url\":\"https://example.invalid/x\"",
                         "\"provenance_url\":5"),
                 SNAP);
        CHECK("provenance", Reason(o) == "provenance-type");
        o = Feed(st, Sub(base, "\"feature_id\":\"f1\"",
                         "\"feature_id\":\"f1\",\"entity_ref\":{\"cik\":5}"),
                 SNAP);
        CHECK("entity-ref-shape", Reason(o) == "entity-ref-shape");
        o = Feed(st, Sub(base, "\"feature_id\":\"f1\"",
                         "\"feature_id\":\"f1\",\"entity_ref\":{\"cik\":\"123\"}"),
                 SNAP);
        CHECK("entity-ref-ok", Accepted(o));  // resolution is Slice G
        o = Feed(st, Sub(base, "\"feature_id\":\"f1\"", "\"feature_id\":\"\""),
                 SNAP);
        CHECK("feature-id-empty", Reason(o) == "feature-id-shape");
        o = Feed(st, Sub(base, "\"feature_id\":\"f1\"",
                         "\"feature_id\":\"" + std::string(129, 'x') + "\""),
                 SNAP);
        CHECK("feature-id-long", Reason(o) == "feature-id-shape");
    }
    // ---- retention: order, bounds, overflow, payload ----
    {
        static IngestState st;
        // out-of-order arrival sorts newest-first (stable on ties).
        Feed(st, Base(OBS - 20LL * 1000000000LL, 3600), SNAP);
        Feed(st, Base(OBS, 3600), SNAP);
        Feed(st, Base(OBS - 10LL * 1000000000LL, 3600), SNAP);
        CHECK("order", st.n == 3 &&
                           PayloadSlot(st, 0).observed_ns == OBS &&
                           PayloadSlot(st, 1).observed_ns ==
                               OBS - 10LL * 1000000000LL &&
                           PayloadSlot(st, 2).observed_ns ==
                               OBS - 20LL * 1000000000LL);
        // 70 records, newest arriving first: 64 retained, the 6 oldest
        // dropped (valid but too old for a full arena).
        static IngestState st2;
        for (int i = 69; i >= 0; i--)
            Feed(st2, Base(OBS + i, 3600), SNAP + 1000);
        CHECK("retain-64",
              st2.n == 64 && st2.accepted == 64 && st2.dropped == 6 &&
                  st2.per_reason[(int)RejectCode::OVER_COUNT - 1] == 6);
        CHECK("drop-oldest",
              PayloadSlot(st2, 63).observed_ns == OBS + 6 &&
                  PayloadSlot(st2, 0).observed_ns == OBS + 69);
        CHECK("payload-16", PayloadCount(st2) == 16);
        // a record older than everything retained is dropped, not stored.
        IngestOutcome o = Feed(st2, Base(OBS, 3600), SNAP + 1000);
        CHECK("too-old",
              !Accepted(o) && Reason(o) == "over-count" && st2.n == 64 &&
                  st2.dropped == 7);
        // over-size: canonical bytes beyond one slot (long URL is free
        // text only in length — content stays a plain string).
        std::string wide = "[\"";
        for (int i = 0; i < 16; i++) {
            if (i) wide += ",\"";
            wide += std::string(240, char('a' + i % 26)) + "\"";
        }
        wide += "]";
        std::string big = Sub(Base(OBS, 3600), "[\"AAPL\"]", wide);
        o = Feed(st2, big, SNAP + 1000);
        CHECK("over-size",
              !Accepted(o) && Reason(o) == "over-size" && st2.n == 64);
    }
    // ---- determinism: same bundle twice => identical bytes ----
    {
        static IngestState a;
        static IngestState b;
        Feed(a, Base(OBS, 3600), SNAP);
        Feed(b, Base(OBS, 3600), SNAP);
        CHECK("replay-identical",
              a.n == b.n && PayloadSlot(a, 0).len == PayloadSlot(b, 0).len &&
                  memcmp(PayloadSlot(a, 0).bytes, PayloadSlot(b, 0).bytes,
                         PayloadSlot(a, 0).len) == 0);
    }
    // ---- rate window: strictly above 5% alerts ----
    {
        RateWindow w;
        IngestState g;
        IngestState b;
        Feed(g, Base(OBS, 3600), SNAP);  // 1 good
        for (int i = 0; i < 19; i++)
            Feed(b, Sub(Base(OBS, 3600), "\"kind\":\"filing_event\"",
                        "\"kind\":\"bogus\""),
                 SNAP);  // 19 bad
        RateAdd(w, g, SNAP);
        RateAdd(w, b, SNAP);
        // 1 good + 19 bad = 20 total, 19 bad: alerts.
        CHECK("rate-alert", ShouldAlert(w));
        RateWindow w2;
        IngestState g2;
        for (int i = 0; i < 19; i++) Feed(g2, Base(OBS + i, 3600), SNAP);
        IngestState b2;
        Feed(b2, Sub(Base(OBS, 3600), "\"kind\":\"filing_event\"",
                     "\"kind\":\"bogus\""),
             SNAP);
        RateAdd(w2, g2, SNAP);
        RateAdd(w2, b2, SNAP);
        // exactly 5% (1/20) does NOT alert: strictly above only.
        CHECK("rate-exact5", !ShouldAlert(w2));
        RateWindow w3;
        CHECK("rate-empty", !ShouldAlert(w3));
        // One over-count drop is exactly ONE bad event (rejected and
        // dropped are disjoint). Full arena (64a, 0r) + 1 drop + 2
        // validation rejects: 3/67 = 4.48% -> no alert. (The old
        // double-count made this 4/68 = 5.9% -> alert.)
        RateWindow w4;
        IngestState full;
        for (int i = 63; i >= 0; i--)
            Feed(full, Base(OBS + i, 3600), SNAP);
        CHECK("rate-drop-setup", full.n == 64 && full.dropped == 0 &&
                                       full.rejected == 0);
        IngestOutcome od =
            Feed(full, Base(OBS - 1, 3600), SNAP);  // older than oldest
        CHECK("rate-drop-one", !Accepted(od) && Reason(od) == "over-count" &&
                                     full.dropped == 1 && full.rejected == 0 &&
                                     full.per_reason[(int)RejectCode::OVER_COUNT -
                                                     1] == 1);
        RateAdd(w4, full, SNAP);
        IngestState b4;
        for (int i = 0; i < 2; i++)
            Feed(b4, Sub(Base(OBS, 3600), "\"kind\":\"filing_event\"",
                         "\"kind\":\"bogus\""),
                 SNAP);
        RateAdd(w4, b4, SNAP);
        CHECK("rate-drop-counted-once", !ShouldAlert(w4));
        // ...and one more reject crosses: 4/68 = 5.9% alerts.
        IngestState b4b;
        Feed(b4b, Sub(Base(OBS, 3600), "\"kind\":\"filing_event\"",
                      "\"kind\":\"bogus\""),
             SNAP);
        RateAdd(w4, b4b, SNAP);
        CHECK("rate-drop-plus-one", ShouldAlert(w4));
        // hour roll resets the window.
        RateAdd(w2, b2, SNAP + 3600LL * 1000000000LL);
        CHECK("rate-roll", ShouldAlert(w2) && w2.accepted == 0 &&
                               w2.rejected == 1);
    }

    printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
