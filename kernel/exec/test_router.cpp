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

using jev::broker::CloseState;
using jev::broker::OrderSide;
using jev::exec::OrderIntent;
using jev::exec::RouteAction;
using jev::exec::RouteMachine;
using jev::exec::RouteObs;
using jev::exec::RouteOut;
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
// Test-harness correct-caller model: the harness attributes its own
// events to its own order (tags obs with the machine identity).
// Gate tests below call RouteStep directly with crafted tags.
static void Tag(RouteObs& o, const RouteMachine& m) {
    for (int i = 0; i < 65; ++i) o.client_id[i] = m.client_id[i];
}
// Fixture POST UUID (valid 8-4-4-4-12 grammar): accepted acks carry
// the broker id the router must persist before any cancel path.
static void SetAckId(RouteObs& o) {
    const char* u = "0193abcd-1234-5678-9abc-def012345678";
    for (int i = 0; u[i]; ++i) o.ack.broker_order_id[i] = u[i];
    o.ack.broker_order_id[36] = '\0';
}
// Definitive exit execution observation (close FILLED, authoritative).
static void SetExitAck(RouteObs& o) {
    o.exit_responded = true;
    o.exit_ack.state = CloseState::FILLED;
    o.exit_ack.executed = true;
    o.exit_ack.transport_ok = true;
    o.exit_ack.filled_qty = 100;
}
// Emergency/partial close observation (DEAD + cumulative qty).
static void SetExitDead(RouteObs& o, std::int64_t qty) {
    o.exit_responded = true;
    o.exit_ack.state = CloseState::DEAD;
    o.exit_ack.transport_ok = true;
    o.exit_ack.filled_qty = qty;
}
static void SetUuid(char (&d)[64]) {
    const char* u = "0193abcd-1234-5678-9abc-def012345678";
    for (int i = 0; u[i]; ++i) d[i] = u[i];
    d[36] = '\0';
}
// Distinct broker event: 32-hex id derived from seq + the seq itself.
static void SetEvent(RouteObs& o, unsigned seq) {
    for (int i = 0; i < 32; ++i) {
        unsigned v = (seq * 7u + (unsigned)i * 13u) % 16u;
        o.event_id[i] = (v < 10) ? (char)('0' + v) : (char)('a' + v - 10);
    }
    o.event_id[32] = '\0';
    o.event_seq = (std::uint64_t)seq;
}
// Real Alpaca-shaped event identity: ULID with chosen timestamp ms
// + randomness (Crockford base32, 26 chars, verbatim preserved).
static void SetUlid(RouteObs& o, std::uint64_t ms, unsigned rand) {
    static const char* kC =
        "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (int i = 9; i >= 0; --i) {
        o.event_id[i] = kC[ms & 31u];
        ms >>= 5;
    }
    unsigned r = rand;
    for (int i = 25; i >= 10; --i) {
        o.event_id[i] = kC[r & 31u];
        r = r * 1103515245u + 12345u;
        r >>= 7;
    }
    o.event_id[26] = '\0';
    o.event_seq = 0;  // stream events carry no caller seq
}
static RouteOut Step(const RouteMachine& m, const OrderIntent& in,
                     const VenueCtx& v, RouteObs o) {
    if (m.state != RouteState::IDLE && m.client_id[0] != '\0')
        Tag(o, m);
    return jev::exec::RouteStep(m, in, v, o);
}

