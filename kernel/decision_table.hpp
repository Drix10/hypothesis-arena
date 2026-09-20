// P3.3 — Deterministic decision table (doc 03 §3.2, EXACT row order).
//
// Consumes ONLY ValidatedJEVAnswerSetV3 (typed, validator-built) plus
// deterministic engine inputs. No JSON, no strings-as-numbers, no model
// outputs beyond the four bounded answers. First HOLD wins and is the
// logged reason. Same snapshot + same AnswerSet -> bit-identical output.
//
// Budget-dependent calibration_gate (§13.3 prereq, doc 03 §3.3):
//   ordinary 1xR rows: breach HOLDS, insufficient ALLOWED;
//   elevated 2xR max-gate: pass REQUIRED (insufficient fails the gate).
// conviction max NOMINATES the max-gate; the engine's independently
// validated conditions AUTHORIZE. Family probabilities never size.
//
// P3.4 default (b): confidence is never read here (no accessor exists).
// Sizing (budgets to notionals) is P3.5: this table emits BUDGET TIERS only.
#pragma once
#include <string>
#include "jev_validate.hpp"

namespace jev {

enum class CalibrationGate { PASS, INSUFFICIENT, BREACH };

// Deterministic engine inputs (C++-computed, never model outputs — except
// enter/latent_risk as bounded table inputs per doc 03 §3.3).
struct EngineInputs {
    bool deterministic_veto = false;  // row 0: R-breach/session/corp/pending
    std::string veto_reason = "engine";
    bool disagreement = false;        // R14 opposite TRIGGER effects
    bool event_blackout = false;      // C++ impact+phase blackout
    CalibrationGate calibration_gate = CalibrationGate::INSUFFICIENT;
    // §3.3 step-1 max-gate engine conditions (independently validated):
    bool r6_vol_trip = false;
    bool exposure_headroom_r2 = true;
    bool pending_risk_breach = false;
};

struct Decision {
    enum class Budget { HOLD, BASE_1R, ELEVATED_2R };
    Budget budget = Budget::HOLD;
    std::string action;  // "HOLD" | "BASE" | "ELEVATED"
    std::string reason;  // frozen reason code (logged)
};

// Row order is doc 03 §3.2, verbatim. Boundary pins (also §3.7 17-20):
//   enter: <0.5 HOLD | 0.5-0.8 mid-band (0.5 AND 0.8 belong here) | >0.8 free
//   latent_risk: HOLD iff STRICTLY > 0.5 (0.5 passes)
//   max-gate: enter >= 0.8 AND latent <= 0.3 AND calib == pass AND
//             family != execution AND conviction == max AND engine conditions.
inline Decision EvaluateDecision(const ValidatedJEVAnswerSetV3& a,
                                 const EngineInputs& in) {
    const double E = a.enter();
    const double L = a.latent_risk();
    const EdgeFamily F = a.family();
    const Conviction C = a.conviction();
    auto hold = [](const char* r) {
        Decision d;
        d.action = "HOLD";
        d.reason = r;
        return d;
    };
    // Row 0: deterministic veto is authoritative, never a model opinion.
    if (in.deterministic_veto) return hold("engine-veto");
    // Additive hidden-risk veto (strictly greater: 0.5 passes).
    if (L > 0.5) return hold("latent-risk");
    if (in.disagreement) return hold("disagreement");
    if (in.event_blackout) return hold("event-blackout");
    // Calibration breach HOLDS every budget tier (R13 deterministic).
    if (in.calibration_gate == CalibrationGate::BREACH)
        return hold("calibration-breach");
    if (E < 0.5) return hold("no-edge");
    const bool midband = (E >= 0.5 && E <= 0.8);
    const bool below_strong =
        (C == Conviction::FLAT || C == Conviction::LEAN);
    if (midband && (F == EdgeFamily::EXECUTION || below_strong))
        return hold("mid-band");
    if (F == EdgeFamily::EXECUTION) return hold("execution-family");
    if (C == Conviction::FLAT) return hold("conviction-flat");
    if (C == Conviction::LEAN || C == Conviction::STRONG) {
        Decision d;
        d.budget = Decision::Budget::BASE_1R;
        d.action = "BASE";
        d.reason = "base-1R";
        return d;
    }
    // C == MAX: nominates the max-gate; the engine authorizes or downgrades.
    const bool gate = (E >= 0.8 && L <= 0.3 &&
                       in.calibration_gate == CalibrationGate::PASS &&
                       F != EdgeFamily::EXECUTION && !in.r6_vol_trip &&
                       in.exposure_headroom_r2 && !in.pending_risk_breach);
    if (gate) {
        Decision d;
        d.budget = Decision::Budget::ELEVATED_2R;
        d.action = "ELEVATED";
        d.reason = "elevated-2R";
        return d;
    }
    Decision d;  // downgrade to strong: base budget, logged as such.
    d.budget = Decision::Budget::BASE_1R;
    d.action = "BASE";
    d.reason = "downgrade-strong";
    return d;
}

}  // namespace jev
