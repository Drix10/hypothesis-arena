// P3.3 (corrected) — Typed JEVStateV3: the EXACT frozen §3.4 state contract.
//
// plan/03 §3.4 defines the JEV request state (17 top-level keys, full
// feature records, full portfolio/event_window/calibration/risk_flags).
// An earlier P3.3 revision carried only a subset (feature IDs); that was
// a functional architecture bug (review: research evidence must REACH
// JEV, not just feature IDs). This header is the full contract.
//
// Closed schema, both directions:
//   BUILD (kernel -> wire): setters take C++ types, Serialize() emits
//     canonical bytes bit-equal to frozen jev.py canon().
//   CHECK (parsed external state -> typed): FromJVal() enforces exact
//     key sets at EVERY level (top + all nested objects + feature/value
//     members). Unknown keys, missing required containers, non-object
//     feature members, wrong scalar types, non-finite doubles, and
//     out-of-range integers all fail closed (state-shape).
// No raw text, no prose, no unbounded output: strings are bounded,
// value payloads are the frozen typed forms (enum/bucket/bool/count).
//
// Frozen vocabularies (plan/03 §3.4 + collector/ctx_read.py f2 X11):
//   session{asia,london,new_york,us_open,closed} regime{trend,range,volatile}
//   kind(6) effect(6) evidence{source,derived,inference} conf{low,medium,high}
//   vtype{enum,bucket,bool,count} stage(4) impact(5) phase(4)
//   vs_baseline{better,equal,worse,insufficient} gate{pass,insufficient,breach}
//   source_status values{healthy,stale,failed,not_scheduled,unavailable,na}
// kind is the closed ontology (ctx owns WHICH kinds exist); source_id is
// a bounded non-empty string (the source NAMESPACE is owned by ctx/X11 —
// the JEV boundary checks shape, ctx checks membership; same separation
// of verifiers as context_hash vs state_hash).
//
// Definitional numeric bounds (market/math truth, not invented policy):
// price/spread_bps/atr >= 0; enter_brier_200 in [0,1] (Brier definition);
// counts/epochs/ages/positions non-negative int64 (checked, never stoll).
//
// feature_revision quirk (FROZEN recipe, not our choice): the sidecar
// recipe hashes comma-joined sorted feature IDs with "?" for members
// lacking one — and §3.4 features carry NO feature_id field. So over full
// states the revision is sha256("?,?...") (count-only). The kernel MUST
// reproduce this exactly (it verifies artifact decision_keys); making the
// revision content-aware would DIVERGE from the sidecar. A content-aware
// revision needs a plan amendment + version bump, never a silent fix.
//
// P3.4 default (b): no confidence anywhere in this file.
#pragma once
#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include "jev_validate.hpp"

