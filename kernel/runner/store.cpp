// H1 integration — durability seam implementation. See store.hpp.
#include "store.hpp"

#include <cstdio>
#include <cstring>
#include <cerrno>

#ifdef _WIN32
#include <direct.h>
#include <io.h>
#define DUR_COMMIT(f) _commit(_fileno(f))
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#define DUR_COMMIT(f) fsync(fileno(f))
#endif

#include "../jev_validate.hpp"  // Sha256Hex

namespace jev {
namespace runner {

namespace {
bool CommitFile(FILE* f) {
    if (std::fflush(f) != 0) return false;
    return DUR_COMMIT(f) == 0;
}
std::string Trim(const std::string& s) {
    std::size_t a = 0;
    while (a < s.size() && (s[a] == ' ' || s[a] == '\t')) ++a;
    std::size_t b = s.size();
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' ||
                     s[b - 1] == '\r' || s[b - 1] == '\n'))
        --b;
    return s.substr(a, b - a);
}
}  // namespace

// Parse "seq|ts|kind|intent|payload|prev|row" into a Row (strict:
// exactly 7 fields, then VerifyRow).
bool ParseRowLine(const std::string& ln, journal::Row* out) {
    std::vector<std::string> f;
    std::string cur;
    for (char c : ln) {
        if (c == '|') {
            f.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    f.push_back(cur);
    if (f.size() != 7) return false;
    journal::Row r;
    long long seq = -1;
    long long ts = 0;
    if (f[0].empty() || f[1].empty()) return false;
    for (char c : f[0]) {
        if (c < '0' || c > '9') return false;
    }
    bool neg = false;
    std::string tsb = f[1];
    if (!tsb.empty() && tsb[0] == '-') {
        neg = true;
        tsb = tsb.substr(1);
    }
    for (char c : tsb) {
        if (c < '0' || c > '9') return false;
    }
    try {
        seq = std::stoll(f[0]);
        ts = std::stoll(f[1]);
    } catch (...) {
        return false;
    }
    if (neg) ts = -ts;
    if (!journal::FormatRow((std::uint64_t)seq, (std::int64_t)ts,
                            f[2].c_str(), f[3].c_str(), f[4].c_str(),
                            f[5].c_str(), &r))
        return false;
    if (r.row_hash != f[6]) return false;
    *out = r;
    return true;
}

// Serialize one journal row to its canonical line (JournalAppend
// formats inline; the drain path needs the same bytes to compare
// buffer lines against the live tail).
bool RowLine(const journal::Row& r, char* out, std::size_t n) {
    int w = std::snprintf(out, n, "%llu|%lld|%s|%s|%s|%s|%s",
                          (unsigned long long)r.seq,
                          (long long)r.ts_ns, r.kind.c_str(),
                          r.intent_id.c_str(), r.payload_hash.c_str(),
                          r.prev_hash.c_str(), r.row_hash.c_str());
    return w > 0 && static_cast<std::size_t>(w) < n;
}

bool AppendLine(const char* path, const char* line) {
    if (!path || !line) return false;
    FILE* f = std::fopen(path, "ab");
    if (!f) return false;
    std::size_t n = std::strlen(line);
    bool ok = (std::fwrite(line, 1, n, f) == n) &&
              (std::fwrite("\n", 1, 1, f) == 1) && CommitFile(f);
    std::fclose(f);
    return ok;
}

bool AtomicWrite(const char* path, const char* data) {
    if (!path || !data) return false;
    std::string tmp = std::string(path) + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    std::size_t n = std::strlen(data);
    bool ok = (n == 0 || std::fwrite(data, 1, n, f) == n) &&
              CommitFile(f);
    std::fclose(f);
    if (!ok) {
        std::remove(tmp.c_str());
        return false;
    }
#ifdef _WIN32
    std::remove(path);  // rename fails on existing dest (documented)
#endif
    if (std::rename(tmp.c_str(), path) != 0) {
        std::remove(tmp.c_str());
        return false;
    }
    return true;
}

bool ReadLines(const char* path, std::vector<std::string>* out) {
    if (!path || !out) return false;
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    out->clear();
    char buf[4096];
    std::string cur;
    std::size_t n = 0;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) {
        for (std::size_t i = 0; i < n; ++i) {
            if (buf[i] == '\n') {
                if (!cur.empty() && cur.back() == '\r') cur.pop_back();
                out->push_back(cur);
                cur.clear();
            } else {
                if (cur.size() >= 4096) {
                    std::fclose(f);
                    return false;
                }
                cur.push_back(buf[i]);
            }
        }
    }
    if (!cur.empty()) out->push_back(cur);
    std::fclose(f);
    return true;
}

bool FileExists(const char* path) {
    if (!path) return false;
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    std::fclose(f);
    return true;
}

bool JournalAppend(const char* path, const journal::Row& r) {
    if (!journal::VerifyRow(r)) return false;
    char ln[1024];
    int w = std::snprintf(ln, sizeof(ln), "%llu|%lld|%s|%s|%s|%s|%s",
                          (unsigned long long)r.seq, (long long)r.ts_ns,
                          r.kind.c_str(), r.intent_id.c_str(),
                          r.payload_hash.c_str(), r.prev_hash.c_str(),
                          r.row_hash.c_str());
    if (w <= 0 || w >= static_cast<int>(sizeof(ln))) return false;
    return AppendLine(path, ln);
}

bool JournalLoad(const char* path, std::vector<journal::Row>* out) {
    std::vector<std::string> lns;
    if (!out) return false;
    out->clear();
    if (!FileExists(path)) return true;  // no file = clean genesis
    if (!ReadLines(path, &lns)) return false;
    for (std::size_t i = 0; i < lns.size(); ++i) {
        if (lns[i].empty()) continue;
        journal::Row r;
        if (!ParseRowLine(lns[i], &r)) return false;
        out->push_back(r);
    }
    return true;
}

bool JournalVerifyFile(const char* path) {
    std::vector<journal::Row> rows;
    if (!JournalLoad(path, &rows)) return false;
    if (rows.empty()) return true;  // empty file is a clean genesis
    return journal::VerifyChain(rows.data(), rows.size());
}

std::string PayloadHash(const char* body) {
    if (!body) return std::string();
    return jev::Sha256Hex(body);
}

bool SaveSnapshot(const char* path, const char* record) {
    return AtomicWrite(path, record ? record : "");
}

bool LoadSnapshot(const char* path, char* record, std::size_t n) {
    if (!path || !record || n == 0) return false;
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    std::size_t i = 0;
    int c = 0;
    while ((c = std::fgetc(f)) != EOF) {
        if (i + 1 >= n) {
            std::fclose(f);
            return false;
        }
        if (c == '\n' || c == '\r') continue;
        record[i++] = (char)c;
    }
    record[i] = '\0';
    std::fclose(f);
    return i > 0;
}

bool FreezeAdd(const char* path, const char* symbol) {
    if (!symbol || !symbol[0]) return false;
    if (FreezeHas(path, symbol)) return true;  // idempotent
    return AppendLine(path, symbol);
}

bool FreezeHas(const char* path, const char* symbol) {
    if (!symbol) return false;
    std::vector<std::string> lns;
    if (!ReadLines(path, &lns)) return false;  // missing = empty set
    for (std::size_t i = 0; i < lns.size(); ++i) {
        if (lns[i] == symbol) return true;
    }
    return false;
}

bool SaveIntent(const char* path, const char* symbol, int side,
                int kind, long long qty, long long stop, long long tp) {
    if (!path || !symbol || !symbol[0]) return false;
    if ((side != 0 && side != 1) || (kind != 0 && kind != 1))
        return false;
    if (qty <= 0 || qty > 999999999 || stop <= 0 || tp <= 0)
        return false;
    char ln[128];
    int w = std::snprintf(ln, sizeof(ln), "%.15s|%d|%d|%lld|%lld|%lld",
                          symbol, side, kind, qty, stop, tp);
    if (w <= 0 || w >= static_cast<int>(sizeof(ln))) return false;
    if (FileExists(path)) return true;  // immutable: first wins
    return AtomicWrite(path, ln);
}

bool LoadIntent(const char* path, IntentDesc* out) {
    if (!path || !out) return false;
    std::vector<std::string> lns;
    if (!ReadLines(path, &lns) || lns.size() != 1) return false;
    const std::string& ln = lns[0];
    std::vector<std::string> f;
    std::string cur;
    for (char c : ln) {
        if (c == '|') {
            f.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    f.push_back(cur);
    if (f.size() != 6) return false;
    if (f[0].empty() || f[0].size() > 15) return false;
    for (char c : f[0]) {
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '.'))
            return false;
    }
    long long v[5];
    for (int i = 1; i < 6; ++i) {
        if (f[i].empty() || f[i].size() > 9) return false;
        for (char c : f[i]) {
            if (c < '0' || c > '9') return false;
        }
        try {
            v[i - 1] = std::stoll(f[i]);
        } catch (...) {
            return false;
        }
    }
    if ((v[0] != 0 && v[0] != 1) || (v[1] != 0 && v[1] != 1))
        return false;
    if (v[2] <= 0 || v[3] <= 0 || v[4] <= 0) return false;
    std::strcpy(out->symbol, f[0].c_str());
    out->side = (int)v[0];
    out->kind = (int)v[1];
    out->qty = v[2];
    out->stop = v[3];
    out->tp = v[4];
    return true;
}

bool ReadStage(const char* path, Stage* out, const char** reason) {
    static const char kMissing[] = "stage-missing";
    static const char kCorrupt[] = "stage-corrupt";
    static const char kChain[] = "stage-chain-bad";
    if (!out) {
        if (reason) *reason = kCorrupt;
        return false;
    }
    std::vector<std::string> lns;
    if (!ReadLines(path, &lns) || lns.empty()) {
        if (reason) *reason = kMissing;
        return false;
    }
    // Records split on "stage:" lines; fields "key: value".
    struct Rec {
        std::string stage, by, at, cap, attest;
    };
    std::vector<Rec> recs;
    for (std::size_t i = 0; i < lns.size(); ++i) {
        std::string ln = Trim(lns[i]);
        if (ln.empty()) continue;
        std::size_t c = ln.find(':');
        if (c == std::string::npos) {
            if (reason) *reason = kCorrupt;
            return false;
        }
        std::string k = Trim(ln.substr(0, c));
        std::string v = Trim(ln.substr(c + 1));
        if (k == "stage") {
            recs.push_back(Rec());
            recs.back().stage = v;
        } else if (recs.empty()) {
            if (reason) *reason = kCorrupt;
            return false;
        } else if (k == "approved_by") {
            recs.back().by = v;
        } else if (k == "approved_at") {
            recs.back().at = v;
        } else if (k == "capital_usd") {
            recs.back().cap = v;
        } else if (k == "attest_hash") {
            recs.back().attest = v;
        } else {
            if (reason) *reason = kCorrupt;
            return false;
        }
    }
    if (recs.empty()) {
        if (reason) *reason = kCorrupt;
        return false;
    }
    std::string prev = "GENESIS";
    for (std::size_t i = 0; i < recs.size(); ++i) {
        const Rec& r = recs[i];
        if (r.stage.empty() || r.by.empty() || r.at.empty() ||
            r.cap.empty() || r.attest.size() != 64)
            return false;
        for (char ch : r.cap) {
            if (ch < '0' || ch > '9') {
                if (reason) *reason = kCorrupt;
                return false;
            }
        }
        std::string body = r.stage + "|" + r.by + "|" + r.at + "|" +
                           r.cap + "|" + prev;
        if (jev::Sha256Hex(body) != r.attest) {
            if (reason) *reason = kChain;
            return false;
        }
        prev = r.attest;
    }
    const Rec& last = recs.back();
    if (last.stage.size() >= sizeof(out->stage) ||
        last.by.size() >= sizeof(out->approved_by) ||
        last.at.size() >= sizeof(out->approved_at)) {
        if (reason) *reason = kCorrupt;
        return false;
    }
    std::strcpy(out->stage, last.stage.c_str());
    std::strcpy(out->approved_by, last.by.c_str());
    std::strcpy(out->approved_at, last.at.c_str());
    try {
        out->capital_usd = std::stoll(last.cap);
    } catch (...) {
        if (reason) *reason = kCorrupt;
        return false;
    }
    std::strcpy(out->attest_hash, last.attest.c_str());
    return true;
}

bool StageGateG0(const char* path, const char** reason) {
    static const char kNotG0[] = "stage-not-g0-paper";
    static const char kCap[] = "stage-capital-nonzero";
    Stage s;
    if (!ReadStage(path, &s, reason)) return false;
    if (std::strcmp(s.stage, "G0_PAPER") != 0) {
        if (reason) *reason = kNotG0;
        return false;
    }
    if (s.capital_usd != 0) {
        if (reason) *reason = kCap;
        return false;
    }
    return true;
}

bool Alert(const char* path, const char* level, const char* code,
           const char* detail, long long ts_ns) {
    if (!level || !code || ts_ns <= 0) return false;
    char ln[512];
    int w = std::snprintf(
        ln, sizeof(ln), "{\"ts_ns\":%lld,\"level\":\"%.15s\","
        "\"code\":\"%.63s\",\"detail\":\"%.280s\"}",
        ts_ns, level, code, detail ? detail : "");
    if (w <= 0 || w >= static_cast<int>(sizeof(ln))) return false;
    return AppendLine(path, ln);
}

// Journal filename dates: journal-YYYYMMDD.jsonl. Day count is
// days_from_civil (proleptic Gregorian, no tables, no tz).
long long DaysCivil(long long y, long long m, long long d) {
    y -= (m <= 2) ? 1 : 0;
    long long era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy =
        (unsigned)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (long long)doe - 719468;
}
// Unparseable names are KEPT (false), never deleted.
bool JournalDateOld(const char* name, long long now_day) {
    const char* pre = "journal-";
    for (int i = 0; pre[i]; ++i) {
        if (name[i] != pre[i]) return false;
    }
    long long d[8];
    for (int i = 0; i < 8; ++i) {
        if (name[8 + i] < '0' || name[8 + i] > '9') return false;
        d[i] = name[8 + i] - '0';
    }
    if (std::strcmp(name + 16, ".jsonl") != 0) return false;
    long long y = d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3];
    long long m = d[4] * 10 + d[5];
    long long dd = d[6] * 10 + d[7];
    if (m < 1 || m > 12 || dd < 1 || dd > 31) return false;
    return (now_day - DaysCivil(y, m, dd)) > 90;
}
long long UnixDay(long long y, long long m, long long d) {
    return DaysCivil(y, m, d);
}
#ifdef _WIN32
#include <windows.h>
bool RetainJournals(const char* dir, long long now_unix_day, int* kept,
                    int* pruned) {
    int k = 0;
    int p = 0;
    std::string pat = std::string(dir) + "\\journal-*.jsonl";
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pat.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) {
        if (kept) *kept = 0;
        if (pruned) *pruned = 0;
        return true;  // empty dir is clean
    }
    do {
        if (JournalDateOld(fd.cFileName, now_unix_day)) {
            std::string full =
                std::string(dir) + "\\" + fd.cFileName;
            if (DeleteFileA(full.c_str()))
                ++p;
            else
                ++k;
        } else {
            ++k;
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    if (kept) *kept = k;
    if (pruned) *pruned = p;
    return true;
}
#else
#include <dirent.h>
bool RetainJournals(const char* dir, long long now_unix_day, int* kept,
                    int* pruned) {
    int k = 0;
    int p = 0;
    DIR* dp = opendir(dir);
    if (!dp) {
        if (kept) *kept = 0;
        if (pruned) *pruned = 0;
        return true;  // empty dir is clean
    }
    struct dirent* e = nullptr;
    while ((e = readdir(dp)) != nullptr) {
        std::string nm = e->d_name;
        if (nm.size() < 21 || nm.compare(0, 8, "journal-") != 0)
            continue;
        if (JournalDateOld(e->d_name, now_unix_day)) {
            std::string full = std::string(dir) + "/" + nm;
            if (std::remove(full.c_str()) == 0)
                ++p;
            else
                ++k;
        } else {
            ++k;
        }
    }
    closedir(dp);
    if (kept) *kept = k;
    if (pruned) *pruned = p;
    return true;
}
#endif

bool BackupFile(const char* src, const char* dst) {
    if (!src || !dst) return false;
    FILE* f = std::fopen(src, "rb");
    if (!f) return false;
    std::string tmp = std::string(dst) + ".tmp";
    FILE* g = std::fopen(tmp.c_str(), "wb");
    if (!g) {
        std::fclose(f);
        return false;
    }
    char buf[8192];
    std::size_t n = 0;
    bool ok = true;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) {
        if (std::fwrite(buf, 1, n, g) != n) {
            ok = false;
            break;
        }
    }
    if (std::ferror(f)) ok = false;
    ok = ok && CommitFile(g);
    std::fclose(g);
    std::fclose(f);
    if (!ok) {
        std::remove(tmp.c_str());
        return false;
    }
#ifdef _WIN32
    std::remove(dst);
#endif
    if (std::rename(tmp.c_str(), dst) != 0) {
        std::remove(tmp.c_str());
        return false;
    }
    return true;
}

