#include "moc_plan.hpp"

namespace jev {
namespace exec {

MocAction PlanMoc(const MocInput& in) {
    if (in.stop == StopState::UNKNOWN || in.moc == MocState::UNKNOWN)
        return MocAction::RECONCILE;
    if (in.stop == StopState::FILLED) {
        // The position is gone; an MOC still alive would sell what is no
        // longer held.
        return in.moc == MocState::ACCEPTED ? MocAction::CANCEL_MOC
                                            : MocAction::DONE;
    }
    switch (in.moc) {
        case MocState::FILLED:
            return in.stop == StopState::LIVE ? MocAction::CANCEL_STOP
                                              : MocAction::DONE;
        case MocState::ACCEPTED:
            return in.stop == StopState::LIVE ? MocAction::CANCEL_STOP
                                              : MocAction::WAIT;
        case MocState::REJECTED:
            return MocAction::KEEP_PROTECTED;
        case MocState::NOT_SENT:
            return in.now_s < in.moc_cutoff_s ? MocAction::SUBMIT_MOC
                                              : MocAction::KEEP_PROTECTED;
        default:
            return MocAction::RECONCILE;
    }
}

const char* MocActionName(MocAction a) {
    switch (a) {
        case MocAction::WAIT: return "wait";
        case MocAction::SUBMIT_MOC: return "submit-moc";
        case MocAction::CANCEL_STOP: return "cancel-stop";
        case MocAction::CANCEL_MOC: return "cancel-moc";
        case MocAction::KEEP_PROTECTED: return "keep-protected";
        case MocAction::DONE: return "done";
        case MocAction::RECONCILE: return "reconcile";
    }
    return "reconcile";
}

}  // namespace exec
}  // namespace jev
