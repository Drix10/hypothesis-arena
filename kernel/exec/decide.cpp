#include "decide.hpp"

#include <cstring>

#include "../risk/sizing.hpp"

namespace jev {
namespace exec {
namespace {

EntryDecision Hold(const std::string& reason, const std::string& cid = "",
                   const std::string& symbol = "") {
    EntryDecision d;
    d.reason = reason;
    d.cid = cid;
    d.symbol = symbol;
    return d;
}

void Copy(char* dst, size_t cap, const std::string& s) {
    std::strncpy(dst, s.c_str(), cap - 1);
    dst[cap - 1] = '\0';
}

// Exit profile -> protection shape (doc 06 6.0 table). Trend and the plain
// profile keep the bracket until the live drill settles how a resting stop and
// a sell interact; intraday and event profiles are stop-only. Unknown
// profiles are refused.
bool ProtectionFor(const std::string& profile, broker::Protection* p,
                   bool* gtc) {
    *gtc = false;
    if (profile == "exit_profile_v1" || profile == "exit_trend_v1") {
        // Multi-day holds: day legs would expire at the close and leave the
        // position without a stop overnight.
        *p = broker::Protection::BRACKET;
        *gtc = true;
    } else if (profile == "exit_intraday_v1") {
        *p = broker::Protection::OTO_STOP;
    } else if (profile == "exit_event_v1") {
        *p = broker::Protection::OTO_STOP;
        *gtc = true;
    } else {
        return false;
    }
    return true;
}

}  // namespace

EntryDecision Decide(const DecideInput& in) {
    if (!in.record) return Hold("bad-inputs");
    ingest::CandOutcome c =
        ingest::ValidateCandidate(*in.record, in.tables, in.now_ns);
    if (!c.accepted) return Hold(ingest::CandRejectStr(c.code));
    if (c.side == "SELL") {
        auto it = in.held_qty.find(c.symbol);
        if (it == in.held_qty.end() || it->second <= 0)
            return Hold("exit-no-position", c.cid, c.symbol);
        risk::RiskSnapshot x = in.state;
        x.filter = risk::FilterPolicy::NONE;
        x.intent.kind = risk::IntentKind::EXIT;
        x.intent.symbol = c.symbol;
        x.intent.side = risk::Side::SHORT;  // a sell against a long
        x.intent.notional_cents = (int64_t)((__int128)it->second * c.entry_cents);
        x.intent.has_stop = true;
        x.intent.asset = risk::AssetClass::STOCK;
        x.intent.account = risk::AccountType::CASH;
        x.now_us = in.now_ns / 1000;
        risk::VetoVerdict xv = risk::EvaluateVeto(x);
        if (!xv.proceed) return Hold(xv.reason, c.cid, c.symbol);
        EntryDecision d;
        d.proceed = true;
        d.reason = "proceed";
        d.limiter = "full-position";
        d.cid = c.cid;
        d.symbol = c.symbol;
        Copy(d.intent.intent_id, sizeof(d.intent.intent_id), c.cid);
        Copy(d.intent.symbol, sizeof(d.intent.symbol), c.symbol);
        d.intent.side = broker::OrderSide::SELL;
        d.intent.qty_shares = it->second;
        d.intent.stop_cents = c.stop_cents;
        d.intent.tp_cents = c.tp_cents;
        d.intent.kind = risk::IntentKind::EXIT;
        return d;
    }

    risk::RiskSnapshot s = in.state;
    s.filter = risk::FilterPolicy::NONE;
    risk::StageScale st = risk::ScaleFor(s.stage);
    risk::SizingInput si;
    si.equity_cents = s.equity_cents;
    si.risk_bp = in.risk_bp;
    si.entry_cents = c.entry_cents;
    si.stop_cents = c.stop_cents;
    if (s.r6_trip) si.scale_den = 2;
    si.stage_num = st.mult_num;
    si.stage_den = st.mult_den;
    __int128 pending = 0;
    for (const auto& p : s.pending)
        if (p.side == risk::Side::LONG) pending += p.notional_cents;
    __int128 free_cash = (__int128)s.settled_cash_cents - pending;
    si.settled_cash_cents = free_cash > 0 ? (int64_t)free_cash : 0;
    si.r2_headroom_cents = INT64_MAX;  // the veto below is the R2 authority
    si.liquidity_cap_shares = in.liquidity_cap_shares;
    risk::Sizing z = risk::ComputeSize(si);
    if (z.qty <= 0) return Hold(z.limiter, c.cid, c.symbol);

    s.v3_constraints = true;
    s.instrument_allowed = true;  // the candidate gate checked the allowlist
    s.intent.kind = risk::IntentKind::ENTRY;
    s.intent.symbol = c.symbol;
    s.intent.side = risk::Side::LONG;
    s.intent.notional_cents = (int64_t)((__int128)z.qty * c.entry_cents);
    s.intent.has_stop = true;
    s.intent.asset = risk::AssetClass::STOCK;
    s.intent.account = risk::AccountType::CASH;
    s.now_us = in.now_ns / 1000;
    risk::VetoVerdict v = risk::EvaluateVeto(s);
    if (!v.proceed) return Hold(v.reason, c.cid, c.symbol);
    // A drift-removal directive must be executed and reconciled before any
    // new entry (veto.hpp H1 contract); until that path exists, hold.
    if (v.drift_idx >= 0) return Hold("r7-drift-directive-pending", c.cid, c.symbol);

    broker::Protection prot = broker::Protection::BRACKET;
    bool gtc = false;
    if (!ProtectionFor(c.exit_profile, &prot, &gtc))
        return Hold("cand-exit-profile", c.cid, c.symbol);

    EntryDecision d;
    d.proceed = true;
    d.reason = "proceed";
    d.limiter = z.limiter;
    d.cid = c.cid;
    d.symbol = c.symbol;
    Copy(d.intent.intent_id, sizeof(d.intent.intent_id), c.cid);
    Copy(d.intent.symbol, sizeof(d.intent.symbol), c.symbol);
    d.intent.side = broker::OrderSide::BUY;
    d.intent.qty_shares = z.qty;
    d.intent.stop_cents = c.stop_cents;
    d.intent.tp_cents = c.tp_cents;
    d.intent.kind = risk::IntentKind::ENTRY;
    d.intent.protection = prot;
    d.intent.gtc = gtc;
    d.intent.scale_num = 1;
    d.intent.scale_den = v.size_scale < 1.0 ? 2 : 1;
    d.intent.stage_num = v.stage_num;
    d.intent.stage_den = v.stage_den;
    return d;
}

}  // namespace exec
}  // namespace jev
