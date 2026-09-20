// P3.3 — Typed JEVStateV3 + exact serializer (frozen sidecar recipe).
//
// The kernel is the SOLE producer of JEV request states in production, so
// the state schema is CLOSED and frozen here (no invented keys, no silent
// extras — anything outside this schema is a protocol change):
//   required: context_hash, symbol, stage, question_set_version,
//             snapshot_epoch, indicators{regime}, portfolio, event_window
//   optional: spread_bps, cycle_id, research_revision,
//             indicators{price_return_bucket, atr_bucket, zscore},
//             event_window{phase}, portfolio{exposure_pct},
//             features[{feature_id}]  (ID-only, insertion order preserved)
// state_hash = SHA-256 over the canonical bytes of EXACTLY this object.
//
// Two directions, two tools (never conflated):
//   BUILD (kernel -> wire): JEVStateV3 setters take C++ types, Serialize()
//     emits canonical bytes bit-equal to frozen jev.py canon().
//   CHECK (parsed external state -> decision_key): CheckStateShape()
//     rejects malformed feature_id as state-shape HOLD BEFORE the frozen
//     ComputeDecisionKey() runs, so its "?" fallback is unreachable
//     through the P3.3 path (it stays as defense-in-depth only).
//
// P3.4 default (b): no confidence anywhere in this file.
#pragma once
#include <cmath>
#include <cstdint>
#include <string>
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

// Closed JEV-state sub-objects (fixed keys, sorted on emit).
struct StateIndicators {
    ScalarField regime;  // required
    ScalarField price_return_bucket, atr_bucket, zscore;
};
struct StatePortfolio {
    ScalarField exposure_pct;
};
struct StateEventWindow {
    ScalarField phase;
};