namespace jev {

// Strict UTF-8 -> code points. Rejects overlongs, surrogate halves,
// >0x10FFFF, truncated sequences: kernel states never carry them, and a
// lone-surrogate Python str has no canonical form here -> construction
// fails closed (state-shape) instead of emitting wrong bytes.
inline bool DecodeUtf8(const std::string& in, std::u32string& out,
                       std::string& why) {
    out.clear();
    for (size_t i = 0; i < in.size();) {
        uint8_t c = (uint8_t)in[i];
        uint32_t cp = 0;
        size_t n = 0;
        if (c < 0x80) {
            cp = c;
            n = 1;
        } else if ((c & 0xE0) == 0xC0) {
            cp = c & 0x1F;
            n = 2;
        } else if ((c & 0xF0) == 0xE0) {
            cp = c & 0x0F;
            n = 3;
        } else if ((c & 0xF8) == 0xF0) {
            cp = c & 0x07;
            n = 4;
        } else {
            why = "bad-utf8-lead";
            return false;
        }
        if (i + n > in.size()) {
            why = "bad-utf8-truncated";
            return false;
        }
        for (size_t k = 1; k < n; k++) {
            uint8_t d = (uint8_t)in[i + k];
            if ((d & 0xC0) != 0x80) {
                why = "bad-utf8-continuation";
                return false;
            }
            cp = (cp << 6) | (d & 0x3F);
        }
        static const uint32_t MIN_CP[5] = {0, 0, 0x80, 0x800, 0x10000};
        if (cp < MIN_CP[n]) {
            why = "bad-utf8-overlong";
            return false;
        }
        if ((cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) {
            why = "bad-utf8-range";
            return false;
        }
        out += char32_t(cp);
        i += n;
    }
    return true;
}

// Checked non-negative int64 parse (blocker #3): strict digits, overflow
// fails closed. ONE path for every integer the state boundary reads
// (epochs, ages, counts, positions) — no stoll anywhere near state input.
inline bool ParseNonNegInt64(const std::string& tok, int64_t& out) {
    if (tok.empty()) return false;
    int64_t v = 0;
    for (char c : tok) {
        if (c < '0' || c > '9') return false;
        if (v > (INT64_MAX - (c - '0')) / 10) return false;
        v = v * 10 + (c - '0');
    }
    out = v;
    return true;
}

// Frozen enum matcher: exact membership, no prefixes, no case folding.
inline bool MatchEnum(const std::string& v, const char* const* set,
                      size_t n) {
    for (size_t i = 0; i < n; i++)
        if (v == set[i]) return true;
    return false;
}

// One scalar state field in BOTH renderings the frozen recipe needs:
// json_fragment (canonical bytes) and pystr (decision_key part). Stored,
// never recomputed, so Serialize() and DecisionKey() cannot drift apart.
struct ScalarField {
    std::string json;    // canonical fragment: "quoted" | 12 | 1.5 | true
    std::string pystr;   // PyStr() form: raw | 12 | 1.5 | True
    bool present = false;
};

inline bool ScalarStr(ScalarField& f, const std::string& raw,
                      std::string& why) {
    std::u32string u;
    if (!DecodeUtf8(raw, u, why)) return false;
    std::string esc;
    AppendEscaped(esc, u);
    f.json = esc;
    f.pystr = raw;
    f.present = true;
    return true;
}
inline void ScalarInt(ScalarField& f, int64_t v) {
    f.json = std::to_string(v);
    f.pystr = std::to_string(v);
    f.present = true;
}
inline bool ScalarDouble(ScalarField& f, double v, std::string& why) {
    if (!std::isfinite(v)) {
        why = "nonfinite-double";
        return false;  // contract-excluded: sidecar never emits these
    }
    f.json = CanonDouble(v);
    f.pystr = CanonDouble(v);  // PyStr(float) == shortest repr == CanonDouble
    f.present = true;
    return true;
}
inline void ScalarBool(ScalarField& f, bool v) {
    f.json = v ? "true" : "false";
    f.pystr = v ? "True" : "False";
    f.present = true;
}

// Frozen §3.4 vocabularies.
static const char* SESSION_SET[] = {"asia", "london", "new_york", "us_open",
                                    "closed"};
static const char* REGIME_SET[] = {"trend", "range", "volatile"};
static const char* KIND_SET[] = {"filing_event", "macro_release",
                                 "calendar_ahead", "osint_event",
                                 "sentiment_tail", "regime_hint"};
static const char* EFFECT_SET[] = {"bullish", "bearish", "risk_up",
                                   "risk_down", "neutral", "unknown"};
static const char* EVIDENCE_SET[] = {"source", "derived", "inference"};
static const char* CONF_SET[] = {"low", "medium", "high"};
static const char* VTYPE_SET[] = {"enum", "bucket", "bool", "count"};
static const char* STAGE_SET[] = {"G0_PAPER", "G1_TINY", "G2_SCALED",
                                  "G3_FULL"};
static const char* IMPACT_SET[] = {"none", "low", "medium", "high", "binary"};
static const char* PHASE_SET[] = {"none", "pre", "blackout", "post"};
static const char* VS_BASELINE_SET[] = {"better", "equal", "worse",
                                        "insufficient"};
static const char* GATE_SET[] = {"pass", "insufficient", "breach"};
static const char* SRC_STATUS_SET[] = {"healthy", "stale", "failed",
                                       "not_scheduled", "unavailable", "na"};

// Bounds (documented above): strings ≤ 1024 unless a tighter cap applies.
static const size_t MAX_STATE_STR = 1024;
static const size_t MAX_STATE_FEATURES = 16;  // §3.4: max 16 in payload
static const size_t MAX_FEATURE_SYMBOLS = 16;  // ctx f2 parity
static const size_t MAX_SOURCE_STATUS = 64;

// Full §3.4 feature record (closed: exactly these members, this order).
struct StateFeature {
    ScalarField age_s, conf_bucket, effect, evidence, kind, source_id;
    std::vector<std::string> symbols;  // 1..16, insertion order
    ScalarField value_type, value_v;   // value = {type, v}
};

struct StateIndicators {
    ScalarField rsi, zscore, atr, regime, price_return_bucket, atr_bucket;
};
struct StatePortfolio {
    ScalarField equity, exposure_pct, pending_exposure_pct, open_positions,
        buying_power;
};
struct StateEventWindow {
    ScalarField blackout, impact, phase;
};
struct StateCalibration {
    ScalarField enter_brier_200, vs_baseline, gate;
};
struct StateRiskFlags {
    ScalarField deterministic_veto, var_breach, corr_breach;
};
struct StateSignalBuckets {
    ScalarField trigger_6h, context_6h;
};

class JEVStateV3 {
   public:
    static bool FromJVal(const JVal& st, JEVStateV3& out, std::string& why);
    // ---- BUILD setters (kernel mints states; every setter fails closed)
    bool set_context_hash(const std::string& v, std::string& why) {
        if (!IsHex64(v)) {
            why = "state-shape:context_hash";
            return false;
        }
        context_hash_ = v;
        return true;
    }
    bool set_symbol(const std::string& v, std::string& why) {
        if (v.empty() || v.size() > MAX_STATE_STR) {
            why = "state-shape:symbol";
            return false;
        }
        return ScalarStr(symbol_, v, why);
    }
    bool set_price_int(int64_t v, std::string& why) {
        if (v < 0) {
            why = "state-shape:price";
            return false;
        }
        ScalarInt(price_, v);
        return true;
    }
    bool set_price_double(double v, std::string& why) {
        if (!(v >= 0.0) || !std::isfinite(v)) {
            why = "state-shape:price";
            return false;
        }
        return ScalarDouble(price_, v, why);
    }
    bool set_spread_int(int64_t v, std::string& why) {
        if (v < 0) {
            why = "state-shape:spread_bps";
            return false;
        }
        ScalarInt(spread_bps_, v);
        return true;
    }
    bool set_spread_double(double v, std::string& why) {
        if (!(v >= 0.0) || !std::isfinite(v)) {
            why = "state-shape:spread_bps";
            return false;
        }
        return ScalarDouble(spread_bps_, v, why);
    }
    bool set_session(const std::string& v, std::string& why) {
        if (!MatchEnum(v, SESSION_SET, 5)) {
            why = "state-shape:session";
            return false;
        }
        return ScalarStr(session_, v, why);
    }
    bool set_rsi(double v, std::string& why) {
        return ScalarDouble(ind_.rsi, v, why);
    }
    bool set_zscore(double v, std::string& why) {
        return ScalarDouble(ind_.zscore, v, why);
    }
    bool set_atr(double v, std::string& why) {
        if (!(v >= 0.0) || !std::isfinite(v)) {
            why = "state-shape:atr";
            return false;
        }
        return ScalarDouble(ind_.atr, v, why);
    }
    bool set_regime(const std::string& v, std::string& why) {
        if (!MatchEnum(v, REGIME_SET, 3)) {
            why = "state-shape:regime";
            return false;
        }
        return ScalarStr(ind_.regime, v, why);
    }
    bool set_price_return_bucket(const std::string& v, std::string& why) {
        if (v.empty() || v.size() > MAX_STATE_STR) {
            why = "state-shape:price_return_bucket";
            return false;
        }
        return ScalarStr(ind_.price_return_bucket, v, why);
    }
    bool set_atr_bucket(const std::string& v, std::string& why) {
        if (v.empty() || v.size() > MAX_STATE_STR) {
            why = "state-shape:atr_bucket";
            return false;
        }
        return ScalarStr(ind_.atr_bucket, v, why);
    }
    // Portfolio numbers: finite; open_positions is a count (int >= 0).
    bool set_equity(double v, std::string& why) {
        return ScalarDouble(pf_.equity, v, why);
    }
    bool set_exposure(double v, std::string& why) {
        return ScalarDouble(pf_.exposure_pct, v, why);
    }
    bool set_pending_exposure(double v, std::string& why) {
        return ScalarDouble(pf_.pending_exposure_pct, v, why);
    }
    bool set_open_positions(int64_t v, std::string& why) {
        if (v < 0) {
            why = "state-shape:open_positions";
            return false;
        }
        ScalarInt(pf_.open_positions, v);
        return true;
    }
    bool set_buying_power(double v, std::string& why) {
        return ScalarDouble(pf_.buying_power, v, why);
    }
    bool set_disagreement(bool v) {
        ScalarBool(disagreement_, v);
        return true;
    }
    bool set_blackout(bool v) {
        ScalarBool(ew_.blackout, v);
        return true;
    }
    bool set_impact(const std::string& v, std::string& why) {
        if (!MatchEnum(v, IMPACT_SET, 5)) {
            why = "state-shape:impact";
            return false;
        }
        return ScalarStr(ew_.impact, v, why);
    }
    bool set_phase(const std::string& v, std::string& why) {
        if (!MatchEnum(v, PHASE_SET, 4)) {
            why = "state-shape:phase";
            return false;
        }
        return ScalarStr(ew_.phase, v, why);
    }
    bool set_brier(double v, std::string& why) {
        if (!(v >= 0.0) || !(v <= 1.0) || !std::isfinite(v)) {
            why = "state-shape:enter_brier_200";
            return false;
        }
        return ScalarDouble(cal_.enter_brier_200, v, why);
    }
    bool set_vs_baseline(const std::string& v, std::string& why) {
        if (!MatchEnum(v, VS_BASELINE_SET, 4)) {
            why = "state-shape:vs_baseline";
            return false;
        }
        return ScalarStr(cal_.vs_baseline, v, why);
    }
    bool set_gate(const std::string& v, std::string& why) {
        if (!MatchEnum(v, GATE_SET, 3)) {
            why = "state-shape:gate";
            return false;
        }
        return ScalarStr(cal_.gate, v, why);
    }
    bool set_stage(const std::string& v, std::string& why) {
        if (!MatchEnum(v, STAGE_SET, 4)) {
            why = "state-shape:stage";
            return false;
        }
        return ScalarStr(stage_, v, why);
    }
    bool set_research_revision(const std::string& v, std::string& why) {
        if (v.empty() || v.size() > MAX_STATE_STR) {
            why = "state-shape:research_revision";
            return false;
        }
        return ScalarStr(research_revision_, v, why);
    }
    bool set_veto(bool v) {
        ScalarBool(rf_.deterministic_veto, v);
        return true;
    }
    bool set_var_breach(bool v) {
        ScalarBool(rf_.var_breach, v);
        return true;
    }
    bool set_corr_breach(bool v) {
        ScalarBool(rf_.corr_breach, v);
        return true;
    }
    void set_snapshot_epoch(int64_t v) { epoch_ = v; }
    bool set_trigger_6h(int64_t v, std::string& why) {
        if (v < 0) {
            why = "state-shape:trigger_6h";
            return false;
        }
        ScalarInt(sig_.trigger_6h, v);
        return true;
    }
    bool set_context_6h(int64_t v, std::string& why) {
        if (v < 0) {
            why = "state-shape:context_6h";
            return false;
        }
        ScalarInt(sig_.context_6h, v);
        return true;
    }
    bool add_source_status(const std::string& k, const std::string& v,
                           std::string& why) {
        if (k.empty() || k.size() > 128) {
            why = "state-shape:source_status-key";
            return false;
        }
        if (!MatchEnum(v, SRC_STATUS_SET, 6)) {
            why = "state-shape:source_status-value";
            return false;
        }
        if (src_status_.size() >= MAX_SOURCE_STATUS) {
            why = "state-shape:source_status-size";
            return false;
        }
        for (auto& kv : src_status_)
            if (kv.first == k) {
                why = "state-shape:source_status-dupe";
                return false;
            }
        std::u32string ku, vu;
        if (!DecodeUtf8(k, ku, why) || !DecodeUtf8(v, vu, why)) return false;
        src_status_.push_back({k, v});
        return true;
    }
    // Full feature record (closed §3.4 member set). v_* : exactly one must
    // be set, matching vtype (enum/bucket=str, bool=bool, count=int>=0).
    bool add_feature(const std::string& kind,
                     const std::vector<std::string>& symbols,
                     const std::string& vtype, const std::string& v_str,
                     bool v_bool, int64_t v_int, const std::string& effect,
                     const std::string& evidence, const std::string& conf,
                     int64_t age_s, const std::string& source_id,
                     std::string& why) {
        if (features_.size() >= MAX_STATE_FEATURES) {
            why = "state-shape:features-size";
            return false;
        }
        StateFeature f;
        if (!MatchEnum(kind, KIND_SET, 6)) {
            why = "state-shape:kind";
            return false;
        }
        if (!ScalarStr(f.kind, kind, why)) return false;
        if (symbols.empty() || symbols.size() > MAX_FEATURE_SYMBOLS) {
            why = "state-shape:symbols";
            return false;
        }
        for (auto& s : symbols) {
            if (s.empty() || s.size() > 64) {
                why = "state-shape:symbols";
                return false;
            }
            std::u32string u;
            if (!DecodeUtf8(s, u, why)) return false;
            f.symbols.push_back(s);
        }
        if (!MatchEnum(vtype, VTYPE_SET, 4)) {
            why = "state-shape:value-type";
            return false;
        }
        if (!ScalarStr(f.value_type, vtype, why)) return false;
        if (vtype == "enum" || vtype == "bucket") {
            if (v_str.size() > MAX_STATE_STR) {
                why = "state-shape:value";
                return false;
            }
            if (!ScalarStr(f.value_v, v_str, why)) return false;
        } else if (vtype == "bool") {
            ScalarBool(f.value_v, v_bool);
        } else {
            if (v_int < 0) {
                why = "state-shape:value";
                return false;
            }
            ScalarInt(f.value_v, v_int);
        }
        if (!MatchEnum(effect, EFFECT_SET
, 6)) {
            why = "state-shape:effect";
            return false;
        }
        if (!ScalarStr(f.effect, effect, why)) return false;
        if (!MatchEnum(evidence, EVIDENCE_SET, 3)) {
            why = "state-shape:evidence";
            return false;
        }
        if (!ScalarStr(f.evidence, evidence, why)) return false;
        if (!MatchEnum(conf, CONF_SET, 3)) {
            why = "state-shape:confidence_bucket";
            return false;
        }
        if (!ScalarStr(f.conf_bucket, conf, why)) return false;
        if (age_s < 0) {
            why = "state-shape:age_s";
            return false;
        }
        ScalarInt(f.age_s, age_s);
        if (source_id.empty() || source_id.size() > 128) {
            why = "state-shape:source_id";
            return false;
        }
        if (!ScalarStr(f.source_id, source_id, why)) return false;
        features_.push_back(std::move(f));
        return true;
    }
    // Closed-schema validation: all 17 top-level members present.
    bool seal(std::string& why) const {
        if (context_hash_.empty()) {
            why = "state-shape:context_hash";
            return false;
        }
        if (!symbol_.present || !price_.present || !spread_bps_.present ||
            !session_.present || !ind_.rsi.present || !ind_.zscore.present ||
            !ind_.atr.present || !ind_.regime.present ||
            !ind_.price_return_bucket.present || !ind_.atr_bucket.present ||
            !pf_.equity.present || !pf_.exposure_pct.present ||
            !pf_.pending_exposure_pct.present ||
            !pf_.open_positions.present || !pf_.buying_power.present ||
            !disagreement_.present || !ew_.blackout.present ||
            !ew_.impact.present || !ew_.phase.present ||
            !cal_.enter_brier_200.present || !cal_.vs_baseline.present ||
            !cal_.gate.present || !stage_.present ||
            !research_revision_.present || !rf_.deterministic_veto.present ||
            !rf_.var_breach.present || !rf_.corr_breach.present ||
            !sig_.trigger_6h.present || !sig_.context_6h.present) {
            why = "state-shape:missing";
            return false;
        }
        if (epoch_ < 0) {
            why = "state-shape:epoch";
            return false;
        }
        return true;
    }
    // Canonical bytes, bit-equal to frozen jev.py canon() over the same
    // logical state (code-point key order; insertion order inside arrays;
    // source_status sorted by key like Python sort_keys).
    std::string Serialize() const {
        std::string o = "{";
        bool first = true;
        auto emit = [&](const char* k, const std::string& frag) {
            if (!first) o += ",";
            first = false;
            o += "\"";
            o += k;
            o += "\":";
            o += frag;
        };
        emit("calibration", EmitCalibration());
        emit("context_hash", "\"" + context_hash_ + "\"");
        emit("disagreement", disagreement_.json);
        emit("event_window", EmitEventWindow());
        emit("features", EmitFeatures());
        emit("indicators", EmitIndicators());
        emit("portfolio", EmitPortfolio());
        emit("price", price_.json);
        emit("research_revision", research_revision_.json);
        emit("risk_flags", EmitRiskFlags());
        emit("session", session_.json);
        emit("signal_buckets", EmitSignalBuckets());
        emit("snapshot_epoch", std::to_string(epoch_));
        emit("source_status", EmitSourceStatus());
        emit("spread_bps", spread_bps_.json);
        emit("stage", stage_.json);
        emit("symbol", symbol_.json);
        o += "}";
        return o;
    }
    std::string StateHash() const { return Sha256Hex(Serialize()); }
    // decision_key over the SAME stored renderings (no re-parse, no drift).
    // feature_revision is the FROZEN sidecar recipe: comma-joined sorted
    // IDs with "?" for members lacking one — and full §3.4 features carry
    // NO feature_id, so every member contributes "?". Count-sensitive,
    // content-blind, exactly like Python. (See header-top note.)
    std::string DecisionKey() const {
        std::string joined;
        for (size_t i = 0; i < features_.size(); i++) {
            if (i) joined += ",";
            joined += "?";
        }
        std::string parts = symbol_.pystr + "|" + std::to_string(epoch_) +
                            "|" + ind_.price_return_bucket.pystr + "|" +
                            spread_bps_.pystr + "|" + ind_.atr_bucket.pystr +
                            "|" + ind_.zscore.pystr + "|" +
                            ind_.regime.pystr + "|" + ew_.phase.pystr +
                            "|" + pf_.exposure_pct.pystr + "|" +
                            Sha256Hex(joined) + "|" +
                            research_revision_.pystr + "|v3";
        return Sha256Hex(parts);
    }

   private:
    static bool IsHex64(const std::string& s) {
        if (s.size() != 64) return false;
        for (char c : s)
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                  (c >= 'A' && c <= 'F')))
                return false;
        return true;
    }
    static void EmitScalar(std::string& o, bool& first, const char* k,
                           const ScalarField& f) {
        if (!f.present) return;
        if (!first) o += ",";
        first = false;
        o += "\"";
        o += k;
        o += "\":";
        o += f.json;
    }
    std::string EmitIndicators() const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "atr", ind_.atr);
        EmitScalar(o, first, "atr_bucket", ind_.atr_bucket);
        EmitScalar(o, first, "price_return_bucket",
                   ind_.price_return_bucket);
        EmitScalar(o, first, "regime", ind_.regime);
        EmitScalar(o, first, "rsi", ind_.rsi);
        EmitScalar(o, first, "zscore", ind_.zscore);
        o += "}";
        return o;
    }
    std::string EmitPortfolio() const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "buying_power", pf_.buying_power);
        EmitScalar(o, first, "equity", pf_.equity);
        EmitScalar(o, first, "exposure_pct", pf_.exposure_pct);
        EmitScalar(o, first, "open_positions", pf_.open_positions);
        EmitScalar(o, first, "pending_exposure_pct",
                   pf_.pending_exposure_pct);
        o += "}";
        return o;
    }
    std::string EmitEventWindow() const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "blackout", ew_.blackout);
        EmitScalar(o, first, "impact", ew_.impact);
        EmitScalar(o, first, "phase", ew_.phase);
        o += "}";
        return o;
    }
    std::string EmitCalibration() const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "enter_brier_200", cal_.enter_brier_200);
        EmitScalar(o, first, "gate", cal_.gate);
        EmitScalar(o, first, "vs_baseline", cal_.vs_baseline);
        o += "}";
        return o;
    }
    std::string EmitRiskFlags() const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "corr_breach", rf_.corr_breach);
        EmitScalar(o, first, "deterministic_veto", rf_.deterministic_veto);
        EmitScalar(o, first, "var_breach", rf_.var_breach);
        o += "}";
        return o;
    }
    std::string EmitSignalBuckets() const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "context_6h", sig_.context_6h);
        EmitScalar(o, first, "trigger_6h", sig_.trigger_6h);
        o += "}";
        return o;
    }
    std::string EmitSourceStatus() const {
        std::vector<std::pair<std::string, std::string>> sorted =
            src_status_;
        std::sort(sorted.begin(), sorted.end(),
                  [](const std::pair<std::string, std::string>& a,
                     const std::pair<std::string, std::string>& b) {
                      return a.first < b.first;
                  });
        std::string o = "{";
        for (size_t i = 0; i < sorted.size(); i++) {
            if (i) o += ",";
            std::u32string ku, vu;
            std::string why;
            DecodeUtf8(sorted[i].first, ku, why);  // validated at add()
            DecodeUtf8(sorted[i].second, vu, why);
            o += "\"";
            AppendEscapedInner(o, ku);
            o += "\":\"";
            AppendEscapedInner(o, vu);
            o += "\"";
        }
        o += "}";
        return o;
    }
    static void AppendEscapedInner(std::string& o, const std::u32string& u) {
        std::string tmp;
        AppendEscaped(tmp, u);  // includes surrounding quotes
        o += tmp.substr(1, tmp.size() - 2);
    }
    std::string EmitFeature(const StateFeature& f) const {
        std::string o = "{";
        bool first = true;
        EmitScalar(o, first, "age_s", f.age_s);
        EmitScalar(o, first, "confidence_bucket", f.conf_bucket);
        EmitScalar(o, first, "effect", f.effect);
        EmitScalar(o, first, "evidence", f.evidence);
        EmitScalar(o, first, "kind", f.kind);
        EmitScalar(o, first, "source_id", f.source_id);
        if (!f.symbols.empty()) {
            if (!first) o += ",";
            first = false;
            o += "\"symbols\":[";
            for (size_t i = 0; i < f.symbols.size(); i++) {
                if (i) o += ",";
                std::u32string u;
                std::string why;
                DecodeUtf8(f.symbols[i], u, why);  // validated at add()
                AppendEscaped(o, u);
            }
            o += "]";
        }
        if (!first) o += ",";
        o += "\"value\":{\"type\":";
        o += f.value_type.json;
        o += ",\"v\":";
        o += f.value_v.json;
        o += "}";
        o += "}";
        return o;
    }
    std::string EmitFeatures() const {
        std::string o = "[";
        for (size_t i = 0; i < features_.size(); i++) {
            if (i) o += ",";
            o += EmitFeature(features_[i]);
        }
        o += "]";
        return o;
    }
    // ---- strict field readers for FromJVal (all fail closed) ----
    static bool ReqStr(const JVal& o, const char* k, std::string& dst,
                       std::string& why) {
        const JVal* v = ObjGet(o, k);
        if (!v || v->t != JVal::T::STR) {
            why = std::string("state-shape:") + k;
            return false;
        }
        dst = U32ToUtf8(v->s);
        return true;
    }
    static bool ReqBool(const JVal& o, const char* k, bool& dst,
                        std::string& why) {
        const JVal* v = ObjGet(o, k);
        if (!v || v->t != JVal::T::BOOL) {
            why = std::string("state-shape:") + k;
            return false;
        }
        dst = v->b;
        return true;
    }
    static bool ReqInt(const JVal& o, const char* k, int64_t& dst,
                       std::string& why) {
        const JVal* v = ObjGet(o, k);
        if (!v || v->t != JVal::T::NUM || v->num_double) {
            why = std::string("state-shape:") + k;
            return false;
        }
        if (!ParseNonNegInt64(v->num, dst)) {
            why = std::string("state-shape:") + k;
            return false;
        }
        return true;
    }
    static bool ReqNum(const JVal& o, const char* k, bool& is_int,
                       int64_t& ival, double& dval, std::string& why) {
        const JVal* v = ObjGet(o, k);
        if (!v || v->t != JVal::T::NUM) {
            why = std::string("state-shape:") + k;
            return false;
        }
        is_int = !v->num_double;
        if (is_int) {
            bool neg = false;
            std::string tok = v->num;
            size_t i = 0;
            if (!tok.empty() && tok[0] == '-') {
                neg = true;
                i = 1;
            }
            int64_t t = 0;
            if (!ParseNonNegInt64(tok.substr(i), t)) {
                why = std::string("state-shape:") + k;
                return false;
            }
            if (neg && (uint64_t)t > (uint64_t)INT64_MAX + 1ULL) {
                why = std::string("state-shape:") + k;
                return false;
            }
            // Negation overflow guard: -(INT64_MAX+1) is INT64_MIN,
            // computed unsigned to avoid signed UB.
            ival = neg ? (t > INT64_MAX
                               ? INT64_MIN
                               : -t)
                        : t;
            dval = 0;
        } else {
            if (!std::isfinite(v->dval)) {
                why = std::string("state-shape:") + k;
                return false;
            }
            ival = 0;
            dval = v->dval;
        }
        return true;
    }
    static bool ExactKeys(const JVal& o, const char* const* keys, size_t n,
                          const char* what, std::string& why) {
        if (o.o.size() != n) {
            why = std::string("state-shape:") + what;
            return false;
        }
        for (auto& kv : o.o) {
            std::string k = U32ToUtf8(kv.first);
            bool known = false;
            for (size_t i = 0; i < n; i++)
                if (k == keys[i]) {
                    known = true;
                    break;
                }
            if (!known) {
                why = std::string("state-shape:") + what;
                return false;
            }
        }
        return true;
    }
    std::string context_hash_;
    ScalarField symbol_, price_, spread_bps_, session_;
    ScalarField disagreement_;
    ScalarField stage_, research_revision_;
    int64_t epoch_ = -1;  // unset until set_snapshot_epoch
    StateIndicators ind_;
    StatePortfolio pf_;
    StateEventWindow ew_;
    StateCalibration cal_;
    StateRiskFlags rf_;
    StateSignalBuckets sig_;
    std::vector<std::pair<std::string, std::string>> src_status_;
    std::vector<StateFeature> features_;
};

