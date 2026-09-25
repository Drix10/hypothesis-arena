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
        o.query.transport_ok = true;
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
        o.query.transport_ok = true;
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
        o.query.transport_ok = true;
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
        o.query.transport_ok = true;
        auto r4 = RouteStep(r3.next, in, venue, o);
        o.cancel_confirmed = false;
        o.cancel_failed = true;  // explicit broker rejection -> UNKNOWN
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
        o.query.transport_ok = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        auto r2 = RouteStep(r.next, in, venue, o);
        Check(r2.action == RouteAction::JOURNAL_FILL, "crash-adopts-fill");
    }
    // 14. duplicate delivery is idempotent: PROTECTED never re-journals.
    {
        RouteMachine m;
        m.state = RouteState::PROTECTED;
        m.protection_ok = true;  // legitimate resting machine
        RouteObs o = OpenMarket();
        o.query.found = true;
        o.query.transport_ok = true;
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
    // 16. P0: filled-without-protection is NEVER a cancel of a
    // nonexistent remainder and NEVER silently PROTECTED. Repair now.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        // naked ack, partial fill -> ESTABLISH, not cancel
        o.ack.accepted = true;
        o.ack.protection_accepted = false;
        o.ack.filled_qty = 30;
        auto r3 = RouteStep(r2.next, in, venue, o);
        Check(r3.action == RouteAction::ESTABLISH_PROTECTION &&
                  r3.next.state == RouteState::REPAIR_SENT &&
                  r3.next.filled_qty == 30,
              "naked-partial-repairs");
        // naked ack, full fill -> ESTABLISH (no remainder exists)
        o.ack.filled_qty = 100;
        auto r3b = RouteStep(r2.next, in, venue, o);
        Check(r3b.action == RouteAction::ESTABLISH_PROTECTION,
              "naked-full-repairs");
        // repair succeeds -> JOURNAL_REPAIR -> PROTECTED
        o.adapter_responded = true;
        o.repair_ok = true;
        auto r4 = RouteStep(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_REPAIR &&
                  r4.next.state == RouteState::PROTECTED &&
                  r4.next.protection_ok,
              "repair-protected");
        // repair fails -> flatten immediately, then exit journaled
        auto r4f = RouteStep(r3.next, in, venue, o);
        (void)r4f;
        RouteObs of = o;
        of.repair_ok = false;
        auto r5 = RouteStep(r3.next, in, venue, of);
        Check(r5.action == RouteAction::FLATTEN_NOW &&
                  r5.next.state == RouteState::EXIT_SENT,
              "repair-failed-flattens");
        of.executed = true;
        auto r6 = RouteStep(r5.next, in, venue, of);
        Check(r6.action == RouteAction::JOURNAL_EXIT &&
                  r6.next.state == RouteState::CLOSED,
              "flatten-exited");
    }
    // 17. P0: query-side missing protection also repairs; cancel
    // confirmation without confirmed protection repairs too.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.filled_qty = 40;
        o.query.protection_active = false;
        auto r4 = RouteStep(r3.next, in, venue, o);
        Check(r4.action == RouteAction::ESTABLISH_PROTECTION,
              "query-partial-noprot-repairs");
        o.query.filled_qty = 100;
        auto r4b = RouteStep(r3.next, in, venue, o);
        Check(r4b.action == RouteAction::ESTABLISH_PROTECTION,
              "query-full-noprot-repairs");
        // Crafted CANCEL_SENT with filled qty but no confirmed
        // protection (e.g. restored edge): confirm -> repair, never
        // PROTECTED.
        RouteMachine mc;
        mc.state = RouteState::CANCEL_SENT;
        mc.kind = IntentKind::ENTRY;
        mc.filled_qty = 50;
        mc.protection_ok = false;
        RouteObs oc = OpenMarket();
        oc.cancel_confirmed = true;
        auto rc = RouteStep(mc, in, venue, oc);
        Check(rc.action == RouteAction::ESTABLISH_PROTECTION &&
                  rc.next.state == RouteState::REPAIR_SENT,
              "cancel-sent-unprotected-repairs");
        mc.protection_ok = true;
        auto rc2 = RouteStep(mc, in, venue, oc);
        Check(rc2.next.state == RouteState::PROTECTED,
              "cancel-sent-protected-rests");
    }
    // 18. P0 invariant sweep: no transition reaches PROTECTED without
    // positively confirmed protection (states x pok x obs combos).
    {
        int checked = 0;
        for (int st = 0; st <= 12; ++st)
            for (int pok = 0; pok <= 1; ++pok)
                for (int bits = 0; bits < 256; ++bits) {
                    RouteMachine m;
                    m.state = static_cast<RouteState>(st);
                    m.kind = IntentKind::ENTRY;
                    m.filled_qty = 50;
                    m.protection_ok = (pok == 1);
                    RouteObs o = OpenMarket();
                    o.journal_ok = (bits & 1) != 0;
                    o.adapter_responded = (bits & 2) != 0;
                    o.ack.accepted = (bits & 4) != 0;
                    o.ack.protection_accepted = (bits & 8) != 0;
                    o.query_due = (bits & 16) != 0;
                    o.query.found = (bits & 1) != 0;
                    o.query.filled_qty = (bits & 4) ? 100 : 0;
                    o.query.protection_active = (bits & 8) != 0;
                    o.cancel_confirmed = (bits & 32) != 0;
                    o.repair_ok = (bits & 16) != 0;
                    o.query.transport_ok = (bits & 64) != 0;
                    o.cancel_failed = (bits & 128) != 0;
                    auto r = RouteStep(m, in, venue, o);
                    bool ok = (r.next.state != RouteState::PROTECTED) ||
                              r.next.protection_ok;
                    checked += (r.next.state == RouteState::PROTECTED);
                    if (!ok) {
                        char name[48];
                        std::snprintf(name, sizeof(name),
                                      "prot-inv-%d-%d-%d", st, pok,
                                      bits);
                        Check(false, name);
                    }
                }
        Check(checked > 0, "prot-inv-covered");
    }
    // 19. P1-3 edges: already-cancelled direct path; bad-state fails
    // closed; transport silence waits (not-found vs failure distinct).
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        auto r2 = RouteStep(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = RouteStep(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.cancelled = true;
        o.query.filled_qty = 0;
        auto r4 = RouteStep(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_CANCEL &&
                  r4.next.state == RouteState::CANCELLED,
              "already-cancelled-direct");
        // transport silence (!responded, !due): wait, nothing else.
        RouteMachine mq;
        mq.state = RouteState::QUERY_SENT;
        RouteObs oq = OpenMarket();
        oq.adapter_responded = false;
        oq.query_due = false;
        Check(RouteStep(mq, in, venue, oq).action ==
                  RouteAction::NONE,
              "query-silence-waits");
        // silence (responded, neither flag) re-checks, never UNKNOWN.
        {
            RouteMachine mc;
            mc.state = RouteState::CANCEL_SENT;
            RouteObs os = OpenMarket();
            auto rs = RouteStep(mc, in, venue, os);
            Check(rs.action == RouteAction::CONFIRM_CANCELLED &&
                      rs.next.state == RouteState::CANCEL_SENT &&
                      !rs.freeze_symbol,
                  "cancel-silence-rechecks");
        }
        // lookup under the same identity — reconcile, not a resend.
        RouteObs of = OpenMarket();
        of.query.transport_ok = false;
        auto rf = RouteStep(mq, in, venue, of);
        Check(rf.action == RouteAction::QUERY_ONCE &&
                  rf.next.state == RouteState::QUERY_SENT,
              "query-transport-retry");
        // invalid state value: fail closed, never act.
        RouteMachine mb;
        mb.state = static_cast<RouteState>(99);
        auto rb = RouteStep(mb, in, venue, OpenMarket());
        Check(rb.action == RouteAction::REJECT,
              "bad-state-fails-closed");
    }
    // 20. P1-1 seam: snapshot/restore round-trips + strict rejects.
    {
        using jev::exec::RestoreMachine;
        using jev::exec::SnapshotMachine;
        for (int st = 0; st <= 12; ++st) {
            RouteMachine m;
            m.state = static_cast<RouteState>(st);
            m.kind = (st & 1) ? IntentKind::EXIT : IntentKind::ENTRY;
            for (int i = 0; i < 64; ++i) {
                // lowercase hex only (the strict parser requires it).
                int v = (i * 7 + st) % 16;
                m.client_id[i] =
                    (v < 10) ? ('0' + v) : ('a' + v - 10);
            }
            // Real UUID-shaped broker id (hyphens required by grammar).
            const char* uuid = "0193abcd-1234-5678-9abc-def012345678";
            for (int i = 0; i < 36; ++i) m.broker_id[i] = uuid[i];
            m.broker_id[36] = '\0';
            m.client_id[64] = '\0';
            m.broker_id[63] = '\0';
            m.filled_qty = st * 7;
            m.emergency = (st & 2) != 0;
            m.protection_ok = (st & 4) != 0;
            char buf[256];
            RouteMachine q;
            bool ok =
                SnapshotMachine(m, buf, sizeof(buf)) &&
                RestoreMachine(buf, &q);
            char name[32];
            std::snprintf(name, sizeof(name), "snap-%d", st);
            bool same = ok && q.state == m.state &&
                        q.kind == m.kind &&
                        q.filled_qty == m.filled_qty &&
                        q.emergency == m.emergency &&
                        q.protection_ok == m.protection_ok;
            for (int i = 0; i < 65 && same; ++i)
                if (q.client_id[i] != m.client_id[i]) same = false;
            for (int i = 0; i < 64 && same; ++i)
                if (q.broker_id[i] != m.broker_id[i]) same = false;
            Check(same, name);
        }
        RouteMachine q;
        Check(!RestoreMachine(nullptr, &q), "snap-null");
        Check(!RestoreMachine("H1:0:0:0:0:0::", nullptr),
              "snap-null-out");
        Check(!RestoreMachine("X1:0:0:0:0:0::", &q), "snap-tag");
        Check(!RestoreMachine("H1:13:0:0:0:0::", &q), "snap-state");
        Check(!RestoreMachine("H1:0:2:0:0:0::", &q), "snap-kind");
        Check(!RestoreMachine("H1:0:0:0:0:0:ZZ:", &q), "snap-hex");
        Check(!RestoreMachine("H1:0:0:0:0:0::extra", &q),
              "snap-trailing");
        Check(!RestoreMachine("H1:0:0:0:0:0:", &q), "snap-short");
        // UUID grammar: hyphens exact, lowercase hex, 36 chars.
        Check(!RestoreMachine(
                  "H1:0:0:0:0:0::0193ABCD-1234-5678-9abc-def012345678",
                  &q),
              "snap-uuid-upper");
        Check(!RestoreMachine(
                  "H1:0:0:0:0:0::0193abcd1234-5678-9abc-def012345678",
                  &q),
              "snap-uuid-hyphen");
        Check(!RestoreMachine("H1:0:0:0:0:0::0193abcd", &q),
              "snap-uuid-short");
        Check(!RestoreMachine(
                  "H1:0:0:0:0:0::0193abcd-1234-5678-9abc-def01234567X",
                  &q),
              "snap-uuid-char");
        // Empty broker id restores (no UUID observed yet).
        Check(RestoreMachine("H1:2:0:0:0:0::", &q) &&
                  q.broker_id[0] == '\0',
              "snap-empty-bid");
        char tiny[8];
        RouteMachine m;
        Check(!SnapshotMachine(m, nullptr, 64), "snap-ser-null");
        Check(!SnapshotMachine(m, tiny, sizeof(tiny)), "snap-ser-small");
    }
    if (g_fail == 0) std::printf("ROUTER SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