class JEVStateV3 {
   public:
    static bool FromJVal(const JVal& st, JEVStateV3& out, std::string& why);
    // Required top-level fields (construction fails closed otherwise).
    bool set_context_hash(const std::string& v, std::string& why) {
        if (!IsHex64(v)) {
            why = "state-shape:context_hash";
            return false;
        }
        context_hash_ = v;
        return true;
    }
    bool set_symbol(const std::string& v, std::string& why) {
        // 1024 = P3.1 parse parity (longer would fail the boundary anyway).
        if (v.empty() || v.size() > 1024) {
            why = "state-shape:symbol";
            return false;
        }
        return ScalarStr(symbol_, v, why);
    }
    bool set_stage(const std::string& v, std::string& why) {
        if (v.empty() || v.size() > 1024) {
            why = "state-shape:stage";
            return false;
        }
        return ScalarStr(stage_, v, why);
    }
    void set_snapshot_epoch(int64_t v) { epoch_ = v; }
    // Optional scalars (absent == omitted from bytes AND "?" in key parts).
    bool set_spread_bps_int(int64_t v) {
        ScalarInt(spread_bps_, v);
        return true;
    }
    bool set_spread_bps_double(double v, std::string& why) {
        return ScalarDouble(spread_bps_, v, why);
    }
    bool set_cycle_id(const std::string& v, std::string& why) {
        return ScalarStr(cycle_id_, v, why);
    }
    bool set_research_revision(const std::string& v, std::string& why) {
        return ScalarStr(research_revision_, v, why);
    }
    bool set_regime(const std::string& v, std::string& why) {
        return ScalarStr(ind_.regime, v, why);
    }
    bool set_price_return_bucket_str(const std::string& v, std::string& why) {
        return ScalarStr(ind_.price_return_bucket, v, why);
    }
    bool set_price_return_bucket_int(int64_t v) {
        ScalarInt(ind_.price_return_bucket, v);
        return true;
    }
    bool set_price_return_bucket_double(double v, std::string& why) {
        return ScalarDouble(ind_.price_return_bucket, v, why);
    }
    bool set_atr_bucket_str(const std::string& v, std::string& why) {
        return ScalarStr(ind_.atr_bucket, v, why);
    }
    bool set_atr_bucket_int(int64_t v) {
        ScalarInt(ind_.atr_bucket, v);
        return true;
    }
    bool set_atr_bucket_double(double v, std::string& why) {
        return ScalarDouble(ind_.atr_bucket, v, why);
    }
    bool set_zscore(double v, std::string& why) {
        return ScalarDouble(ind_.zscore, v, why);
    }
    bool set_phase(const std::string& v, std::string& why) {
        return ScalarStr(ew_.phase, v, why);
    }
    bool set_exposure_pct_int(int64_t v) {
        ScalarInt(pf_.exposure_pct, v);
        return true;
    }
    bool set_exposure_pct_double(double v, std::string& why) {
        return ScalarDouble(pf_.exposure_pct, v, why);
    }
    // Feature IDs: strict strings only (missing/non-string rejected HERE,
    // so ComputeDecisionKey's "?" fallback is unreachable via this path).
    bool add_feature_id(const std::string& v, std::string& why) {
        // 128 = ctx f2 feature-id bound (collector/ctx_read.py parity).
        if (v.empty() || v.size() > 128) {
            why = "state-shape:feature_id";
            return false;
        }
        std::u32string u;
        if (!DecodeUtf8(v, u, why)) return false;
        feature_ids_.push_back(v);
        return true;
    }
    // Closed-schema validation: every required field present and sane.
    bool seal(std::string& why) const {
        if (context_hash_.empty()) {
            why = "state-shape:context_hash";
            return false;
        }
        if (!symbol_.present || !stage_.present || !ind_.regime.present) {
            why = "state-shape:missing-required";
            return false;
        }
        if (epoch_ < 0) {
            why = "state-shape:epoch";
            return false;
        }
        return true;
    }
    // Canonical bytes, bit-equal to frozen jev.py canon() over the same
    // logical state (keys already in code-point order; absence == omission).
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
        emit("context_hash", "\"" + context_hash_ + "\"");
        if (cycle_id_.present) emit("cycle_id", cycle_id_.json);
        emit("event_window", EmitEventWindow());
        emit("features", EmitFeatures());
        emit("indicators", EmitIndicators());
        emit("portfolio", EmitPortfolio());
        emit("question_set_version", "\"v3\"");
        if (research_revision_.present)
            emit("research_revision", research_revision_.json);
        emit("snapshot_epoch", std::to_string(epoch_));
        if (spread_bps_.present) emit("spread_bps", spread_bps_.json);
        emit("stage", stage_.json);
        emit("symbol", symbol_.json);
        o += "}";
        return o;
    }
    std::string StateHash() const { return Sha256Hex(Serialize()); }
    // decision_key over the SAME stored renderings (no re-parse, no drift).
    std::string DecisionKey() const {
        auto part = [](const ScalarField& f) -> std::string {
            return f.present ? f.pystr : "?";
        };
        std::vector<std::string> ids = feature_ids_;
        std::sort(ids.begin(), ids.end());
        std::string joined;
        for (size_t i = 0; i < ids.size(); i++) {
            if (i) joined += ",";
            joined += ids[i];
        }
        std::string parts = part(symbol_) + "|" + std::to_string(epoch_) +
                            "|" + part(ind_.price_return_bucket) + "|" +
                            part(spread_bps_) + "|" + part(ind_.atr_bucket) +
                            "|" + part(ind_.zscore) + "|" +
                            part(ind_.regime) + "|" + part(ew_.phase) + "|" +
                            part(pf_.exposure_pct) + "|" + Sha256Hex(joined) +
                            "|" + part(research_revision_) + "|v3";
        return Sha256Hex(parts);
    }
    // Epoch-microseconds conversion for created/expires (frozen P3.2 wire
    // format stays seconds-double; internals use int64 micros).
    static bool UnixMicros(double seconds, int64_t& out) {
        if (!std::isfinite(seconds) || seconds < -62135596800.0 ||
            seconds > 4102444800.0) {
            return false;
        }
        out = (int64_t)(seconds * 1000000.0);
        return true;
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
    std::string EmitIndicators() const {
        std::string o = "{";
        bool first = true;
        auto emit = [&](const char* k, const ScalarField& f) {
            if (!f.present) return;
            if (!first) o += ",";
            first = false;
            o += "\"";
            o += k;
            o += "\":";
            o += f.json;
        };
        emit("atr_bucket", ind_.atr_bucket);
        emit("price_return_bucket", ind_.price_return_bucket);
        emit("regime", ind_.regime);
        emit("zscore", ind_.zscore);
        o += "}";
        return o;
    }
    std::string EmitEventWindow() const {
        std::string o = "{";
        if (ew_.phase.present) o += "\"phase\":" + ew_.phase.json;
        o += "}";
        return o;
    }
    std::string EmitPortfolio() const {
        std::string o = "{";
        if (pf_.exposure_pct.present)
            o += "\"exposure_pct\":" + pf_.exposure_pct.json;
        o += "}";
        return o;
    }
    std::string EmitFeatures() const {
        std::string o = "[";
        for (size_t i = 0; i < feature_ids_.size(); i++) {
            if (i) o += ",";
            std::u32string u;
            std::string why;
            DecodeUtf8(feature_ids_[i], u, why);  // validated at add()
            o += "{\"feature_id\":";
            AppendEscaped(o, u);
            o += "}";
        }
        o += "]";
        return o;
    }
    std::string context_hash_;
    ScalarField symbol_, stage_;
    int64_t epoch_ = -1;  // unset until set_snapshot_epoch
    ScalarField spread_bps_, cycle_id_, research_revision_;
    StateIndicators ind_;
    StatePortfolio pf_;
    StateEventWindow ew_;
    std::vector<std::string> feature_ids_;
};

