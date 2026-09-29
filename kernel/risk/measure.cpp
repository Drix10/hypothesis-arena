#include "measure.hpp"

#include <cmath>

namespace jev {
namespace risk {
namespace {

bool Positive(double x) { return std::isfinite(x) && x > 0.0; }

double SampleStdev(const double* r, int n) {
    double m = 0.0;
    for (int i = 0; i < n; ++i) m += r[i];
    m /= n;
    double ss = 0.0;
    for (int i = 0; i < n; ++i) ss += (r[i] - m) * (r[i] - m);
    return std::sqrt(ss / (n - 1));
}

}  // namespace

VolResult MeasureVol(const double* closes, int n, int stale_bars) {
    VolResult out;
    if (!closes || stale_bars < 0 || stale_bars > kMaxStaleBars ||
        n < kVolBaselineReturns + 1)
        return out;
    static thread_local double r[kVolBaselineReturns];
    const double* c = closes + (n - (kVolBaselineReturns + 1));
    for (int i = 0; i < kVolBaselineReturns; ++i) {
        if (!Positive(c[i]) || !Positive(c[i + 1])) return out;
        r[i] = std::log(c[i + 1] / c[i]);
    }
    out.baseline = SampleStdev(r, kVolBaselineReturns);
    out.current = SampleStdev(r + (kVolBaselineReturns - kVolCurrentReturns),
                              kVolCurrentReturns);
    if (!(out.baseline > 0.0) || !std::isfinite(out.baseline)) return out;
    out.available = true;
    out.trip = out.current > kVolTripRatio * out.baseline;
    return out;
}

CorrResult MeasureCorr(const double* a, const double* b, int n,
                       int stale_bars) {
    CorrResult out;
    if (!a || !b || n != kCorrWindow || stale_bars < 0 ||
        stale_bars > kMaxStaleBars)
        return out;
    double xs[kCorrWindow], ys[kCorrWindow];
    int m = 0;
    for (int i = 0; i < n; ++i) {
        if (std::isfinite(a[i]) && std::isfinite(b[i])) {
            xs[m] = a[i];
            ys[m] = b[i];
            ++m;
        }
    }
    if (m < kCorrMinPresent) return out;
    double mx = 0.0, my = 0.0;
    for (int i = 0; i < m; ++i) {
        mx += xs[i];
        my += ys[i];
    }
    mx /= m;
    my /= m;
    double sxx = 0.0, syy = 0.0, sxy = 0.0;
    for (int i = 0; i < m; ++i) {
        sxx += (xs[i] - mx) * (xs[i] - mx);
        syy += (ys[i] - my) * (ys[i] - my);
        sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (!(sxx > 0.0) || !(syy > 0.0)) return out;  // zero variance
    out.rho = sxy / std::sqrt(sxx * syy);
    out.available = std::isfinite(out.rho);
    out.breach = out.available && out.rho > kCorrBreach;
    return out;
}

}  // namespace risk
}  // namespace jev
