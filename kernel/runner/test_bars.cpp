#include <cmath>
#include <cstdio>
#include <string>

#include "bars.hpp"
#include "calendar.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

using namespace kernel::runner;

int main(int argc, char** argv) {
    int64_t t = 0;
    CHECK("iso-parse", ParseIsoZ("2026-09-24T13:00:00Z", &t) &&
                           t == DaysFromCivil(2026, 9, 24) * 86400 + 13 * 3600);
    CHECK("iso-roundtrip", FormatIsoZ(t) == "2026-09-24T13:00:00Z");
    for (const char* bad : {"2026-09-24 13:00:00Z", "2026-13-24T13:00:00Z",
                            "2026-09-24T13:00:00", "2026-09-24T25:00:00Z", ""})
        CHECK("iso-bad", !ParseIsoZ(bad, &t));

    // A real-shaped reply: extended-hours bars (08:00Z) must be dropped.
    std::string body =
        "{\"bars\":{\"VTI\":[{\"t\":\"2026-09-24T08:00:00Z\",\"c\":300.1},"
        "{\"t\":\"2026-09-24T13:00:00Z\",\"c\":301.2},"
        "{\"t\":\"2026-09-24T14:00:00Z\",\"c\":302.3},"
        "{\"t\":\"2026-09-24T20:00:00Z\",\"c\":303.4},"
        "{\"t\":\"2026-09-27T14:00:00Z\",\"c\":304.5}]},"
        "\"next_page_token\":null}";
    BarMap m;
    bool more = true;
    CHECK("parse", ParseBars(body, &m, &more) && !more && m["VTI"].size() == 5);
    std::set<int64_t> none;
    KeepRegularSession(&m["VTI"], none);
    // 13:00Z = 09:00 ET and 14:00Z = 10:00 ET stay; 20:00Z = 16:00 ET,
    // 08:00Z = 04:00 ET and the Sunday bar go.
    CHECK("regular-only", m["VTI"].size() == 2 &&
                              m["VTI"][0].close == 301.2);

    bool m2 = false;
    CHECK("paged-flag", ParseBars("{\"bars\":{},\"next_page_token\":\"abc\"}", &m, &m2) && m2);
    CHECK("bad-close", !ParseBars("{\"bars\":{\"X\":[{\"t\":\"2026-09-24T13:00:00Z\",\"c\":0}]}}", &m, &m2));
    CHECK("bad-time", !ParseBars("{\"bars\":{\"X\":[{\"t\":\"nope\",\"c\":1}]}}", &m, &m2));
    CHECK("no-bars-key", !ParseBars("{}", &m, &m2));

    CHECK("urlencode", UrlEncode("SUV+fE/18==") == "SUV%2BfE%2F18%3D%3D" &&
                           UrlEncode("aZ09-._~") == "aZ09-._~");
    int64_t now = DaysFromCivil(2026, 9, 25) * 86400 + 21 * 3600;  // Fri 17:00 ET
    auto st = ExpectedStarts(now, 8, none);
    CHECK("expected-8", st.size() == 8);
    CHECK("expected-last-is-15-et", st.back() ==
                                       DaysFromCivil(2026, 9, 25) * 86400 + 19 * 3600);
    CHECK("expected-spans-days", st.front() <
                                     DaysFromCivil(2026, 9, 25) * 86400);
    std::vector<Bar> bars = {{st[2], 10.0}, {st[3], 11.0}, {st[7], 12.0}};
    double out[8];
    AlignCloses(bars, st, out);
    CHECK("align-present", out[2] == 10.0 && out[3] == 11.0 && out[7] == 12.0);
    CHECK("align-missing-nan", std::isnan(out[0]) && std::isnan(out[4]));
    // Malformed or hostile replies are rejected, never partially read.
    for (const char* bad : {
             "", "{", "{\"bars\":{\"X\":[{\"t\":\"2026-09-24T13:00:00Z\",\"c\":1}",
             "{\"bars\":{\"X\":[{\"c\":1}]}}",
             "{\"bars\":{\"X\":[{\"t\":\"2026-09-24T13:00:00Z\"}]}}",
             "{\"bars\":{\"X\":[{\"t\":\"2026-09-24T13:00:00Z\",\"c\":\"1\"}]}}",
             "{\"bars\":{\"X\":[{\"t\":\"2026-09-24T13:00:00Z\",\"c\":1}]}} x",
             "{\"bars\":{\"X\":[{\"t\":\"2026-09-24T13:00:00Z\",\"c\":-4}]}}",
             "{\"bars\":{\"X\":[[[[[[[[[[1]]]]]]]]]]}}",
             "{\"next_page_token\":null}"})
        CHECK("scanner-rejects", !ParseBars(bad, &m, &more));
    CHECK("scanner-skips-extra-fields", ParseBars(
        "{\"bars\":{\"X\":[{\"c\":1.5,\"h\":2,\"l\":1,\"n\":5,\"o\":1,"
        "\"t\":\"2026-09-24T13:00:00Z\",\"v\":100,\"vw\":1.4,\"x\":[1,{\"a\":null}]}]},"
        "\"next_page_token\":null}", &m, &more) && m["X"].size() == 1 &&
                                       m["X"][0].close == 1.5);
    if (argc == 2) {
        std::string real;
        {
            FILE* f = std::fopen((std::string(argv[1]) + "/alpaca_bars_hourly_sip.json").c_str(), "rb");
            char buf[4096];
            size_t n;
            while (f && (n = std::fread(buf, 1, sizeof buf, f)) > 0) real.append(buf, n);
            if (f) std::fclose(f);
        }
        BarMap rm;
        bool rmore = true;
        CHECK("real-reply-parses", ParseBars(real, &rm, &rmore) && !rmore &&
                                       rm.count("VTI") && rm.count("IEF"));
        size_t before = rm["VTI"].size();
        KeepRegularSession(&rm["VTI"], none);
        CHECK("real-sip-has-extended-hours", rm["VTI"].size() < before);
        bool grid = !rm["VTI"].empty();
        for (const Bar& b : rm["VTI"]) {
            int64_t local = b.start_s + EtOffsetSeconds(b.start_s);
            int hr = (int)(local % 86400) / 3600;
            grid = grid && hr >= 9 && hr <= 15;
        }
        CHECK("real-regular-hours-only", grid);
    }
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
