// Slice D gate [correctness + drill]: kill evaluation, entry gate,
// MEDIUM flatten FSM, HARD ordered sequence, persistence round-trip.
// Usage: ./test_kill
#include <cstdio>
#include <ctime>

#include "switch.hpp"

static int g_fail = 0;
static int g_count = 0;

static void Check(bool cond, const char* name) {
    ++g_count;
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

using jev::kill::Closer;
using jev::kill::FlattenState;
using jev::kill::HardAction;
using jev::kill::HardPhase;
using jev::risk::KillLevel;

int main() {
    using jev::kill::EvaluateLevel;
    using jev::kill::KillInputs;
    // 1. empty inputs -> NONE
    {
        KillInputs in;
        auto r = EvaluateLevel(in);
        Check(r.level == KillLevel::NONE, "empty-none");
    }
    // 2. each SOFT trigger alone -> SOFT + frozen reason
    {
        struct Case {
            const char* name;
            KillInputs in;
        };
        KillInputs h;
        h.halt_file = true;
        KillInputs j;
        j.jev_streak_s5 = true;
        KillInputs f;
        f.feed_stale_gt30s = true;
        KillInputs s;
        s.spend_tier = 2;
        KillInputs r;
        r.research_paused_past_ttl = true;
        const Case cases[] = {
            {"soft-halt", h}, {"soft-s5", j}, {"soft-stale", f},
            {"soft-tier2", s}, {"soft-research", r},
        };
        const char* reasons[] = {
            "kill:halt-file", "kill:jev-streak-s5", "kill:feed-stale",
            "kill:spend-tier-2", "kill:research-paused",
        };
        for (int i = 0; i < 5; ++i) {
            auto r2 = EvaluateLevel(cases[i].in);
            bool ok = r2.level == KillLevel::SOFT;
            const char* a = r2.reason;
            const char* b = reasons[i];
            bool same = true;
            for (int k = 0;; ++k) {
                if (a[k] != b[k]) {
                    same = false;
                    break;
                }
                if (a[k] == '\0') break;
            }
            Check(ok && same, cases[i].name);
        }
    }
    // 3. each MEDIUM trigger alone -> MEDIUM
    {
        KillInputs d;
        d.drawdown_r5 = true;
        Check(EvaluateLevel(d).level == KillLevel::MEDIUM, "med-drawdown");
        KillInputs l;
        l.daily_loss_breach = true;
        Check(EvaluateLevel(l).level == KillLevel::MEDIUM, "med-daily");
        KillInputs v;
        v.rule_violation = true;
        Check(EvaluateLevel(v).level == KillLevel::MEDIUM, "med-rule");
        KillInputs c;
        c.calib_breach = true;
        Check(EvaluateLevel(c).level == KillLevel::MEDIUM, "med-calib");
        KillInputs t;
        t.spend_tier = 3;
        Check(EvaluateLevel(t).level == KillLevel::MEDIUM, "med-tier3");
    }
    // 4. each HARD trigger alone -> HARD
    {
        KillInputs j;
        j.journal_chain_break = true;
        Check(EvaluateLevel(j).level == KillLevel::HARD, "hard-journal");
        KillInputs d;
        d.drift_unresolvable = true;
        Check(EvaluateLevel(d).level == KillLevel::HARD, "hard-drift");
        KillInputs b;
        b.broker_auth_fail = true;
        Check(EvaluateLevel(b).level == KillLevel::HARD, "hard-auth");
        KillInputs e;
        e.determinism_fail = true;
        Check(EvaluateLevel(e).level == KillLevel::HARD, "hard-determ");
        KillInputs s;
        s.sandbox_compromise = true;
        Check(EvaluateLevel(s).level == KillLevel::HARD, "hard-sandbox");
    }
    // 5. spend tiers 0/1/negative/huge never kill by themselves
    for (int tier : {0, 1, -1, 99}) {
        KillInputs in;
        in.spend_tier = tier;
        char name[32];
        std::snprintf(name, sizeof(name), "tier-%d-no-kill", tier);
        Check(EvaluateLevel(in).level == KillLevel::NONE, name);
    }
    // 6. precedence: higher tier wins (frozen)
    {
        KillInputs sm;
        sm.halt_file = true;
        sm.drawdown_r5 = true;
        Check(EvaluateLevel(sm).level == KillLevel::MEDIUM, "prec-soft-med");
        KillInputs mh;
        mh.daily_loss_breach = true;
        mh.broker_auth_fail = true;
        Check(EvaluateLevel(mh).level == KillLevel::HARD, "prec-med-hard");
        KillInputs sh;
        sh.feed_stale_gt30s = true;
        sh.determinism_fail = true;
        Check(EvaluateLevel(sh).level == KillLevel::HARD, "prec-soft-hard");
        KillInputs all;
        all.halt_file = all.jev_streak_s5 = all.feed_stale_gt30s = true;
        all.spend_tier = 2;
        all.research_paused_past_ttl = all.drawdown_r5 = true;
        all.daily_loss_breach = all.rule_violation = all.calib_breach =
            true;
        all.journal_chain_break = all.drift_unresolvable = true;
        all.broker_auth_fail = all.determinism_fail = true;
        all.sandbox_compromise = true;
        Check(EvaluateLevel(all).level == KillLevel::HARD, "prec-all-hard");
    }
    // 7. entry gate: deliberate resume friction (doc 06 sec. 6.4)
    {
        using jev::kill::EntriesAllowed;
        Check(EntriesAllowed(KillLevel::NONE, false, true),
              "entry-clean");
        Check(!EntriesAllowed(KillLevel::NONE, false, false),
              "entry-flagless-denied");
        Check(!EntriesAllowed(KillLevel::NONE, true, true),
              "entry-halt-present-denied");
        Check(!EntriesAllowed(KillLevel::SOFT, false, true),
              "entry-soft-denied");
        Check(!EntriesAllowed(KillLevel::MEDIUM, false, true),
              "entry-medium-denied");
        Check(!EntriesAllowed(KillLevel::HARD, false, true),
              "entry-hard-denied");
    }
    // 8. flatten FSM transitions
    {
        using jev::kill::FlattenStep;
        using jev::kill::StepFlatten;
        FlattenStep go;
        go.conditions_allow = true;
        auto o = StepFlatten(FlattenState::MEDIUM_ACTIVE, go);
        Check(o.state == FlattenState::FLATTEN_PENDING && o.issue_flatten,
              "flat-order-issues-once");
        FlattenStep wait;
        o = StepFlatten(FlattenState::MEDIUM_ACTIVE, wait);
        Check(o.state == FlattenState::MEDIUM_ACTIVE && !o.issue_flatten,
              "flat-waits-conditions");
        FlattenStep ext;
        ext.closed_externally = true;
        o = StepFlatten(FlattenState::MEDIUM_ACTIVE, ext);
        Check(o.state == FlattenState::FLATTENED &&
                  o.closer == Closer::STOP_TP,
              "flat-true-closer-active");
        FlattenStep term;
        term.venue_closed_terminal = true;
        o = StepFlatten(FlattenState::MEDIUM_ACTIVE, term);
        Check(o.state == FlattenState::PROTECTION_ONLY &&
                  !o.issue_flatten,
              "flat-protection-only");
        FlattenStep ack;
        ack.broker_confirms_flat = true;
        o = StepFlatten(FlattenState::FLATTEN_PENDING, ack);
        Check(o.state == FlattenState::FLATTENED &&
                  o.closer == Closer::SWITCH_FLATTEN,
              "flat-acked");
        o = StepFlatten(FlattenState::FLATTEN_PENDING, ext);
        Check(o.state == FlattenState::FLATTENED &&
                  o.closer == Closer::STOP_TP,
              "flat-true-closer-pending");
        // Staying in PENDING never re-issues (no blind re-send loops).
        o = StepFlatten(FlattenState::FLATTEN_PENDING, wait);
        Check(o.state == FlattenState::FLATTEN_PENDING &&
                  !o.issue_flatten,
              "flat-pending-no-reissue");
        for (int i = 0; i < 20; ++i)
            o = StepFlatten(o.state, wait);
        Check(o.state == FlattenState::FLATTEN_PENDING &&
                  !o.issue_flatten,
              "flat-pending-stable");
        o = StepFlatten(FlattenState::FLATTENED, wait);
        Check(o.state == FlattenState::FLATTENED && !o.issue_flatten,
              "flat-terminal-flat");
        o = StepFlatten(FlattenState::PROTECTION_ONLY, go);
        Check(o.state == FlattenState::PROTECTION_ONLY &&
                  !o.issue_flatten,
              "flat-terminal-prot");
    }
    // 9. persistence round-trips every state combination
    {
        using jev::kill::ParseKill;
        using jev::kill::Persisted;
        using jev::kill::SerializeKill;
        for (int f = 0; f <= 3; ++f)
            for (int c = 0; c <= 2; ++c)
                for (int h = 0; h <= 6; ++h) {
                    Persisted p;
                    p.flatten = static_cast<FlattenState>(f);
                    p.closer = static_cast<Closer>(c);
                    p.hard = static_cast<HardPhase>(h);
                    char buf[16];
                    bool ok = SerializeKill(p, buf, sizeof(buf));
                    Persisted q;
                    bool pok = ok && ParseKill(buf, &q);
                    char name[40];
                    std::snprintf(name, sizeof(name), "persist-%d-%d-%d",
                                  f, c, h);
                    Check(pok && q.flatten == p.flatten &&
                              q.closer == p.closer && q.hard == p.hard,
                          name);
                }
        // guards: null/small/bad-enum serialize; malformed parses
        {
            Persisted p;
            char buf[16];
            Check(!SerializeKill(p, nullptr, sizeof(buf)), "ser-null");
            Check(!SerializeKill(p, buf, 7), "ser-small");
            Persisted bad = p;
            bad.hard = static_cast<HardPhase>(9);
            Check(!SerializeKill(bad, buf, sizeof(buf)), "ser-bad-enum");
            Persisted q;
            Check(!ParseKill(nullptr, &q), "parse-null");
            Check(!ParseKill("D1:0:0:0", nullptr), "parse-null-out");
            Check(!ParseKill("D1:0:0", &q), "parse-short");
            Check(!ParseKill("D1:0:0:00", &q), "parse-long");
            Check(!ParseKill("X1:0:0:0", &q), "parse-tag");
            Check(!ParseKill("D1:4:0:0", &q), "parse-range-f");
            Check(!ParseKill("D1:0:3:0", &q), "parse-range-c");
            Check(!ParseKill("D1:0:0:7", &q), "parse-range-h");
            Check(!ParseKill("", &q), "parse-empty");
        }
    }
    // 10. HARD full path, protection present: exact operation order
    {
        using jev::kill::HardStep;
        using jev::kill::StepHard;
        HardPhase p = HardPhase::IDLE;
        HardStep obs;
        obs.protection_present = true;
        obs.protection_confirmed = true;
        HardAction log[8];
        int n = 0;
        for (int i = 0; i < 8 && p != HardPhase::DONE; ++i) {
            auto o = StepHard(p, obs);
            log[n++] = o.action;
            p = o.phase;
        }
        auto fin = StepHard(p, obs);
        Check(n == 5 && log[0] == HardAction::QUERY_PROTECTION &&
                  log[1] == HardAction::SEND_FLATTEN_CANCEL &&
                  log[2] == HardAction::CONFIRM_ACTIVE &&
                  log[3] == HardAction::REVOKE_CREDENTIALS &&
                  log[4] == HardAction::EXIT_NONZERO &&
                  fin.action == HardAction::NONE,
              "hard-order-present");
    }
    // 11. HARD missing-protection path: ESTABLISH appears exactly once,
    // sequence still terminates at DONE
    {
        using jev::kill::HardStep;
        using jev::kill::StepHard;
        HardPhase p = HardPhase::IDLE;
        HardStep obs;
        obs.protection_present = false;
        obs.reestablished = true;
        obs.protection_confirmed = true;
        int establish = 0;
        HardAction last = HardAction::NONE;
        for (int i = 0; i < 8 && p != HardPhase::DONE; ++i) {
            auto o = StepHard(p, obs);
            if (o.action == HardAction::ESTABLISH_PROTECTION) ++establish;
            last = o.action;
            p = o.phase;
        }
        Check(p == HardPhase::DONE && establish == 1 &&
                  last == HardAction::EXIT_NONZERO,
              "hard-order-missing");
    }
    // 12. HARD unconfirmed: NEVER advances to revocation (the ordering
    // property). 50 cycles of unconfirmed stays put, re-querying.
    {
        using jev::kill::HardStep;
        using jev::kill::StepHard;
        HardPhase p = HardPhase::CONFIRM_PROTECTION;
        HardStep obs;
        obs.protection_present = true;
        obs.protection_confirmed = false;
        bool revoked = false;
        for (int i = 0; i < 50; ++i) {
            auto o = StepHard(p, obs);
            if (o.action == HardAction::REVOKE_CREDENTIALS) revoked = true;
            p = o.phase;
        }
        Check(p == HardPhase::CONFIRM_PROTECTION && !revoked,
              "hard-unconfirmed-never-revokes");
    }
    // 13. ordering invariant over every phase x boolean combination:
    // REVOKE fires only from CONFIRM+confirmed; EXIT only from
    // REVOKE_AND_EXIT. (7 phases x 16 combos = 112 checks.)
    {
        using jev::kill::HardStep;
        using jev::kill::StepHard;
        for (int ph = 0; ph <= 6; ++ph)
            for (int bits = 0; bits < 16; ++bits) {
                HardStep in;
                in.protection_present = (bits & 1) != 0;
                in.reestablished = (bits & 2) != 0;
                in.flatten_acked = (bits & 4) != 0;
                in.protection_confirmed = (bits & 8) != 0;
                auto o = StepHard(static_cast<HardPhase>(ph), in);
                bool revoke_ok =
                    (o.action != HardAction::REVOKE_CREDENTIALS) ||
                    (ph == static_cast<int>(
                              HardPhase::CONFIRM_PROTECTION) &&
                     in.protection_confirmed);
                bool exit_ok =
                    (o.action != HardAction::EXIT_NONZERO) ||
                    (ph == static_cast<int>(
                              HardPhase::REVOKE_AND_EXIT));
                char name[40];
                std::snprintf(name, sizeof(name), "hard-inv-%d-%d", ph,
                              bits);
                Check(revoke_ok && exit_ok, name);
            }
    }
    // 14. evaluation is non-blocking: 100k evaluations must complete
    // far inside the 5 s operator budget (proves no blocking/I-O on
    // the predicate path; the real <5s drill covers file+signal).
    {
        KillInputs in;
        in.halt_file = in.drawdown_r5 = in.broker_auth_fail = true;
        std::clock_t t0 = std::clock();
        int acc = 0;
        for (int i = 0; i < 100000; ++i)
            acc += static_cast<int>(EvaluateLevel(in).level);
        std::clock_t t1 = std::clock();
        double secs =
            static_cast<double>(t1 - t0) / CLOCKS_PER_SEC;
        Check(acc != 0 && secs < 5.0, "eval-nonblocking");
    }
    if (g_fail == 0) std::printf("KILL SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
