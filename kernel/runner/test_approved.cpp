#include <cstdio>
#include <string>

#include "approved.hpp"
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

using namespace jev::runner;

int main(int argc, char** argv) {
    jev::ingest::CandidateTables t;
    CHECK("approved-ok", ParseApproved(
        "{\"sleeves\":[{\"id\":\"trend_etf_v1\",\"window_s\":3600}],"
        "\"allowlist\":[\"VTI\",\"BRK.B\"]}", &t) &&
                             t.sleeves.size() == 1 && t.allowlist.size() == 2 &&
                             t.sleeves[0].window_s == 3600);
    for (const char* bad : {
             "", "[]", "{}",
             "{\"sleeves\":[],\"allowlist\":[\"VTI\"]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":3600}],\"allowlist\":[]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":0}],\"allowlist\":[\"VTI\"]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":1e9}],\"allowlist\":[\"VTI\"]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":3600.5}],\"allowlist\":[\"VTI\"]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":3600}],\"allowlist\":[\"vti\"]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":3600}],\"allowlist\":[\"V T\"]}",
             "{\"sleeves\":[{\"id\":\"a\",\"window_s\":3600}],\"allowlist\":[1]}"})
        CHECK("approved-bad", !ParseApproved(bad, &t));

    std::set<int64_t> h;
    CHECK("calendar-ok", ParseCalendar(
        "{\"holidays_2026\":[\"2026-01-01\",\"2026-12-25\"],"
        "\"x\":1}", &h) && h.size() == 2 &&
                             h.count(DaysFromCivil(2026, 12, 25)) == 1);
    for (const char* bad : {"", "{}", "{\"holidays_2026\":[]}",
                            "{\"holidays_2026\":[\"2026-13-01\"]}",
                            "{\"holidays_2026\":[\"2026-02-31\"]}",
                            "{\"holidays_2026\":[\"2026-04-31\"]}",
                            "{\"holidays_2026\":[\"nope\"]}",
                            "{\"holidays_2026\":\"2026-01-01\"}",
                            "{\"holidays_2026\":[5]}"})
        CHECK("calendar-bad", !ParseCalendar(bad, &h));
    if (argc == 2) {
        std::string real;
        CHECK("real-calendar-reads", ReadFile(std::string(argv[1]) + "/collector/session_calendar.json", &real));
        CHECK("real-calendar-parses", ParseCalendar(real, &h) && h.size() == 10);
    }
    std::string none;
    CHECK("missing-file-fails", !ReadFile("/nonexistent/file", &none));
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
