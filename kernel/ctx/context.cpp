// Slice G implementation. Canonical recipe frozen in snapshot.hpp.
#include "snapshot.hpp"

#include <cstdio>

#include "../jev_validate.hpp"  // jev::Sha256Hex (P3.1 primitive)
#include "../stage/stage.hpp"   // Slice E stage vocabulary

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
    // Lowercase 64-hex ONLY: matches the frozen Slice C ingest
    // contract (which rejects uppercase). One representation.
    if (s.size() != 64) return false;
    for (char c : s) {
        if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) return false;
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
    // Duplicate symbols have no discriminator: ambiguous snapshot.
    for (size_t i = 0; i < s.marks.size(); ++i)
        for (size_t j = i + 1; j < s.marks.size(); ++j)
            if (s.marks[i].symbol == s.marks[j].symbol)
                return "mark-duplicate";
    // Bidirectional mask coherence: set => populated+valid, clear =>
    // canonical empty. Ghost data (populated but declared absent) is
    // malformed — downstream must never read it.
    bool has_marks = !s.marks.empty();
    if ((s.present_mask & kMarks) && !has_marks) return "marks-incoherent";
    if (!(s.present_mask & kMarks) && has_marks) return "marks-ghost";
    if (!s.session.empty() && !IsSession(s.session)) return "session";
    bool has_session = !s.session.empty();
    if ((s.present_mask & kSession) && !has_session)
        return "session-incoherent";
    if (!(s.present_mask & kSession) && has_session)
        return "session-ghost";
    if (s.indicators.size() > 5) return "indicators-bound";
    for (const auto& in : s.indicators) {
        if (!SymOk(in.symbol)) return "ind-symbol";
        if (in.vwap_ud <= 0) return "ind-vwap";
    }
    for (size_t i = 0; i < s.indicators.size(); ++i)
        for (size_t j = i + 1; j < s.indicators.size(); ++j)
            if (s.indicators[i].symbol == s.indicators[j].symbol)
                return "ind-duplicate";
    bool has_ind = !s.indicators.empty();
    if ((s.present_mask & kIndicators) && !has_ind)
        return "indicators-incoherent";
    if (!(s.present_mask & kIndicators) && has_ind)
        return "indicators-ghost";
    if (!s.regime.empty() && !IsRegime(s.regime)) return "regime";
    bool has_regime = !s.regime.empty();
    if ((s.present_mask & kRegime) && !has_regime)
        return "regime-incoherent";
    if (!(s.present_mask & kRegime) && has_regime)
        return "regime-ghost";
    // sentiment/var_corr are plain integers: ghost = nonzero while clear.
    bool has_sent = (s.sentiment_d6[0] | s.sentiment_d6[1] |
                     s.sentiment_d6[2] | s.sentiment_d6[3]) != 0;
    if (!(s.present_mask & kSentiment) && has_sent)
        return "sentiment-ghost";
    if (s.var_corr_flags & ~0x3u) return "varcorr-reserved";
    bool has_vc = s.var_corr_flags != 0;
    if (!(s.present_mask & kVarCorr) && has_vc) return "varcorr-ghost";
    // Portfolio: explicitly present zero is legitimate (flat book);
    // ghost = nonzero while clear.
    if ((s.present_mask & kPortfolio) &&
        (s.equity_ud < 0 || s.exposure_ud < 0 || s.buying_power_ud < 0))
        return "portfolio-negative";
    bool has_pf = (s.equity_ud != 0 || s.exposure_ud != 0 ||
                   s.buying_power_ud != 0 || s.pending_count != 0);
    if (!(s.present_mask & kPortfolio) && has_pf)
        return "portfolio-ghost";
    bool has_feat = (s.feature_bundle_id != 0 ||
                     !s.feature_bundle_hash.empty());
    if ((s.present_mask & kFeatures) &&
        (s.feature_bundle_id == 0 || !Hex64(s.feature_bundle_hash)))
        return "features-incoherent";
    if (!(s.present_mask & kFeatures) && has_feat)
        return "features-ghost";
    if (s.sources.size() > 8) return "sources-bound";
    for (const auto& src : s.sources) {
        if (!NameOk(src.name) || !IsSourceState(src.state))
            return "source-row";
    }
    for (size_t i = 0; i < s.sources.size(); ++i)
        for (size_t j = i + 1; j < s.sources.size(); ++j)
            if (s.sources[i].name == s.sources[j].name)
                return "source-duplicate";
    bool has_sources = !s.sources.empty();
    if ((s.present_mask & kSources) && !has_sources)
        return "sources-incoherent";
    if (!(s.present_mask & kSources) && has_sources)
        return "sources-ghost";
    if (!s.stage.empty() && !stage::IsKnownStage(s.stage))
        return "stage";
    bool has_stage = !s.stage.empty();
    if ((s.present_mask & kStage) && !has_stage)
        return "stage-incoherent";
    if (!(s.present_mask & kStage) && has_stage)
        return "stage-ghost";
    bool has_research = s.research_revision != 0;
    if ((s.present_mask & kResearch) && !has_research)
        return "research-incoherent";  // revision 0 IS absent
    if (!(s.present_mask & kResearch) && has_research)
        return "research-ghost";
    if (!s.calib.empty() && !IsCalib(s.calib)) return "calib";
    bool has_calib = !s.calib.empty() || s.brier_d6 != 0;
    if ((s.present_mask & kCalib) && s.calib.empty())
        return "calib-incoherent";  // verdict is the section core;
    if (!(s.present_mask & kCalib) && has_calib)
        return "calib-ghost";
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
