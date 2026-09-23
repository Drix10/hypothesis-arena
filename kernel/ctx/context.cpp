// Slice G implementation. Canonical recipe frozen in snapshot.hpp.
#include "snapshot.hpp"

#include <cstdio>

#include "../jev_validate.hpp"  // jev::Sha256Hex (P3.1 primitive)
#include "../stage/stage.hpp"   // stage::IsKnownStage (Slice E vocab)

namespace ctx {
namespace {

bool SymOk(const std::string& s) {
    if (s.empty() || s.size() > 12) return false;
    for (char c : s) {
        if ((c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '.')
            return false;
    }
    return true;
}

bool NameOk(const std::string& s) {
    if (s.empty() || s.size() > 32) return false;
    for (char c : s) {
        if ((c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_')
            return false;
    }
    return true;
}

bool Hex64(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s) {
        if ((c < '0' || c > '9') && (c < 'a' || c > 'f') &&
            (c < 'A' || c > 'F'))
            return false;
    }
    return true;
}

// JSON string escape for the canonical form.
std::string Esc(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        unsigned char u = static_cast<unsigned char>(c);
        if (c == '"' || c == '\\') {
            o += '\\';
            o += c;
        } else if (u < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", u);
            o += buf;
        } else {
            o += c;
        }
    }
    o += '"';
    return o;
}

}  // namespace

std::string ValidateSnapshot(const Snapshot& s) {
    if (s.marks.size() > 5) return "marks-bound";
    for (const auto& m : s.marks) {
        if (!SymOk(m.symbol)) return "mark-symbol";
        if (m.mark_ud <= 0 || m.bid_ud <= 0 || m.ask_ud < m.bid_ud)
            return "mark-quote";
    }
    if ((s.present_mask & kMarks) && s.marks.empty())
        return "marks-incoherent";
    if (!s.session.empty() && !IsSession(s.session)) return "session";
    if ((s.present_mask & kSession) && s.session.empty())
        return "session-incoherent";
    if (s.indicators.size() > 5) return "indicators-bound";
    for (const auto& in : s.indicators) {
        if (!SymOk(in.symbol)) return "ind-symbol";
        if (in.vwap_ud <= 0) return "ind-vwap";
    }
    if ((s.present_mask & kIndicators) && s.indicators.empty())
        return "indicators-incoherent";
    if (!s.regime.empty() && !IsRegime(s.regime)) return "regime";
    if ((s.present_mask & kRegime) && s.regime.empty())
        return "regime-incoherent";
    // sentiment/var_corr are plain integers: mask coherence only.
    if ((s.present_mask & kPortfolio) &&
        (s.equity_ud < 0 || s.exposure_ud < 0 || s.buying_power_ud < 0))
        return "portfolio-negative";
    if ((s.present_mask & kFeatures) &&
        (s.feature_bundle_id == 0 || !Hex64(s.feature_bundle_hash)))
        return "features-incoherent";
    if (s.sources.size() > 8) return "sources-bound";
    for (const auto& src : s.sources) {
        if (!NameOk(src.name) || !IsSourceState(src.state))
            return "source-row";
    }
    if ((s.present_mask & kSources) && s.sources.empty())
        return "sources-incoherent";
    if (!s.stage.empty() && !stage::IsKnownStage(s.stage))
        return "stage";
    if ((s.present_mask & kStage) && s.stage.empty())
        return "stage-incoherent";
    if (!s.calib.empty() && !IsCalib(s.calib)) return "calib";
    if ((s.present_mask & kCalib) && s.calib.empty())
        return "calib-incoherent";
    if (s.present_mask & ~0xFFFu) return "mask-reserved";
    return "";
}

std::string CanonicalSnapshot(const Snapshot& s) {
    // Top-level keys ASCII-sorted; nested objects fixed order.
    std::string o = "{";
    o += "\"brier_d6\":" + std::to_string(s.brier_d6);
    o += ",\"buying_power_ud\":" + std::to_string(s.buying_power_ud);
    o += ",\"calib\":" + Esc(s.calib);
    o += ",\"equity_ud\":" + std::to_string(s.equity_ud);
    o += ",\"exposure_ud\":" + std::to_string(s.exposure_ud);
    std::string feat =
        "{\"bundle_hash\":" + Esc(s.feature_bundle_hash) +
        ",\"bundle_id\":" + std::to_string(s.feature_bundle_id) + "}";
    o += ",\"features\":" + feat;
    o += ",\"indicators\":[";
    for (size_t i = 0; i < s.indicators.size(); ++i) {
        const auto& in = s.indicators[i];
        if (i) o += ",";
        o += "{\"atr_d6\":" + std::to_string(in.atr_d6) +
             ",\"rsi_d6\":" + std::to_string(in.rsi_d6) +
             ",\"symbol\":" + Esc(in.symbol) +
             ",\"vwap_ud\":" + std::to_string(in.vwap_ud) +
             ",\"z_d6\":" + std::to_string(in.z_d6) + "}";
    }
    o += "]";
    o += ",\"marks\":[";
    for (size_t i = 0; i < s.marks.size(); ++i) {
        const auto& m = s.marks[i];
        if (i) o += ",";
        o += "{\"ask_ud\":" + std::to_string(m.ask_ud) +
             ",\"bid_ud\":" + std::to_string(m.bid_ud) +
             ",\"mark_ud\":" + std::to_string(m.mark_ud) +
             ",\"symbol\":" + Esc(m.symbol) + "}";
    }
    o += "]";
    o += ",\"pending_count\":" + std::to_string(s.pending_count);
    o += ",\"present_mask\":" + std::to_string(s.present_mask);
    o += ",\"regime\":" + Esc(s.regime);
    o += ",\"research_revision\":" + std::to_string(s.research_revision);
    o += ",\"sentiment_d6\":[" + std::to_string(s.sentiment_d6[0]) + "," +
         std::to_string(s.sentiment_d6[1]) + "," +
         std::to_string(s.sentiment_d6[2]) + "," +
         std::to_string(s.sentiment_d6[3]) + "]";
    o += ",\"session\":" + Esc(s.session);
    o += ",\"sources\":[";
    for (size_t i = 0; i < s.sources.size(); ++i) {
        const auto& src = s.sources[i];
        if (i) o += ",";
        o += "{\"name\":" + Esc(src.name) +
             ",\"state\":" + Esc(src.state) + "}";
    }
    o += "]";
    o += ",\"stage\":" + Esc(s.stage);
    o += ",\"var_corr_flags\":" + std::to_string(s.var_corr_flags);
    o += "}";
    return o;
}

std::string ContextHash(const Snapshot& s) {
    return jev::Sha256Hex(CanonicalSnapshot(s));
}

}  // namespace ctx
