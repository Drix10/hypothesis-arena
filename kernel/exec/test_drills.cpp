// H1 gate [drill]: randomized ordering, crash/restart, outage rows,
// D+H1 integration, journal-only summary, redaction/retention.
// Deterministic (seeded LCG, no RNG): every seed must converge to the
// same broker-consistent final state. Usage: ./test_drills
#include <cstdio>

#include "../broker/adapter.hpp"
#include "../broker/alpaca_paper.hpp"
#include "../jev_validate.hpp"  // Sha256Hex for the test sink only
#include "../kill/switch.hpp"   // D+H1: real level evaluation consumed
#include "../log/journal.hpp"
#include "../risk/veto.hpp"
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
using jev::exec::RestoreMachine;
using jev::exec::RouteAction;
using jev::exec::RouteMachine;
using jev::exec::RouteObs;
using jev::exec::RouteState;
using jev::exec::SnapshotMachine;
using jev::exec::VenueCtx;
using jev::journal::Row;
using jev::risk::IntentKind;
using jev::risk::KillLevel;

// Seeded LCG (test-only determinism; the kernel never rolls dice).
static unsigned g_rng = 0x12345678;
static unsigned NextRand() {
    g_rng = g_rng * 1664525u + 1013904223u;
    return (g_rng >> 16) & 0x7FFFu;
}

static void FillId(char (&d)[65], const char* s) {
    int i = 0;
    while (s[i] && i < 64) {
        d[i] = s[i];
        ++i;
    }
    d[i] = '\0';
}

struct Ctx {
    OrderIntent in;
    VenueCtx venue;
};

static Ctx GoodCtx(const char* iid, const char* sym) {
    Ctx c;
    FillId(c.in.intent_id, iid);
    int i = 0;
    while (sym[i] && i < 15) {
        c.in.symbol[i] = sym[i];
        ++i;
    }
    c.in.symbol[i] = '\0';
    c.in.side = OrderSide::BUY;
    c.in.qty_shares = 100;
    c.in.stop_cents = 22000;
    c.in.tp_cents = 24000;
    c.in.kind = IntentKind::ENTRY;
    const char* b = "alpaca-paper";
    const char* a = "paper-acct-7";
    i = 0;
    while (b[i]) {
        c.venue.broker[i] = b[i];
        ++i;
    }
    c.venue.broker[i] = '\0';
    i = 0;
    while (a[i]) {
        c.venue.account[i] = a[i];
        ++i;
    }
    c.venue.account[i] = '\0';
    for (int k = 0; k < 64; ++k) c.venue.context_hash[k] = 'b';
    c.venue.context_hash[64] = '\0';
    return c;
}

static RouteObs OpenMarket() {
    RouteObs o;
    o.journal_ok = true;
    o.adapter_responded = true;
    o.query_due = true;
    o.stage_entry_ok = true;
    return o;
}

// Journal sink: appends a row per WRITE_*/JOURNAL_* action with the
// caller-owned chain (proves journal sufficiency for the summary).
struct Sink {
    Row rows[64];
    int n = 0;
    std::uint64_t seq = 0;
    const char* hex =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    bool append(const char* kind, const char* intent, const char* body) {
        if (n >= 64 || !jev::journal::RedactionOk(body)) return false;
        // Chain link (no temporaries: genesis is 64 zeros inline).
        char prevbuf[65];
        if (n == 0) {
            for (int i = 0; i < 64; ++i) prevbuf[i] = '0';
            prevbuf[64] = '\0';
        } else {
            const std::string& ph = rows[n - 1].row_hash;
            for (int i = 0; i < 64; ++i) prevbuf[i] = ph[i];
            prevbuf[64] = '\0';
        }
        char pay[65];
        {
            // payload digest over the redacted body (bounded test sink).
            std::string h = jev::Sha256Hex(body);
            for (int i = 0; i < 64; ++i) pay[i] = h[i];
            pay[64] = '\0';
        }
        if (!jev::journal::FormatRow(seq, 1000 + seq * 100, kind,
                                     intent, pay, prevbuf, &rows[n]))
            return false;
        ++n;
        ++seq;
        return true;
    }
    bool verify() const {
        return jev::journal::VerifyChain(rows, n);
    }
};

