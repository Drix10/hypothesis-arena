// Hourly bars from the Alpaca data API, filtered to the regular session and
// aligned to the expected-bar grid used by the R6/R7 gates.
#pragma once
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace jev {
namespace runner {

struct Bar {
    int64_t start_s = 0;  // UTC seconds of the bar's start
    double close = 0.0;
};
typedef std::map<std::string, std::vector<Bar>> BarMap;

// Parses {"bars":{"SYM":[{"t":..., "c":...}]}, "next_page_token":...}.
// *more is set when the reply is paged; *token then holds the page token.
bool ParseBars(const std::string& body, BarMap* out, bool* more,
               std::string* token = nullptr);
bool ParseIsoZ(const std::string& s, int64_t* utc_s);
std::string FormatIsoZ(int64_t utc_s);

// Percent-encodes everything outside the RFC 3986 unreserved set.
std::string UrlEncode(const std::string& s);

// Keeps bars starting 09:00..15:00 ET on session days (drops extended hours).
void KeepRegularSession(std::vector<Bar>* bars,
                        const std::set<int64_t>& holidays);

// Starts of the last n completed regular-session bars at `now_s`, oldest first.
std::vector<int64_t> ExpectedStarts(int64_t now_s, int n,
                                    const std::set<int64_t>& holidays);

// closes on the expected grid; NaN where a bar is missing.
void AlignCloses(const std::vector<Bar>& bars,
                 const std::vector<int64_t>& starts, double* out);

}  // namespace runner
}  // namespace jev