// Strict closed-schema construction from a parsed state object: the exact
// frozen §3.4 member set at every level, required everywhere. Used by
// tests and by any kernel path adopting an externally supplied state.
inline bool JEVStateV3::FromJVal(const JVal& st, JEVStateV3& out,
                                 std::string& why) {
    if (st.t != JVal::T::OBJ) {
        why = "state-shape:top";
        return false;
    }
    static const char* TOP[] = {
        "calibration",     "context_hash", "disagreement", "event_window",
        "features",        "indicators",   "portfolio",    "price",
        "research_revision", "risk_flags", "session",      "signal_buckets",
        "snapshot_epoch",  "source_status", "spread_bps",  "stage",
        "symbol"};
    if (!ExactKeys(st, TOP, 17, "top", why)) {
        for (auto& kv : st.o) {
            std::string k = U32ToUtf8(kv.first);
            bool known = false;
            for (auto n : TOP)
                if (k == n) {
                    known = true;
                    break;
                }
            if (!known) {
                why = "state-shape:unknown-key:" + k;
                return false;
            }
        }
        why = "state-shape:missing";
        return false;
    }
    std::string ch, sym, sess, stg, rev;
    if (!ReqStr(st, "context_hash", ch, why) ||
        !ReqStr(st, "symbol", sym, why) ||
        !ReqStr(st, "session", sess, why) ||
        !ReqStr(st, "stage", stg, why) ||
        !ReqStr(st, "research_revision", rev, why))
        return false;
    const JVal* ep = ObjGet(st, "snapshot_epoch");
    int64_t epoch = -1;
    if (!ep || ep->t != JVal::T::NUM || ep->num_double ||
        !ParseNonNegInt64(ep->num, epoch)) {
        why = "state-shape:epoch";
        return false;
    }
    if (!out.set_context_hash(ch, why) || !out.set_symbol(sym, why) ||
        !out.set_session(sess, why) || !out.set_stage(stg, why) ||
        !out.set_research_revision(rev, why))
        return false;
    out.set_snapshot_epoch(epoch);
    bool is_int = false;
    int64_t ival = 0;
    double dval = 0;
    if (!ReqNum(st, "price", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_price_int(ival, why)) return false;
    } else if (!out.set_price_double(dval, why))
        return false;
    if (!ReqNum(st, "spread_bps", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_spread_int(ival, why)) return false;
    } else if (!out.set_spread_double(dval, why))
        return false;
    bool b = false;
    if (!ReqBool(st, "disagreement", b, why)) return false;
    out.set_disagreement(b);
    const JVal* ind = ObjGet(st, "indicators");
    static const char* IND[] = {"atr",         "atr_bucket",
                                "price_return_bucket", "regime", "rsi",
                                "zscore"};
    if (!ind || ind->t != JVal::T::OBJ ||
        !ExactKeys(*ind, IND, 6, "indicators-keys", why))
        return false;
    std::string regime, prb, ab;
    if (!ReqStr(*ind, "regime", regime, why) ||
        !ReqStr(*ind, "price_return_bucket", prb, why) ||
        !ReqStr(*ind, "atr_bucket", ab, why))
        return false;
    if (!out.set_regime(regime, why) ||
        !out.set_price_return_bucket(prb, why) ||
        !out.set_atr_bucket(ab, why))
        return false;
    if (!ReqNum(*ind, "rsi", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_rsi((double)ival, why)) return false;
    } else if (!out.set_rsi(dval, why))
        return false;
    if (!ReqNum(*ind, "zscore", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_zscore((double)ival, why)) return false;
    } else if (!out.set_zscore(dval, why))
        return false;
    if (!ReqNum(*ind, "atr", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_atr((double)ival, why)) return false;
    } else if (!out.set_atr(dval, why))
        return false;
    const JVal* pf = ObjGet(st, "portfolio");
    static const char* PF[] = {"buying_power", "equity", "exposure_pct",
                               "open_positions", "pending_exposure_pct"};
    if (!pf || pf->t != JVal::T::OBJ ||
        !ExactKeys(*pf, PF, 5, "portfolio-keys", why))
        return false;
    if (!ReqNum(*pf, "equity", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_equity((double)ival, why)) return false;
    } else if (!out.set_equity(dval, why))
        return false;
    if (!ReqNum(*pf, "exposure_pct", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_exposure((double)ival, why)) return false;
    } else if (!out.set_exposure(dval, why))
        return false;
    if (!ReqNum(*pf, "pending_exposure_pct", is_int, ival, dval, why))
        return false;
    if (is_int) {
        if (!out.set_pending_exposure((double)ival, why)) return false;
    } else if (!out.set_pending_exposure(dval, why))
        return false;
    if (!ReqInt(*pf, "open_positions", ival, why) ||
        !out.set_open_positions(ival, why))
        return false;
    if (!ReqNum(*pf, "buying_power", is_int, ival, dval, why)) return false;
    if (is_int) {
        if (!out.set_buying_power((double)ival, why)) return false;
    } else if (!out.set_buying_power(dval, why))
        return false;
    const JVal* ew = ObjGet(st, "event_window");
    static const char* EW[] = {"blackout", "impact", "phase"};
    if (!ew || ew->t != JVal::T::OBJ ||
        !ExactKeys(*ew, EW, 3, "event_window-keys", why))
        return false;
    if (!ReqBool(*ew, "blackout", b, why)) return false;
    out.set_blackout(b);
    std::string impact, phase;
    if (!ReqStr(*ew, "impact", impact, why) ||
        !ReqStr(*ew, "phase", phase, why))
        return false;
    if (!out.set_impact(impact, why) || !out.set_phase(phase, why))
        return false;
    const JVal* cal = ObjGet(st, "calibration");
    static const char* CAL[] = {"enter_brier_200", "gate", "vs_baseline"};
    if (!cal || cal->t != JVal::T::OBJ ||
        !ExactKeys(*cal, CAL, 3, "calibration-keys", why))
        return false;
    if (!ReqNum(*cal, "enter_brier_200", is_int, ival, dval, why))
        return false;
    if (is_int) {
        if (!out.set_brier((double)ival, why)) return false;
    } else if (!out.set_brier(dval, why))
        return false;
    std::string vsb, gate;
    if (!ReqStr(*cal, "vs_baseline", vsb, why) ||
        !ReqStr(*cal, "gate", gate, why))
        return false;
    if (!out.set_vs_baseline(vsb, why) || !out.set_gate(gate, why))
        return false;
    const JVal* rf = ObjGet(st, "risk_flags");
    static const char* RF[] = {"corr_breach", "deterministic_veto",
                               "var_breach"};
    if (!rf || rf->t != JVal::T::OBJ ||
        !ExactKeys(*rf, RF, 3, "risk_flags-keys", why))
        return false;
    bool veto = false, varb = false, corb = false;
    if (!ReqBool(*rf, "deterministic_veto", veto, why) ||
        !ReqBool(*rf, "var_breach", varb, why) ||
        !ReqBool(*rf, "corr_breach", corb, why))
        return false;
    out.set_veto(veto);
    out.set_var_breach(varb);
    out.set_corr_breach(corb);
    const JVal* sig = ObjGet(st, "signal_buckets");
    static const char* SIG[] = {"context_6h", "trigger_6h"};
    if (!sig || sig->t != JVal::T::OBJ ||
        !ExactKeys(*sig, SIG, 2, "signal_buckets-keys", why))
        return false;
    if (!ReqInt(*sig, "trigger_6h", ival, why) ||
        !out.set_trigger_6h(ival, why))
        return false;
    if (!ReqInt(*sig, "context_6h", ival, why) ||
        !out.set_context_6h(ival, why))
        return false;
    const JVal* ss = ObjGet(st, "source_status");
    if (!ss || ss->t != JVal::T::OBJ) {
        why = "state-shape:source_status";
        return false;
    }
    if (ss->o.size() > MAX_SOURCE_STATUS) {
        why = "state-shape:source_status-size";
        return false;
    }
    for (auto& kv : ss->o) {
        std::string k = U32ToUtf8(kv.first);
        if (kv.second.t != JVal::T::STR) {
            why = "state-shape:source_status-value";
            return false;
        }
        if (!out.add_source_status(k, U32ToUtf8(kv.second.s), why))
            return false;
    }
    const JVal* feats = ObjGet(st, "features");
    if (!feats || feats->t != JVal::T::ARR) {
        why = "state-shape:features";
        return false;
    }
    if (feats->a.size() > MAX_STATE_FEATURES) {
        why = "state-shape:features-size";
        return false;
    }
    static const char* FEAT[] = {"age_s",  "confidence_bucket", "effect",
                                 "evidence", "kind", "source_id",
                                 "symbols", "value"};
    for (auto& m : feats->a) {
        if (m.t != JVal::T::OBJ) {
            why = "state-shape:feature-not-object";
            return false;
        }
        if (!ExactKeys(m, FEAT, 8, "feature-keys", why)) return false;
        std::string kind, effect, evidence, conf, sid;
        if (!ReqStr(m, "kind", kind, why) ||
            !ReqStr(m, "effect", effect, why) ||
            !ReqStr(m, "evidence", evidence, why) ||
            !ReqStr(m, "confidence_bucket", conf, why) ||
            !ReqStr(m, "source_id", sid, why))
            return false;
        const JVal* syms = ObjGet(m, "symbols");
        if (!syms || syms->t != JVal::T::ARR || syms->a.empty() ||
            syms->a.size() > MAX_FEATURE_SYMBOLS) {
            why = "state-shape:symbols";
            return false;
        }
        std::vector<std::string> symv;
        for (auto& s : syms->a) {
            if (s.t != JVal::T::STR) {
                why = "state-shape:symbols";
                return false;
            }
            symv.push_back(U32ToUtf8(s.s));
        }
        const JVal* vv = ObjGet(m, "value");
        static const char* VAL[] = {"type", "v"};
        if (!vv || vv->t != JVal::T::OBJ ||
            !ExactKeys(*vv, VAL, 2, "value-keys", why))
            return false;
        std::string vtype;
        if (!ReqStr(*vv, "type", vtype, why)) return false;
        const JVal* vval = ObjGet(*vv, "v");
        if (!vval) {
            why = "state-shape:value-v";
            return false;
        }
        std::string vstr;
        bool vbool = false;
        int64_t vint = 0;
        if (vtype == "enum" || vtype == "bucket") {
            if (vval->t != JVal::T::STR) {
                why = "state-shape:value-v";
                return false;
            }
            vstr = U32ToUtf8(vval->s);
        } else if (vtype == "bool") {
            if (vval->t != JVal::T::BOOL) {
                why = "state-shape:value-v";
                return false;
            }
            vbool = vval->b;
        } else if (vtype == "count") {
            if (vval->t != JVal::T::NUM || vval->num_double ||
                !ParseNonNegInt64(vval->num, vint)) {
                why = "state-shape:value-v";
                return false;
            }
        } else {
            why = "state-shape:value-type";
            return false;
        }
        int64_t age = 0;
        if (!ReqInt(m, "age_s", age, why)) return false;
        if (!out.add_feature(kind, symv, vtype, vstr, vbool, vint, effect,
                             evidence, conf, age, sid, why))
            return false;
    }
    if (!out.seal(why)) return false;
    return true;
}

}  // namespace jev
