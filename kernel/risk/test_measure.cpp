#include <cmath>
#include <cstdio>
#include <vector>

#include "measure.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

using namespace kernel::risk;

// Deterministic pseudo-noise in [-1, 1].
static double Noise(int i) {
    return std::sin(i * 12.9898) * 0.5 + std::sin(i * 78.233) * 0.5;
}

static std::vector<double> Series(int n, double vol, int spike_from = -1,
                                  double spike_vol = 0.0) {
    std::vector<double> c(n);
    double p = 100.0;
    for (int i = 0; i < n; ++i) {
        double v = (spike_from >= 0 && i >= spike_from) ? spike_vol : vol;
        p *= std::exp(v * Noise(i));
        c[i] = p;
    }
    return c;
}

int main() {
    auto calm = Series(520, 0.002);
    VolResult v = MeasureVol(calm.data(), (int)calm.size(), 0);
    CHECK("calm-available-no-trip", v.available && !v.trip);

    auto spike = Series(520, 0.002, 520 - 24, 0.02);
    v = MeasureVol(spike.data(), (int)spike.size(), 0);
    CHECK("spike-trips", v.available && v.trip && v.current > 3 * v.baseline);

    auto shortv = Series(300, 0.002);
    CHECK("too-short-unavailable",
          !MeasureVol(shortv.data(), (int)shortv.size(), 0).available);
    CHECK("stale-3-unavailable", !MeasureVol(calm.data(), 520, 3).available);
    CHECK("stale-2-ok", MeasureVol(calm.data(), 520, 2).available);
    std::vector<double> flat(520, 50.0);
    CHECK("zero-variance-unavailable", !MeasureVol(flat.data(), 520, 0).available);
    auto bad = calm;
    bad[500] = -1.0;
    CHECK("nonpositive-close-unavailable",
          !MeasureVol(bad.data(), 520, 0).available);
    auto nan = calm;
    nan[400] = NAN;
    CHECK("nan-close-unavailable", !MeasureVol(nan.data(), 520, 0).available);
    CHECK("null-unavailable", !MeasureVol(nullptr, 0, 0).available);
    CHECK("negative-stale-unavailable", !MeasureVol(calm.data(), 520, -1).available);

    double a[30], b[30], c[30];
    for (int i = 0; i < 30; ++i) {
        a[i] = 100 + i + Noise(i);
        b[i] = 200 + 2 * (i + Noise(i));      // perfectly correlated with a
        c[i] = 100 + 5 * Noise(i * 7 + 3);    // unrelated
    }
    CorrResult r = MeasureCorr(a, b, 30, 0);
    CHECK("correlated-breach", r.available && r.breach && r.rho > 0.99);
    r = MeasureCorr(a, c, 30, 0);
    CHECK("uncorrelated-ok", r.available && !r.breach);
    double m[30];
    for (int i = 0; i < 30; ++i) m[i] = i < 6 ? NAN : b[i];
    CHECK("24-present-unavailable", !MeasureCorr(a, m, 30, 0).available);
    for (int i = 0; i < 30; ++i) m[i] = i < 5 ? NAN : b[i];
    CHECK("25-present-ok", MeasureCorr(a, m, 30, 0).available);
    double flat30[30];
    for (int i = 0; i < 30; ++i) flat30[i] = 10.0;
    CHECK("zero-variance-corr-unavailable",
          !MeasureCorr(a, flat30, 30, 0).available);
    CHECK("stale-corr-unavailable", !MeasureCorr(a, b, 30, 3).available);
    CHECK("wrong-window-unavailable", !MeasureCorr(a, b, 29, 0).available);
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