int main() {
    using jev::exec::RouteStep;
    OrderIntent in = GoodEntry();
    VenueCtx venue = GoodVenue();
    // intent_rowed: crash between the journaled intent row and the
    // first snapshot skips WRITE (never a second intent row); the
    // default path still journals first.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        o.intent_rowed = true;
        auto r1 = Step(m, in, venue, o);
        Check(r1.action == RouteAction::NONE &&
                  r1.next.state == RouteState::JOURNAL_PENDING,
              "rowed-skips-write");
        RouteObs o2 = OpenMarket();
        auto r2 = Step(m, in, venue, o2);
        Check(r2.action == RouteAction::WRITE_JOURNAL,
              "unrowed-writes");
    }
    // 1. entry happy path: journal -> send -> query -> fill
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        Check(r1.action == RouteAction::WRITE_JOURNAL, "happy-journal");
        auto r2 = Step(r1.next, in, venue, o);
        Check(r2.action == RouteAction::SEND_PROTECTED, "happy-send");
        o.journal_ok = false;
        o.adapter_responded = false;
        auto r3 = Step(r2.next, in, venue, o);
        Check(r3.action == RouteAction::QUERY_ONCE, "happy-query");
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        auto r4 = Step(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_FILL &&
                  r4.next.state == RouteState::PROTECTED,
              "happy-fill");
        auto r5 = Step(r4.next, in, venue, o);
        Check(r5.action == RouteAction::NONE, "happy-terminal");
    }
    // 2. journal-before-order is absolute for entries
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        o.journal_ok = false;
        auto r2 = Step(r1.next, in, venue, o);
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
        Check(Step(m, bad, venue, o).reason != nullptr &&
                  Step(m, bad, venue, o).action ==
                      RouteAction::REJECT,
              "reject-zero-qty");
        bad = in;
        bad.stop_cents = 0;
        Check(Step(m, bad, venue, o).action == RouteAction::REJECT,
              "reject-no-stop");
        bad = in;
        bad.scale_num = 2;
        Check(Step(m, bad, venue, o).action == RouteAction::REJECT,
              "reject-bad-scale");
        bad = in;
        bad.stage_num = 3;
        Check(Step(m, bad, venue, o).action == RouteAction::REJECT,
              "reject-bad-stage");
    }
    // 4. entry gates: kill / stale / stage / frozen
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        RouteObs k = o;
        k.kill = KillLevel::SOFT;
        auto r = Step(m, in, venue, k);
        Check(r.action == RouteAction::REJECT, "gate-kill-soft");
        k.kill = KillLevel::HARD;
        r = Step(m, in, venue, k);
        Check(r.action == RouteAction::REJECT, "gate-kill-hard");
        RouteObs s = o;
        s.feed_stale = true;
        r = Step(m, in, venue, s);
        Check(r.action == RouteAction::REJECT, "gate-stale");
        RouteObs g = o;
        g.stage_entry_ok = false;
        r = Step(m, in, venue, g);
        Check(r.action == RouteAction::REJECT, "gate-stage");
        RouteObs f = o;
        f.symbol_frozen = true;
        r = Step(m, in, venue, f);
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
        auto r1 = Step(m, ex, venue, o);
        Check(r1.action == RouteAction::WRITE_JOURNAL, "exit-gaps-open");
        auto r2 = Step(r1.next, ex, venue, o);
        Check(r2.action == RouteAction::EXECUTE_EXIT, "exit-exec");
        SetExitAck(o);
        auto r3 = Step(r2.next, ex, venue, o);
        Check(r3.action == RouteAction::JOURNAL_EXIT &&
                  r3.next.state == RouteState::CLOSED,
              "exit-closed");
    }
    // 6. emergency exception: EXIT journal fails -> act first, then
    // the SAME exit machinery (ordering differs, row still lands).
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine m;
        m.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, ex, venue, o);
        o.journal_ok = false;
        auto r2 = Step(r1.next, ex, venue, o);
        Check(r2.action == RouteAction::EXECUTE_EMERGENCY &&
                  r2.next.state == RouteState::EXIT_EMERGENCY &&
                  r2.next.emergency,
              "emergency-exec-first");
        // Executed flag WITHOUT ack detail: reconcile by ID under
        // budget — never blind CLOSED without an authoritative qty.
        o.executed = true;
        auto r2b = Step(r2.next, ex, venue, o);
        Check(r2b.action == RouteAction::QUERY_ONCE &&
                  r2b.next.state == RouteState::EXIT_EMERGENCY &&
                  r2b.next.emergency,
              "emergency-flag-reconciles");
        // The query answer lands back in the reconcile path:
        // QUERY_SENT adopts it, full fill buffers home.
        RouteObs oq = OpenMarket();
        oq.adapter_responded = true;
        oq.query.transport_ok = true;
        oq.query.found = true;
        oq.query.filled_qty = 100;
        SetUuid(oq.query.broker_order_id);
        auto r2c = Step(r2b.next, ex, venue, oq);
        Check(r2c.action == RouteAction::NONE &&
                  r2c.next.state == RouteState::QUERY_SENT,
              "emergency-to-query");
        auto r2d = Step(r2c.next, ex, venue, oq);
        Check(r2d.action == RouteAction::BUFFER_EMERGENCY &&
                  r2d.next.state == RouteState::CLOSED &&
                  r2d.next.exit_closed_qty == 100,
              "emergency-query-buffers");
        // Authoritative full FILLED -> BUFFER (the row never landed
        // via the normal path) + CLOSED at exactly full qty.
        RouteObs oe = OpenMarket();
        SetExitAck(oe);
        auto r3 = Step(r2.next, ex, venue, oe);
        Check(r3.action == RouteAction::BUFFER_EMERGENCY &&
                  r3.next.state == RouteState::CLOSED &&
                  r3.next.filled_qty == 100 && r3.next.emergency,
              "emergency-buffered");
    }
    // 6b. emergency partial: a DEAD+40 emergency close folds the
    // 40, mints Y for exactly 60, and still buffers the terminal
    // (remainder managed across restart, never stranded).
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine m;
        m.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, ex, venue, o);
        o.journal_ok = false;
        auto re = Step(r1.next, ex, venue, o);
        Check(re.next.state == RouteState::EXIT_EMERGENCY,
              "emg-armed");
        RouteObs od = OpenMarket();
        SetExitDead(od, 40);
        auto rd = Step(re.next, ex, venue, od);
        Check(rd.action == RouteAction::EXECUTE_EXIT &&
                  rd.next.exit_attempt == 1 &&
                  rd.next.exit_closed_qty == 40 &&
                  rd.exit_qty == 60 && rd.next.emergency &&
                  rd.next.state == RouteState::EXIT_EMERGENCY,
              "emergency-dead-mints");
        // Restart mid-recovery: Y's full fill still buffers home.
        char sng[320];
        Check(SnapshotMachine(rd.next, sng, sizeof(sng)),
              "emg-snaps");
        RouteMachine qe;
        Check(RestoreMachine(sng, &qe) &&
                  qe.exit_closed_qty == 40 && qe.emergency,
              "emg-restores");
        RouteObs of = OpenMarket();
        SetExitAck(of);
        of.exit_ack.filled_qty = 60;
        auto rf = Step(qe, ex, venue, of);
        Check(rf.action == RouteAction::BUFFER_EMERGENCY &&
                  rf.next.state == RouteState::CLOSED &&
                  rf.next.exit_closed_qty == 100,
              "emergency-buffered-100");
    }
    // 7. rejected entry -> journal cancel, terminal
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.adapter_responded = true;
        o.ack.accepted = false;
        o.ack.authoritative_reject = true;
        auto r3 = Step(r2.next, in, venue, o);
        Check(r3.action == RouteAction::JOURNAL_CANCEL &&
                  r3.next.state == RouteState::CANCELLED,
              "entry-rejected");
        // Ambiguous send (transport failure): reconcile same ID.
        RouteObs oa = o;
        oa.ack.authoritative_reject = false;
        auto r3c = Step(r2.next, in, venue, oa);
        Check(r3c.action == RouteAction::QUERY_ONCE &&
                  r3c.next.state == RouteState::QUERY_SENT &&
                  r3c.next.query_attempts == 1,
              "ambiguous-reconciles");
        // Auth failure and rate limiting reconcile too — never a
        // terminal trade rejection.
        RouteObs oau = oa;
        oau.ack.auth_failure = true;
        auto rau = Step(r2.next, in, venue, oau);
        Check(rau.action == RouteAction::QUERY_ONCE &&
                  rau.next.state == RouteState::QUERY_SENT,
              "auth-reconciles");
        RouteObs orl = oa;
        orl.ack.rate_limited = true;
        auto rrl = Step(r2.next, in, venue, orl);
        Check(rrl.action == RouteAction::QUERY_ONCE &&
                  rrl.next.state == RouteState::QUERY_SENT,
              "rate-reconciles");
        // Retry-once budget (P0-1): one initial + one retry, no third.
        RouteObs oq = OpenMarket();
        oq.query.transport_ok = false;  // lookup failed, not absent
        auto q2 = Step(r3c.next, in, venue, oq);
        Check(q2.action == RouteAction::QUERY_ONCE &&
                  q2.next.query_attempts == 2,
              "exactly-one-retry");
        auto q3 = Step(q2.next, in, venue, oq);
        Check(q3.action == RouteAction::JOURNAL_UNKNOWN &&
                  q3.next.state == RouteState::UNKNOWN_FROZEN &&
                  q3.freeze_symbol,
              "no-third-query");
        // Budget exhaustion: consumed budget freezes.
        RouteMachine mx;
        mx.state = RouteState::QUERY_SENT;
        mx.query_attempts = 2;
        RouteObs ox = OpenMarket();
        ox.query.transport_ok = false;
        auto rx = Step(mx, in, venue, ox);
        Check(rx.action == RouteAction::JOURNAL_UNKNOWN &&
                  rx.freeze_symbol,
              "reconcile-exhausted");
        // Restart preserves the consumed budget (snapshot round-trip
        // at attempts=2 stays exhausted — a crash cannot mint a
        // third lookup).
        {
            char snap[256];
            Check(SnapshotMachine(q2.next, snap, sizeof(snap)),
                  "budget-snapshots");
            RouteMachine qr;
            Check(RestoreMachine(snap, &qr) && qr.query_attempts == 2,
                  "budget-restores");
            auto qx = Step(qr, in, venue, oq);
            // attempts==2 with a failed lookup -> exactly one retry
            // left? No: 2 is the max, so this must freeze.
            Check(qx.action == RouteAction::JOURNAL_UNKNOWN &&
                      qx.freeze_symbol,
                  "restart-no-fresh-budget");
        }
    }
    // 7b. identity gate (P1-5/P1-6): matching tags apply, foreign
    // tags are ignored, untagged obs on an established machine are
    // ignored (fail closed — no unattributable event ever mutates).
    // Direct RouteStep calls: the Step() harness would attribute.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        Tag(o, r1.next);  // preamble attributed; the crafted
                           // tags below are the actual test
        auto r2 = RouteStep(r1.next, in, venue, o);
        Check(r2.action == RouteAction::SEND_PROTECTED,
              "gate-armed");
        // Matching tag applies.
        RouteObs ok = o;
        Tag(ok, r2.next);
        ok.adapter_responded = false;
        auto rok = RouteStep(r2.next, in, venue, ok);
        Check(rok.action == RouteAction::QUERY_ONCE,
              "gate-matching-applies");
        // Foreign tag ignored (state + attempts untouched).
        RouteObs fr = ok;
        fr.client_id[0] = (fr.client_id[0] == '0') ? '1' : '0';
        auto rfr = RouteStep(r2.next, in, venue, fr);
        Check(rfr.action == RouteAction::NONE &&
                  rfr.next.query_attempts == 0,
              "gate-foreign-ignored");
        // Untagged on established machine ignored.
        RouteObs un = ok;
        un.client_id[0] = '\0';
        auto run = RouteStep(r2.next, in, venue, un);
        Check(run.action == RouteAction::NONE &&
                  run.next.query_attempts == 0,
              "gate-untagged-ignored");
        // Duplicate delivery is idempotent: same tagged event twice
        // cannot fork the machine or double-spend budget (second
        // application waits on the in-flight query, attempts stay 1).
        auto d1 = RouteStep(r2.next, in, venue, ok);
        RouteObs ok2 = ok;
        Tag(ok2, d1.next);
        ok2.adapter_responded = false;
        auto d2 = RouteStep(d1.next, in, venue, ok2);
        Check(d1.action == RouteAction::QUERY_ONCE &&
                  d1.next.query_attempts == 1 &&
                  d2.action == RouteAction::NONE &&
                  d2.next.query_attempts == 1 &&
                  d2.next.state == d1.next.state,
              "gate-duplicate-idempotent");
    }
    // 8. naked ack (no protection) -> cancel path, never hold naked
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.ack.accepted = true;
        o.ack.protection_accepted = false;
        o.ack.filled_qty = 0;
        SetAckId(o);
        auto r3 = Step(r2.next, in, venue, o);
        Check(r3.action == RouteAction::CANCEL_REMAINDER &&
                  r3.next.state == RouteState::CANCEL_SENT,
              "naked-cancels");
        // P0-3: the POST UUID was persisted BEFORE the cancel path.
        bool id_kept = true;
        for (int i = 0; i < 37; ++i)
            if (r3.next.broker_id[i] != o.ack.broker_order_id[i])
                id_kept = false;
        Check(id_kept, "naked-uuid-persisted");
        // P0-1 E2E: accepted/naked POST that already filled routes to
        // protection repair (filled qty from the real ack), NEVER to
        // the zero-fill cancel path.
        RouteObs of = o;
        of.ack.filled_qty = 30;
        auto r3f = Step(r2.next, in, venue, of);
        Check(r3f.action == RouteAction::ESTABLISH_PROTECTION &&
                  r3f.next.state == RouteState::REPAIR_SENT &&
                  r3f.next.filled_qty == 30,
              "naked-filled-repairs");
        // Unparseable POST id: reconcile, never cancel blind.
        RouteObs ob = o;
        ob.ack.broker_order_id[0] = 'X';
        auto r3b = Step(r2.next, in, venue, ob);
        Check(r3b.action == RouteAction::QUERY_ONCE &&
                  r3b.next.broker_id[0] == '\0',
              "bad-ack-id-reconciles");
    }
    // 9. nothing filled -> cancel -> confirm -> cancelled
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = Step(r2.next, in, venue, o);
        Check(r3.action == RouteAction::QUERY_ONCE, "timeout-queries");
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.filled_qty = 0;
        auto r4 = Step(r3.next, in, venue, o);
        Check(r4.action == RouteAction::CANCEL_REMAINDER, "empty-cancels");
        o.adapter_responded = false;
        auto r5 = Step(r4.next, in, venue, o);
        Check(r5.action == RouteAction::CONFIRM_CANCELLED,
              "cancel-confirm-step");
        o.adapter_responded = true;
        o.cancel_confirmed = true;
        auto r6 = Step(r4.next, in, venue, o);
        Check(r6.action == RouteAction::JOURNAL_CANCEL &&
                  r6.next.state == RouteState::CANCELLED,
              "cancel-closed");
    }
    // 10. partial: journal partial -> cancel remainder -> protected
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = Step(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.filled_qty = 40;
        o.query.protection_active = true;
        auto r4 = Step(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_PARTIAL &&
                  r4.next.state == RouteState::PARTIAL_AWAIT &&
                  r4.next.filled_qty == 40,
              "partial-journaled");
        o.journal_ok = false;
        auto r4b = Step(r4.next, in, venue, o);
        Check(r4b.action == RouteAction::NONE, "partial-waits-row");
        o.journal_ok = true;
        auto r5 = Step(r4.next, in, venue, o);
        Check(r5.action == RouteAction::CANCEL_REMAINDER, "partial-cancel");
        o.adapter_responded = true;
        o.cancel_confirmed = true;
        o.cancel_filled_qty = 40;  // authoritative final quantity
        auto r6 = Step(r5.next, in, venue, o);
        Check(r6.action == RouteAction::JOURNAL_CANCEL &&
                  r6.next.state == RouteState::PROTECTED &&
                  r6.next.filled_qty == 40,
              "partial-protected");
    }
    // 11. cancel failed -> UNKNOWN + freeze (never "filled")
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = Step(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;  // found-but-empty: cancel path (a 404
                               // would terminal directly now)
        o.query.transport_ok = true;
        auto r4 = Step(r3.next, in, venue, o);
        o.cancel_confirmed = false;
        o.cancel_failed = true;  // explicit broker rejection -> UNKNOWN
        auto r5 = Step(r4.next, in, venue, o);
        Check(r5.action == RouteAction::JOURNAL_UNKNOWN &&
                  r5.next.state == RouteState::UNKNOWN_FROZEN &&
                  r5.freeze_symbol,
              "unknown-freezes");
        auto r6 = Step(r5.next, in, venue, o);
        Check(r6.action == RouteAction::NONE, "unknown-terminal");
        // Frozen symbol blocks the next intent on it.
        RouteMachine m2;
        RouteObs f = OpenMarket();
        f.symbol_frozen = true;
        Check(Step(m2, in, venue, f).action == RouteAction::REJECT,
              "frozen-blocks-next");
    }
    // 12. identity stability: two independent runs mint the same ID;
    // machine state matches a fresh recompute (retry reuses it).
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r1b = Step(m, in, venue, o);
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
        auto r = Step(m, in, venue, o);
        Check(r.action == RouteAction::QUERY_ONCE &&
                  r.next.state == RouteState::QUERY_SENT,
              "crash-reconciles-first");
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        auto r2 = Step(r.next, in, venue, o);
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
        auto r = Step(m, in, venue, o);
        Check(r.action == RouteAction::NONE, "duplicate-quiet");
    }
    // 15. drift-directive ordering pattern: EXIT closes before ENTRY.
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine me;
        me.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        auto e1 = Step(me, ex, venue, o);
        auto e2 = Step(e1.next, ex, venue, o);
        SetExitAck(o);
        auto e3 = Step(e2.next, ex, venue, o);
        Check(e3.next.state == RouteState::CLOSED, "drift-exit-closed");
        RouteMachine mn;
        auto n1 = Step(mn, in, venue, o);
        Check(n1.action == RouteAction::WRITE_JOURNAL, "entry-after-exit");
    }
    // 16. P0: filled-without-protection is NEVER a cancel of a
    // nonexistent remainder and NEVER silently PROTECTED. Repair now.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        // naked ack, partial fill -> ESTABLISH, not cancel
        o.ack.accepted = true;
        o.ack.protection_accepted = false;
        o.ack.filled_qty = 30;
        SetAckId(o);
        auto r3 = Step(r2.next, in, venue, o);
        Check(r3.action == RouteAction::ESTABLISH_PROTECTION &&
                  r3.next.state == RouteState::REPAIR_SENT &&
                  r3.next.filled_qty == 30,
              "naked-partial-repairs");
        // naked ack, full fill -> ESTABLISH (no remainder exists)
        o.ack.filled_qty = 100;
        auto r3b = Step(r2.next, in, venue, o);
        Check(r3b.action == RouteAction::ESTABLISH_PROTECTION,
              "naked-full-repairs");
        // repair succeeds -> JOURNAL_REPAIR -> PROTECTED
        o.adapter_responded = true;
        o.repair_ok = true;
        auto r4 = Step(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_REPAIR &&
                  r4.next.state == RouteState::PROTECTED &&
                  r4.next.protection_ok,
              "repair-protected");
        // repair fails -> flatten immediately, then exit journaled
        auto r4f = Step(r3.next, in, venue, o);
        (void)r4f;
        RouteObs of = o;
        of.repair_ok = false;
        auto r5 = Step(r3.next, in, venue, of);
        Check(r5.action == RouteAction::FLATTEN_NOW &&
                  r5.next.state == RouteState::EXIT_SENT,
              "repair-failed-flattens");
        SetExitAck(of);
        auto r6 = Step(r5.next, in, venue, of);
        Check(r6.action == RouteAction::JOURNAL_EXIT &&
                  r6.next.state == RouteState::CLOSED,
              "flatten-exited");
    }
    // 17. P0: query-side missing protection also repairs; cancel
    // confirmation without confirmed protection repairs too.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = Step(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.filled_qty = 40;
        o.query.protection_active = false;
        auto r4 = Step(r3.next, in, venue, o);
        Check(r4.action == RouteAction::ESTABLISH_PROTECTION,
              "query-partial-noprot-repairs");
        o.query.filled_qty = 100;
        auto r4b = Step(r3.next, in, venue, o);
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
        auto rc = Step(mc, in, venue, oc);
        Check(rc.action == RouteAction::ESTABLISH_PROTECTION &&
                  rc.next.state == RouteState::REPAIR_SENT,
              "cancel-sent-unprotected-repairs");
        mc.protection_ok = true;
        oc.cancel_filled_qty = 50;  // authoritative: rests covered
        auto rc2 = Step(mc, in, venue, oc);
        Check(rc2.next.state == RouteState::PROTECTED &&
                  rc2.next.filled_qty == 50,
              "cancel-sent-protected-rests");
        // Same machine, final observation WITHOUT authoritative
        // quantity: coverage unproven -> repair, never assume.
        RouteObs oc2 = OpenMarket();
        oc2.cancel_confirmed = true;
        auto rc3 = Step(mc, in, venue, oc2);
        Check(rc3.action == RouteAction::ESTABLISH_PROTECTION,
              "cancel-no-qty-repairs");
        // P1-4: partial 40 -> cancel -> fills grow to authoritative
        // total 100 -> PROTECTED with 100 (not stale 40).
        RouteMachine mp;
        mp.state = RouteState::CANCEL_SENT;
        mp.kind = IntentKind::ENTRY;
        mp.filled_qty = 40;
        mp.protection_ok = true;
        RouteObs op = OpenMarket();
        op.cancel_confirmed = true;
        op.cancel_filled_qty = 100;
        auto rp = Step(mp, in, venue, op);
        Check(rp.action == RouteAction::JOURNAL_CANCEL &&
                  rp.next.state == RouteState::PROTECTED &&
                  rp.next.filled_qty == 100,
              "cancel-final-authoritative-qty");
    }
    // 18. P0 invariant sweep: no transition reaches PROTECTED without
    // positively confirmed protection (states x pok x obs combos).
    {
        int checked = 0;
        for (int st = 0; st <= 12; ++st)
            for (int pok = 0; pok <= 1; ++pok)
                for (int bits = 0; bits < 4096; ++bits) {
                    RouteMachine m;
                    m.state = static_cast<RouteState>(st);
                    m.kind = IntentKind::ENTRY;
                    m.intent_id[0] = '\0';  // unbound: skip gate
                    m.filled_qty = 50;
                    m.protection_ok = (pok == 1);
                    RouteObs o = OpenMarket();
                    o.journal_ok = (bits & 1) != 0;
                    o.adapter_responded = (bits & 2) != 0;
                    o.ack.accepted = (bits & 4) != 0;
                    o.ack.protection_accepted = (bits & 8) != 0;
                    o.ack.transport_ok = (bits & 256) != 0;
                    o.ack.authoritative_reject = (bits & 512) != 0;
                    o.ack.auth_failure = (bits & 1024) != 0;
                    o.ack.rate_limited = (bits & 2048) != 0;
                    o.query_due = (bits & 16) != 0;
                    o.query.found = (bits & 1) != 0;
                    o.query.filled_qty = (bits & 4) ? 100 : 0;
                    o.query.protection_active = (bits & 8) != 0;
                    o.cancel_confirmed = (bits & 32) != 0;
                    o.repair_ok = (bits & 16) != 0;
                    o.query.transport_ok = (bits & 64) != 0;
                    o.cancel_failed = (bits & 128) != 0;
                    auto r = Step(m, in, venue, o);
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
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        o.adapter_responded = false;
        auto r3 = Step(r2.next, in, venue, o);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.transport_ok = true;
        o.query.cancelled = true;
        o.query.filled_qty = 0;
        auto r4 = Step(r3.next, in, venue, o);
        Check(r4.action == RouteAction::JOURNAL_CANCEL &&
                  r4.next.state == RouteState::CANCELLED,
              "already-cancelled-direct");
        // transport silence (!responded, !due): wait, nothing else.
        RouteMachine mq;
        mq.state = RouteState::QUERY_SENT;
        RouteObs oq = OpenMarket();
        oq.adapter_responded = false;
        oq.query_due = false;
        Check(Step(mq, in, venue, oq).action ==
                  RouteAction::NONE,
              "query-silence-waits");
        // silence (responded, neither flag) re-checks, never UNKNOWN.
        {
            RouteMachine mc;
            mc.state = RouteState::CANCEL_SENT;
            RouteObs os = OpenMarket();
            auto rs = Step(mc, in, venue, os);
            Check(rs.action == RouteAction::CONFIRM_CANCELLED &&
                      rs.next.state == RouteState::CANCEL_SENT &&
                      !rs.freeze_symbol,
                  "cancel-silence-rechecks");
        }
        // lookup under the same identity — reconcile, not a resend.
        RouteObs of = OpenMarket();
        of.query.transport_ok = false;
        auto rf = Step(mq, in, venue, of);
        Check(rf.action == RouteAction::QUERY_ONCE &&
                  rf.next.state == RouteState::QUERY_SENT,
              "query-transport-retry");
        // invalid state value: fail closed, never act.
        RouteMachine mb;
        mb.state = static_cast<RouteState>(99);
        auto rb = Step(mb, in, venue, OpenMarket());
        Check(rb.action == RouteAction::REJECT,
              "bad-state-fails-closed");
    }
    // 19b. P0-4 intent binding: same intent applies; any drift in
    // intent_id / symbol / side / kind is ignored (never terminal).
    // Direct RouteStep: the Step() harness would hide the mismatch.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = RouteStep(m, in, venue, o);
        Tag(o, r1.next);  // preamble attributed; crafted below
        auto r2 = RouteStep(r1.next, in, venue, o);
        Check(r2.action == RouteAction::SEND_PROTECTED, "bind-armed");
        RouteObs ok = o;
        Tag(ok, r2.next);
        ok.adapter_responded = false;
        Check(RouteStep(r2.next, in, venue, ok).action ==
                  RouteAction::QUERY_ONCE,
              "bind-same-applies");
        OrderIntent other = in;
        other.intent_id[0] = 'X';
        auto rx = RouteStep(r2.next, other, venue, ok);
        Check(rx.action == RouteAction::NONE &&
                  rx.next.state == RouteState::SENT_UNACKED,
              "bind-intent-id-rejected");
        OrderIntent osy = in;
        osy.symbol[0] = 'X';
        Check(RouteStep(r2.next, osy, venue, ok).action ==
                  RouteAction::NONE,
              "bind-symbol-rejected");
        OrderIntent osd = in;
        osd.side = (in.side == OrderSide::BUY) ? OrderSide::SELL
                                               : OrderSide::BUY;
        Check(RouteStep(r2.next, osd, venue, ok).action ==
                  RouteAction::NONE,
              "bind-side-rejected");
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        Check(RouteStep(r2.next, ex, venue, ok).action ==
                  RouteAction::NONE,
              "bind-entry-exit-rejected");
        // Restart preserves the binding (snapshot round-trip still
        // rejects the foreign intent and applies the original).
        char snap[320];
        Check(SnapshotMachine(r2.next, snap, sizeof(snap)),
              "bind-snapshots");
        RouteMachine qr;
        Check(RestoreMachine(snap, &qr), "bind-restores");
        Check(RouteStep(qr, other, venue, ok).action ==
                  RouteAction::NONE,
              "bind-restart-rejects");
        Check(RouteStep(qr, in, venue, ok).action ==
                  RouteAction::QUERY_ONCE,
              "bind-restart-applies");
        // P0-3: every mismatch flavor returns the machine
        // BYTE-IDENTICAL (snapshot bytes equal before/after).
        {
            char before[320], after[320];
            Check(SnapshotMachine(r2.next, before, sizeof(before)),
                  "ident-snaps");
            OrderIntent variants[4] = {other, osy, osd, ex};
            const char* vnames[4] = {
                "ident-intent-id", "ident-symbol", "ident-side",
                "ident-kind"};
            for (int vi = 0; vi < 4; ++vi) {
                auto rv = RouteStep(r2.next, variants[vi], venue, ok);
                bool act_ok = (rv.action == RouteAction::NONE);
                bool bytes_ok =
                    SnapshotMachine(rv.next, after, sizeof(after));
                if (bytes_ok) {
                    for (int bi = 0; before[bi] || after[bi]; ++bi)
                        if (before[bi] != after[bi]) bytes_ok = false;
                }
                Check(act_ok && bytes_ok, vnames[vi]);
            }
            // Foreign + untagged observations: same guarantee.
            RouteObs fr2 = ok;
            fr2.client_id[0] =
                (fr2.client_id[0] == '0') ? '1' : '0';
            auto rf2 = RouteStep(r2.next, in, venue, fr2);
            bool f_ok = (rf2.action == RouteAction::NONE) &&
                        SnapshotMachine(rf2.next, after, sizeof(after));
            if (f_ok) {
                for (int bi = 0; before[bi] || after[bi]; ++bi)
                    if (before[bi] != after[bi]) f_ok = false;
            }
            Check(f_ok, "ident-foreign");
            RouteObs un2 = ok;
            un2.client_id[0] = '\0';
            auto ru2 = RouteStep(r2.next, in, venue, un2);
            bool u_ok = (ru2.action == RouteAction::NONE) &&
                        SnapshotMachine(ru2.next, after, sizeof(after));
            if (u_ok) {
                for (int bi = 0; before[bi] || after[bi]; ++bi)
                    if (before[bi] != after[bi]) u_ok = false;
            }
            Check(u_ok, "ident-untagged");
        }
    }
    // 19c. P0-2 authoritative 404 terminals directly (no CANCEL_SENT
    // for a nonexistent order); P0-1 bracket-held protects without
    // legs; simple-class found-but-unprotected repairs (legitimate).
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        RouteObs oq = OpenMarket();
        oq.adapter_responded = false;
        auto rq = Step(r2.next, in, venue, oq);
        Check(rq.action == RouteAction::QUERY_ONCE, "absent-armed");
        // 404: terminal cancel directly.
        RouteObs o404 = OpenMarket();
        o404.adapter_responded = true;
        o404.query.transport_ok = true;
        o404.query.found = false;
        auto r404 = Step(rq.next, in, venue, o404);
        Check(r404.action == RouteAction::JOURNAL_CANCEL &&
                  r404.next.state == RouteState::CANCELLED &&
                  r404.next.broker_id[0] == '\0',
              "absent-404-direct");
        // Bracket held as a unit (legs null): protected, no repair.
        RouteObs ob = OpenMarket();
        ob.adapter_responded = true;
        ob.query.transport_ok = true;
        ob.query.found = true;
        ob.query.filled_qty = 100;
        ob.query.bracket_class = true;
        SetUuid(ob.query.broker_order_id);
        auto rb2 = Step(rq.next, in, venue, ob);
        Check(rb2.action == RouteAction::JOURNAL_FILL &&
                  rb2.next.state == RouteState::PROTECTED,
              "bracket-held-protected");
        // Simple class, filled, no bracket: repair (legitimate — no
        // bracket exists to duplicate).
        RouteObs os = OpenMarket();
        os.adapter_responded = true;
        os.query.transport_ok = true;
        os.query.found = true;
        os.query.filled_qty = 100;
        SetUuid(os.query.broker_order_id);
        auto rs = Step(rq.next, in, venue, os);
        Check(rs.action == RouteAction::ESTABLISH_PROTECTION,
              "simple-filled-repairs");
    }
    // 19d. P0-5 exit reconciliation: definitive close terminals;
    // ambiguous close reconciles by ID (no blind second send);
    // 404 after close reconciles to re-issue; restart keeps the ID.
    {
        OrderIntent ex = in;
        ex.kind = IntentKind::EXIT;
        RouteMachine m;
        m.kind = IntentKind::EXIT;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, ex, venue, o);
        auto r2 = Step(r1.next, ex, venue, o);
        Check(r2.action == RouteAction::EXECUTE_EXIT, "exitx-armed");
        // Ambiguous (response lost): reconcile, same ID, budget 1.
        RouteObs oa = OpenMarket();
        oa.exit_responded = true;
        auto ra = Step(r2.next, ex, venue, oa);
        Check(ra.action == RouteAction::QUERY_ONCE &&
                  ra.next.state == RouteState::QUERY_SENT &&
                  ra.next.query_attempts == 1,
              "exit-ambiguous-reconciles");
        // Query finds the close filled -> terminal, no second send.
        RouteObs of = OpenMarket();
        of.adapter_responded = true;
        of.query.transport_ok = true;
        of.query.found = true;
        of.query.filled_qty = 100;
        SetUuid(of.query.broker_order_id);
        auto rf = Step(ra.next, ex, venue, of);
        Check(rf.action == RouteAction::JOURNAL_EXIT &&
                  rf.next.state == RouteState::CLOSED,
              "exit-reconciled-closed");
        // Query 404 (close never landed) -> re-issue, still same ID.
        RouteObs o4 = OpenMarket();
        o4.adapter_responded = true;
        o4.query.transport_ok = true;
        o4.query.found = false;
        auto r4 = Step(ra.next, ex, venue, o4);
        Check(r4.action == RouteAction::EXECUTE_EXIT &&
                  r4.next.state == RouteState::EXIT_SENT,
              "exit-absent-reissues");
        // P0-2 close lifecycle: PENDING/PARTIAL reconcile (never
        // CLOSED); DEAD re-issues; only FILLED terminals.
        RouteObs op = OpenMarket();
        op.exit_responded = true;
        op.exit_ack.transport_ok = true;
        op.exit_ack.state = CloseState::PENDING;
        auto rp = Step(r2.next, ex, venue, op);
        Check(rp.action == RouteAction::QUERY_ONCE,
              "exit-pending-reconciles");
        RouteObs op2 = OpenMarket();
        op2.exit_responded = true;
        op2.exit_ack.transport_ok = true;
        op2.exit_ack.state = CloseState::PARTIAL;
        op2.exit_ack.filled_qty = 40;
        auto rp2 = Step(r2.next, ex, venue, op2);
        Check(rp2.action == RouteAction::QUERY_ONCE &&
                  rp2.next.state == RouteState::QUERY_SENT,
              "exit-partial-reconciles");
        RouteObs od = OpenMarket();
        od.exit_responded = true;
        od.exit_ack.transport_ok = true;
        od.exit_ack.state = CloseState::DEAD;
        char bef[65];
        for (int i = 0; i < 65; ++i) bef[i] = r2.next.client_id[i];
        auto rd = Step(r2.next, ex, venue, od);
        // P0-2: DEFINITIVE death burns the ID — re-issue mints the
        // next deterministic sub-identity (never the same POST
        // twice), attributable via the unchanged bound intent.
        bool neon = false;
        for (int i = 0; i < 65; ++i)
            if (rd.next.client_id[i] != bef[i]) neon = true;
        Check(rd.action == RouteAction::EXECUTE_EXIT &&
                  rd.next.state == RouteState::EXIT_SENT &&
                  rd.next.exit_attempt == 1 && neon,
              "exit-dead-new-identity");
        // Second death -> attempt 2, again distinct.
        auto rd2 = Step(rd.next, ex, venue, od);
        bool neon2 = false;
        for (int i = 0; i < 65; ++i)
            if (rd2.next.client_id[i] != rd.next.client_id[i])
                neon2 = true;
        Check(rd2.action == RouteAction::EXECUTE_EXIT &&
                  rd2.next.exit_attempt == 2 && neon2,
              "exit-dead-attempt-2");
        // P0-2 partial DEAD: X filled 40 before cancel -> closed=40
        // persists, Y targets exactly the remaining 60 (never 100).
        RouteObs odp = OpenMarket();
        odp.exit_responded = true;
        odp.exit_ack.transport_ok = true;
        odp.exit_ack.state = CloseState::DEAD;
        odp.exit_ack.filled_qty = 40;
        auto rdp = Step(r2.next, ex, venue, odp);
        Check(rdp.action == RouteAction::EXECUTE_EXIT &&
                  rdp.next.exit_attempt == 1 &&
                  rdp.next.exit_closed_qty == 40 &&
                  rdp.exit_qty == 60 &&
                  rdp.next.broker_id[0] == '\0',
              "exit-dead-partial-remainder");
        // P1-4: the mint clears X's UUID (Y captures its own later).
        Check(rd.next.broker_id[0] == '\0', "exit-mint-clears-uuid");
        // P0/P1-3 stale REST snapshot vs ULID stream authority.
        // Same client/order across both sources; restart-safe via
        // persisted last-event. REST never regresses stream state.
        {
            // Non-trivial floor: crafted QUERY_SENT with an
            // established fill floor 40 + ULID high-water (real
            // binding, so it snapshots/restores like a crash image).
            // A later no-event REST snapshot saying 30 would
            // PARTIAL-regress under naive receipt order; the
            // monotonic floor ignores it instead, byte-identical.
            RouteMachine ms;
            ms.state = RouteState::QUERY_SENT;
            for (int i = 0; i < 64; ++i) ms.client_id[i] = 'a';
            ms.client_id[64] = '\0';
            const char* iid = "intent-001";
            int ii = 0;
            while (iid[ii]) {
                ms.intent_id[ii] = iid[ii];
                ++ii;
            }
            ms.intent_id[ii] = '\0';
            ms.symbol[0] = 'A';
            ms.symbol[1] = 'A';
            ms.symbol[2] = 'P';
            ms.symbol[3] = 'L';
            ms.symbol[4] = '\0';
            ms.filled_qty = 40;
            RouteObs ue = OpenMarket();
            SetUlid(ue, 1780000005000ULL, 3u);
            for (int i = 0; i < 33; ++i)
                ms.last_event_id[i] = ue.event_id[i];
            RouteObs sr = OpenMarket();
            for (int i = 0; i < 65; ++i) sr.client_id[i] = 'a';
            sr.adapter_responded = true;
            sr.query.transport_ok = true;
            sr.query.found = true;
            sr.query.filled_qty = 30;
            sr.query.protection_active = true;
            SetUuid(sr.query.broker_order_id);
            auto s_s = Step(ms, in, venue, sr);
            Check(s_s.action == RouteAction::NONE &&
                      s_s.next.state == RouteState::QUERY_SENT &&
                      s_s.next.filled_qty == 40,
                  "xauth-stale-rest-ignored");
            // Restart between sources: the persisted ULID floor
            // still rejects the stale REST snapshot.
            char snapx[320];
            Check(SnapshotMachine(ms, snapx, sizeof(snapx)),
                  "xauth-restart-snaps");
            RouteMachine qx2;
            Check(RestoreMachine(snapx, &qx2) && qx2.filled_qty == 40,
                  "xauth-restart-loads");
            bool ulid_kept = true;
            for (int i = 0; i < 27 && ulid_kept; ++i)
                if (qx2.last_event_id[i] != ue.event_id[i])
                    ulid_kept = false;
            Check(ulid_kept, "xauth-restart-keeps-ulid");
            auto s_r = Step(qx2, in, venue, sr);
            Check(s_r.action == RouteAction::NONE &&
                      s_r.next.filled_qty == 40,
                  "xauth-restart-stale-ignored");
            // Reverse: a newer ULID 100 still applies over the REST
            // floor (crafted QUERY_SENT, last empty).
            RouteMachine mq2;
            mq2.state = RouteState::QUERY_SENT;
            mq2.client_id[0] = '\0';
            mq2.intent_id[0] = '\0';
            mq2.filled_qty = 40;
            RouteObs mu = OpenMarket();
            mu.adapter_responded = true;
            mu.query.transport_ok = true;
            mu.query.found = true;
            mu.query.filled_qty = 100;
            mu.query.protection_active = true;
            SetUuid(mu.query.broker_order_id);
            SetUlid(mu, 1780000006000ULL, 3u);
            auto m_f = Step(mq2, in, venue, mu);
            Check(m_f.action == RouteAction::JOURNAL_FILL &&
                      m_f.next.filled_qty == 100,
                  "xauth-ulid-over-rest");
        }
        // P0 cross-family LIFECYCLE authority: a no-event REST
        // snapshot may add monotonic fill knowledge but can NEVER
        // originate a terminal transition against ULID-established
        // live stream state. Adversarial case: stream shows X live
        // (partial 40, ULID high-water); later REST with no event
        // claims X canceled at 40. Floor check alone accepts it
        // (40 >= 40) — the lifecycle rule must still refuse to mint
        // Y or otherwise act as X's definitive death.
        {
            OrderIntent ex = in;
            ex.kind = IntentKind::EXIT;
            // Crafted stream-live EXIT machine: QUERY_SENT, live
            // partial 40 folded, ULID high-water, real binding.
            RouteMachine mx;
            mx.state = RouteState::QUERY_SENT;
            mx.kind = IntentKind::EXIT;
            for (int i = 0; i < 64; ++i) mx.client_id[i] = 'c';
            mx.client_id[64] = '\0';
            const char* iix = "intent-001";
            int ixi = 0;
            while (iix[ixi]) {
                mx.intent_id[ixi] = iix[ixi];
                ++ixi;
            }
            mx.intent_id[ixi] = '\0';
            mx.symbol[0] = 'A';
            mx.symbol[1] = 'A';
            mx.symbol[2] = 'P';
            mx.symbol[3] = 'L';
            mx.symbol[4] = '\0';
            mx.exit_closed_qty = 40;
            mx.exit_counted_qty = 40;
            mx.filled_qty = 40;
            RouteObs ue = OpenMarket();
            SetUlid(ue, 1780000005000ULL, 3u);
            for (int i = 0; i < 33; ++i)
                mx.last_event_id[i] = ue.event_id[i];
            // Stale REST terminal: canceled, same qty, NO event.
            RouteObs st = OpenMarket();
            for (int i = 0; i < 65; ++i) st.client_id[i] = 'c';
            st.adapter_responded = true;
            st.query.transport_ok = true;
            st.query.found = true;
            st.query.cancelled = true;
            st.query.filled_qty = 40;
            SetUuid(st.query.broker_order_id);
            auto rs = Step(mx, ex, venue, st);
            Check(rs.action == RouteAction::QUERY_ONCE &&
                      rs.next.state == RouteState::QUERY_SENT &&
                      rs.next.exit_closed_qty == 40 &&
                      rs.next.exit_attempt == 0 &&
                      rs.next.client_id[0] == 'c',
                  "xrest-terminal-reconciles");
            // Restart between sources: still no mint, same totals.
            char snx[320];
            Check(SnapshotMachine(mx, snx, sizeof(snx)),
                  "xrest-snaps");
            RouteMachine qx;
            Check(RestoreMachine(snx, &qx), "xrest-restores");
            auto rr = Step(qx, ex, venue, st);
            Check(rr.action == RouteAction::QUERY_ONCE &&
                      rr.next.exit_attempt == 0 &&
                      rr.next.exit_closed_qty == 40,
                  "xrest-restart-reconciles");
            // Reverse: a NEWER event-carrying ULID cancel (broker
            // time after the stream high-water) IS definitive —
            // ULID-vs-ULID orders it, and the mint proceeds.
            RouteObs nc = OpenMarket();
            for (int i = 0; i < 65; ++i) nc.client_id[i] = 'c';
            nc.adapter_responded = true;
            nc.query.transport_ok = true;
            nc.query.found = true;
            nc.query.cancelled = true;
            nc.query.filled_qty = 40;
            SetUuid(nc.query.broker_order_id);
            SetUlid(nc, 1780000006000ULL, 3u);
            auto rn = Step(mx, ex, venue, nc);
            Check(rn.action == RouteAction::EXECUTE_EXIT &&
                      rn.next.exit_attempt == 1 &&
                      rn.exit_qty == 60,
                  "xrest-newer-ulid-mints");
            // Stale REST protection-state: a snapshot with no legs
            // must NOT unset positively confirmed protection.
            RouteMachine mp;
            mp.state = RouteState::QUERY_SENT;
            for (int i = 0; i < 64; ++i) mp.client_id[i] = 'd';
            mp.client_id[64] = '\0';
            const char* iip = "intent-001";
            int ipi = 0;
            while (iip[ipi]) {
                mp.intent_id[ipi] = iip[ipi];
                ++ipi;
            }
            mp.intent_id[ipi] = '\0';
            mp.symbol[0] = 'A';
            mp.symbol[1] = 'A';
            mp.symbol[2] = 'P';
            mp.symbol[3] = 'L';
            mp.symbol[4] = '\0';
            mp.protection_ok = true;
            mp.filled_qty = 100;
            RouteObs sp = OpenMarket();
            for (int i = 0; i < 65; ++i) sp.client_id[i] = 'd';
            sp.adapter_responded = true;
            sp.query.transport_ok = true;
            sp.query.found = true;
            sp.query.filled_qty = 100;
            sp.query.protection_active = false;
            sp.query.bracket_class = false;
            SetUuid(sp.query.broker_order_id);
            auto rp = Step(mp, in, venue, sp);
            Check(rp.action == RouteAction::JOURNAL_FILL &&
                      rp.next.state == RouteState::PROTECTED,
                  "xrest-protection-stands");
        }
        // Entry-side uncertain terminals: a no-event 404 or a
        // no-event canceled claim against stream-live state
        // reconciles (QUERY_ONCE), never terminals directly.
        {
            // Crafted stream-live ENTRY machine in QUERY_SENT.
            RouteMachine me;
            me.state = RouteState::QUERY_SENT;
            for (int i = 0; i < 64; ++i) me.client_id[i] = 'e';
            me.client_id[64] = '\0';
            const char* iie = "intent-001";
            int iei = 0;
            while (iie[iei]) {
                me.intent_id[iei] = iie[iei];
                ++iei;
            }
            me.intent_id[iei] = '\0';
            me.symbol[0] = 'A';
            me.symbol[1] = 'A';
            me.symbol[2] = 'P';
            me.symbol[3] = 'L';
            me.symbol[4] = '\0';
            RouteObs ue2 = OpenMarket();
            SetUlid(ue2, 1780000005000ULL, 5u);
            for (int i = 0; i < 33; ++i)
                me.last_event_id[i] = ue2.event_id[i];
            // No-event 404 against the live order.
            RouteObs s404 = OpenMarket();
            for (int i = 0; i < 65; ++i) s404.client_id[i] = 'e';
            s404.adapter_responded = true;
            s404.query.transport_ok = true;
            s404.query.found = false;
            auto r404 = Step(me, in, venue, s404);
            Check(r404.action == RouteAction::QUERY_ONCE &&
                      r404.next.state == RouteState::QUERY_SENT,
                  "xrest-404-reconciles");
            // No-event canceled+0 against the live order.
            RouteObs scx = OpenMarket();
            for (int i = 0; i < 65; ++i) scx.client_id[i] = 'e';
            scx.adapter_responded = true;
            scx.query.transport_ok = true;
            scx.query.found = true;
            scx.query.cancelled = true;
            scx.query.filled_qty = 0;
            SetUuid(scx.query.broker_order_id);
            auto rcx = Step(me, in, venue, scx);
            Check(rcx.action == RouteAction::QUERY_ONCE &&
                      rcx.next.state == RouteState::QUERY_SENT,
                  "xrest-cancel-reconciles");
            // No-event canceled + POSITIVE fill: same rule (the
            // terminal claim carries no ordering authority at any
            // qty — reconcile, never PARTIAL/terminal on it).
            RouteObs scp = OpenMarket();
            for (int i = 0; i < 65; ++i) scp.client_id[i] = 'e';
            scp.adapter_responded = true;
            scp.query.transport_ok = true;
            scp.query.found = true;
            scp.query.cancelled = true;
            scp.query.filled_qty = 40;
            SetUuid(scp.query.broker_order_id);
            auto rcp = Step(me, in, venue, scp);
            Check(rcp.action == RouteAction::QUERY_ONCE &&
                      rcp.next.state == RouteState::QUERY_SENT &&
                      rcp.next.filled_qty == 0,
                  "xrest-cancel-fill-reconciles");
            // No-event normalized DEAD + fill: same rule.
            RouteObs sdd = OpenMarket();
            for (int i = 0; i < 65; ++i) sdd.client_id[i] = 'e';
            sdd.adapter_responded = true;
            sdd.query.transport_ok = true;
            sdd.query.found = true;
            sdd.query.filled_qty = 40;
            sdd.query.close_state = CloseState::DEAD;
            SetUuid(sdd.query.broker_order_id);
            auto rdd = Step(me, in, venue, sdd);
            Check(rdd.action == RouteAction::QUERY_ONCE &&
                      rdd.next.state == RouteState::QUERY_SENT,
                  "xrest-dead-fill-reconciles");
            // No-event full FILLED against live state: a conflicting
            // terminal completion claim reconciles too (never
            // PROTECTED on an unordered snapshot).
            RouteObs sff = OpenMarket();
            for (int i = 0; i < 65; ++i) sff.client_id[i] = 'e';
            sff.adapter_responded = true;
            sff.query.transport_ok = true;
            sff.query.found = true;
            sff.query.filled_qty = 100;
            sff.query.protection_active = true;
            sff.query.close_state = CloseState::FILLED;
            SetUuid(sff.query.broker_order_id);
            auto rff = Step(me, in, venue, sff);
            Check(rff.action == RouteAction::QUERY_ONCE &&
                      rff.next.state == RouteState::QUERY_SENT,
                  "xrest-fill-reconciles");
            // Restart: the suppression survives the crash image.
            char snm[320];
            Check(SnapshotMachine(me, snm, sizeof(snm)),
                  "xrest-entry-snaps");
            RouteMachine qm;
            Check(RestoreMachine(snm, &qm), "xrest-entry-restores");
            auto rmr = Step(qm, in, venue, scp);
            Check(rmr.action == RouteAction::QUERY_ONCE &&
                      rmr.next.state == RouteState::QUERY_SENT,
                  "xrest-entry-restart-reconciles");
        }
        // Restart after the mint keeps attempt+id (no double-mint).
        char snapd[320];
        Check(SnapshotMachine(rd.next, snapd, sizeof(snapd)),
              "exitd-snapshots");
        RouteMachine qd;
        Check(RestoreMachine(snapd, &qd) && qd.exit_attempt == 1,
              "exitd-restores");
        bool sameid = true;
        for (int i = 0; i < 65; ++i)
            if (qd.client_id[i] != rd.next.client_id[i]) sameid = false;
        Check(sameid, "exitd-id-survives");
        // Exit query partial (40 < 100): reconcile again, never
        // CLOSED on a partial; exhaustion freezes for S2/human.
        RouteObs oq = OpenMarket();
        oq.adapter_responded = true;
        oq.query.transport_ok = true;
        oq.query.found = true;
        oq.query.filled_qty = 40;
        SetUuid(oq.query.broker_order_id);
        auto rq2 = Step(rp2.next, ex, venue, oq);
        Check(rq2.action == RouteAction::QUERY_ONCE,
              "exit-query-partial-reconciles");
        auto rq3 = Step(rq2.next, ex, venue, oq);
        Check(rq3.action == RouteAction::JOURNAL_UNKNOWN &&
                  rq3.freeze_symbol,
              "exit-query-exhausted-freezes");
        // P0-1: short "fill" (4 < 100) reconciles, never CLOSED.
        RouteObs osf = OpenMarket();
        osf.exit_responded = true;
        osf.exit_ack.transport_ok = true;
        osf.exit_ack.state = CloseState::FILLED;
        osf.exit_ack.filled_qty = 4;
        auto rsf = Step(r2.next, ex, venue, osf);
        Check(rsf.action == RouteAction::QUERY_ONCE &&
                  rsf.next.state == RouteState::QUERY_SENT,
              "exit-short-fill-reconciles");
        // Cancelled-unfilled query burns the ID too (same P0-2 rule).
        RouteObs ocx = OpenMarket();
        ocx.adapter_responded = true;
        ocx.query.transport_ok = true;
        ocx.query.found = true;
        ocx.query.cancelled = true;
        ocx.query.filled_qty = 0;
        SetUuid(ocx.query.broker_order_id);
        char bef2[65];
        for (int i = 0; i < 65; ++i) bef2[i] = ra.next.client_id[i];
        auto rx = Step(ra.next, ex, venue, ocx);
        bool neonx = false;
        for (int i = 0; i < 65; ++i)
            if (rx.next.client_id[i] != bef2[i]) neonx = true;
        Check(rx.action == RouteAction::EXECUTE_EXIT &&
                  rx.next.exit_attempt == 1 && neonx,
              "exit-cancelled-new-identity");
        // Cancelled WITH partial fills folds first: closed=40
        // persists, Y targets the remaining 60 (never re-query a
        // dead order, never resubmit for 100).
        RouteObs ocp = OpenMarket();
        ocp.adapter_responded = true;
        ocp.query.transport_ok = true;
        ocp.query.found = true;
        ocp.query.cancelled = true;
        ocp.query.filled_qty = 40;
        SetUuid(ocp.query.broker_order_id);
        auto rpc = Step(ra.next, ex, venue, ocp);
        Check(rpc.action == RouteAction::EXECUTE_EXIT &&
                  rpc.next.exit_attempt == 1 &&
                  rpc.next.exit_closed_qty == 40 &&
                  rpc.exit_qty == 60,
              "exit-cancelled-partial-folds");
        // Restart of the ambiguous exit reconciles (no duplicate
        // close send: attempts preserved, query first).
        char snap[320];
        Check(SnapshotMachine(ra.next, snap, sizeof(snap)),
              "exitx-snapshots");
        RouteMachine qx;
        Check(RestoreMachine(snap, &qx), "exitx-restores");
        RouteObs ow = OpenMarket();
        ow.adapter_responded = false;
        auto rw = Step(qx, ex, venue, ow);
        Check(rw.action == RouteAction::NONE &&
                  rw.next.state == RouteState::QUERY_SENT,
              "exitx-restart-waits-query");
    }
    // 19e. P1-8 cancel accepted-vs-final: 204/request-accepted
    // stays confirming; only explicit final-canceled terminals;
    // explicit 422 fails to UNKNOWN.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        auto r2 = Step(r1.next, in, venue, o);
        RouteObs oq = OpenMarket();
        oq.adapter_responded = false;
        auto rq = Step(r2.next, in, venue, oq);
        RouteObs on = OpenMarket();
        on.adapter_responded = true;
        on.query.transport_ok = true;
        on.query.found = true;
        on.query.filled_qty = 0;
        SetUuid(on.query.broker_order_id);
        auto rn = Step(rq.next, in, venue, on);
        Check(rn.action == RouteAction::CANCEL_REMAINDER &&
                  rn.next.state == RouteState::CANCEL_SENT,
              "ccl-armed");
        // Accepted (204) but not final: stay confirming.
        RouteObs oa = OpenMarket();
        oa.adapter_responded = true;
        oa.cancel_accepted = true;
        auto ra2 = Step(rn.next, in, venue, oa);
        Check(ra2.action == RouteAction::CONFIRM_CANCELLED &&
                  ra2.next.state == RouteState::CANCEL_SENT,
              "cancel-accepted-stays");
        // Final canceled observed: terminal now.
        RouteObs of2 = OpenMarket();
        of2.adapter_responded = true;
        of2.cancel_confirmed = true;
        auto rf2 = Step(rn.next, in, venue, of2);
        Check(rf2.action == RouteAction::JOURNAL_CANCEL &&
                  rf2.next.state == RouteState::CANCELLED,
              "cancel-final-terminals");
        // Explicit 422: UNKNOWN, never terminal-cancel.
        RouteObs ox = OpenMarket();
        ox.adapter_responded = true;
        ox.cancel_failed = true;
        auto rx2 = Step(rn.next, in, venue, ox);
        Check(rx2.action == RouteAction::JOURNAL_UNKNOWN &&
                  rx2.freeze_symbol,
              "cancel-refused-unknown");
    }
    // 19g. P0-3/P0-4 ULID broker-time authority (real Alpaca-shaped
    // stream ids, verbatim preserved): older-ULID-after-newer is
    // stale even though it ARRIVED later; duplicates collapse;
    // same-ms ties break by full-string order; the winner persists
    // in the snapshot bytes.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        Tag(o, r1.next);
        auto r2 = Step(r1.next, in, venue, o);
        // Arm to QUERY_SENT with an untagged ack-wait (last empty).
        RouteObs pre = OpenMarket();
        Tag(pre, r2.next);
        pre.adapter_responded = false;
        auto rq = Step(r2.next, in, venue, pre);
        Check(rq.action == RouteAction::QUERY_ONCE, "ulid-armed");
        // Failed lookup tagged t2 advances the high-water.
        RouteObs e2 = OpenMarket();
        Tag(e2, rq.next);
        e2.query.transport_ok = false;
        SetUlid(e2, 1780000002000ULL, 7u);
        auto a2 = Step(rq.next, in, venue, e2);
        Check(a2.action == RouteAction::QUERY_ONCE &&
                  a2.next.query_attempts == 2,
              "ulid-newer-applies");
        // Older ULID arriving later: stale, byte-identical.
        RouteObs e1 = OpenMarket();
        Tag(e1, a2.next);
        e1.query.transport_ok = false;
        SetUlid(e1, 1780000001000ULL, 7u);
        char ub[320], ua[320];
        Check(SnapshotMachine(a2.next, ub, sizeof(ub)), "ulid-snaps");
        auto as = Step(a2.next, in, venue, e1);
        bool sok = (as.action == RouteAction::NONE) &&
                   SnapshotMachine(as.next, ua, sizeof(ua));
        if (sok) {
            for (int bi = 0; ub[bi] || ua[bi]; ++bi)
                if (ub[bi] != ua[bi]) sok = false;
        }
        Check(sok, "ulid-stale-ignored");
        // Exact redelivery of t2: duplicate collapse.
        auto ad = Step(a2.next, in, venue, e2);
        Check(ad.action == RouteAction::NONE &&
                  ad.next.query_attempts == 2,
              "ulid-duplicate-collapses");
        // Same-ms tiebreak on a machine with budget headroom:
        // winner persists verbatim in state.
        RouteMachine mq;
        mq.state = RouteState::QUERY_SENT;
        mq.client_id[0] = '\0';  // unbound crafted machine: gates out
        mq.intent_id[0] = '\0';
        RouteObs eA = OpenMarket();
        eA.query.transport_ok = false;
        SetUlid(eA, 1780000003000ULL, 1u);
        RouteObs eB = OpenMarket();
        eB.query.transport_ok = false;
        SetUlid(eB, 1780000003000ULL, 2u);
        // Same-ms tiebreak on a machine with budget headroom: the
        // lexicographically larger wins; presenting winner-first,
        // the smaller is stale (arrival order cannot override
        // broker-time order). Winner persists verbatim in state.
        int wcmp = 0;
        for (int i = 0; i < 26; ++i) {
            if (eA.event_id[i] != eB.event_id[i]) {
                wcmp = (eA.event_id[i] > eB.event_id[i]) ? 1 : -1;
                break;
            }
        }
        Check(wcmp != 0, "ulid-tiebreak-distinct");
        RouteObs& wfirst = (wcmp > 0) ? eA : eB;
        RouteObs& wsecond = (wcmp > 0) ? eB : eA;
        auto aW = Step(mq, in, venue, wfirst);
        auto aL = Step(aW.next, in, venue, wsecond);
        Check(aW.action == RouteAction::QUERY_ONCE &&
                  aL.action == RouteAction::NONE,
              "ulid-tiebreak-decisive");
        bool kept = true;
        for (int i = 0; i < 27 && kept; ++i)
            if (aW.next.last_event_id[i] != wfirst.event_id[i])
                kept = false;
        Check(kept, "ulid-tiebreak-persists-winner");
    }
    // 19f. P1-9 event-bearing ordering: distinct events carry
    // id+seq; duplicates collapse; permuted arrival converges.
    {
        RouteMachine m;
        RouteObs o = OpenMarket();
        auto r1 = Step(m, in, venue, o);
        Tag(o, r1.next);
        auto r2 = Step(r1.next, in, venue, o);
        // Same event twice: second collapses (no double budget).
        RouteObs e1 = OpenMarket();
        Tag(e1, r2.next);
        e1.adapter_responded = false;
        SetEvent(e1, 1);
        auto a1 = Step(r2.next, in, venue, e1);
        Check(a1.action == RouteAction::QUERY_ONCE, "ev-applies");
        auto a2 = Step(a1.next, in, venue, e1);
        Check(a2.action == RouteAction::NONE &&
                  a2.next.query_attempts == 1,
              "ev-duplicate-collapses");
        // A distinct event (new id+seq) still applies.
        RouteObs e2 = OpenMarket();
        Tag(e2, a1.next);
        SetEvent(e2, 2);
        e2.query.transport_ok = false;  // failed lookup, not silence
        auto a3 = Step(a1.next, in, venue, e2);
        Check(a3.action == RouteAction::QUERY_ONCE &&
                  a3.next.query_attempts == 2,
              "ev-distinct-applies");
        // P0-4 adversarial order: stale fill arriving AFTER the
        // fresh fill is ignored (naive receipt-order would regress
        // filled 100 -> 40); early-or-late, the final is identical.
        {
            // Order A: fresh (seq2, fill 100) then stale (seq1, 40).
            RouteMachine ma;
            RouteObs oa = OpenMarket();
            auto a_r1 = Step(ma, in, venue, oa);
            Tag(oa, a_r1.next);
            auto a_r2 = Step(a_r1.next, in, venue, oa);
            RouteObs fresh = OpenMarket();
            Tag(fresh, a_r2.next);
            fresh.adapter_responded = true;
            fresh.query.transport_ok = true;
            fresh.query.found = true;
            fresh.query.filled_qty = 100;
            fresh.query.protection_active = true;
            SetUuid(fresh.query.broker_order_id);
            SetEvent(fresh, 2);
            // Drive to QUERY_SENT first (fresh ack, seq1).
            RouteObs pre = OpenMarket();
            Tag(pre, a_r2.next);
            pre.adapter_responded = false;
            SetEvent(pre, 1);
            auto a_q = Step(a_r2.next, in, venue, pre);
            Check(a_q.action == RouteAction::QUERY_ONCE, "adv-armed");
            auto a_f = Step(a_q.next, in, venue, fresh);
            Check(a_f.action == RouteAction::JOURNAL_FILL &&
                      a_f.next.filled_qty == 100,
                  "adv-fresh-applies");
            // Late stale delivery (seq1 < high-water 2): ignored,
            // machine byte-identical.
            RouteObs stale = OpenMarket();
            Tag(stale, a_f.next);
            stale.adapter_responded = true;
            stale.query.transport_ok = true;
            stale.query.found = true;
            stale.query.filled_qty = 40;
            stale.query.protection_active = true;
            SetUuid(stale.query.broker_order_id);
            SetEvent(stale, 1);
            char sb[320], sa[320];
            Check(SnapshotMachine(a_f.next, sb, sizeof(sb)),
                  "adv-snaps");
            auto a_s = Step(a_f.next, in, venue, stale);
            bool s_ok = (a_s.action == RouteAction::NONE) &&
                        SnapshotMachine(a_s.next, sa, sizeof(sa));
            if (s_ok) {
                for (int bi = 0; sb[bi] || sa[bi]; ++bi)
                    if (sb[bi] != sa[bi]) s_ok = false;
            }
            Check(s_ok, "adv-stale-ignored");
            // Same-seq, different id on the live machine: conflict,
            // first-wins (non-terminal proof, not a terminal echo).
            RouteObs conf = OpenMarket();
            Tag(conf, a_q.next);
            conf.adapter_responded = false;
            SetEvent(conf, 1);  // seq1 taken by pre (other id)
            conf.event_id[0] =
                (conf.event_id[0] == '0') ? '1' : '0';
            auto a_c = Step(a_q.next, in, venue, conf);
            Check(a_c.action == RouteAction::NONE &&
                      a_c.next.query_attempts == 1,
                  "adv-conflict-first-wins");
        }
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
            // Original-intent binding (empty on IDLE only).
            if (st != 0) {
                const char* iid = "intent-001";
                int i = 0;
                while (iid[i]) {
                    m.intent_id[i] = iid[i];
                    ++i;
                }
                m.intent_id[i] = '\0';
                m.symbol[0] = 'A';
                m.symbol[1] = 'A';
                m.symbol[2] = 'P';
                m.symbol[3] = 'L';
                m.symbol[4] = '\0';
                m.side = (st & 8) ? OrderSide::SELL : OrderSide::BUY;
            }
            for (int i = 0; i < 32; ++i)
                m.last_event_id[i] = (i % 2) ? 'b' : 'a';
            m.last_event_id[32] = '\0';
            m.last_event_seq = (std::uint64_t)(st * 3 + 1);
            m.filled_qty = st * 7;
            m.query_attempts = (std::uint8_t)(st % 3);
            m.exit_attempt = (std::uint8_t)(st % 2);
            m.exit_closed_qty = (std::int64_t)((st * 11) % 101);
            m.exit_counted_qty = (std::int64_t)((st * 7) % 101);
            m.emergency = (st & 2) != 0;
            m.protection_ok = (st & 4) != 0;
            char buf[320];
            RouteMachine q;
            bool ok =
                SnapshotMachine(m, buf, sizeof(buf)) &&
                RestoreMachine(buf, &q);
            char name[32];
            std::snprintf(name, sizeof(name), "snap-%d", st);
            bool same = ok && q.state == m.state &&
                        q.kind == m.kind &&
                        q.query_attempts == m.query_attempts &&
                        q.exit_attempt == m.exit_attempt &&
                        q.exit_closed_qty == m.exit_closed_qty &&
                        q.exit_counted_qty == m.exit_counted_qty &&
                        q.filled_qty == m.filled_qty &&
                        q.emergency == m.emergency &&
                        q.side == m.side &&
                        q.last_event_seq == m.last_event_seq &&
                        q.protection_ok == m.protection_ok;
            for (int i = 0; i < 65 && same; ++i)
                if (q.client_id[i] != m.client_id[i]) same = false;
            for (int i = 0; i < 64 && same; ++i)
                if (q.broker_id[i] != m.broker_id[i]) same = false;
            for (int i = 0; i < 65 && same; ++i)
                if (q.intent_id[i] != m.intent_id[i]) same = false;
            for (int i = 0; i < 16 && same; ++i)
                if (q.symbol[i] != m.symbol[i]) same = false;
            for (int i = 0; i < 33 && same; ++i)
                if (q.last_event_id[i] != m.last_event_id[i])
                    same = false;
            Check(same, name);
        }
        RouteMachine q;
        Check(!RestoreMachine(nullptr, &q), "snap-null");
        Check(!RestoreMachine("H1:0:0:0:0:0:0:::::0::0:0:0:0", nullptr),
              "snap-null-out");
        Check(!RestoreMachine("X1:0:0:0:0:0:0:::::0::0:0:0:0", &q),
              "snap-tag");
        Check(!RestoreMachine("H1:13:0:0:0:0:0:::intent-001:AAPL:0::0:0:0:0",
                              &q),
              "snap-state");
        Check(!RestoreMachine("H1:0:2:0:0:0:0:::::0::0:0:0:0", &q),
              "snap-kind");
        Check(!RestoreMachine("H1:0:0:0:0:0:0:ZZ::::0::0:0:0:0", &q),
              "snap-hex");
        Check(!RestoreMachine("H1:0:0:0:0:0:0:::::0::0extra:0:0:0", &q),
              "snap-trailing");
        Check(!RestoreMachine("H1:0:0:0:0:0:0:", &q), "snap-short");
        // UUID grammar: hyphens exact, lowercase hex, 36 chars.
        Check(!RestoreMachine("H1:0:0:0:0:0:0::0193ABCD-1234-5678-9abc-"
                              "def012345678:::0::0:0:0:0",
                              &q),
              "snap-uuid-upper");
        Check(!RestoreMachine("H1:0:0:0:0:0:0::0193abcd1234-5678-9abc-"
                              "def012345678:::0::0:0:0:0",
                              &q),
              "snap-uuid-hyphen");
        Check(!RestoreMachine("H1:0:0:0:0:0:0::0193abcd:::0::0:0:0:0", &q),
              "snap-uuid-short");
        Check(!RestoreMachine("H1:0:0:0:0:0:0::0193abcd-1234-5678-9abc-"
                              "def01234567X:::0::0:0:0:0",
                              &q),
              "snap-uuid-char");
        // Empty broker id restores (no UUID observed yet), binding
        // intact.
        Check(RestoreMachine("H1:2:0:0:0:0:0:::intent-001:AAPL:0::0:0:0:0",
                             &q) &&
                  q.broker_id[0] == '\0' && q.symbol[1] == 'A' &&
                  q.side == OrderSide::BUY,
              "snap-empty-bid");
        // Binding coherence: IDLE carries none; non-IDLE requires all.
        Check(!RestoreMachine("H1:0:0:0:0:0:0:::intent-001:AAPL:0::0:0:0:0",
                              &q),
              "snap-idle-with-binding");
        Check(!RestoreMachine("H1:2:0:0:0:0:0:::::0::0:0:0:0", &q),
              "snap-binding-required");
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:0:::intent 001:AAPL:0::0:0:0:0", &q),
              "snap-bad-intent");
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:0:::intent-001:aapl:0::0:0:0:0", &q),
              "snap-bad-sym");
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:0:::intent-001:AAPL:2::0:0:0:0", &q),
              "snap-bad-side");
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:0:::intent-001:AAPL:0:Z!::0:0:0:0", &q),
              "snap-bad-evid");
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:0:::intent-001:AAPL:0::x:0:0:0", &q),
              "snap-bad-evseq");
        // P1-3: persisted budget is exactly 0..2 (frozen
        // kQueryMaxAttempts); 3 and 9 refuse both ways.
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:3:::intent-001:AAPL:0::0:0:0:0", &q),
              "snap-att-3-refused");
        Check(!RestoreMachine(
                  "H1:2:0:0:0:0:9:::intent-001:AAPL:0::0:0:0:0", &q),
              "snap-att-9-refused");
        // Exit sub-identity counter: exactly one digit 0..9.
        Check(!RestoreMachine(
                  "H1:9:1:0:0:0:0:aa::intent-001:AAPL:0::0:X:0:0", &q),
              "snap-xatt-bad");
        Check(RestoreMachine(
                  "H1:9:1:0:0:0:0:aa::intent-001:AAPL:0::0:3:40:30",
                  &q) &&
                  q.exit_attempt == 3 && q.exit_closed_qty == 40 &&
                  q.exit_counted_qty == 30,
              "snap-xatt-roundtrip");
        Check(!RestoreMachine(
                  "H1:9:1:0:0:0:0:aa::intent-001:AAPL:0::0:3:40", &q),
              "snap-ecount-short");
        Check(!RestoreMachine(
                  "H1:9:1:0:0:0:0:aa::intent-001:AAPL:0::0:3:40:30x",
                  &q),
              "snap-ecount-trailing");
        {
            RouteMachine mw2;
            mw2.state = RouteState::QUERY_SENT;
            mw2.query_attempts = 3;
            for (int i = 0; i < 64; ++i) mw2.client_id[i] = 'a';
            mw2.client_id[64] = '\0';
            const char* iid2 = "intent-001";
            int i2 = 0;
            while (iid2[i2]) {
                mw2.intent_id[i2] = iid2[i2];
                ++i2;
            }
            mw2.intent_id[i2] = '\0';
            mw2.symbol[0] = 'A';
            mw2.symbol[1] = 'A';
            mw2.symbol[2] = 'P';
            mw2.symbol[3] = 'L';
            mw2.symbol[4] = '\0';
            char buf2[320];
            Check(!SnapshotMachine(mw2, buf2, sizeof(buf2)),
                  "snap-write-att-3-refused");
        }
        // Writer refuses un-restorable machines (garbage must never
        // be persisted: an unrecoverable snapshot is a crash-path lie).
        {
            using jev::exec::SnapshotMachine;
            RouteMachine mw;
            mw.state = RouteState::QUERY_SENT;
            for (int i = 0; i < 64; ++i) mw.client_id[i] = 'a';
            mw.client_id[64] = '\0';
            const char* bad = "not-a-uuid!";
            int i = 0;
            while (bad[i]) {
                mw.broker_id[i] = bad[i];
                ++i;
            }
            mw.broker_id[i] = '\0';
            const char* iid = "intent-001";
            i = 0;
            while (iid[i]) {
                mw.intent_id[i] = iid[i];
                ++i;
            }
            mw.intent_id[i] = '\0';
            mw.symbol[0] = 'A';
            mw.symbol[1] = 'A';
            mw.symbol[2] = 'P';
            mw.symbol[3] = 'L';
            mw.symbol[4] = '\0';
            char buf[320];
            Check(!SnapshotMachine(mw, buf, sizeof(buf)),
                  "snap-writer-refuses-garbage");
        }
        char tiny[8];
        RouteMachine m;
        Check(!SnapshotMachine(m, nullptr, 64), "snap-ser-null");
        Check(!SnapshotMachine(m, tiny, sizeof(tiny)), "snap-ser-small");
    }
    if (g_fail == 0) std::printf("ROUTER SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