// Strict pre-check for PARSED external states: every features[] member
// must be an object with a string feature_id (the frozen sidecar skips
// non-dicts; P3.3 refuses non-string IDs outright). Returns "" on ok,
// else the HOLD reason. Run BEFORE ComputeDecisionKey().
inline std::string CheckStateShape(const JVal& state) {
    const JVal* feats = ObjGet(state, "features");
    if (!feats) return "";
    if (feats->t != JVal::T::ARR) return "state-shape:features";
    for (auto& f : feats->a) {
        if (f.t != JVal::T::OBJ) continue;  // sidecar skips non-dicts
        const JVal* id = ObjGet(f, "feature_id");
        if (!id || id->t != JVal::T::STR) return "state-shape:feature_id";
    }
    return "";
}

// Strict closed-schema construction from a parsed state object. Unknown
// top-level keys, wrong scalar types, non-finite doubles, negative
// epochs, or non-v3 question sets fail closed (state-shape). Used by
// tests and by any kernel path that must adopt an externally supplied
// state BEFORE ComputeDecisionKey() runs.
inline bool JEVStateV3::FromJVal(const JVal& st, JEVStateV3& out,
                             std::string& why) {
    if (st.t != JVal::T::OBJ) {
        why = "state-shape:top";
        return false;
    }
    static const char* KNOWN[] = {"context_hash", "symbol", "stage",
                                  "question_set_version", "snapshot_epoch",
                                  "spread_bps", "cycle_id",
                                  "research_revision", "indicators",
                                  "portfolio", "event_window", "features"};
    for (auto& kv : st.o) {
        std::string k = U32ToUtf8(kv.first);
        bool known = false;
        for (auto n : KNOWN)
            if (k == n) {
                known = true;
                break;
            }
        if (!known) {
            why = "state-shape:unknown-key:" + k;
            return false;
        }
    }
    auto req_str = [&](const char* k, std::string& dst) -> bool {
        const JVal* v = ObjGet(st, k);
        if (!v || v->t != JVal::T::STR) {
            why = std::string("state-shape:") + k;
            return false;
        }
        dst = U32ToUtf8(v->s);
        return true;
    };
    std::string ch, sym, stage;
    if (!req_str("context_hash", ch) || !req_str("symbol", sym) ||
        !req_str("stage", stage))
        return false;
    const JVal* qv = ObjGet(st, "question_set_version");
    if (!qv || qv->t != JVal::T::STR || U32ToUtf8(qv->s) != "v3") {
        why = "state-shape:qversion";
        return false;
    }
    const JVal* ep = ObjGet(st, "snapshot_epoch");
    if (!ep || ep->t != JVal::T::NUM || ep->num_double) {
        why = "state-shape:epoch";
        return false;
    }
    int64_t epoch = 0;
    {
        bool neg = false;
        std::string tok = ep->num;
        size_t i = 0;
        if (!tok.empty() && tok[0] == '-') {
            neg = true;
            i = 1;
        }
        for (; i < tok.size(); i++) {
            if (tok[i] < '0' || tok[i] > '9') {
                why = "state-shape:epoch";
                return false;
            }
            epoch = epoch * 10 + (tok[i] - '0');
        }
        if (neg || tok.empty()) {
            why = "state-shape:epoch";
            return false;
        }
    }
    if (!out.set_context_hash(ch, why) || !out.set_symbol(sym, why) ||
        !out.set_stage(stage, why))
        return false;
    out.set_snapshot_epoch(epoch);
    auto opt_scalar = [&](const JVal* v, ScalarField& f,
                          const char* k) -> bool {
        if (!v) return true;  // absent == omitted
        if (v->t == JVal::T::STR) {
            std::string raw = U32ToUtf8(v->s);
            // Round-trip through the escaper input validation: strings
            // are stored via ScalarStr (strict UTF-8 decode inside).
            // JVal strings are already code points; re-encode then set.
            std::string utf8;
            for (char32_t c : v->s) {
                if (c < 0x80) utf8 += (char)c;
                else if (c < 0x800) {
                    utf8 += (char)(0xC0 | (c >> 6));
                    utf8 += (char)(0x80 | (c & 0x3F));
                } else if (c < 0x10000) {
                    utf8 += (char)(0xE0 | (c >> 12));
                    utf8 += (char)(0x80 | ((c >> 6) & 0x3F));
                    utf8 += (char)(0x80 | (c & 0x3F));
                } else {
                    utf8 += (char)(0xF0 | (c >> 18));
                    utf8 += (char)(0x80 | ((c >> 12) & 0x3F));
                    utf8 += (char)(0x80 | ((c >> 6) & 0x3F));
                    utf8 += (char)(0x80 | (c & 0x3F));
                }
            }
            // Lone-surrogate code points cannot exist in valid UTF-8:
            // detect them before ScalarStr (which would accept the
            // re-encoded bytes only if they form valid UTF-8 — surrogates
            // never do, so decode fails closed there too).
            return ScalarStr(f, utf8, why);
        }
        if (v->t == JVal::T::NUM) {
            if (v->num_double) {
                if (!std::isfinite(v->dval)) {
                    why = std::string("state-shape:") + k;
                    return false;
                }
                return ScalarDouble(f, v->dval, why);
            }
            try {
                ScalarInt(f, std::stoll(v->num));
            } catch (...) {
                why = std::string("state-shape:") + k;
                return false;
            }
            return true;
        }
        if (v->t == JVal::T::BOOL) {
            ScalarBool(f, v->b);
            return true;
        }
        why = std::string("state-shape:") + k;
        return false;  // objects/arrays/null are not state scalars
    };
    const JVal* ind = ObjGet(st, "indicators");
    if (ind && ind->t != JVal::T::OBJ) {
        why = "state-shape:indicators";
        return false;
    }
    const JVal* pf = ObjGet(st, "portfolio");
    if (pf && pf->t != JVal::T::OBJ) {
        why = "state-shape:portfolio";
        return false;
    }
    const JVal* ew = ObjGet(st, "event_window");
    if (ew && ew->t != JVal::T::OBJ) {
        why = "state-shape:event_window";
        return false;
    }
    // Regime is required by the closed schema (indicators always emitted).
    const JVal* reg = ind ? ObjGet(*ind, "regime") : nullptr;
    if (!reg || reg->t != JVal::T::STR) {
        why = "state-shape:regime";
        return false;
    }
    if (!out.set_regime(U32ToUtf8(reg->s), why)) return false;
    auto sub = [&](const JVal* o, const char* k, ScalarField& f) -> bool {
        if (!o) return true;
        return opt_scalar(ObjGet(*o, k), f, k);
    };
    if (ind) {
        if (!sub(ind, "price_return_bucket", out.ind_.price_return_bucket) ||
            !sub(ind, "atr_bucket", out.ind_.atr_bucket) ||
            !sub(ind, "zscore", out.ind_.zscore))
            return false;
    }
    if (pf && !sub(pf, "exposure_pct", out.pf_.exposure_pct)) return false;
    if (ew && !sub(ew, "phase", out.ew_.phase)) return false;
    const JVal* sp = ObjGet(st, "spread_bps");
    if (sp && (sp->t != JVal::T::NUM ||
                !opt_scalar(sp, out.spread_bps_, "spread_bps")))
        return false;
    const JVal* cy = ObjGet(st, "cycle_id");
    if (cy && (cy->t != JVal::T::STR ||
                !out.set_cycle_id(U32ToUtf8(cy->s), why)))
        return false;
    const JVal* rr = ObjGet(st, "research_revision");
    if (rr && (rr->t != JVal::T::STR ||
                !out.set_research_revision(U32ToUtf8(rr->s), why)))
        return false;
    const JVal* feats = ObjGet(st, "features");
    if (feats) {
        if (feats->t != JVal::T::ARR) {
            why = "state-shape:features";
            return false;
        }
        for (auto& m : feats->a) {
            if (m.t != JVal::T::OBJ) continue;  // sidecar skips non-dicts
            const JVal* id = ObjGet(m, "feature_id");
            if (!id || id->t != JVal::T::STR) {
                why = "state-shape:feature_id";
                return false;
            }
            // Feature members carry ONLY feature_id in the closed schema.
            if (m.o.size() != 1) {
                why = "state-shape:feature-member";
                return false;
            }
            if (!out.add_feature_id(U32ToUtf8(id->s), why)) return false;
        }
    }
    if (!out.seal(why)) return false;
    return true;
}

}  // namespace jev
