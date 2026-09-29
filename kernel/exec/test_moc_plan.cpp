// Drills for the MOC / protective-stop sequencing (doc 06 6.0).
#include <cstdio>
#include <string_view>

#include "moc_plan.hpp"

using namespace jev::exec;

static int fails = 0, count = 0;
#define CHECK(name, expr)                   \
    do {                                    \
        ++count;                            \
        if (!(expr)) {                      \
            std::printf("FAIL %s\n", name); \
            ++fails;                        \
        }                                   \
    } while (0)

static MocAction P(StopState s, MocState m, long long now = 100,
                   long long cutoff = 200) {
    MocInput in;
    in.stop = s;
    in.moc = m;
    in.now_s = now;
    in.moc_cutoff_s = cutoff;
    return PlanMoc(in);
}

int main() {
    CHECK("submit-before-cutoff",
          P(StopState::LIVE, MocState::NOT_SENT) == MocAction::SUBMIT_MOC);
    CHECK("submit-unprotected-entry-too",
          P(StopState::NONE, MocState::NOT_SENT) == MocAction::SUBMIT_MOC);
    CHECK("cutoff-missed-stays-protected",
          P(StopState::LIVE, MocState::NOT_SENT, 200, 200) ==
              MocAction::KEEP_PROTECTED);
    CHECK("stop-released-only-after-moc-ack",
          P(StopState::LIVE, MocState::ACCEPTED) == MocAction::CANCEL_STOP);
    CHECK("stop-not-released-before-ack",
          P(StopState::LIVE, MocState::NOT_SENT) != MocAction::CANCEL_STOP);
    CHECK("after-stop-cancel-wait-for-auction",
          P(StopState::CANCELLED, MocState::ACCEPTED) == MocAction::WAIT);
    CHECK("moc-fill-clears-stale-stop",
          P(StopState::LIVE, MocState::FILLED) == MocAction::CANCEL_STOP);
    CHECK("moc-fill-done",
          P(StopState::CANCELLED, MocState::FILLED) == MocAction::DONE);
    // Drill: the stop fills before the MOC. The MOC is cancelled, never left
    // to over-sell.
    CHECK("stop-fills-first-cancels-live-moc",
          P(StopState::FILLED, MocState::ACCEPTED) == MocAction::CANCEL_MOC);
    CHECK("stop-fills-before-moc-sent-done",
          P(StopState::FILLED, MocState::NOT_SENT) == MocAction::DONE);
    // Drill: the MOC is rejected. The stop stays and the exit retries.
    CHECK("moc-reject-keeps-protection",
          P(StopState::LIVE, MocState::REJECTED) == MocAction::KEEP_PROTECTED);
    CHECK("unknown-stop-reconciles",
          P(StopState::UNKNOWN, MocState::ACCEPTED) == MocAction::RECONCILE);
    CHECK("unknown-moc-reconciles",
          P(StopState::LIVE, MocState::UNKNOWN) == MocAction::RECONCILE);
    CHECK("names", std::string_view(MocActionName(MocAction::CANCEL_MOC)) ==
                       "cancel-moc");
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
