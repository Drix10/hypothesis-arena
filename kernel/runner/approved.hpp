// Loaders for the two operator-owned inputs of the paper loop: the approved
// strategies + instrument allowlist (stage manifest), and the exchange calendar.
// Both fail closed: unreadable or malformed input is a refusal to run.
#pragma once
#include <cstdint>
#include <set>
#include <string>

#include "../ingest/candidates.hpp"

namespace kernel {
namespace runner {

// {"strategies":[{"id":"etf_trend","window_s":3600}],"allowlist":["VTI"]}
bool ParseApproved(const std::string& json, ingest::CandidateTables* out);

// collector/session_calendar.json: every "holidays_YYYY" array of ISO dates.
// Needs at least one holiday list and a valid date for every entry.
bool ParseCalendar(const std::string& json, std::set<int64_t>* holidays);

// Optional "early_close_YYYY" arrays (13:00 ET closes). Absent = empty set;
// a malformed entry fails the parse.
bool ParseEarlyCloses(const std::string& json, std::set<int64_t>* early);

bool ReadFile(const std::string& path, std::string* out);

}  // namespace runner
}  // namespace kernel