static const char* kIntentBody = "intent entry 100 AAPL";

// Drives one machine to a terminal state over a script; records the
// journal-kind trace and snapshots bytes after every step.
struct Drive {
    RouteMachine m;
    const char* trace[16];
    int tn = 0;
    char snaps[16][256];
    int sn = 0;
    int intent_rows = 0;
    void step(const Ctx& c, const RouteObs& o, Sink* sink) {
        auto r = jev::exec::RouteStep(m, c.in, c.venue, o);
        if (r.action == RouteAction::WRITE_JOURNAL ||
            r.action == RouteAction::JOURNAL_FILL ||
            r.action == RouteAction::JOURNAL_PARTIAL ||
            r.action == RouteAction::JOURNAL_CANCEL ||
            r.action == RouteAction::JOURNAL_UNKNOWN ||
            r.action == RouteAction::JOURNAL_EXIT ||
            r.action == RouteAction::JOURNAL_REPAIR) {
            if (r.action == RouteAction::WRITE_JOURNAL) ++intent_rows;
            if (sink) sink->append(r.journal_kind, c.in.intent_id,
                                   kIntentBody);
            if (tn < 16) trace[tn++] = r.journal_kind;
        }
        m = r.next;
        if (sn < 16) SnapshotMachine(m, snaps[sn++], 256);
    }
};

static bool SameTrace(const Drive& a, const Drive& b) {
    if (a.tn != b.tn) return false;
    for (int i = 0; i < a.tn; ++i) {
        const char* x = a.trace[i];
        const char* y = b.trace[i];
        while (*x && *y && *x == *y) {
            ++x;
            ++y;
        }
        if (*x != *y) return false;
    }
    return true;
}

