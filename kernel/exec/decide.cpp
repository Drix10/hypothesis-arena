#include "decide.hpp"

#include <cstring>

#include "../risk/sizing.hpp"

namespace jev {
namespace exec {
namespace {

EntryDecision Hold(const std::string& reason, const std::string& cid = "") {
    EntryDecision d;
    d.reason = reason;
    d.cid = cid;
    return d;
}

void Copy(char* dst, size_t cap, const std::string& s) {
    std::strncpy(dst, s.c_str(), cap - 1);
    dst[cap - 1] = '\0';
}

}  // namespace

EntryDecision Decide(const DecideInput& in) {
    if (!in.record) return Hold("bad-inputs");
    ingest::CandOutcome c =
        ingest::ValidateCandidate(*in.record, in.tables, in.now_ns);
    if (!c.accepted) return Hold(ingest::CandRejectStr(c.code));
    if (c.side != "BUY") return Hold("exit-path-not-sized", c.cid);

    risk::RiskSnapshot s = in.state;
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
    if (z.qty <= 0) return Hold(z.limiter, c.cid);

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
    if (!v.proceed) return Hold(v.reason, c.cid);
    // A drift-removal directive must be executed and reconciled before any
    // new entry (veto.hpp H1 contract); until that path exists, hold.
    if (v.drift_idx >= 0) return Hold("r7-drift-directive-pending", c.cid);

    EntryDecision d;
    d.proceed = true;
    d.reason = "proceed";
    d.limiter = z.limiter;
    d.cid = c.cid;
    Copy(d.intent.intent_id, sizeof(d.intent.intent_id), c.cid);
    Copy(d.intent.symbol, sizeof(d.intent.symbol), c.symbol);
    d.intent.side = broker::OrderSide::BUY;
    d.intent.qty_shares = z.qty;
    d.intent.stop_cents = c.stop_cents;
    d.intent.tp_cents = c.tp_cents;
    d.intent.kind = risk::IntentKind::ENTRY;
    d.intent.scale_num = 1;
    d.intent.scale_den = v.size_scale < 1.0 ? 2 : 1;
    d.intent.stage_num = v.stage_num;
    d.intent.stage_den = v.stage_den;
    return d;
}

}  // namespace exec
}  // namespace jev
