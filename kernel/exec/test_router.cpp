// H1 gate [correctness]: router lifecycle matrix — journal-first,
// protected-only entry, one-query reconcile, partials, unknown-freeze,
// exit survival, emergency exception, stable identity, crash recovery.
// Usage: ./test_router
#include <cstdio>

#include "router.hpp"

static int g_fail = 0;
static int g_count = 0;

static void Check(bool cond, const char* name) {
    ++g_count;
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

using jev::broker::OrderSide;
using jev::exec::OrderIntent;
using jev::exec::RouteAction;
using jev::exec::RouteMachine;
using jev::exec::RouteObs;
using jev::exec::RouteState;
using jev::exec::VenueCtx;
using jev::risk::IntentKind;
using jev::risk::KillLevel;

static void FillId(char (&d)[65], const char* s) {
    int i = 0;
    while (s[i] && i < 64) {
        d[i] = s[i];
        ++i;
    }
    d[i] = '\0';
}

static OrderIntent GoodEntry() {
    OrderIntent in;
    FillId(in.intent_id, "intent-001");
    in.symbol[0] = 'A';
    in.symbol[1] = 'A';
    in.symbol[2] = 'P';
    in.symbol[3] = 'L';
    in.symbol[4] = '\0';
    in.side = OrderSide::BUY;
    in.qty_shares = 100;
    in.stop_cents = 22000;
    in.tp_cents = 24000;
    in.kind = IntentKind::ENTRY;
    return in;
}

static VenueCtx GoodVenue() {
    VenueCtx v;
    const char* b = "alpaca-paper";
    const char* a = "paper-acct-7";
    int i = 0;
    while (b[i]) {
        v.broker[i] = b[i];
        ++i;
    }
    v.broker[i] = '\0';
    i = 0;
    while (a[i]) {
        v.account[i] = a[i];
        ++i;
    }
    v.account[i] = '\0';
    for (int k = 0; k < 64; ++k) v.context_hash[k] = 'a' + (k % 26);
    v.context_hash[64] = '\0';
    return v;
}

static RouteObs OpenMarket() {
    RouteObs o;
    o.journal_ok = true;
    o.adapter_responded = true;
    o.query_due = true;
    o.stage_entry_ok = true;
    return o;
}

int main() {
    using jev::exec::RouteStep;
    OrderIntent in = GoodEntry();
    VenueCtx venue = GoodVenue();
    // 1. entry happy path: journal -> send -> query -> fill
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        Check(r1.action == RouteAction::WRITE_JOURNAL, "happy-journal");
        auto r2 = RouteStep(r1.next, in, venue, o);
        Check(r2.action == RouteAction::SEND_PROTECTED, "happy-send");
        o.journal_ok = false;
        o.adapter_responded = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        Check(r3.action == RouteAction::QUERY_ONCE, "happy-query");
        o.adapter_responded = true;
        o.query.found = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        auto r4 = RouteStep(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_FILL &&
                  r4.next.state == RouteState::PROTECTED,
              "happy-fill");
        auto r5 = RouteStep(r4.next, in, venue, o);
        Check(r5.action == RouteAction::NONE, "happy-terminal");
    }
    // 2. journal-before-order is absolute for entries
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        o.journal_ok = false;
        auto r2 = RouteStep(r1.next, in, venue, o);
        Check(r2.action == RouteAction::REJECT &&
                  r2.next.state == RouteState::CANCELLED,
              "no-row-no-send");
    }
    // 3. bad intents rejected (shape + frozen scalar vocabulary)
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        OrderIntent bad = in;
        bad.qty_shares = 0;
        Check(RouteStep(m, bad, venue, o).reason != nullptr &&
                  RouteStep(m, bad, venue, o).action ==
                      RouteAction::REJECT,
              "reject-zero-qty");
        bad = in;
        bad.stop_cents = 0;
        Check(RouteStep(m, bad, venue, o).action == RouteAction::REJECT,
              "reject-no-stop");
        bad = in;
        bad.scale_num = 2;
        Check(RouteStep(m, bad, venue, o).action == RouteAction::REJECT,
              "reject-bad-scale");
        bad = in;
        bad.stage_num = 3;
        Check(RouteStep(m, bad, venue, o).action == RouteAction::REJECT,
              "reject-bad-stage");
    }
    // 4. entry gates: kill / stale / stage / frozen
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        RouteObs k = o;
        k.kill = KillLevel::SOFT;
        auto r = RouteStep(m, in, venue, k);
        Check(r.action == RouteAction::REJECT, "gate-kill-soft");
        k.kill = KillLevel::HARD;
        r = RouteStep(m, in, venue, k);
        Check(r.action == RouteAction::REJECT, "gate-kill-hard");
        RouteObs s = o;
        s.feed_stale = true;
        r = RouteStep(m, in, venue, s);
        Check(r.action == RouteAction::REJECT, "gate-stale");
        RouteObs g = o;
        g.stage_entry_ok = false;
        r = RouteStep(m, in, venue, g);
        Check(r.action == RouteAction::REJECT, "gate-stage");
        RouteObs f = o;
        f.symbol_frozen = true;
        r = RouteStep(m, in, venue, f);
        Check(r.action == RouteAction::REJECT, "gate-frozen");
    }
    // 5. exits ignore kill/stale/stage gates
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine m;
        m.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        o.kill = KillLevel::HARD;
        o.feed_stale = true;
        o.stage_entry_ok = false;
        auto r1 = RouteStep(m, ex, venue, o);
        Check(r1.action == RouteAction::WRITE_JOURNAL, "exit-gaps-open");
        auto r2 = RouteStep(r1.next, ex, venue, o);
        Check(r2.action == RouteAction::EXECUTE_EXIT, "exit-exec");
        o.executed = true;
        auto r3 = RouteStep(r2.next, ex, venue, o);
        Check(r3.action == RouteAction::JOURNAL_EXIT &&
                  r3.next.state == RouteState::CLOSED,
              "exit-closed");
    }
    // 6. emergency exception: EXIT journal fails -> act, then buffer
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine m;
        m.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, ex, venue, o);
        o.journal_ok = false;
        auto r2 = RouteStep(r1.next, ex, venue, o);
        Check(r2.action == RouteAction::EXECUTE_EMERGENCY &&
                  r2.next.state == RouteState::EXIT_EMERGENCY &&
                  r2.next.emergency,
              "emergency-exec-first");
        o.executed = true;
        auto r3 = RouteStep(r2.next, ex, venue, o);
        Check(r3.action == RouteAction::BUFFER_EMERGENCY &&
                  r3.next.state == RouteState::CLOSED,
              "emergency-buffered");
    }
    // 7. rejected entry -> journal cancel, terminal
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.adapter_responded = true;
        o.ack.accepted = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        Check(r3.action == RouteAction::JOURNAL_CANCEL &&
                  r3.next.state == RouteState::CANCELLED,
              "entry-rejected");
    }
    // 8. naked ack (no protection) -> cancel path, never hold naked
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.ack.accepted = true;
        o.ack.protection_accepted = false;
        o.ack.filled_qty = 0;
        auto r3 = RouteStep(r2.next, in, venue, o);
        Check(r3.action == RouteAction::CANCEL_REMAINDER &&
                  r3.next.state == RouteState::CANCEL_SENT,
              "naked-cancels");
    }
    // 9. nothing filled -> cancel -> confirm -> cancelled
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        Check(r3.action == RouteAction::QUERY_ONCE, "timeout-queries");
        o.adapter_responded = true;
        o.query.found = true;
        o.query.filled_qty = 0;
        auto r4 = RouteStep(r3.next, in, venue, o);
        Check(r4.action == RouteAction::CANCEL_REMAINDER, "empty-cancels");
        o.adapter_responded = false;
        auto r5 = RouteStep(r4.next, in, venue, o);
        Check(r5.action == RouteAction::CONFIRM_CANCELLED,
              "cancel-confirm-step");
        o.adapter_responded = true;
        o.cancel_confirmed = true;
        auto r6 = RouteStep(r4.next, in, venue, o);
        Check(r6.action == RouteAction::JOURNAL_CANCEL &&
                  r6.next.state == RouteState::CANCELLED,
              "cancel-closed");
    }
    // 10. partial: journal partial -> cancel remainder -> protected
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.filled_qty = 40;
        o.query.protection_active = true;
        auto r4 = RouteStep(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_PARTIAL &&
                  r4.next.state == RouteState::PARTIAL_AWAIT &&
                  r4.next.filled_qty == 40,
              "partial-journaled");
        o.journal_ok = false;
        auto r4b = RouteStep(r4.next, in, venue, o);
        Check(r4b.action == RouteAction::NONE, "partial-waits-row");
        o.journal_ok = true;
        auto r5 = RouteStep(r4.next, in, venue, o);
        Check(r5.action == RouteAction::CANCEL_REMAINDER, "partial-cancel");
        o.adapter_responded = true;
        o.cancel_confirmed = true;
        auto r6 = RouteStep(r5.next, in, venue, o);
        Check(r6.action == RouteAction::JOURNAL_CANCEL &&
                  r6.next.state == RouteState::PROTECTED &&
                  r6.next.filled_qty == 40,
              "partial-protected");
    }
    // 11. cancel failed -> UNKNOWN + freeze (never "filled")
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = false;
        auto r4 = RouteStep(r3.next, in, venue, o);
        o.cancel_confirmed = false;
        auto r5 = RouteStep(r4.next, in, venue, o);
        Check(r5.action == RouteAction::JOURNAL_UNKNOWN &&
                  r5.next.state == RouteState::UNKNOWN_FROZEN &&
                  r5.freeze_symbol,
              "unknown-freezes");
        auto r6 = RouteStep(r5.next, in, venue, o);
        Check(r6.action == RouteAction::NONE, "unknown-terminal");
        // Frozen symbol blocks the next intent on it.
        RouteMachine m2;
        RouteObs f = OpenMarket();
        f.symbol_frozen = true;
        Check(RouteStep(m2, in, venue, f).action == RouteAction::REJECT,
              "frozen-blocks-next");
    }
    // 12. identity stability: two independent runs mint the same ID;
    // machine state matches a fresh recompute (retry reuses it).
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r1b = RouteStep(m, in, venue, o);
        bool same = true;
        for (int i = 0; i < 65; ++i)
            if (r1.next.client_id[i] != r1b.next.client_id[i]) same = false;
        Check(same && r1.next.client_id[0] != '\0', "id-stable");
        char fresh[65];
        bool ok = jev::broker::MakeClientOrderId(
            venue.broker, venue.account, venue.context_hash,
            in.symbol,
            in.side, in.intent_id, fresh);
        bool match = ok;
        for (int i = 0; i < 65 && match; ++i)
            if (fresh[i] != r1.next.client_id[i]) match = false;
        Check(match, "id-matches-recipe");
    }
    // 13. crash-after-send: restarted SENT_UNACKED reconciles first —
    // the machine can never SEND from any non-IDLE state.
    {
        RouteMachine m;
        m.state = RouteState::SENT_UNACKED;
        m.kind = IntentKind::ENTRY;
        RouteObs o = OpenMarket();
        o.adapter_responded = false;
        o.query_due = true;
        auto r = RouteStep(m, in, venue, o);
        Check(r.action == RouteAction::QUERY_ONCE &&
                  r.next.state == RouteState::QUERY_SENT,
              "crash-reconciles-first");
        o.adapter_responded = true;
        o.query.found = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        auto r2 = RouteStep(r.next, in, venue, o);
        Check(r2.action == RouteAction::JOURNAL_FILL, "crash-adopts-fill");
    }
    // 14. duplicate delivery is idempotent: PROTECTED never re-journals.
    {
        RouteMachine m;
        m.state = RouteState::PROTECTED;
        RouteObs o = OpenMarket();
        o.query.found = true;
        o.query.filled_qty = 100;
        auto r = RouteStep(m, in, venue, o);
        Check(r.action == RouteAction::NONE, "duplicate-quiet");
    }
    // 15. drift-directive ordering pattern: EXIT closes before ENTRY.
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine me;
        me.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        auto e1 = RouteStep(me, ex, venue, o);
        auto e2 = RouteStep(e1.next, ex, venue, o);
        o.executed = true;
        auto e3 = RouteStep(e2.next, ex, venue, o);
        Check(e3.next.state == RouteState::CLOSED, "drift-exit-closed");
        RouteMachine mn;
        auto n1 = RouteStep(mn, in, venue, o);
        Check(n1.action == RouteAction::WRITE_JOURNAL, "entry-after-exit");
    }
    if (g_fail == 0) std::printf("ROUTER SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
