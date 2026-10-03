// Market-on-close exit sequencing against a live protective stop.
// Pure: the caller supplies the observed order states and acts on the result.
// The stop is cancelled only after the MOC is acknowledged; a stop that fills
// first turns the MOC into an over-sell, so a live MOC is cancelled then; a
// rejected or missed MOC leaves the position protected for the next session.
#pragma once
#include <cstdint>

namespace kernel {
namespace exec {

enum class StopState : std::uint8_t { NONE, LIVE, FILLED, CANCELLED, UNKNOWN };
enum class MocState : std::uint8_t {
    NOT_SENT, ACCEPTED, REJECTED, FILLED, UNKNOWN
};

enum class MocAction : std::uint8_t {
    WAIT,           // nothing to do this cycle
    SUBMIT_MOC,     // send the MOC (before the cutoff)
    CANCEL_STOP,    // MOC acknowledged: release the stop
    CANCEL_MOC,     // stop filled first: a live MOC would over-sell
    KEEP_PROTECTED, // MOC rejected or missed: stop stays, retry next session
    DONE,           // position closed by the MOC or the stop
    RECONCILE       // unknown state: query, place nothing
};

struct MocInput {
    StopState stop = StopState::NONE;
    MocState moc = MocState::NOT_SENT;
    std::int64_t now_s = 0;
    std::int64_t moc_cutoff_s = 0;  // venue cutoff for today's MOC
};

MocAction PlanMoc(const MocInput& in);
const char* MocActionName(MocAction a);

}  // namespace exec
}  // namespace kernel
