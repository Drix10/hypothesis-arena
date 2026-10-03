// Paper runner durability seam.
//
// The caller-owned side of the pure kernel's seam: journal file append +
// OS-commit + restart load + chain verify, atomic machine snapshots, freeze
// set, STAGE gate, HALT read, alerts.jsonl, retention/backup/summary.
// Synchronous and bounded; std::string is allowed here (the noalloc gates
// cover the decision core). Every function returns false on any I/O
// shortfall; the runner treats a failed write as journal_ok=false, never as a
// landed row.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../log/journal.hpp"

namespace kernel {
namespace runner {

// ---- primitives ----
// Append one line (with trailing '\n') + flush + OS-commit.
bool AppendLine(const char* path, const char* line);
// Checked decimal parse for the CLI cycles argument: digits only (empty = 0,
// unbounded), rejecting the digit that would overflow signed long long. The
// caller's 0..1000000 window applies after.
bool ParseCycles(const char* text, long long* out);
// tmp + flush + OS-commit + rename (single-process atomic).
bool AtomicWrite(const char* path, const char* data);
// Write-fault injection (tests only; production never calls these,
// default-off): fail the Nth upcoming AtomicWrite whose path ends with
// `suffix` (skip 0 = the next matching write). One-shot per slot;
// ClearWriteFaults disarms everything. Up to 4 faults may be armed at once,
// so a double failure (mint fails and rollback fails) is expressible.
void InjectWriteFault(const char* suffix, int skip);
void ClearWriteFaults();
bool ReadLines(const char* path, std::vector<std::string>* out);
// Path integrity: absent vs corrupt/non-regular are distinct. A directory or
// unreadable node never reads as a missing file; callers fail closed on
// CORRUPT.
enum class PathKind { ABSENT, REGULAR, CORRUPT };
PathKind StatPath(const char* path);
// Bounded variant: refuses (false, out cleared) when the file exceeds
// max_bytes, for incident-scoped state files that are tiny by construction
// (hard-chain.txt). The live journal is bounded separately (JournalCap).
bool ReadLinesCapped(const char* path, std::vector<std::string>* out,
                     std::size_t max_bytes);
bool FileExists(const char* path);
// Size in bytes; -1 when unreadable.
long long FileSizeBytes(const char* path);

// ---- journal file ----
// One canonical row per line:
//   seq|ts_ns|kind|intent_id|payload_hash|prev_hash|row_hash
// Fields carry no pipes (intent ids [A-Za-z0-9_.-], lowercase hex hashes,
// fixed kinds).
bool JournalAppend(const char* path, const journal::Row& r);
// A journal larger than JournalCap() bytes refuses to load; the runner treats
// that like a corrupt file (halt). Rows are ~250 bytes, so 64 MiB covers
// decades at full stage order rates; the daily roll alerts at half the cap.
// SetJournalCap is for tests.
constexpr std::size_t kJournalDefaultCap = 64u << 20;
std::size_t JournalCap();
void SetJournalCap(std::size_t bytes);
bool JournalLoad(const char* path, std::vector<journal::Row>* out);
// Strict re-parse of one canonical journal line; malformed numbers fail.
bool ParseRowLine(const std::string& ln, journal::Row* out);
// Serialize one row to its canonical line (false on truncation).
bool RowLine(const journal::Row& r, char* out, std::size_t n);
// Load + VerifyChain. False on any break (caller HARD-kills).
bool JournalVerifyFile(const char* path);
// Crash recovery for a torn final line (a write cut short before its "\n").
// Only a tail with no newline is trimmed: the partial bytes go to
// `<path>.torn` (appended) and the file is rewritten to the last complete
// line. Returns 0 = nothing to do, 1 = trimmed, -1 = error (caller refuses).
// Complete-but-bad rows are never touched; the chain check still decides.
int JournalTrimTornTail(const char* path);
// payload_hash input: sha256 over the kind-specific body (<=280 chars,
// RedactionOk-gated upstream of FormatRow).
std::string PayloadHash(const char* body);

// ---- machine snapshots ----
// Fixed "RM:..." record per intent (SnapshotMachine/RestoreMachine own the
// bytes; this makes the write crash-safe).
bool SaveSnapshot(const char* path, const char* record);
bool LoadSnapshot(const char* path, char* record, std::size_t n);

// ---- intent registration ----
// Immutable intent descriptor, written once at SubmitIntent: the crash image
// carries binding but not economics (qty/stop/tp), so recovery reloads them
// here. One line: symbol|side01|kind01|qty|stop|tp (strict, bounded).
bool SaveIntent(const char* path, const char* symbol, int side,
                int kind, long long qty, long long stop, long long tp);
struct IntentDesc {
    char symbol[16]{};
    int side = -1;
    int kind = -1;
    long long qty = 0;
    long long stop = 0;
    long long tp = 0;
};
bool LoadIntent(const char* path, IntentDesc* out);

// ---- freeze set (one symbol per line) ----
bool FreezeAdd(const char* path, const char* symbol);
bool FreezeHas(const char* path, const char* symbol);

// ---- STAGE gate ----
struct Stage {
    char stage[16]{};
    char approved_by[128]{};
    char approved_at[64]{};
    long long capital_usd = -1;
    char attest_hash[65]{};
};
// Verify the full chain (genesis prev_attest = "GENESIS"). False + static
// reason on missing/corrupt/chain-bad. out = last record.
bool ReadStage(const char* path, Stage* out, const char** reason);
// paper runner: chain verifies + stage==PAPER + capital==0.
bool StageGateG0(const char* path, const char** reason);

// ---- alerts ----
bool Alert(const char* path, const char* level, const char* code,
           const char* detail, long long ts_ns);

// ---- retention / backup / summary ----
// Byte-copy src -> dst (fails closed on any short read/write).
bool CopyFileBytes(const char* src, const char* dst);
// Make a directory when missing (single level); false only when creation was
// needed and failed.
bool MkDirIfMissing(const char* dir);
// Unix day -> proleptic-Gregorian y/m/d (Hinnant civil_from_days), for dated
// journal names.
void CivilFromDays(long long z, int* y, unsigned* m, unsigned* d);
// Delete journal-YYYYMMDD.jsonl files older than 90 days (filename dates
// only; unparseable names are kept).
bool RetainJournals(const char* dir, long long now_unix_day,
                    int* kept, int* pruned);
// Proleptic-Gregorian day count (operator/test helper for now_unix_day).
long long UnixDay(long long y, long long m, long long d);
// Byte-copy + commit (fails closed on any short read/write).
bool BackupFile(const char* src, const char* dst);
// From the journal file alone: per-kind counts, distinct intents, unknowns,
// last seq, chain verdict.
struct Summary {
    long long rows = 0;
    long long intent = 0;
    long long fill = 0;
    long long partial = 0;
    long long cancel = 0;
    long long unknown = 0;
    long long exit = 0;
    long long reconcile = 0;
    long long drift_directive = 0;
    long long demotion = 0;
    long long intents = 0;
    long long last_seq = -1;
    bool chain_ok = false;
};
bool SummarizeJournal(const char* path, Summary* out);
bool FormatSummary(const Summary& s, char* out, std::size_t n);

}  // namespace runner
}  // namespace kernel