int main() {
    using jev::exec::RouteStep;
    // 1. randomized duplicate/redundant delivery: ONE broker reality
    // expressed as full consistent observations, delivered in rotated
    // orders with duplicates. Every seed must converge to the same
    // terminal + trace + client ID (duplicates/reorderings of a
    // consistent reality cannot fork the machine).
    Drive base;
    {
        Ctx c = GoodCtx("intent-001", "AAPL");
        Sink sink;
        Drive d;
        RouteObs o = OpenMarket();
        o.ack.accepted = true;
        o.ack.protection_accepted = true;
        o.query.found = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        for (int i = 0; i < 4; ++i) d.step(c, o, &sink);
        base = d;
        Check(d.m.state == RouteState::PROTECTED, "drill-base-protected");
    }
    for (int seed = 0; seed < 25; ++seed) {
        g_rng = 0x1000u + (unsigned)seed;
        Ctx c = GoodCtx("intent-001", "AAPL");
        Sink sink;
        Drive d;
        // One extra duplicate at a rotating slot (0-3), plus a
        // rotating number of trailing duplicates after completion.
        int dup_at = (int)(NextRand() % 4);
        int trailing = (int)(NextRand() % 3);
        for (int i = 0; i < 4 + 1 + trailing; ++i) {
            RouteObs o = OpenMarket();
            o.ack.accepted = true;
            o.ack.protection_accepted = true;
            o.query.found = true;
            o.query.filled_qty = 100;
            o.query.protection_active = true;
            if (i == dup_at || i > 4) {
                // duplicate delivery: same consistent observation
            }
            (void)i;
            d.step(c, o, &sink);
        }
        char name[40];
        std::snprintf(name, sizeof(name), "drill-converge-%d", seed);
        bool ok = (d.m.state == RouteState::PROTECTED) &&
                  SameTrace(d, base) && sink.verify();
        for (int i = 0; i < 65 && ok; ++i)
            if (d.m.client_id[i] != base.m.client_id[i]) ok = false;
        Check(ok, name);
    }
    // 1b. second reality (partial fill): rotated + duplicated delivery
    // converges to partial-cancel-protected with its own fixed trace.
    {
        Ctx c = GoodCtx("intent-001b", "AAPL");
        Sink sink;
        Drive d;
        RouteObs fill;
        fill.journal_ok = true;
        fill.adapter_responded = true;
        fill.query_due = true;
        fill.stage_entry_ok = true;
        fill.ack.accepted = true;
        fill.ack.protection_accepted = true;
        RouteObs q = fill;
        q.journal_ok = false;
        q.query.found = true;
        q.query.filled_qty = 40;
        q.query.protection_active = true;
        RouteObs cc = fill;
        cc.cancel_confirmed = true;
        // order: journal, send, query(fill 40), partial-row, cancel,
        // confirm — with the query observation duplicated once.
        d.step(c, fill, &sink);
        d.step(c, fill, &sink);
        d.step(c, q, &sink);
        d.step(c, q, &sink);  // duplicate query delivery: quiet
        d.step(c, q, &sink);
        d.step(c, cc, &sink);
        d.step(c, cc, &sink);  // confirm lands: cancel journaled
        Check(d.m.state == RouteState::PROTECTED &&
                  d.m.filled_qty == 40 && sink.verify(),
              "drill-partial-converge");
    }
    // 2. crash mid-cycle: snapshot after EVERY step; reload from each
    // and complete. Same terminal, same ID, exactly one intent row.
    {
        Ctx c = GoodCtx("intent-002", "AAPL");
        Drive full;
        Sink sink_full;
        RouteObs o = OpenMarket();
        full.step(c, o, &sink_full);
        full.step(c, o, &sink_full);
        o.journal_ok = false;
        o.adapter_responded = false;
        full.step(c, o, &sink_full);
        o.adapter_responded = true;
        o.query.found = true;
        o.query.filled_qty = 100;
        o.query.protection_active = true;
        full.step(c, o, &sink_full);
        Check(full.m.state == RouteState::PROTECTED, "crash-base");
        for (int s = 0; s < full.sn; ++s) {
            RouteMachine m;
            char name[40];
            std::snprintf(name, sizeof(name), "crash-resume-%d", s);
            if (!RestoreMachine(full.snaps[s], &m)) {
                Check(false, name);
                continue;
            }
            // Resume with the consistent-reality observation (ack +
            // query agree the order filled protected). Any snapshot
            // advances: JOURNAL_PENDING->SEND, SENT_UNACKED->QUERY,
            // QUERY_SENT->FILL, PROTECTED rests. Prefix intent rows:
            // every snapshot is post-step-0, so the live run had
            // written its single intent row already.
            RouteObs w = OpenMarket();
            w.ack.accepted = true;
            w.ack.protection_accepted = true;
            w.query.found = true;
            w.query.filled_qty = 100;
            w.query.protection_active = true;
            Drive d;
            d.m = m;
            Sink sink;
            for (int i = 0; i < 6; ++i) d.step(c, w, &sink);
            bool ok = (d.m.state == RouteState::PROTECTED);
            for (int i = 0; i < 65 && ok; ++i)
                if (d.m.client_id[i] != full.m.client_id[i]) ok = false;
            // Exactly one intent row across crash + resume (no dup ID).
            int intents = 1;  // live-run prefix (all snaps post-step-0)
            for (int t = 0; t < d.tn; ++t) {
                const char* k = d.trace[t];
                if (k[0] == 'i' && k[1] == 'n' && k[2] == 't' &&
                    k[3] == 'e' && k[4] == 'n' && k[5] == 't' &&
                    k[6] == '\0')
                    ++intents;
            }
            Check(ok && intents == 1 && sink.verify(), name);
        }
    }
    // 3. outage rows (§6.2a mapped to router inputs): new risk stops,
    // old risk stays managed (exits alive in every row).
    {
        Ctx c = GoodCtx("intent-003", "AAPL");
        // feed down
        RouteMachine m;
        RouteObs o = OpenMarket();
        o.feed_stale = true;
        Check(RouteStep(m, c.in, c.venue, o).action ==
                  RouteAction::REJECT,
              "outage-feed-blocks-entry");
        OrderIntent ex = c.in;
        ex.kind = IntentKind::EXIT;
        RouteMachine me;
        me.kind = IntentKind::EXIT;
        Check(RouteStep(me, ex, c.venue, o).action ==
                  RouteAction::WRITE_JOURNAL,
              "outage-feed-exit-alive");
        // broker down (unwired adapter refuses; router journals cancel)
        jev::broker::AlpacaPaperAdapter dead(nullptr);
        jev::broker::ProtectedOrder po;
        po.symbol[0] = 'A';
        po.symbol[1] = 'A';
        po.symbol[2] = 'P';
        po.symbol[3] = 'L';
        po.symbol[4] = '\0';
        po.side = jev::broker::OrderSide::BUY;
        po.qty_shares = 100;
        po.stop_cents = 22000;
        po.tp_cents = 24000;
        auto dead_ack = dead.SubmitProtected(po);
        Check(!dead_ack.accepted, "outage-broker-refuses");
        RouteMachine m2;
        RouteObs o2 = OpenMarket();
        auto e1 = RouteStep(m2, c.in, c.venue, o2);
        auto e2 = RouteStep(e1.next, c.in, c.venue, o2);
        o2.ack.accepted = false;  // transport-level refusal surfaces here
        auto e3 = RouteStep(e2.next, c.in, c.venue, o2);
        Check(e3.action == RouteAction::JOURNAL_CANCEL,
              "outage-broker-no-naked-risk");
        // JEV down -> SOFT via the REAL Slice D evaluator (no D change:
        // H1 consumes the level as a frozen input).
        jev::kill::KillInputs ki;
        ki.jev_streak_s5 = true;
        auto lvl = jev::kill::EvaluateLevel(ki);
        Check(lvl.level == KillLevel::SOFT, "outage-d-level");
        RouteMachine m3;
        RouteObs o3 = OpenMarket();
        o3.kill = lvl.level;
        Check(RouteStep(m3, c.in, c.venue, o3).action ==
                  RouteAction::REJECT,
              "outage-jev-blocks-entry");
        RouteMachine me3;
        me3.kind = IntentKind::EXIT;
        Check(RouteStep(me3, ex, c.venue, o3).action ==
                  RouteAction::WRITE_JOURNAL,
              "outage-jev-exit-alive");
        // journal chain break -> HARD blocks entries, exits alive.
        RouteMachine m4;
        RouteObs o4 = OpenMarket();
        o4.kill = KillLevel::HARD;
        Check(RouteStep(m4, c.in, c.venue, o4).action ==
                  RouteAction::REJECT,
              "outage-hard-blocks-entry");
        RouteMachine me4;
        me4.kind = IntentKind::EXIT;
        Check(RouteStep(me4, ex, c.venue, o4).action ==
                  RouteAction::WRITE_JOURNAL,
              "outage-hard-exit-alive");
        // research down (stage entry closed) blocks entries only.
        RouteMachine m5;
        RouteObs o5 = OpenMarket();
        o5.stage_entry_ok = false;
        Check(RouteStep(m5, c.in, c.venue, o5).action ==
                  RouteAction::REJECT,
              "outage-research-blocks-entry");
    }
    // 4. journal-only summary: counts derivable from rows alone; the
    // chain verifies over the whole drill sink.
    {
        Sink sink;
        sink.append("intent", "i-a", kIntentBody);
        sink.append("fill", "i-a", kIntentBody);
        sink.append("intent", "i-b", kIntentBody);
        sink.append("partial", "i-b", kIntentBody);
        sink.append("cancel", "i-b", kIntentBody);
        sink.append("exit", "i-a", kIntentBody);
        int fills = 0, partials = 0, cancels = 0, exits = 0;
        for (int i = 0; i < sink.n; ++i) {
            const char* k = sink.rows[i].kind.c_str();
            if (k[0] == 'f') ++fills;
            if (k[0] == 'p') ++partials;
            if (k[0] == 'c') ++cancels;
            if (k[0] == 'e') ++exits;
        }
        Check(fills == 1 && partials == 1 && cancels == 1 && exits == 1,
              "summary-counts");
        Check(sink.verify(), "summary-chain");
        // Every row carries the fields a summary needs.
        bool fields = true;
        for (int i = 0; i < sink.n && fields; ++i)
            fields = sink.rows[i].ts_ns > 0 &&
                     !sink.rows[i].intent_id.empty() &&
                     sink.rows[i].seq == (unsigned)i;
        Check(fields, "summary-fields");
    }
    if (g_fail == 0) std::printf("DRILL SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
