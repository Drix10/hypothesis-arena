// Deterministic engine inputs for the JEV filter table (doc 03 3.3).
//
// C++-computed by the veto (BuildEngineInputs); the filter (jev_filter.hpp)
// is the only consumer. Veto reasons are a frozen enum, never free text:
// paper-trade analysis needs countable HOLD causes (R5 loss cap, R6 vol,
// session, short/corp-action blocks, pending risk).
#pragma once

namespace jev {

enum class CalibrationGate { PASS, INSUFFICIENT, BREACH };

enum class VetoReason {
    NONE,
    LOSS_CAP_R5,
    VOL_TRIP_R6,
    SESSION_CLOSED,
    SHORT_BLOCK,
    CORP_ACTION_BLOCK,
    PENDING_RISK,
    OTHER_BREACH
};
inline const char* VetoCode(VetoReason v) {
    switch (v) {
        case VetoReason::LOSS_CAP_R5:
            return "r5-loss-cap";
        case VetoReason::VOL_TRIP_R6:
            return "r6-vol-trip";
        case VetoReason::SESSION_CLOSED:
            return "session-closed";
        case VetoReason::SHORT_BLOCK:
            return "short-block";
        case VetoReason::CORP_ACTION_BLOCK:
            return "corp-action-block";
        case VetoReason::PENDING_RISK:
            return "pending-risk";
        case VetoReason::OTHER_BREACH:
            return "other-breach";
        default:
            return "engine";
    }
}
struct EngineInputs {
    bool deterministic_veto = false;  // row 0: R-breach/session/corp/pending
    VetoReason veto_reason = VetoReason::NONE;
    bool disagreement = false;        // R14 opposite TRIGGER effects
    bool event_blackout = false;      // C++ impact+phase blackout
    CalibrationGate calibration_gate = CalibrationGate::INSUFFICIENT;
    // 3.3 step-1 max-gate engine conditions (independently validated):
    bool r6_vol_trip = false;
    bool exposure_headroom_r2 = true;
    bool pending_risk_breach = false;
};

}  // namespace jev
