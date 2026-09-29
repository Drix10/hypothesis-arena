#include "account.hpp"

#include "../jev_validate.hpp"

namespace jev {
namespace runner {
namespace {

const JVal* Get(const JVal& o, const char* k) {
    std::u32string key;
    for (const char* p = k; *p; ++p) key.push_back((char32_t)(unsigned char)*p);
    return o.find(key);
}

bool Str(const JVal& o, const char* k, std::string* out) {
    const JVal* v = Get(o, k);
    if (!v || v->t != JVal::T::STR) return false;
    *out = U32ToUtf8(v->s);
    return true;
}

bool Bool(const JVal& o, const char* k, bool* out) {
    const JVal* v = Get(o, k);
    if (!v || v->t != JVal::T::BOOL) return false;
    *out = v->b;
    return true;
}

bool ParseInt(const std::string& s, int64_t* out) {
    if (s.empty() || s.size() > 15) return false;
    int64_t v = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        v = v * 10 + (c - '0');
    }
    *out = v;
    return true;
}

bool Money(const JVal& o, const char* k, int64_t* out) {
    std::string s;
    return Str(o, k, &s) && ParseMoneyCents(s, out);
}

}  // namespace

bool ParseMoneyCents(const std::string& s, int64_t* out) {
    if (s.empty() || s.size() > 24) return false;
    size_t i = 0;
    bool neg = false;
    if (s[0] == '-') {
        neg = true;
        i = 1;
    }
    size_t dot = s.find('.', i);
    std::string whole = s.substr(i, dot == std::string::npos ? dot : dot - i);
    std::string frac = dot == std::string::npos ? "" : s.substr(dot + 1);
    if (whole.empty() || whole.size() > 13) return false;
    if (dot != std::string::npos && frac.empty()) return false;
    int64_t w = 0;
    if (!ParseInt(whole, &w)) return false;
    int64_t cents = w * 100;
    for (size_t k = 0; k < frac.size(); ++k) {
        char c = frac[k];
        if (c < '0' || c > '9') return false;
        if (k < 2) cents += (c - '0') * (k == 0 ? 10 : 1);  // rest truncated
    }
    *out = neg ? -cents : cents;
    return true;
}

bool ParseAccount(const std::string& body, AccountView* out) {
    JVal v;
    std::string err;
    if (!ParseJson(body, v, err) || v.t != JVal::T::OBJ) return false;
    AccountView a;
    std::string status;
    bool acct_blocked = true, trade_blocked = true;
    int64_t nmbp = 0;
    if (!Money(v, "equity", &a.equity_cents) ||
        !Money(v, "last_equity", &a.last_equity_cents) ||
        !Money(v, "cash", &a.cash_cents) ||
        !Money(v, "non_marginable_buying_power", &nmbp) ||
        !Str(v, "status", &status) || !Bool(v, "account_blocked", &acct_blocked) ||
        !Bool(v, "trading_blocked", &trade_blocked))
        return false;
    a.settled_cash_cents = a.cash_cents < nmbp ? a.cash_cents : nmbp;
    if (a.settled_cash_cents < 0) a.settled_cash_cents = 0;
    a.blocked = status != "ACTIVE" || acct_blocked || trade_blocked;
    *out = a;
    return true;
}

bool ParsePositions(const std::string& body, std::vector<PositionView>* out) {
    JVal v;
    std::string err;
    if (!ParseJson(body, v, err) || v.t != JVal::T::ARR) return false;
    std::vector<PositionView> ps;
    for (const JVal& e : v.a) {
        if (e.t != JVal::T::OBJ) return false;
        PositionView p;
        std::string qty, side;
        if (!Str(e, "symbol", &p.symbol) || p.symbol.empty() ||
            !Str(e, "qty", &qty) || !Str(e, "side", &side) ||
            !Money(e, "market_value", &p.market_value_cents))
            return false;
        int64_t q = 0;
        if (!ParseMoneyCents(qty, &q)) return false;  // qty may be fractional
        p.qty = q / 100;
        size_t dot = qty.find('.');
        if (dot != std::string::npos)
            for (size_t k = dot + 1; k < qty.size(); ++k)
                if (qty[k] != '0') p.fractional = true;
        p.is_long = side == "long";
        if (side != "long" && side != "short") return false;
        ps.push_back(p);
    }
    *out = ps;
    return true;
}

bool ParseOpenOrders(const std::string& body, std::vector<OrderView>* out) {
    JVal v;
    std::string err;
    if (!ParseJson(body, v, err) || v.t != JVal::T::ARR) return false;
    std::vector<OrderView> os;
    for (const JVal& e : v.a) {
        if (e.t != JVal::T::OBJ) return false;
        OrderView o;
        std::string side, qty, filled;
        if (!Str(e, "symbol", &o.symbol) || o.symbol.empty() ||
            !Str(e, "side", &side) || (side != "buy" && side != "sell") ||
            !Str(e, "qty", &qty) || !Str(e, "filled_qty", &filled))
            return false;
        int64_t q = 0, f = 0;
        if (!ParseMoneyCents(qty, &q) || !ParseMoneyCents(filled, &f) ||
            f > q)
            return false;
        o.is_buy = side == "buy";
        o.remaining_qty = (q - f + 99) / 100;  // any remainder counts as a share
        if (o.remaining_qty > 0) os.push_back(o);
    }
    *out = os;
    return true;
}

}  // namespace runner
}  // namespace jev