bool CopyFileBytes(const char* src, const char* dst) {
    // Same contract as BackupFile (byte-copy + OS-commit + atomic
    // rename); the dated journal copy IS a backup with a rhythm
    // name, so one implementation serves both.
    return BackupFile(src, dst);
}

bool MkDirIfMissing(const char* dir) {
    if (!dir || dir[0] == '\0') return false;
#ifdef _WIN32
    if (_mkdir(dir) == 0) return true;
#else
    if (mkdir(dir, 0700) == 0) return true;
#endif
    return errno == EEXIST;
}

void CivilFromDays(long long z, int* y, unsigned* m, unsigned* d) {
    // Howard Hinnant's civil_from_days (public domain algorithm):
    // days since 1970-01-01 -> proleptic-Gregorian y/m/d.
    z += 719468;
    long long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097);  // [0, 146096]
    unsigned yoe =
        (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long long yy = (long long)yoe + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned mp = (5 * doy + 2) / 153;
    unsigned dd = doy - (153 * mp + 2) / 5 + 1;
    unsigned mm = mp + (mp < 10 ? 3 : -9);
    yy += (mm <= 2) ? 1 : 0;
    if (y) *y = (int)yy;
    if (m) *m = mm;
    if (d) *d = dd;
}

bool SummarizeJournal(const char* path, Summary* out) {
    if (!out) return false;
    std::vector<journal::Row> rows;
    *out = Summary();
    if (!JournalLoad(path, &rows)) return false;
    out->chain_ok = rows.empty() ||
                    journal::VerifyChain(rows.data(), rows.size());
    std::vector<std::string> ids;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const journal::Row& r = rows[i];
        ++out->rows;
        out->last_seq = (long long)r.seq;
        if (r.kind == "intent")
            ++out->intent;
        else if (r.kind == "fill")
            ++out->fill;
        else if (r.kind == "partial")
            ++out->partial;
        else if (r.kind == "cancel")
            ++out->cancel;
        else if (r.kind == "unknown")
            ++out->unknown;
        else if (r.kind == "exit")
            ++out->exit;
        else if (r.kind == "reconcile")
            ++out->reconcile;
        else if (r.kind == "drift_directive")
            ++out->drift_directive;
        else if (r.kind == "demotion")
            ++out->demotion;
        bool seen = false;
        for (std::size_t k = 0; k < ids.size(); ++k) {
            if (ids[k] == r.intent_id) {
                seen = true;
                break;
            }
        }
        if (!seen) {
            ids.push_back(r.intent_id);
            ++out->intents;
        }
    }
    return true;
}

bool FormatSummary(const Summary& s, char* out, std::size_t n) {
    int w = std::snprintf(
        out, n,
        "rows=%lld intents=%lld intent=%lld fill=%lld partial=%lld "
        "cancel=%lld unknown=%lld exit=%lld reconcile=%lld "
        "drift_directive=%lld demotion=%lld last_seq=%lld chain=%s",
        s.rows, s.intents, s.intent, s.fill, s.partial, s.cancel,
        s.unknown, s.exit, s.reconcile, s.drift_directive,
        s.demotion, s.last_seq, s.chain_ok ? "ok" : "BROKEN");
    return w > 0 && static_cast<std::size_t>(w) < n;
}

}  // namespace runner
}  // namespace jev
