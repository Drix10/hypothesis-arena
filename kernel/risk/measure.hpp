// R6 / R7 measurement from hourly closes. Availability is a
// first-class outcome: stale, thin or degenerate inputs make the rule
// UNAVAILABLE, and the veto holds entries on unavailable.
#pragma once

namespace kernel {
namespace risk {

constexpr int kVolBaselineReturns = 480;
constexpr int kVolCurrentReturns = 24;
constexpr double kVolTripRatio = 3.0;
constexpr int kMaxStaleBars = 2;   // latest bar within 2 expected hourly bars
constexpr int kCorrWindow = 30;
constexpr int kCorrMinPresent = 25;
constexpr double kCorrBreach = 0.9;

struct VolResult {
    bool available = false;
    bool trip = false;
    double baseline = 0.0;
    double current = 0.0;
};

// closes: present hourly closes, oldest first (missing hours are simply
// absent, never zero-filled). stale_bars: expected hourly bars that have
// elapsed since the latest close, per the venue calendar.
VolResult MeasureVol(const double* closes, int n, int stale_bars);

struct CorrResult {
    bool available = false;
    bool breach = false;
    double rho = 0.0;
};

// a, b: the last kCorrWindow expected hours, oldest first, NaN where the
// bar is missing. Needs kCorrMinPresent pairs present in both series.
CorrResult MeasureCorr(const double* a, const double* b, int n,
                       int stale_bars);

}  // namespace risk
}  // namespace kernel
