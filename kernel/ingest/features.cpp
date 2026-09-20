// P3.5 Slice C — f2 validation + fixed-arena retention. See features.hpp
// for scope, order, and the zero-malloc contract.
//
// ALLOCATION DISCIPLINE: this file uses no heap vocabulary at all
// (build-gated, comments stripped). All vocabulary compares run directly
// on u32strings against ASCII literals; reason details encode straight
// into the outcome buffer. The parser-owned numeric token is read via
// pointer+length, never converted into an owned string.
#include "features.hpp"

#include <cstring>

namespace jev {
namespace ingest {
namespace {

// ---- frozen f2 vocabularies (doc 08 sec. 8.5; P1.5-identical) ----
const char* kKinds[] = {"filing_event", "macro_release", "calendar_ahead",
                        "osint_event", "sentiment_tail", "regime_hint"};
const char* kEffects[] = {"bullish", "bearish", "risk_up", "risk_down",
                          "neutral", "unknown"};
const char* kEvidence[] = {"source", "derived", "inference"};
const char* kConf[] = {"low", "medium", "high"};
const char* kSources[] = {"edgar_8k",   "fed_monetary", "ecb_mid",
                          "treasury_auctions", "bls_empsit",    "fred_macro"};
// Frozen source->kind emission registry: kinds with no frozen emitter
// (osint_event, sentiment_tail, regime_hint) are rejected here, never
// admitted on structural validity alone.
const char* kEdgarKinds[] = {"filing_event"};
const char* kMacroKinds[] = {"macro_release", "calendar_ahead"};
const char* kRequired[] = {"schema_version", "kind", "symbols", "value",
                           "effect", "evidence", "confidence_bucket",
                           "source_id", "canonical_hash", "observed_at_ns",
                           "ttl_s"};
const char* kOptional[] = {"feature_id", "canonical_hashes", "entity_ref",
                           "ingested_at_ns", "provenance_url"};
const char* kPrimStr[] = {"schema_version", "kind", "effect", "evidence",
                          "confidence_bucket", "source_id"};
const char* kProseKeys[] = {"thesis_text", "critique_text", "narrative",
                            "summary",     "thesis",        "critique",
                            "commentary",  "analysis_text"};

// ASCII-literal compare against a u32string: exact, allocation-free.
// (Vocabularies and field names are pure ASCII by construction.)
bool AsciiEq(const std::u32string& u, const char* a) {
    size_t i = 0;
    for (; a[i]; i++)
        if (i >= u.size() || u[i] != (char32_t)(unsigned char)a[i])
            return false;
    return i == u.size();
}
bool InAsciiList(const char* const* list, size_t n,
                 const std::u32string& u) {
    for (size_t i = 0; i < n; i++)
        if (AsciiEq(u, list[i])) return true;
    return false;
}
// Allocation-free member lookup (the zero-malloc contract forbids the
// U8() key temporaries: each U8() builds a std::string + u32string
// that may heap-allocate, invisible to any file-local grep gate).
const JVal* FindAscii(const JVal& obj, const char* key) {
    if (obj.t != JVal::T::OBJ) return nullptr;
    for (auto& kv : obj.o)
        if (AsciiEq(kv.first, key)) return &kv.second;
    return nullptr;
}
#define NARR(a) (sizeof(a) / sizeof((a)[0]))

// Strict int64 over a JSON numeric token (pointer+length into the
// parser-owned token: read, never owned). Optional '-', 1+ digits,
// overflow-checked. Mirrors exact-int semantics (JSON floats never
// reach here: num_double tokens are rejected by callers first).
bool ParseInt64(const char* tok, size_t len, int64_t& out) {
    if (len == 0) return false;
    size_t i = 0;
    bool neg = false;
    if (tok[0] == '-') {
        neg = true;
        i = 1;
    }
    if (i >= len) return false;
    uint64_t acc = 0;
    const uint64_t lim = neg ? (uint64_t)INT64_MAX + 1 : (uint64_t)INT64_MAX;
    for (; i < len; i++) {
        char c = tok[i];
        if (c < '0' || c > '9') return false;
        uint64_t d = (uint64_t)(c - '0');
        if (acc > (lim - d) / 10) return false;  // overflow: not an int64
        acc = acc * 10 + d;
    }
    out = neg ? (acc == (uint64_t)INT64_MAX + 1 ? INT64_MIN : -(int64_t)acc)
              : (int64_t)acc;
    return true;
}
// Exact-int JVal: NUM token without float marking, parseable as int64.
bool AsInt64(const JVal& v, int64_t& out) {
    if (v.t != JVal::T::NUM || v.num_double) return false;
    return ParseInt64(v.num.data(), v.num.size(), out);
}
bool IsHex64U32(const std::u32string& u) {
    if (u.size() != 64) return false;
    for (char32_t c : u)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}
// Prose quarantine: any object key (at any depth) in the frozen prose
// set. The field allowlist below is the real guard; this preserves the
// P1.5 first-failure reason for smuggled prose keys.
bool HasProse(const JVal& v) {
    if (v.t == JVal::T::OBJ) {
        for (auto& kv : v.o) {
            if (InAsciiList(kProseKeys, NARR(kProseKeys), kv.first))
                return true;
            if (HasProse(kv.second)) return true;
        }
        return false;
    }
    if (v.t == JVal::T::ARR) {
        for (auto& e : v.a)
            if (HasProse(e)) return true;
    }
    return false;
}
// Bounded u32 -> UTF-8 append into the reason buffer (ASCII fast path
// is exact; non-ASCII encodes standardly). Always NUL-terminates.
void AppendU32(char* buf, size_t cap, size_t& at, const std::u32string& u) {
    for (char32_t c : u) {
        if (c < 0x80) {
            if (at + 1 >= cap) break;
            buf[at++] = (char)c;
        } else if (c < 0x800) {
            if (at + 2 >= cap) break;
            buf[at++] = (char)(0xC0 | (c >> 6));
            buf[at++] = (char)(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            if (at + 3 >= cap) break;
            buf[at++] = (char)(0xE0 | (c >> 12));
            buf[at++] = (char)(0x80 | ((c >> 6) & 0x3F));
            buf[at++] = (char)(0x80 | (c & 0x3F));
        } else if (c < 0x110000) {
            if (at + 4 >= cap) break;
            buf[at++] = (char)(0xF0 | (c >> 18));
            buf[at++] = (char)(0x80 | ((c >> 12) & 0x3F));
            buf[at++] = (char)(0x80 | ((c >> 6) & 0x3F));
            buf[at++] = (char)(0x80 | (c & 0x3F));
        } else {
            break;
        }
    }
    buf[at < cap ? at : cap - 1] = '\0';
}
void SetReason(IngestOutcome& o, bool accepted, bool context_only,
               RejectCode code, const std::u32string* detail) {
    o.accepted = accepted;
    o.context_only = context_only;
    o.code = code;
    const char* base =
        accepted ? (context_only ? "inference-capped" : "ok")
                 : RejectCodeStr(code);
    size_t at = 0;
    while (base[at] && at + 1 < sizeof(o.reason)) {
        o.reason[at] = base[at];
        at++;
    }
    if (detail && !detail->empty() && !accepted) {
        if (at + 1 < sizeof(o.reason)) o.reason[at++] = ':';
        AppendU32(o.reason, sizeof(o.reason), at, *detail);
    }
    o.reason[at] = '\0';
}
// ASCII-detail variant (static field names): no u32 conversion at all.
void SetReasonA(IngestOutcome& o, bool accepted, bool context_only,
                RejectCode code, const char* ascii) {
    o.accepted = accepted;
    o.context_only = context_only;
    o.code = code;
    const char* base = accepted ? "ok" : RejectCodeStr(code);
    size_t at = 0;
    while (base[at] && at + 1 < sizeof(o.reason)) {
        o.reason[at] = base[at];
        at++;
    }
    if (ascii && ascii[0] && !accepted) {
        if (at + 1 < sizeof(o.reason)) o.reason[at++] = ':';
        for (const char* p = ascii; *p && at + 1 < sizeof(o.reason); p++)
            o.reason[at++] = *p;
    }
    o.reason[at] = '\0';
}

}  // namespace

IngestOutcome IngestRecord(IngestState& st, const JVal& rec, const char* canon,
                           size_t canon_len, int64_t snapshot_ns) {
    IngestOutcome o;
    auto reject = [&](RejectCode code, const std::u32string* detail) {
        SetReason(o, false, false, code, detail);
        st.rejected++;
        st.per_reason[(int)code - 1]++;
        return o;
    };
    auto reject_a = [&](RejectCode code, const char* ascii_detail) {
        // ASCII-only shortcut (static field names): zero conversion.
        SetReasonA(o, false, false, code, ascii_detail);
        st.rejected++;
        st.per_reason[(int)code - 1]++;
        return o;
    };
    if (rec.t != JVal::T::OBJ)
        return reject(RejectCode::SCHEMA_VALUE, nullptr);
    // 1. prose quarantine (P1.5 first).
    if (HasProse(rec)) return reject(RejectCode::PROSE, nullptr);
    // 2/3. unknown fields (first sorted, codepoint order) then missing.
    {
        const std::u32string* names[64];
        int n = 0;
        for (auto& kv : rec.o) {
            if (!InAsciiList(kRequired, NARR(kRequired), kv.first) &&
                !InAsciiList(kOptional, NARR(kOptional), kv.first)) {
                if (n < 64) names[n++] = &kv.first;
            }
        }
        for (int i = 1; i < n; i++) {  // insertion sort, n <= 64
            const std::u32string* t = names[i];
            int j = i - 1;
            while (j >= 0 && *names[j] > *t) {
                names[j + 1] = names[j];
                j--;
            }
            names[j + 1] = t;
        }
        if (n > 0) return reject(RejectCode::UNKNOWN_FIELD, names[0]);
        const char* miss[11];
        int nm = 0;
        for (size_t i = 0; i < NARR(kRequired); i++) {
            bool found = false;
            for (auto& kv : rec.o)
                if (AsciiEq(kv.first, kRequired[i])) {
                    found = true;
                    break;
                }
            if (!found) miss[nm++] = kRequired[i];
        }
        for (int i = 1; i < nm; i++) {  // strcmp == codepoint for ASCII
            const char* mc = miss[i];
            int j = i - 1;
            while (j >= 0 && strcmp(miss[j], mc) > 0) {
                miss[j + 1] = miss[j];
                j--;
            }
            miss[j + 1] = mc;
        }
        if (nm > 0) return reject_a(RejectCode::MISSING_FIELD, miss[0]);
    }
    const JVal* schema = FindAscii(rec, "schema_version");
    const JVal* kind = FindAscii(rec, "kind");
    const JVal* effect = FindAscii(rec, "effect");
    const JVal* evidence = FindAscii(rec, "evidence");
    const JVal* conf = FindAscii(rec, "confidence_bucket");
    const JVal* source = FindAscii(rec, "source_id");
    // 4. version (before primitive check: a non-string version fails HERE,
    // P1.5-identical).
    if (!schema || schema->t != JVal::T::STR || !AsciiEq(schema->s, "f2"))
        return reject(RejectCode::VERSION, nullptr);
    // 5. source namespace (non-string source fails here too).
    if (!source || source->t != JVal::T::STR ||
        !InAsciiList(kSources, NARR(kSources), source->s))
        return reject(RejectCode::SOURCE_UNKNOWN, nullptr);
    bool is_edgar = AsciiEq(source->s, "edgar_8k");
    // 6. primitive string fields.
    const JVal* prims[] = {schema, kind, effect, evidence, conf, source};
    for (size_t i = 0; i < 6; i++)
        if (!prims[i] || prims[i]->t != JVal::T::STR)
            return reject_a(RejectCode::PRIMITIVE_TYPE, kPrimStr[i]);
    // 7. closed vocabularies.
    if (!InAsciiList(kKinds, NARR(kKinds), kind->s) ||
        !InAsciiList(kEffects, NARR(kEffects), effect->s) ||
        !InAsciiList(kEvidence, NARR(kEvidence), evidence->s) ||
        !InAsciiList(kConf, NARR(kConf), conf->s))
        return reject(RejectCode::ENUM, nullptr);
    // 8. emitter registry (kinds without a frozen emitter never pass on
    // structure alone).
    if (is_edgar ? !InAsciiList(kEdgarKinds, NARR(kEdgarKinds), kind->s)
                 : !InAsciiList(kMacroKinds, NARR(kMacroKinds), kind->s))
        return reject(RejectCode::NO_EMITTER, nullptr);
    // 9. value shape, P1.5 precedence exactly: object -> type is a
    // string -> type is a known VTYPES member (schema-value) -> exact
    // {type, v} key set -> exact v type -> count >= 0. Multi-defect
    // records therefore report the same first failure as P1.5 (e.g.
    // {type:"bogus", v:"x", extra:1} is schema-value, not value-shape).
    const JVal* value = FindAscii(rec, "value");
    if (!value || value->t != JVal::T::OBJ)
        return reject(RejectCode::SCHEMA_VALUE, nullptr);
    {
        const JVal* vt = FindAscii(*value, "type");
        if (!vt || vt->t != JVal::T::STR)
            return reject(RejectCode::VALUE_SHAPE, nullptr);
        bool is_enum = AsciiEq(vt->s, "enum");
        bool is_bucket = AsciiEq(vt->s, "bucket");
        bool is_bool = AsciiEq(vt->s, "bool");
        bool is_count = AsciiEq(vt->s, "count");
        if (!is_enum && !is_bucket && !is_bool && !is_count)
            return reject(RejectCode::SCHEMA_VALUE, nullptr);
        const JVal* vv = FindAscii(*value, "v");
        if (value->o.size() != 2 || !vv)
            return reject(RejectCode::VALUE_SHAPE, nullptr);
        bool shape_ok = false;
        if (is_enum || is_bucket)
            shape_ok = (vv->t == JVal::T::STR);
        else if (is_bool)
            shape_ok = (vv->t == JVal::T::BOOL);
        else {  // count: exact non-negative int (3.0 and -1 both fail)
            int64_t c = 0;
            shape_ok = (AsInt64(*vv, c) && c >= 0);
        }
        if (!shape_ok) return reject(RejectCode::VALUE_SHAPE, nullptr);
    }
    // 10. symbols: non-empty array (empty bypasses identity — reject),
    // <= 16, every element a non-empty string.
    {
        const JVal* syms = FindAscii(rec, "symbols");
        if (!syms || syms->t != JVal::T::ARR || syms->a.empty())
            return reject(RejectCode::SYMBOLS_TYPE, nullptr);
        if (syms->a.size() > (size_t)kMaxSymbols)
            return reject(RejectCode::SYMBOLS_CARD, nullptr);
        for (auto& e : syms->a)
            if (e.t != JVal::T::STR || e.s.empty())
                return reject(RejectCode::SYMBOLS_TYPE, nullptr);
    }
    // 11/12. observed (exact int, >= 0) and ttl (exact int, 1..7d).
    int64_t observed = 0;
    {
        const JVal* ob = FindAscii(rec, "observed_at_ns");
        if (!ob || !AsInt64(*ob, observed))
            return reject(RejectCode::OBSERVED_TYPE, nullptr);
        if (observed < 0)  // P1.5 range is 0..INT64_MAX, mirrored exactly
            return reject(RejectCode::OBSERVED_RANGE, nullptr);
    }
    int64_t ttl = 0;
    {
        const JVal* tt = FindAscii(rec, "ttl_s");
        if (!tt || !AsInt64(*tt, ttl))
            return reject(RejectCode::TTL_TYPE, nullptr);
        if (ttl < 1 || ttl > kTtlMaxS)
            return reject(RejectCode::TTL_TYPE, nullptr);
    }
    // 13. lineage shape + combination (DB resolution is Slice G).
    {
        const JVal* ch = FindAscii(rec, "canonical_hash");
        if (!ch || ch->t != JVal::T::STR || !IsHex64U32(ch->s))
            return reject(RejectCode::HASH_FORMAT, nullptr);
        const JVal* chs = FindAscii(rec, "canonical_hashes");
        if (chs) {
            if (chs->t != JVal::T::ARR || chs->a.empty() ||
                chs->a.size() > (size_t)kMaxHashes)
                return reject(RejectCode::HASH_FORMAT, nullptr);
            const std::u32string* hs[16];
            for (size_t i = 0; i < chs->a.size(); i++) {
                if (chs->a[i].t != JVal::T::STR ||
                    !IsHex64U32(chs->a[i].s))
                    return reject(RejectCode::HASH_FORMAT, nullptr);
                hs[i] = &chs->a[i].s;
            }
            for (size_t i = 1; i < chs->a.size(); i++) {
                const std::u32string* t = hs[i];
                size_t j = i;
                while (j > 0 && *hs[j - 1] > *t) {
                    hs[j] = hs[j - 1];
                    j--;
                }
                hs[j] = t;
            }
            for (size_t i = 1; i < chs->a.size(); i++)
                if (*hs[i] == *hs[i - 1])
                    return reject(RejectCode::HASH_FORMAT, nullptr);
            if (chs->a.size() == 1) {
                if (ch->s != *hs[0])
                    return reject(RejectCode::LINEAGE_MISMATCH, nullptr);
            } else {
                // combine: sha256("||".join(sorted)) — U+2016 is E2 80 96.
                Sha256 sh;
                const uint8_t sep[3] = {0xE2, 0x80, 0x96};
                for (size_t i = 0; i < chs->a.size(); i++) {
                    if (i) sh.update(sep, 3);
                    for (char32_t c : *hs[i]) {
                        uint8_t b = (uint8_t)c;  // hex is pure ASCII
                        sh.update(&b, 1);
                    }
                }
                std::array<uint8_t, 32> dg = sh.final();
                if (ch->s.size() != 64)
                    return reject(RejectCode::LINEAGE_MISMATCH, nullptr);
                for (int i = 0; i < 32; i++) {
                    char hi = "0123456789abcdef"[dg[i] >> 4];
                    char lo = "0123456789abcdef"[dg[i] & 15];
                    if (ch->s[2 * (size_t)i] != (char32_t)(unsigned char)hi ||
                        ch->s[2 * (size_t)i + 1] != (char32_t)(unsigned char)lo)
                        return reject(RejectCode::LINEAGE_MISMATCH, nullptr);
                }
            }
        }
        // single-hash case: canonical_hash equals itself by construction.
    }
    // 14/15. R12: integer-exact, no float time math (D6 spirit).
    // Future first (P1.5 order): observed past the snapshot is dropped.
    // Deliberate precision upgrade over P1.5 (verified by cross-run):
    // P1.5 divides to float seconds, so a 1ns-future stamp and a
    // 1ns-past-TTL expiry both vanish in float rounding near 1.8e9 s
    // (future misreports as ingested-before-observed; the expiry is
    // missed entirely and falls through to entity checks). The integer
    // rule below is exact at both boundaries, fail-closed.
    if (observed > snapshot_ns) return reject(RejectCode::FUTURE, nullptr);
    {
        __int128 age = (__int128)snapshot_ns - observed;
        __int128 budget = (__int128)ttl * 1000000000LL;
        if (age > budget) return reject(RejectCode::EXPIRED, nullptr);
    }
    // 16. ingested (optional): exact int, ranged, never future, never
    // before observed (time-travel lineage is rejected, not reasoned).
    {
        const JVal* ig = FindAscii(rec, "ingested_at_ns");
        if (ig) {
            int64_t iv = 0;
            if (!AsInt64(*ig, iv))
                return reject(RejectCode::INGESTED_TYPE, nullptr);
            if (iv < 0)
                return reject(RejectCode::INGESTED_RANGE, nullptr);
            if (iv > snapshot_ns)
                return reject(RejectCode::INGESTED_FUTURE, nullptr);
            if (iv < observed)
                return reject(RejectCode::INGESTED_BEFORE, nullptr);
        }
    }
    // 17. provenance_url (optional): string type only.
    {
        const JVal* pu = FindAscii(rec, "provenance_url");
        if (pu && pu->t != JVal::T::STR)
            return reject(RejectCode::PROVENANCE_TYPE, nullptr);
    }
    // 18. entity_ref shape (optional): exactly {"cik": str}. Resolution
    // against the pinned map is Slice G (needs the map file).
    {
        const JVal* er = FindAscii(rec, "entity_ref");
        if (er) {
            if (er->t != JVal::T::OBJ || er->o.size() != 1)
                return reject(RejectCode::ENTITY_REF_SHAPE, nullptr);
            const JVal* cik = FindAscii(*er, "cik");
            if (!cik || cik->t != JVal::T::STR)
                return reject(RejectCode::ENTITY_REF_SHAPE, nullptr);
        }
    }
    // 19. feature_id shape (optional): non-empty string, <= 128 chars.
    {
        const JVal* fi = FindAscii(rec, "feature_id");
        if (fi) {
            if (fi->t != JVal::T::STR || fi->s.empty() || fi->s.size() > 128)
                return reject(RejectCode::FEATURE_ID, nullptr);
        }
    }
    // Accepted. inference evidence is CONTEXT-only (never TRIGGER).
    bool capped = AsciiEq(evidence->s, "inference");
    // Retention slot bound (resource, counted): canonical bytes must fit.
    if (canon_len > kSlotBytes || !canon)
        return reject(RejectCode::OVER_SIZE, nullptr);
    // Retain newest-first (stable: ties keep arrival order). Full and no
    // newer than the oldest retained => valid-but-dropped (over-count).
    if (st.n >= kRetainMax) {
        if (observed <= st.slots[st.n - 1].observed_ns) {
            // Valid but too old: counts as DROPPED only. (rejected and
            // dropped are disjoint sets; counting both would make one
            // drop two bad events in the rate math.)
            SetReason(o, false, false, RejectCode::OVER_COUNT, nullptr);
            st.dropped++;
            st.per_reason[(int)RejectCode::OVER_COUNT - 1]++;
            return o;
        }
        st.n--;  // evict oldest; the newcomer sorts in below
    }
    int at = st.n;
    while (at > 0 && st.slots[at - 1].observed_ns < observed) {
        st.slots[at] = st.slots[at - 1];
        at--;
    }
    IngestState::Slot& sl = st.slots[at];
    memcpy(sl.bytes, canon, canon_len);
    sl.len = (uint32_t)canon_len;
    sl.observed_ns = observed;
    sl.context_only = capped;
    st.n++;
    st.accepted++;
    SetReason(o, true, capped, RejectCode::OK, nullptr);
    return o;
}

namespace {
// Saturating counter add: operationally unreachable, but keeps the
// hourly window meaningful (monotone, ordered) past any wrap.
void SatAdd(uint64_t& acc, uint64_t x) {
    if (acc > UINT64_MAX - x)
        acc = UINT64_MAX;
    else
        acc += x;
}
}  // namespace

void RateAdd(RateWindow& w, const IngestState& st, int64_t now_ns) {
    // Caller contract: once per bundle, now_ns a non-negative monotonic
    // clock. Elapsed hour resets first, so the rate covers the current
    // one-hour window (tumbling, anchored at first RateAdd).
    // Clock rollback (now < start) keeps the current window rather than
    // resetting: resetting would erase accumulated bad counts. The
    // difference is __int128, so no signed overflow on any input.
    __int128 elapsed = (__int128)now_ns - (__int128)w.window_start_ns;
    if (!w.window_set || elapsed < 0) {
        if (!w.window_set) {
            w.window_start_ns = now_ns;
            w.window_set = true;
            w.accepted = w.rejected = w.dropped = 0;
            for (int i = 0; i < kRejectCount; i++) w.per_reason[i] = 0;
        }
    } else if (elapsed >= kHourNs) {
        w.window_start_ns = now_ns;
        w.accepted = w.rejected = w.dropped = 0;
        for (int i = 0; i < kRejectCount; i++) w.per_reason[i] = 0;
    }
    SatAdd(w.accepted, st.accepted);
    SatAdd(w.rejected, st.rejected);
    SatAdd(w.dropped, st.dropped);
    for (int i = 0; i < kRejectCount; i++)
        SatAdd(w.per_reason[i], st.per_reason[i]);
}

bool ShouldAlert(const RateWindow& w) {
    // Strictly above 5%: 20*bad > total. Every addend is widened to
    // __int128 BEFORE any addition, so no uint64 sum can overflow first.
    __int128 total =
        (__int128)w.accepted + (__int128)w.rejected + (__int128)w.dropped;
    if (total == 0) return false;
    __int128 bad = (__int128)w.rejected + (__int128)w.dropped;
    return (__int128)20 * bad > total;
}

int PayloadCount(const IngestState& st) {
    return st.n < kPayloadMax ? st.n : kPayloadMax;
}
const IngestState::Slot& PayloadSlot(const IngestState& st, int i) {
    return st.slots[i];
}

}  // namespace ingest
}  // namespace jev
