// H1 integration — G0 runner durability seam (doc 06 sec. 6.1/6.5,
// doc 10 sec. 10.1/10.5, doc 13 sec. 13.5 Slice H1).
//
// The pure kernel (RouteStep, journal rows, kill evaluation) never
// touches files, clocks, or sockets. This module is the caller-owned
// side of that seam: journal file append + OS-commit + restart load +
// chain verify, atomic machine snapshots, freeze set, STAGE gate,
// HALT read, alerts.jsonl, retention/backup/summary. Synchronous and
// bounded; std::string is allowed here (cycle path, never tick-hot —
// the noalloc gates cover the decision core, not durability).
//
// Failure policy: every function returns false on any I/O shortfall
// (fail closed — the runner treats a failed durability write as
// journal_ok=false, never as a landed row).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../log/journal.hpp"

namespace jev {
namespace runner {

// ---- primitives ---------------------------------------------------
// Append one line (with trailing '\n') + flush + OS-commit.
bool AppendLine(const char* path, const char* line);
// tmp + flush + OS-commit + rename (single-process atomic).
bool AtomicWrite(const char* path, const char* data);
bool ReadLines(const char* path, std::vector<std::string>* out);
bool FileExists(const char* path);

// ---- journal file -------------------------------------------------
// One canonical row per line:
//   seq|ts_ns|kind|intent_id|payload_hash|prev_hash|row_hash
// Fields carry no pipes by construction (intent ids are
// [A-Za-z0-9_.-], hashes lowercase hex, kinds frozen vocabulary).
bool JournalAppend(const char* path, const journal::Row& r);
bool JournalLoad(const char* path, std::vector<journal::Row>* out);
// Strict re-parse of one canonical journal line (same grammar as
// the live file; malformed numbers fail, never throw).
bool ParseRowLine(const std::string& ln, journal::Row* out);
// Serialize one row to its canonical line (false on truncation).
bool RowLine(const journal::Row& r, char* out, std::size_t n);
// Load + VerifyChain. False on any break (caller HARD-kills).
bool JournalVerifyFile(const char* path);
// payload_hash input: sha256 over the kind-specific body (<=280 chars,
// RedactionOk-gated upstream of FormatRow).
std::string PayloadHash(const char* body);

// ---- machine snapshots --------------------------------------------
// Fixed "H1:..." record per intent (SnapshotMachine/RestoreMachine
// grammar owns the bytes; this only makes the write crash-safe).
bool SaveSnapshot(const char* path, const char* record);
bool LoadSnapshot(const char* path, char* record, std::size_t n);

// ---- intent registration -------------------------------------------
// Immutable intent descriptor (written once at SubmitIntent, never
// modified): the crash image carries binding but NOT economics
// (qty/stop/tp), so recovery reloads them here. One line:
//   symbol|side01|kind01|qty|stop|tp  (strict, all bounded)
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

// ---- freeze set (one symbol per line) ------------------------------
bool FreezeAdd(const char* path, const char* symbol);
bool FreezeHas(const char* path, const char* symbol);

// ---- STAGE gate (plan/10: pipe-delimited attest chain) -------------
struct Stage {
    char stage[16]{};
    char approved_by[128]{};
    char approved_at[64]{};
    long long capital_usd = -1;
    char attest_hash[65]{};
};
// Verify the full chain (genesis prev_attest = "GENESIS"). False +
// static reason on missing/corrupt/chain-bad. out = LAST record.
bool ReadStage(const char* path, Stage* out, const char** reason);
// G0 startup gate: chain verifies + stage==G0_PAPER + capital==0.
bool StageGateG0(const char* path, const char** reason);

// ---- alerts (plan/10 sec. 10.1 v1 channel: alerts.jsonl) ------------
bool Alert(const char* path, const char* level, const char* code,
           const char* detail, long long ts_ns);

// ---- retention / backup / summary ----------------------------------
// Byte-copy src -> dst (fails closed on any short read/write).
bool CopyFileBytes(const char* src, const char* dst);
// Make a directory when missing (single level; true when the dir
// exists afterwards, false only when creation was needed and
// failed).
bool MkDirIfMissing(const char* dir);
// Unix-day (days since 1970-01-01) -> proleptic-Gregorian y/m/d
// (Howard Hinnant's civil_from_days — for dated journal names).
void CivilFromDays(long long z, int* y, unsigned* m, unsigned* d);
// Delete journal-YYYYMMDD.jsonl files in dir older than 90 days
// (filename dates only; unparseable names are kept, never deleted).
bool RetainJournals(const char* dir, long long now_unix_day,
                    int* kept, int* pruned);
// Proleptic-Gregorian day count (operator/test helper for now_unix_day).
long long UnixDay(long long y, long long m, long long d);
// Byte-copy + commit (fails closed on any short read/write).
bool BackupFile(const char* src, const char* dst);
// From the journal file ALONE (no live system): per-kind counts,
// distinct intents, unknowns, last seq, chain verdict.
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
}  // namespace jev
