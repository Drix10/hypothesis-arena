// H1 integration — G0 runner implementation. See runner.hpp for
// the ownership boundary. Deterministic under injected seams;
// single-writer (the operator starts one instance per dir).
#include "runner.hpp"

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstring>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <sys/stat.h>
#include <windows.h>
#else
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <unistd.h>
#endif
#include <thread>

namespace jev {
namespace runner {

namespace {
bool SameId(const char* a, const char* b) {
    if (!a || !b) return false;
    int i = 0;
    while (a[i] && b[i] && i < 65) {
        if (a[i] != b[i]) return false;
        ++i;
    }
    return a[i] == b[i];
}
void CopyStr(char* dst, std::size_t dn, const char* src) {
    if (!dst || dn == 0) return;
    std::size_t i = 0;
    while (i + 1 < dn && src && src[i] != '\0') {
        dst[i] = src[i];
        ++i;
    }
    dst[i] = '\0';
}
bool IsTerminalState(exec::RouteState st) {
    return st == exec::RouteState::PROTECTED ||
           st == exec::RouteState::CANCELLED ||
           st == exec::RouteState::UNKNOWN_FROZEN ||
           st == exec::RouteState::CLOSED;
}
// Uncovered live books (doc 06 sec. 6.1b): true when the
// directory holds slot books that claim LIVE risk with no
// covering journal intent row in hand. Live risk = a snapshot
// past the pre-send states (anything but IDLE /
// JOURNAL_PENDING / recovery-terminal — the send comes steps
// after the first persist, so a post-send machine without a
// row is torn), an unreadable/unrestorable snapshot (cannot
// prove inert — fail closed), or a snapshot with no matching
// intent file (submit writes the intent first, so the
// counterpart cannot be crash debris). Intent-only leftovers
// (submit-before-first-cycle) and terminal books are NOT live
// claims — they keep their established ignore/resume paths.
// Stale AtomicWrite debris (*.tmp) is never a book.
bool HasUncoveredLiveBooks(const std::string& dir) {
    std::vector<std::string> snaps;
#ifdef _WIN32
    std::string pat = dir + "\\snap-*";
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pat.c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            snaps.push_back(fd.cFileName);
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
#else
    DIR* dp = opendir(dir.c_str());
    if (dp) {
        struct dirent* e = nullptr;
        while ((e = readdir(dp)) != nullptr) {
            std::string nm = e->d_name;
            if (nm.compare(0, 5, "snap-") == 0) snaps.push_back(nm);
        }
        closedir(dp);
    }
#endif
    for (std::size_t i = 0; i < snaps.size(); ++i) {
        const std::string& nm = snaps[i];
        if (nm.size() >= 4 &&
            nm.compare(nm.size() - 4, 4, ".tmp") == 0)
            continue;  // crash debris, never a book
        std::string infix = nm.substr(5);
        if (infix.size() >= 4 &&
            infix.compare(infix.size() - 4, 4, ".txt") == 0)
            infix.erase(infix.size() - 4);
        if (!FileExists(
                (dir + "/intent-" + infix + ".txt").c_str()))
            return true;  // half-registration, unattested
        char rec[320];
        if (!LoadSnapshot((dir + "/" + nm).c_str(), rec,
                          sizeof(rec)))
            return true;  // cannot prove inert
        exec::RouteMachine m;
        if (!exec::RestoreMachine(rec, &m)) return true;
        // Recovery-terminal (CANCELLED / UNKNOWN_FROZEN /
        // CLOSED) books need nothing; IDLE / JOURNAL_PENDING
        // books predate any send. Anything else claims live
        // risk — note PROTECTED is live here even though the
        // drive loop treats it as terminal (round-3 recovery
        // rule: restart must not demote it to slotless).
        if (m.state != exec::RouteState::IDLE &&
            m.state != exec::RouteState::JOURNAL_PENDING &&
            m.state != exec::RouteState::CANCELLED &&
            m.state != exec::RouteState::UNKNOWN_FROZEN &&
            m.state != exec::RouteState::CLOSED)
            return true;  // post-send progress without a row
    }
    return false;
}
// Centralized MEDIUM FSM read (doc 06 sec. 6.1b): EVERY cycle
// boundary validates the persisted file before any transition,
// at every kill level — a malformed file can never be
// rewritten into a legitimate-looking state (corruption is
// refused, never erased). ABSENT = missing-or-empty
// (fresh/mint-retry path); OK = one of the four legal states;
// CORRUPT = non-regular node; UNKNOWN = present-but-
// unreadable or non-empty unknown content.
enum class MediumFsmRead { ABSENT, OK, CORRUPT, UNKNOWN };
MediumFsmRead ReadMediumFsm(const char* path, std::string* out) {
    if (out) out->clear();
    if (!path || !out) return MediumFsmRead::CORRUPT;
    if (StatPath(path) == PathKind::CORRUPT)
        return MediumFsmRead::CORRUPT;
    if (StatPath(path) == PathKind::ABSENT)
        return MediumFsmRead::ABSENT;
    std::vector<std::string> lns;
    if (!ReadLines(path, &lns)) return MediumFsmRead::UNKNOWN;
    if (lns.empty()) return MediumFsmRead::ABSENT;  // mint-retry
    const std::string& cur = lns[0];
    if (cur != "MEDIUM_ACTIVE" && cur != "FLATTEN_PENDING" &&
        cur != "FLATTENED" && cur != "PROTECTION_ONLY")
        return MediumFsmRead::UNKNOWN;
    *out = cur;
    return MediumFsmRead::OK;
}
// Filesystem-safe intent id (also the intent-file name infix):
// alnum + '-'/'_' only, 1..64 chars. Rejects path traversal
// ("../") BEFORE any filesystem touch.
bool IsSafeId(const char* s) {
    if (!s || s[0] == '\0') return false;
    int n = 0;
    while (s[n] != '\0') {
        char c = s[n];
        if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
              (c >= 'a' && c <= 'z') || c == '-' || c == '_'))
            return false;
        ++n;
        if (n > 64) return false;
    }
    return true;
}
// Pop the stamped/consumed queue head (bounded shift, max 8).
void ShiftStreamQ(Slot& s) {
    if (s.sev_n_ <= 0) return;
    for (int i = 0; i + 1 < s.sev_n_; ++i) s.sev_[i] = s.sev_[i + 1];
    s.sev_[s.sev_n_ - 1] = StreamEvt();
    --s.sev_n_;
}
// Journal truth for an intent id: 0 = no intent row, 1 = intent
// row only (in flight or crashed before terminal), 2 = terminal
// row present (fill/cancel/unknown/exit). Crash seams consult this
// instead of assuming (a completed flatten is never re-ordered).
int JournalIntentState(const std::string& dir, const char* intent_id) {
    if (!intent_id) return 0;
    std::vector<journal::Row> jr;
    if (!JournalLoad((dir + "/journal.jsonl").c_str(), &jr))
        return 0;
    int st = 0;
    for (std::size_t i = 0; i < jr.size(); ++i) {
        if (jr[i].intent_id != intent_id) continue;
        if (jr[i].kind == "intent") {
            if (st == 0) st = 1;
        } else if (jr[i].kind == "fill" || jr[i].kind == "cancel" ||
                   jr[i].kind == "unknown" || jr[i].kind == "exit") {
            st = 2;
        }
    }
    return st;
}
// Repair sub-identity: "<intent>-repair" hashed through the frozen
// client-ID recipe (own deterministic id, restart-stable, never the
// entry id — the venue rejects duplicate client_order_id). Pure
// function: recovery re-derives it with no snapshot field, so the
// frozen router format never changes. Unrepresentable only when
// fields are empty (the recipe's own rule); then the caller fails
// the repair and the router takes the flatten fallback (doc 06
// sec. 6.1: establish now OR flatten immediately).
bool RepairClientId(const char* broker, const char* account,
                    const char* ctx_hex, const char* symbol,
                    broker::OrderSide protect_side,
                    const char* intent_id, char* coid_out) {
    if (!intent_id || !coid_out) return false;
    std::string rid = intent_id;
    rid += "-repair";
    return broker::MakeClientOrderId(broker, account, ctx_hex,
                                     symbol, protect_side,
                                     rid.c_str(), coid_out);
}
// REPAIR_SENT reconciles the REPAIR order, not the entry: the
// lookup id follows the repair sub-identity while the machine
// waits on it (everywhere else the stable entry id rules).
const char* LookupIdFor(const Slot& s) {
    if (s.m.state == exec::RouteState::REPAIR_SENT &&
        s.has_repair_id && s.repair_coid[0] != '\0')
        return s.repair_coid;
    return s.m.client_id;
}
// Quarantine vocabulary (doc 06 locked): done_for_day / calculated
// (done for today, may resume tomorrow) / replaced (an unknown
// replacement id may be live). Exact match, bounded words.
bool IsQuarantineStatus(const char* st) {
    if (!st || !st[0]) return false;
    const char* const qw[] = {"done_for_day", "calculated",
                              "replaced"};
    for (int w = 0; w < 3; ++w) {
        const char* b = qw[w];
        const char* a = st;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*a == '\0' && *b == '\0') return true;
    }
    return false;
}
// Strict epoch parse: all digits, fits int64, > 0. Anything else
// (missing/corrupt file) = no incident.
long long ParseEpoch(const std::vector<std::string>& lns) {
    if (lns.empty()) return 0;
    const std::string& e = lns[0];
    if (e.empty() || e.size() > 19) return 0;
    // Checked accumulation: a 19-digit file value can exceed
    // LLONG_MAX, and signed overflow is UB regardless of any
    // after-the-fact sign test — refuse before it can happen.
    long long v = 0;
    for (std::size_t i = 0; i < e.size(); ++i) {
        if (e[i] < '0' || e[i] > '9') return 0;
        int dgt = e[i] - '0';
        if (v > (LLONG_MAX - dgt) / 10) return 0;
        v = v * 10 + dgt;
    }
    return v;
}
// Incident close-id tags (doc 06 sec. 6.1b): kind + epoch +
// symbol (+ qty for remainders), hashed through the frozen
// recipe by the caller. One (symbol, side) per incident = one
// pre-flighted identity every kill path shares.
std::string SweepTag(long long epoch, const char* symbol) {
    char t[64];
    std::snprintf(t, sizeof(t), "medium-%lld-%.15s", epoch,
                  symbol ? symbol : "");
    return t;
}
std::string SweepRemainderTag(long long epoch, const char* symbol,
                              long long qty) {
    char t[64];
    std::snprintf(t, sizeof(t), "medium-%lld-%.15s-%lld", epoch,
                  symbol ? symbol : "", qty);
    return t;
}
std::string HardTag(long long epoch, const char* symbol) {
    char t[64];
    std::snprintf(t, sizeof(t), "hard-%lld-%.15s", epoch,
                  symbol ? symbol : "");
    return t;
}
// Journal body vocabulary (bounded, pre-redacted, <=280 chars).
bool BodyFor(const char* kind, const exec::OrderIntent& in,
             long long qty, const char* note, char* out,
             std::size_t n) {
    int w = std::snprintf(out, n, "%s sym=%.15s qty=%lld note=%.100s",
                          kind, in.symbol, qty, note ? note : "");
    return w > 0 && static_cast<std::size_t>(w) < n &&
           jev::journal::RedactionOk(out);
}
}  // namespace

G0Runner::G0Runner(const RunnerConfig& cfg, const RunnerDeps& deps)
    : cfg_(cfg), deps_(deps), adapter_(deps.transport) {
    prev_hash_ = journal::GenesisPrev();
    // Capacity is never exceeded: entries stop at max_slots, exits
    // (which must never wedge behind entry capacity — refusing an
    // exit strands risk) stop at twice that. Both bounds hold
    // BEFORE any push, so Slot& refs never dangle on reallocation
    // mid-cycle (MEDIUM-flatten appends while the drive loop holds
    // refs). The 2x ceiling is the documented worst case: every
    // live entry carrying one live exit at once.
    slots_.reserve((std::size_t)ExitCap());
}

std::string G0Runner::P(const char* name) const {
    return cfg_.dir + "/" + name;
}

std::string G0Runner::SnapPath(const char* intent_id) const {
    return cfg_.dir + "/snap-" + intent_id + ".txt";
}

std::string G0Runner::IntentPath(const char* intent_id) const {
    return cfg_.dir + "/intent-" + intent_id + ".txt";
}

bool G0Runner::JournalWrite(const char* kind, const char* intent_id,
                            const char* body, long long now_ns) {
    if (!kind || !intent_id || !body || now_ns <= 0) return false;
    if (!journal::RedactionOk(body)) return false;
    journal::Row r;
    if (!journal::FormatRow(next_seq_, now_ns, kind, intent_id,
                            PayloadHash(body).c_str(), prev_hash_.c_str(),
                            &r))
        return false;
    if (!JournalAppend(P("journal.jsonl").c_str(), r)) return false;
    prev_hash_ = r.row_hash;
    ++next_seq_;
    return true;
}

bool G0Runner::EmergencyAppend(const journal::Row& r) {
    char ln[1024];
    int w = std::snprintf(ln, sizeof(ln), "%llu|%lld|%s|%s|%s|%s|%s",
                          (unsigned long long)r.seq, (long long)r.ts_ns,
                          r.kind.c_str(), r.intent_id.c_str(),
                          r.payload_hash.c_str(), r.prev_hash.c_str(),
                          r.row_hash.c_str());
    if (w <= 0 || w >= static_cast<int>(sizeof(ln))) return false;
    return AppendLine(P("emergency.jsonl").c_str(), ln);
}

bool G0Runner::DrainEmergency() {
    // Crash-idempotent, one row per turn: append the head (unless
    // the journal tail already IS the head — a pre-crash append),
    // then remove the head from the buffer file. ANY crash
    // restarts the turn; convergence = full chain + empty buffer,
    // never a duplicate row, never a half-drain refusal.
    std::string jp = P("journal.jsonl");
    std::string ep = P("emergency.jsonl");
    std::vector<journal::Row> jr;
    if (!JournalLoad(jp.c_str(), &jr)) return false;
    // Every applied line (live file first, then each appended head):
    // a buffer head matching ANY of these was already drained by a
    // dead process — drop it, never re-append. Anything else that
    // does not chain to the tail is a genuine break (refuse).
    std::vector<std::string> jlines;
    ReadLines(jp.c_str(), &jlines);  // missing = empty (JournalLoad
                                     // above already gated readability)
    std::vector<std::string> seen;
    for (std::size_t i = 0; i < jlines.size(); ++i) {
        if (!jlines[i].empty()) seen.push_back(jlines[i]);
    }
    std::string tail = journal::GenesisPrev();
    if (!jr.empty()) tail = jr.back().row_hash;
    for (;;) {
        std::vector<std::string> lns;
        if (StatPath(ep.c_str()) == PathKind::CORRUPT)
            return false;  // corrupt buffer: Recover refuses
        if (!ReadLines(ep.c_str(), &lns)) return true;  // no buffer
        std::size_t head = lns.size();
        for (std::size_t i = 0; i < lns.size(); ++i) {
            if (!lns[i].empty()) {
                head = i;
                break;
            }
        }
        if (head == lns.size()) {
            AtomicWrite(ep.c_str(), "");
            return true;  // drained
        }
        journal::Row r;
        if (!ParseRowLine(lns[head], &r)) return false;
        if (r.prev_hash == tail) {
            // Fresh row: append, advance the tail, remember it.
            char ln[1024];
            if (!RowLine(r, ln, sizeof(ln))) return false;
            if (!AppendLine(jp.c_str(), ln)) return false;
            seen.push_back(lns[head]);
            tail = r.row_hash;
        } else {
            // Not chained to the tail: already applied (the exact
            // line sits in the chain — a pre-crash append) or a
            // genuine chain break (refuse loudly, never skip).
            bool applied = false;
            for (std::size_t i = 0; i < seen.size(); ++i) {
                if (seen[i] == lns[head]) {
                    applied = true;
                    break;
                }
            }
            if (!applied) return false;
        }
        // Remove the head (atomic rewrite); loop for the next row.
        std::string rest;
        for (std::size_t i = head + 1; i < lns.size(); ++i) {
            if (lns[i].empty()) continue;
            rest += lns[i];
            rest += "\n";
        }
        if (!AtomicWrite(ep.c_str(), rest.c_str())) return false;
    }
}

bool G0Runner::PersistSlot(Slot& s) {
    char rec[320];
    if (!exec::SnapshotMachine(s.m, rec, sizeof(rec))) return false;
    return SaveSnapshot(SnapPath(s.intent.intent_id).c_str(), rec);
}

bool G0Runner::Recover(const char** reason) {
    static const char kStage[] = "recover-stage-refused";
    static const char kChain[] = "recover-journal-broken";
    static const char kSnap[] = "recover-snapshot-bad";
    static const char kOrphan[] = "recover-orphaned-state";
    if (!deps_.now_ns) {
        if (reason) *reason = "recover-no-clock";
        return false;
    }
    if (!StageGateG0(P("STAGE").c_str(), nullptr)) {
        if (reason) *reason = kStage;
        return false;
    }
    stage_ok_ = true;
    // Single-process ownership (Phase-4 prerequisite): a live
    // foreign holder refuses the whole recovery, never co-owns.
    if (!TakeDirLock()) {
        if (reason) *reason = "recover-lock-held";
        return false;
    }
    // Journal: break = HARD, alert, refuse (doc 10: forensics first).
    if (!JournalVerifyFile(P("journal.jsonl").c_str())) {
        Alert(P("alerts.jsonl").c_str(), "HARD", "journal-chain-break",
              "journal.jsonl fails VerifyChain", deps_.now_ns(deps_.clock_ctx));
        if (reason) *reason = kChain;
        return false;
    }
    std::vector<journal::Row> rows;
    if (!JournalLoad(P("journal.jsonl").c_str(), &rows)) {
        if (reason) *reason = kChain;
        return false;
    }
    if (!rows.empty()) {
        next_seq_ = rows.back().seq + 1;
        prev_hash_ = rows.back().row_hash;
    }
    if (!DrainEmergency()) {
        if (reason) *reason = kChain;
        return false;
    }
    // Post-drain reload: recovery decides from the JOINED chain
    // (drained emergency rows are journal rows now). Re-verify —
    // the drain appended, so trust but verify.
    if (!JournalVerifyFile(P("journal.jsonl").c_str())) {
        Alert(P("alerts.jsonl").c_str(), "HARD", "journal-chain-break",
              "post-drain chain fails VerifyChain",
              deps_.now_ns(deps_.clock_ctx));
        if (reason) *reason = kChain;
        return false;
    }
    rows.clear();
    if (!JournalLoad(P("journal.jsonl").c_str(), &rows)) {
        if (reason) *reason = kChain;
        return false;
    }
    if (!rows.empty()) {
        next_seq_ = rows.back().seq + 1;
        prev_hash_ = rows.back().row_hash;
    } else {
        next_seq_ = 0;
        prev_hash_ = journal::GenesisPrev();
    }
    // Orphaned books (doc 06 sec. 6.1b): intents rebuild
    // exclusively from journal intent rows, so durable
    // snap-/intent- books with NO intent row in the journal
    // (absent/empty journal, or a journal that lost them) are
    // torn state — refuse for human recovery, never
    // success-with-zero-slots (the position would silently
    // leave local ownership). The no-intent-row form (not
    // merely empty) keeps the refusal stable across retries:
    // the refusal row below must never launder the orphan
    // into a genesis. A virgin directory (no books) still
    // initializes as genesis.
    bool have_intent_row = false;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        if (rows[i].kind == "intent") {
            have_intent_row = true;
            break;
        }
    }
    if (!have_intent_row && HasUncoveredLiveBooks(cfg_.dir)) {
        OpsRow("reconcile", "runner", "recover-orphaned-state",
               deps_.now_ns(deps_.clock_ctx));
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "recover-orphaned-state",
              "slot books with no journal intent row",
              deps_.now_ns(deps_.clock_ctx));
        if (reason) *reason = kOrphan;
        return false;
    }
    // Durable stream cursor (missing = first run, empty cursor).
    // A corrupt cursor refuses: replay-from-zero would silently
    // discard the durable replay position (human deletes it to
    // re-anchor, never an automatic reset).
    if (StatPath(P("cursor.txt").c_str()) == PathKind::CORRUPT) {
        if (reason) *reason = kSnap;
        return false;
    }
    std::vector<std::string> clns;
    if (ReadLines(P("cursor.txt").c_str(), &clns) && !clns.empty())
        cursor_ = clns[0];
    else
        cursor_.clear();
    cursor_dirty_ = false;
    // Active intents = journal "intent" rows without a terminal row
    // (fill/cancel/unknown/exit). Each needs BOTH its crash image
    // (machine) and its intent file (economics — qty/stop/tp are
    // NOT in the crash image and are never inferred):
    //   snapshot + intent file -> full slot, reconcile-first;
    //   neither file, intent row only -> fresh IDLE slot (the send
    //     never reached a persisted state; pre-flight dedupe in
    //     Dispatch makes the re-drive safe);
    //   snapshot but no intent file (or vice versa, or corrupt) ->
    //     refuse: half a registration cannot be driven (S2/human).
    // Reconcile-first: last_s2_ns = 0 forces a real broker lookup
    // on the first cycle (the crash may have eaten the answer the
    // router was waiting for); sends always pre-flight by stable
    // id, so recovery can never double-send.
    // Terminal-row rule (doc 06 sec. 6.1b): a journal terminal row
    // NEVER overrides a durable snapshot. Snapshot nonterminal ->
    // the slot rebuilds below and reconciles; snapshot terminal ->
    // done; journal-terminal + missing snapshot/intent -> refuse
    // for human recovery (the row alone cannot prove the books).
    slots_.clear();
    std::vector<std::string> ids;
    std::vector<char> ids_term;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        if (rows[i].kind != "intent") continue;
        bool term = false;
        for (std::size_t k = 0; k < rows.size(); ++k) {
            if (rows[k].intent_id == rows[i].intent_id &&
                (rows[k].kind == "fill" || rows[k].kind == "cancel" ||
                 rows[k].kind == "unknown" || rows[k].kind == "exit")) {
                term = true;
                break;
            }
        }
        // Deduplicate (a duplicated intent row is itself a chain
        // anomaly: first wins, alerted, never two slots). A
        // terminal row anywhere marks the id terminal.
        bool seen = false;
        for (std::size_t k = 0; k < ids.size(); ++k) {
            if (ids[k] == rows[i].intent_id) {
                if (term) ids_term[k] = 1;
                seen = true;
                break;
            }
        }
        if (seen) {
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "recover-dup-intent", rows[i].intent_id.c_str(),
                  deps_.now_ns(deps_.clock_ctx));
            continue;
        }
        ids.push_back(rows[i].intent_id);
        ids_term.push_back(term ? 1 : 0);
    }
    for (std::size_t i = 0; i < ids.size(); ++i) {
        char rec[320];
        bool has_snap = LoadSnapshot(
            SnapPath(ids[i].c_str()).c_str(), rec, sizeof(rec));
        IntentDesc id;
        bool has_intent = LoadIntent(
            IntentPath(ids[i].c_str()).c_str(), &id);
        if (StatPath(SnapPath(ids[i].c_str()).c_str()) ==
                PathKind::CORRUPT ||
            StatPath(IntentPath(ids[i].c_str()).c_str()) ==
                PathKind::CORRUPT) {
            // Corrupt durable state is never rebuilt-over (the
            // IDLE exception below is for never-written files
            // only): human recovery.
            OpsRow("reconcile", ids[i].c_str(),
                   "snapshot-corrupt", deps_.now_ns(deps_.clock_ctx));
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "snapshot-corrupt", ids[i].c_str(),
                  deps_.now_ns(deps_.clock_ctx));
            if (reason) *reason = kSnap;
            return false;
        }
        if (ids_term[i] && (!has_snap || !has_intent)) {
            // Journal-terminal with missing durable state: the row
            // alone cannot prove the books (crash between the
            // journal write and the snapshot persist, or operator
            // deletion) — refuse for human recovery, never invent
            // a done slot from a row.
            OpsRow("reconcile", ids[i].c_str(),
                   "terminal-row-missing-snapshot",
                   deps_.now_ns(deps_.clock_ctx));
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "terminal-row-missing-snapshot",
                  ids[i].c_str(),
                  deps_.now_ns(deps_.clock_ctx));
            if (reason) *reason = kSnap;
            return false;
        }
        if (has_snap != has_intent) {
            // Half a registration cannot be driven: EITHER file
            // alone is S2/human territory (refuse loudly). The one
            // exception is the crash between the journaled intent
            // row and the first snapshot WITH the intent file
            // present — that rebuilds IDLE with the row attested
            // (nothing was ever sent: the send comes steps after
            // the first persist, so the fresh mint below is safe
            // and pre-flight dedupes it).
            if (!has_snap && has_intent) {
                if (id.qty <= 0 || id.symbol[0] == '\0') {
                    if (reason) *reason = kSnap;
                    return false;
                }
                if (slots_.size() >= (std::size_t)ExitCap())
                    break;
                Slot s;
                CopyStr(s.intent.intent_id,
                        sizeof(s.intent.intent_id), ids[i].c_str());
                CopyStr(s.intent.symbol, sizeof(s.intent.symbol),
                        id.symbol);
                s.intent.side = (id.side == 1)
                                     ? broker::OrderSide::SELL
                                     : broker::OrderSide::BUY;
                s.intent.kind = (id.kind == 1)
                                     ? jev::risk::IntentKind::EXIT
                                     : jev::risk::IntentKind::ENTRY;
                s.intent.qty_shares = id.qty;
                s.intent.stop_cents = id.stop;
                s.intent.tp_cents = id.tp;
                s.m = exec::RouteMachine();
                s.m.kind = s.intent.kind;
                s.active = true;
                s.intent_rowed = true;
                s.last_s2_ns = 0;
                slots_.push_back(s);
                continue;
            }
            if (reason) *reason = kSnap;
            return false;
        }
        if (slots_.size() >= (std::size_t)ExitCap()) break;
        Slot s;
        if (has_snap) {
            exec::RouteMachine m;
            if (!exec::RestoreMachine(rec, &m)) {
                if (reason) *reason = kSnap;
                return false;
            }
            // Recovery-terminal: CANCELLED / UNKNOWN_FROZEN /
            // CLOSED skip rebuild. PROTECTED is NOT
            // recovery-terminal (doc 06 sec. 6.1b): the runner
            // treats it as a live position everywhere else
            // (reclamation guard, flatness, netting, HARD
            // management), so a durable PROTECTED image rebuilds
            // as an active slot with its economics intact —
            // restart must not demote it to slotless.
            if (m.state == exec::RouteState::CANCELLED ||
                m.state == exec::RouteState::UNKNOWN_FROZEN ||
                m.state == exec::RouteState::CLOSED)
                continue;
            // Binding coherence: the crash image and the intent
            // file must describe the same order.
            if (std::strcmp(m.intent_id, ids[i].c_str()) != 0 ||
                std::strcmp(m.symbol, id.symbol) != 0 ||
                ((m.side == broker::OrderSide::SELL) ? 1 : 0) !=
                    id.side ||
                ((m.kind == jev::risk::IntentKind::EXIT) ? 1 : 0) !=
                    id.kind) {
                if (reason) *reason = kSnap;
                return false;
            }
            CopyStr(s.intent.intent_id, sizeof(s.intent.intent_id),
                      m.intent_id);
            CopyStr(s.intent.symbol, sizeof(s.intent.symbol), m.symbol);
            s.intent.side = m.side;
            s.intent.kind = m.kind;
            s.intent.qty_shares = id.qty;
            s.intent.stop_cents = id.stop;
            s.intent.tp_cents = id.tp;
            s.m = m;
        } else {
            // Neither crash image nor intent file under a journaled
            // intent row: half a registration (operator deleted
            // files, or disk lost them) — refuse loudly, S2/human
            // owns it. Never invent economics.
            if (reason) *reason = kSnap;
            return false;
        }
        if (s.m.state == exec::RouteState::REPAIR_SENT) {
            // The dead process may have POSTed the repair under
            // its sub-identity: re-derive it (pure function — no
            // snapshot field needed) so reconcile-first queries
            // the repair order, never the entry. Derivation
            // failure falls back to the entry id (the repair was
            // unrepresentable; the router flattens from there).
            broker::OrderSide pside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            char rcoid[65] = {0};
            if (RepairClientId(cfg_.venue.broker,
                               cfg_.venue.account,
                               cfg_.venue.context_hash,
                               s.intent.symbol, pside,
                               s.intent.intent_id, rcoid)) {
                CopyStr(s.repair_coid, sizeof(s.repair_coid),
                        rcoid);
                s.has_repair_id = true;
            }
        }
        s.active = true;
        s.last_s2_ns = 0;  // first cycle reconciles first
        if (s.m.state == exec::RouteState::SENT_UNACKED) {
            // The ack the dead process was waiting for is gone:
            // reconcile under the same id (never resend blind —
            // Dispatch pre-flights every send by stable id).
            s.query_due = true;
        }
        if (s.m.state == exec::RouteState::PARTIAL_AWAIT) {
            // The partial row may have landed before the crash:
            // re-derive coverage from the journal instead of
            // assuming (or double-writing) it.
            for (std::size_t k = 0; k < rows.size(); ++k) {
                if (rows[k].intent_id == ids[i] &&
                    (rows[k].kind == "partial" ||
                     rows[k].kind == "fill" ||
                     rows[k].kind == "cancel" ||
                     rows[k].kind == "unknown" ||
                     rows[k].kind == "exit")) {
                    s.has_journal = true;
                    s.journal_ok = true;
                    break;
                }
            }
        }
        slots_.push_back(s);
    }
    // Terminal EXIT closed quantity re-attributes AFTER entries
    // exist (slots_ was empty during the id scan, so no earlier
    // point can do it). Capped by provable open: a done-hook that
    // already ran is a no-op (leftover drops); a hook that never
    // ran folds exactly the surviving closed quantity. Misses
    // journal and retry on the next reconcile.
    for (std::size_t i = 0; i < ids.size(); ++i) {
        if (!ids_term[i]) continue;
        IntentDesc xid;
        if (!LoadIntent(IntentPath(ids[i].c_str()).c_str(),
                        &xid) ||
            xid.kind != 1 || xid.symbol[0] == '\0')
            continue;
        char xrec[320];
        exec::RouteMachine xm;
        if (!LoadSnapshot(SnapPath(ids[i].c_str()).c_str(), xrec,
                          sizeof(xrec)) ||
            !exec::RestoreMachine(xrec, &xm) ||
            xm.state != exec::RouteState::CLOSED ||
            xm.exit_closed_qty <= 0)
            continue;
        if (!AttributeClosedQty(xm.symbol[0] != '\0' ? xm.symbol
                                                 : xid.symbol,
                                xm.exit_closed_qty,
                                deps_.now_ns(deps_.clock_ctx)))
            OpsRow("reconcile", ids[i].c_str(),
                   "attribution-unpersisted",
                   deps_.now_ns(deps_.clock_ctx));
    }
    recovered_ = true;  // ownership + books established: this
                         // object alone may now mutate
    return true;
}

bool G0Runner::SubmitIntent(const exec::OrderIntent& in,
                            const char** reason) {
    static const char kBadId[] = "submit-bad-id";
    static const char kFrozen[] = "submit-frozen-symbol";
    static const char kStage[] = "submit-stage-refused";
    static const char kCap[] = "submit-slot-cap";
    static const char kDup[] = "submit-duplicate";
    static const char kGated[] = "submit-entry-gated";
    static const char kReuse[] = "submit-id-reuse";
    static const char kReg[] = "submit-already-registered";
    static const char kJournal[] = "submit-journal-broken";
    static const char kRec[] = "submit-not-recovered";
    // Lifecycle first: the constructor alone confers no
    // mutation authority (doc 06 sec. 6.1b).
    if (!recovered_ || !lock_took_) {
        if (reason) *reason = kRec;
        return false;
    }
    if (!IsSafeId(in.intent_id) || !in.symbol[0] ||
        in.qty_shares <= 0) {
        if (reason) *reason = kBadId;
        return false;
    }
    if (Find(in.intent_id)) {
        if (reason) *reason = kDup;
        return false;
    }
    bool is_exit = (in.kind == jev::risk::IntentKind::EXIT);
    // EXIT bypasses freeze + stage (old risk stays managed under
    // demotion/freeze); entries need both. Identity first in all
    // cases (no filesystem touch before the grammar passes).
    if (!is_exit) {
        if (FreezeHas(P("freeze.txt").c_str(), in.symbol)) {
            if (reason) *reason = kFrozen;
            return false;
        }
        if (!stage_ok_) {
            if (reason) *reason = kStage;
            return false;
        }
    }
    long long cap = is_exit ? ExitCap() : EntryCap();
    if ((long long)slots_.size() >= cap) {
        // One deferred sweep before refusing: completed work frees
        // capacity (long runs never wedge on history).
        ReclaimDone();
    }
    if ((long long)slots_.size() >= cap) {
        if (reason) *reason = kCap;
        return false;
    }
    if (!is_exit && !EntriesAllowedNow()) {
        if (reason) *reason = kGated;
        return false;
    }
    // Intent-id permanence: an existing record is bound forever to
    // exactly one immutable intent. Different economics under the
    // same id is refused outright; identical economics with a
    // journaled intent row is an already-registered order (refuse —
    // the row, not a resubmission, owns the lifecycle); identical
    // economics with NO journal row is a crash-retry between
    // registration and the first cycle (idempotent resume).
    std::string ipath = IntentPath(in.intent_id);
    if (StatPath(ipath.c_str()) == PathKind::CORRUPT) {
        if (reason) *reason = kReuse;
        return false;
    }
    if (FileExists(ipath.c_str())) {
        IntentDesc old;
        if (!LoadIntent(ipath.c_str(), &old)) {
            if (reason) *reason = kReuse;
            return false;
        }
        int side01 = (in.side == broker::OrderSide::BUY) ? 0 : 1;
        int kind01 = is_exit ? 1 : 0;
        if (std::strcmp(old.symbol, in.symbol) != 0 ||
            old.side != side01 || old.kind != kind01 ||
            old.qty != in.qty_shares || old.stop != in.stop_cents ||
            old.tp != in.tp_cents) {
            if (reason) *reason = kReuse;
            return false;
        }
        std::vector<journal::Row> jr;
        bool loaded = JournalLoad(P("journal.jsonl").c_str(), &jr);
        bool rowed = false;
        if (loaded) {
            for (std::size_t i = 0; i < jr.size(); ++i) {
                if (jr[i].kind == "intent" &&
                    jr[i].intent_id == in.intent_id) {
                    rowed = true;
                    break;
                }
            }
        }
        if (rowed) {
            if (reason) *reason = kReg;
            return false;
        }
        // Crash-retry: the record already holds these economics —
        // resume without rewriting it.
    } else {
        // Journal history wins: an intent file gone missing
        // (operator deletion, disk loss) does not free the id. A
        // verified historical intent row means permanently
        // registered — refuse even though the file is absent
        // (recreating it would fork one identity into two
        // lifecycles). An unverifiable journal refuses too: the
        // journal is the identity authority, and a broken chain
        // cannot prove the id is fresh.
        std::vector<journal::Row> hjr;
        if (!JournalVerifyFile(P("journal.jsonl").c_str())) {
            if (reason) *reason = kJournal;
            return false;
        }
        bool historic = false;
        if (JournalLoad(P("journal.jsonl").c_str(), &hjr)) {
            for (std::size_t i = 0; i < hjr.size(); ++i) {
                if (hjr[i].kind == "intent" &&
                    hjr[i].intent_id == in.intent_id) {
                    historic = true;
                    break;
                }
            }
        }
        if (historic) {
            if (reason) *reason = kReg;
            return false;
        }
        if (!SaveIntent(ipath.c_str(), in.symbol,
                        (in.side == broker::OrderSide::BUY) ? 0 : 1,
                        is_exit ? 1 : 0, in.qty_shares,
                        in.stop_cents, in.tp_cents)) {
            if (reason) *reason = kGated;
            return false;
        }
    }
    Slot s;
    s.intent = in;
    s.m = exec::RouteMachine();
    s.m.kind = in.kind;
    s.active = true;
    s.last_s2_ns = MonoNs(deps_.now_ns ? deps_.now_ns(deps_.clock_ctx)
                                            : 0);
    slots_.push_back(s);
    return true;
}

const Slot* G0Runner::Find(const char* intent_id) const {
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        if (slots_[i].active && SameId(slots_[i].intent.intent_id, intent_id))
            return &slots_[i];
    }
    return nullptr;
}

bool G0Runner::EntriesAllowedNow() const {
    kill::KillInputs ki;
    if (deps_.kill_inputs)
        deps_.kill_inputs(deps_.kill_ctx, &ki);
    else
        ki = kill::KillInputs();
    bool halt = HardHalted();
    if (halt) ki.halt_file = true;
    kill::LevelResult lr = kill::EvaluateLevel(ki);
    return kill::EntriesAllowed(lr.level, halt, deps_.restart_flag);
}

void G0Runner::MaybeForceQuery(Slot& s, long long now_ns) {
    if (!s.active || s.done || IsTerminalState(s.m.state)) return;
    // Failed lookups refresh on the next due trigger (a stale
    // failure must never block fresh reconciliation); a good held
    // answer is never stacked.
    if (s.has_forced_q && s.forced_q.transport_ok) return;
    // S2 cadence + reconcile-first (last_s2_ns = 0 at Recover):
    // one real lookup now, held until the machine consumes it.
    // Event/timer-driven only — never a polling loop (the router
    // budget still bounds router-emitted QUERY_ONCE). Elapsed on
    // the monotonic clock: wall jumps never force/skip lookups.
    long long mono = MonoNs(now_ns);
    bool due = (mono - s.last_s2_ns) >=
               deps_.s2_seconds * 1000000000LL;
    if (!due) return;
    s.forced_q = adapter_.QueryOnce(LookupIdFor(s));
    s.has_forced_q = true;
    s.last_s2_ns = mono;
}

long long G0Runner::MediumEpoch() const {
    // Current MEDIUM incident epoch, or 0 when no incident is on
    // file ( >> mint at medium-enter). Crash-safe by construction:
    // the file outlives the process, so a mid-incident restart
    // reuses the epoch and every sweep id stays stable.
    std::vector<std::string> lns;
    if (!ReadLines(P("medium-incident.txt").c_str(), &lns))
        return 0;  // missing = no incident
    return ParseEpoch(lns);
}
long long G0Runner::MintMediumEpoch(long long now_ns) {
    // A medium-enter IS a new incident by definition (the FSM file
    // was empty/corrupt — a crash mid-incident keeps it, so it
    // never re-enters). Overwrite unconditionally; clock-stuck
    // guard keeps epochs monotonic so ids never repeat.
    // Durable-or-nothing: no persisted epoch file, no new
    // incident identity (a crash before the write lands must
    // restart into the same re-mint, never into ids minted from
    // an epoch the restart cannot recover). Failure returns 0
    // (never a valid epoch); the caller reverts the FSM so the
    // next cycle retries the mint.
    long long old = MediumEpoch();
    long long e = 0;
    if (now_ns > old) {
        e = now_ns;
    } else if (old >= LLONG_MAX) {
        OpsRow("demotion", "runner",
               "medium-epoch-overflow", now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-epoch-overflow", "", now_ns);
        return 0;
    } else {
        e = old + 1;
    }
    char eb[32];
    std::snprintf(eb, sizeof(eb), "%lld", e);
    if (!AtomicWrite(P("medium-incident.txt").c_str(), eb)) {
        OpsRow("demotion", "runner",
               "medium-epoch-unpersisted", now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-epoch-unpersisted", "", now_ns);
        return 0;
    }
    char tb[280];
    std::snprintf(tb, sizeof(tb), "medium-enter epoch=%lld", e);
    OpsRow("demotion", "runner", tb, now_ns);
    if (old > 0) {
        std::snprintf(tb, sizeof(tb),
                        "medium-incident-superseded old=%lld new=%lld",
                        old, e);
        OpsRow("demotion", "runner", tb, now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-incident-superseded", tb, now_ns);
    }
    return e;
}
long long G0Runner::HardEpochFor(long long now_ns,
                                 const char* reason,
                                 bool halt_at_entry) {
    // Crash-mid-HARD keeps HALT (written first in HardStop), so a
    // restart with HALT present is the SAME incident: reuse, or the
    // in-flight closes double under fresh ids. Clearing HALT ends
    // the incident (a human owns the interim); a re-firing HARD is
    // new by definition. Clock-stuck guard as above.
    // Unrecoverable incident: HALT present at entry but the epoch
    // file missing/corrupt/unreadable means the incident identity
    // cannot be resumed — minting fresh ids would double the
    // in-flight closes the HALT exists to protect. Refuse (0) so
    // the stop path halts without sending under a new identity.
    std::vector<std::string> lns;
    long long old = 0;
    bool have_incident = ReadLines(P("hard-incident.txt").c_str(),
                                   &lns);
    if (have_incident) old = ParseEpoch(lns);
    if (halt_at_entry && (!have_incident || old <= 0)) {
        OpsRow("drift-directive", "runner",
               "hard-epoch-unrecoverable", now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "hard-epoch-unrecoverable",
              reason ? reason : "", now_ns);
        return 0;
    }
    if (old > 0 && halt_at_entry) {
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "hard-incident-resume epoch=%lld", old);
        OpsRow("drift-directive", "runner", tb, now_ns);
        return old;
    }
    long long e = 0;
    if (now_ns > old) {
        e = now_ns;
    } else if (old >= LLONG_MAX) {
        OpsRow("drift-directive", "runner",
               "hard-epoch-overflow", now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "hard-epoch-overflow", "", now_ns);
        return 0;
    } else {
        e = old + 1;
    }
    char eb[128];
    std::snprintf(eb, sizeof(eb), "%lld\n%.100s", e,
                  reason ? reason : "");
    if (!AtomicWrite(P("hard-incident.txt").c_str(), eb)) {
        OpsRow("drift-directive", "runner",
               "hard-epoch-unpersisted", now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "hard-epoch-unpersisted", "", now_ns);
        return 0;
    }
    char tb[280];
    std::snprintf(tb, sizeof(tb),
                    "hard-incident-enter epoch=%lld", e);
    OpsRow("drift-directive", "runner", tb, now_ns);
    if (old > 0) {
        std::snprintf(tb, sizeof(tb),
                        "hard-incident-superseded old=%lld new=%lld",
                        old, e);
        OpsRow("drift-directive", "runner", tb, now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "hard-incident-superseded", tb, now_ns);
    }
    return e;
}
bool G0Runner::LocalCloseCovers(const char* symbol) const {
    // A symbol is locally covered while an active non-terminal
    // EXIT/flatten works it, or an ENTRY's flatten is armed (issued
    // or waited-on) or landed (terminal close on file). Frozen
    // symbols (incoherent local state — no EXIT can ever appear)
    // are NOT covered: the incident sweep owns those.
    if (!symbol || !symbol[0]) return false;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active || s.done) continue;
        if (std::strcmp(s.intent.symbol, symbol) != 0) continue;
        if (s.intent.kind == jev::risk::IntentKind::EXIT) {
            if (!IsTerminalState(s.m.state)) return true;
            continue;
        }
        if (s.intent.kind != jev::risk::IntentKind::ENTRY)
            continue;
        if (s.m.filled_qty - s.m.exit_closed_qty <= 0) continue;
        if (s.flatten_armed) return true;
        std::string fid =
            std::string(s.intent.intent_id) + "-flatten";
        if (Find(fid.c_str())) return true;
        if (JournalIntentState(cfg_.dir, fid.c_str()) == 2) {
            // Terminal row on file: landed-closed (entry attributed)
            // stays covered; an OPEN entry beside one means the
            // flatten died non-closed — the sweep owns the rest.
            if (s.m.filled_qty - s.m.exit_closed_qty <= 0)
                return true;
            continue;
        }
    }
    return false;
}
bool G0Runner::FlattenResolvedNotClosed(const Slot& s) const {
    std::string fid = std::string(s.intent.intent_id) + "-flatten";
    const Slot* fs = Find(fid.c_str());
    if (!fs || !fs->done) return false;
    return fs->m.state != exec::RouteState::CLOSED;
}
int G0Runner::CollectCoverExits(const char* symbol,
                                 std::vector<std::size_t>* idx,
                                 long long* total) {
    // Every active non-terminal EXIT on the symbol (indices +
    // summed intent-minus-closed, floored at 0). Callers
    // reconcile EACH one — first-only sampling let a dead first
    // exit mask a live second.
    long long tot = 0;
    int n = 0;
    if (idx) idx->clear();
    if (symbol && symbol[0]) {
        for (std::size_t i = 0; i < slots_.size(); ++i) {
            const Slot& s = slots_[i];
            if (!s.active || s.done) continue;
            if (s.intent.kind != jev::risk::IntentKind::EXIT)
                continue;
            if (IsTerminalState(s.m.state)) continue;
            if (std::strcmp(s.intent.symbol, symbol) != 0)
                continue;
            if (s.m.client_id[0] == '\0') continue;
            long long rem =
                s.intent.qty_shares - s.m.exit_closed_qty;
            if (rem > 0) {
                tot += rem;
                if (idx) idx->push_back(i);
                ++n;
            }
        }
    }
    if (total) *total = tot;
    return n;
}
int G0Runner::EntryCap() const {
    // One validated capacity: the fixed architecture limit is 64
    // live entries (exits run at 2x so risk never wedges behind
    // entry capacity). Larger configured values clamp — the *2
    // arithmetic below cannot overflow and fixed scratch tables
    // cannot be over-indexed. Non-positive falls back to 16 (the
    // historic default), matching prior behavior exactly.
    if (cfg_.max_slots < 1) return 16;
    if (cfg_.max_slots > 64) return 64;
    return (int)cfg_.max_slots;
}
int G0Runner::ExitCap() const {
    return EntryCap() * 2;  // <= 128: plain int math, no overflow
}
long long G0Runner::MonoNs(long long wall_ns) const {
    if (deps_.mono_ns) return deps_.mono_ns(deps_.mono_ctx);
    return wall_ns;
}
static long long MyPid() {
#ifdef _WIN32
    return (long long)GetCurrentProcessId();
#else
    return (long long)getpid();
#endif
}
bool PidAlive(long long pid) {
    if (pid <= 0) return false;
#ifdef _WIN32
    if (pid > 4294967295LL) return false;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,
                           FALSE, (DWORD)pid);
    if (h == NULL) return false;
    DWORD ec = 0;
    bool ok =
        GetExitCodeProcess(h, &ec) != FALSE && ec == STILL_ACTIVE;
    CloseHandle(h);
    return ok;
#else
    if (pid > 2147483647LL) return false;
    if (::kill((pid_t)pid, 0) == 0) return true;
    return errno == EPERM;  // exists but no permission to signal
#endif
}
namespace {
// Per-thread directory holds: the OS handle (fd /
// HANDLE-as-integer) plus the owning live instance. At most
// ONE live object per directory per thread: the same object
// re-acquiring is idempotent (tracked by its own lock_took_),
// while a SECOND live object is refused — two independent
// state machines must never share one ownership token (their
// separate next_seq_/prev_hash_/slots_ would fork the
// journal). Thread-local: no shared state, no mutex — the
// kernel primitive stays the sole cross-thread arbiter, so a
// concurrent two-taker race genuinely contends on it.
struct DirHold {
    std::string path;
    const void* owner;  // live G0Runner holding this path
    long long os;
};
thread_local std::vector<DirHold> g_dir_holds;
}  // namespace
bool G0Runner::TakeDirLock() {
    // One live runner per state directory (Phase-4 prerequisite).
    // The mutual-exclusion mechanism is an OS process-lifetime
    // ownership primitive (doc 06 sec. 6.1b) — flock(LOCK_EX|NB)
    // on POSIX, an exclusive no-share open handle on Windows —
    // acquired once per winning instance and held open while
    // it lives (the open fd/handle IS the lock). Read sharing
    // stays open (diagnostic PID reads always work); WRITE is
    // never shared, so a second contender's exclusive open is
    // denied while we live. A dead holder releases it in the
    // kernel, so stale takeover has no
    // check-then-act window: two concurrent takers serialize in
    // the kernel into exactly one owner. The PID file is
    // diagnostic only (owner identity for alerts, written through
    // the held handle after winning) — never the arbiter.
    // Same-object re-entry is idempotent (repeated Recover on
    // the live owner); a SECOND live object on the same thread
    // is refused below — one live mutable runner per directory.
    // A different thread contends like a foreign process
    // and loses. Holds are tracked per thread (no shared state,
    // no mutex: the kernel primitive stays the sole arbiter, so
    // a concurrent two-taker race genuinely contends on it).
    // The winning INSTANCE owns the hold (members below): its
    // destructor closes the handle and unregisters it, so holds
    // never leak and a later instance re-acquires
    // through the kernel. Live instances keep the OS primitive
    // open — one writer per directory holds while any instance
    // of this process is alive on it.
    if (lock_took_) return true;  // same object: idempotent
    std::string lp = P("runner.lock");
    for (std::size_t i = 0; i < g_dir_holds.size(); ++i) {
        if (g_dir_holds[i].path == lp) {
            // A second live object for the same directory
            // (same thread) is refused with diagnostics to
            // stderr only — no shared-state writes before
            // ownership, like any other lock refusal.
            std::fprintf(stderr,
                           "g0_runner: second live runner dir=%s\n",
                           lp.c_str());
            return false;
        }
    }
    char b[32];
    int w = std::snprintf(b, sizeof(b), "%lld", MyPid());
    if (w <= 0) return false;
    std::size_t n = std::strlen(b);
#ifdef _WIN32
    HANDLE h = CreateFileA(lp.c_str(), GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ, NULL, OPEN_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
#else
    int fd = ::open(lp.c_str(), O_CREAT | O_RDWR, 0600);
    if (fd < 0 || ::flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (fd >= 0) ::close(fd);
#endif
        std::vector<std::string> lns;
        std::string holder = "?";
        if (ReadLines(lp.c_str(), &lns) && !lns.empty() &&
            !lns[0].empty())
            holder = lns[0];
        // Refusal mutates NO shared state (doc 06 sec. 6.1b):
        // no journal row (a contender's fresh next_seq_/genesis
        // would fork an owned chain), no alert write, no file
        // touch. Diagnostics go to stderr only — the supervisor
        // owns them. Once ownership is established, normal
        // journal/alert writes are allowed.
        std::fprintf(stderr,
                       "g0_runner: lock refused dir=%s holder=%s\n",
                       lp.c_str(), holder.c_str());
        return false;
    }
    // Won: stamp our PID through the held handle (diagnostic)
    // and register one reference under this instance.
#ifdef _WIN32
    SetFilePointer(h, 0, NULL, FILE_BEGIN);
    DWORD done = 0;
    WriteFile(h, b, (DWORD)n, &done, NULL);
    SetEndOfFile(h);
    long long os = (long long)(intptr_t)h;
#else
    (void)::ftruncate(fd, 0);
    (void)::write(fd, b, n);
    long long os = (long long)fd;
#endif
    DirHold hd;
    hd.path = lp;
    hd.owner = this;
    hd.os = os;
    g_dir_holds.push_back(hd);
    lock_took_ = true;
    lock_path_ = lp;
    return true;
}
G0Runner::~G0Runner() {
    if (!lock_took_) return;
    lock_took_ = false;
    for (std::size_t i = 0; i < g_dir_holds.size(); ++i) {
        if (g_dir_holds[i].path == lock_path_ &&
            g_dir_holds[i].owner == this) {
            long long os = g_dir_holds[i].os;
            g_dir_holds.erase(g_dir_holds.begin() + (int)i);
#ifdef _WIN32
            CloseHandle((HANDLE)(intptr_t)os);
#else
            ::close((int)os);
#endif
            return;
        }
    }
}
bool G0Runner::SnapPositions(Position* ps, int cap,
                             int* n) const {
    if (n) *n = 0;
    if (!ps || cap <= 0 || !n) return false;
    if (!deps_.list_positions) return false;
    int got = deps_.list_positions(deps_.positions_ctx, ps, cap);
    // Seam contract: 0 <= n <= cap. A violating adapter (65,
    // 100, ...) must never drive an over-read of the fixed
    // buffer — treat as unavailable, exactly like a lookup
    // failure.
    if (got < 0 || got > cap) return false;
    // Row contract: every row NUL-terminated within its fixed
    // field, non-empty symbol, qty inside the share domain (this
    // also excludes LLONG_MIN, whose negation overflows), no
    // duplicate symbols (ambiguous — silently picking one side
    // would invent economics). Any violation invalidates the
    // WHOLE snapshot: unknown, never partial trust.
    for (int i = 0; i < got; ++i) {
        bool term = false;
        for (std::size_t b = 0; b < sizeof(ps[i].symbol); ++b) {
            if (ps[i].symbol[b] == '\0') {
                term = true;
                break;
            }
        }
        if (!term || ps[i].symbol[0] == '\0') return false;
        if (ps[i].qty == LLONG_MIN ||
            ps[i].qty < -999999999LL || ps[i].qty > 999999999LL)
            return false;
    }
    for (int i = 0; i < got; ++i) {
        for (int j = i + 1; j < got; ++j) {
            if (std::strncmp(ps[i].symbol, ps[j].symbol,
                             sizeof(ps[i].symbol)) == 0)
                return false;
        }
    }
    *n = got;
    return true;
}
bool G0Runner::BrokerQty(const char* symbol, long long* out) {
    // Signed broker position for one symbol. False = no seam or
    // failing endpoint (callers fall back + journal; unknown is
    // never flat).
    if (out) *out = 0;
    if (!symbol || !symbol[0] || !out) return false;
    Position ps[64];
    int n = 0;
    if (!SnapPositions(ps, 64, &n)) return false;
    long long q = 0;
    for (int i = 0; i < n; ++i) {
        if (ps[i].symbol[0] == '\0') continue;
        if (std::strcmp(ps[i].symbol, symbol) != 0) continue;
        q += ps[i].qty;
    }
    *out = q;
    return true;
}
std::string G0Runner::HardRemainderTag(long long epoch,
                                        const char* symbol,
                                        long long rem) {
    char tb[64];
    std::snprintf(tb, sizeof(tb), "hard-%lld-%.15s-%lld",
                    epoch, symbol ? symbol : "", rem);
    return std::string(tb);
}
bool G0Runner::MediumHasExposure() {
    // Local ENTRY open, or any broker position. Missing or
    // failing seam counts as exposure (fail closed: never clear
    // an incident that cannot be seen — doc 06 sec. 6.1b).
    if (!LocalFlat()) return true;
    Position ps[64];
    int n = 0;
    if (!SnapPositions(ps, 64, &n)) return true;
    for (int i = 0; i < n; ++i) {
        if (ps[i].symbol[0] != '\0' && ps[i].qty != 0)
            return true;
    }
    return false;
}
bool G0Runner::LocalFlat() {
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY)
            continue;
        if (s.m.state == exec::RouteState::CANCELLED ||
            s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
            s.m.state == exec::RouteState::CLOSED)
            continue;
        if (s.m.filled_qty - s.m.exit_closed_qty > 0)
            return false;
    }
    return true;
}
bool G0Runner::BrokerConfirmedFlat() {
    // Teardown certification (doc 06 sec. 6.1b): seam present +
    // query ok + every position zero. Anything else is UNKNOWN
    // (false) — AllFlat() alone never certifies an incident over.
    Position ps[64];
    int n = 0;
    if (!SnapPositions(ps, 64, &n)) return false;
    for (int i = 0; i < n; ++i) {
        if (ps[i].symbol[0] != '\0' && ps[i].qty != 0)
            return false;
    }
    return true;
}
bool G0Runner::ClearMediumFiles() {
    // Teardown cleanup is load-bearing: both clears must land for
    // the incident to be over. False keeps the incident files for
    // the next cycle (plus caller alert) — never a half-cleared
    // incident that mints fresh over stale state.
    bool a = AtomicWrite(P("medium.txt").c_str(), "");
    bool b = AtomicWrite(P("medium-incident.txt").c_str(), "");
    return a && b;
}
void G0Runner::NoteQuarantine(Slot& s, const broker::OrderQuery& q,
                              const char* scope, long long now_ns) {
    // Doc-06-locked quarantine: the id is burned (never re-sent),
    // the qty is authoritative-for-today but never folded, the
    // machine waits on UNKNOWN. First sighting per slot per status
    // freezes the symbol + journals + alerts; repeats stay silent.
    if (!IsQuarantineStatus(q.status_raw)) return;
    if (std::strcmp(s.quar_, q.status_raw) == 0) return;
    CopyStr(s.quar_, sizeof(s.quar_), q.status_raw);
    FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
    char tb[280];
    std::snprintf(tb, sizeof(tb),
                    "quarantine id=%s status=%.31s filled=%lld",
                    s.intent.intent_id, q.status_raw,
                    (long long)q.filled_qty);
    OpsRow("reconcile", s.intent.intent_id, tb, now_ns);
    Alert(P("alerts.jsonl").c_str(), scope ? scope : "S2",
          "quarantine", tb, now_ns);
}
void G0Runner::NoteQuarantineSym(const char* symbol,
                                 const char* status,
                                 const char* scope,
                                 long long now_ns) {
    // Slotless paths (sweep/hard-position pre-flights) have no
    // slot guard; incidents are rare, so every sighting rows.
    if (!IsQuarantineStatus(status)) return;
    if (symbol && symbol[0])
        FreezeAdd(P("freeze.txt").c_str(), symbol);
    char tb[280];
    std::snprintf(tb, sizeof(tb),
                    "quarantine sym=%.15s status=%.31s",
                    symbol ? symbol : "", status ? status : "");
    OpsRow("reconcile", "runner", tb, now_ns);
    Alert(P("alerts.jsonl").c_str(), scope ? scope : "S2",
          "quarantine", tb, now_ns);
}
bool G0Runner::SweepLiveBlocks(const char* symbol,
                               broker::OrderSide local_close_side,
                               long long epoch) {
    // The incident sweep already owns this symbol when its close
    // is live under either side-tag (books can disagree mid-drift;
    // the local-implied side is checked first). Live = found +
    // PENDING/PARTIAL/UNKNOWN (working or ambiguous — never a
    // competing local close), or FILLED-short (still resolving).
    // Transport failure = do NOT block (retry next cycle; a stale
    // failure must never park the local path forever).
    if (!symbol || !symbol[0] || epoch <= 0) return false;
    broker::OrderSide sides[2] = {
        local_close_side,
        (local_close_side == broker::OrderSide::BUY)
            ? broker::OrderSide::SELL
            : broker::OrderSide::BUY};
    for (int k = 0; k < 2; ++k) {
        char hcoid[65] = {0};
        if (!broker::MakeClientOrderId(
                cfg_.venue.broker, cfg_.venue.account,
                cfg_.venue.context_hash, symbol, sides[k],
                SweepTag(epoch, symbol).c_str(), hcoid))
            continue;
        broker::OrderQuery pre = adapter_.QueryOnce(hcoid);
        if (!pre.transport_ok) continue;
        if (!pre.found) continue;
        broker::CloseResult c = QueryToClose(pre);
        if (c.state == broker::CloseState::PENDING ||
            c.state == broker::CloseState::PARTIAL ||
            c.state == broker::CloseState::UNKNOWN)
            return true;
        if (c.state == broker::CloseState::FILLED &&
            c.filled_qty > 0)
            return true;  // resolving: attribution lands it
    }
    return false;
}
bool G0Runner::FlattenOnMedium(Slot& s, long long now_ns) {
    if (!s.active || s.done) return true;
    if (s.intent.kind != jev::risk::IntentKind::ENTRY) return true;
    if (IsTerminalState(s.m.state)) return true;
    if (s.m.filled_qty <= 0) return true;  // nothing to flatten
    if (s.flatten_armed && !FlattenResolvedNotClosed(s))
        return true;
    // A flatten that resolved NON-closed hands ownership back to
    // the incident sweep (fall through UNarmed): re-arm is
    // forbidden — the intent id is single-use, so only the sweep
    // id can carry the next close. Quiet-closed stays armed above.
    s.flatten_armed = false;
    // Restart coherence: a flatten EXIT from the dead process may
    // already exist (pre-flight dedupe makes its drive safe) —
    // never order a second one.
    std::string fid0 = std::string(s.intent.intent_id) + "-flatten";
    if (fid0.size() > 64) {
        // No representable flatten id: freeze the symbol + alert
        // (a human owns the position; never a blind submit).
        FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "flatten-id-long",
              s.intent.intent_id, now_ns);
        return true;
    }
    if (Find(fid0.c_str())) {
        s.flatten_armed = true;
        return true;
    }
    // A terminally-closed flatten needs no resubmit even when its
    // slot is gone (done slots will reclaim); an intent row with no
    // terminal and no slot is incoherent -> freeze, never resubmit.
    // Landed-closed (entry fully attributed) stays quiet; an OPEN
    // entry beside a terminal row means the flatten died non-closed
    // with its slot already reclaimed — return UNarmed so the
    // incident sweep owns the rest (arming here would defer the
    // sweep back to us forever).
    int js = JournalIntentState(cfg_.dir, fid0.c_str());
    if (js == 2) {
        if (s.m.filled_qty - s.m.exit_closed_qty <= 0) {
            s.flatten_armed = true;
        }
        return true;
    }
    if (js == 1) {
        FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "flatten-orphan", s.intent.intent_id, now_ns);
        return true;
    }
    // Single-owner gate (doc 06 sec. 6.1b): when the incident
    // sweep already owns this symbol, arm and wait — submitting a
    // local flatten now would stack a second close on the live
    // sweep. Attribution zeroes the entry when the sweep lands.
    // Transport failure does NOT block (a stale failure must never
    // park the local path — retry next cycle).
    broker::OrderSide cside =
        (s.intent.side == broker::OrderSide::BUY)
            ? broker::OrderSide::SELL
            : broker::OrderSide::BUY;
    long long epoch = MediumEpoch();
    if (epoch > 0 &&
        SweepLiveBlocks(s.intent.symbol, cside, epoch)) {
        s.flatten_armed = true;
        return true;
    }
    // Recovery-only flatten: EXIT for the filled qty under the
    // derived id (length + pre-existence already gated via fid0).
    exec::OrderIntent ex = s.intent;
    ex.kind = jev::risk::IntentKind::EXIT;
    ex.qty_shares = s.m.filled_qty;
    CopyStr(ex.intent_id, sizeof(ex.intent_id), fid0.c_str());
    ex.intent_id[64] = '\0';
    const char* rs = nullptr;
    if (!SubmitIntent(ex, &rs)) {
        FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
        return true;
    }
    s.flatten_armed = true;
    return true;
}

bool G0Runner::OpsRow(const char* kind, const char* intent_id,
                    const char* text, long long now_ns) {
    if (!kind || !intent_id || !text || now_ns <= 0) return false;
    if (!journal::IsKnownKind(kind)) return false;
    char body[280];
    int w = std::snprintf(body, sizeof(body), "%.200s", text);
    if (w <= 0 || !jev::journal::RedactionOk(body)) return false;
    return JournalWrite(kind, intent_id, body, now_ns);
}

namespace {
// Strict whole-file scan of hard-chain.txt: every row must be
// `<tag> <requested> <attributed>` with requested > 0 and
// 0 <= attributed <= requested; requested per tag is immutable;
// attributed per tag is monotonically nondecreasing
// (exact-duplicate rows are idempotent crash-retry evidence, not
// conflicts). Blank/trailing-garbage/conflicting/regressed rows
// all fail. When tag != nullptr, *req_out/*attr_out take that
// tag's stable requested + last attributed (false when the tag
// carries no row). The file is tiny (truncated at incident end)
// so a capped linear table is exact, never allocating hot-path
// memory beyond it.
// Strict chain row: `<tag> <requested> <attributed>\0` with
// single SPACE separators, tag 1..64 non-space chars, numbers
// strict decimal with reject-before-overflow conversion (never
// scanf-family conversion on persisted numeric text — its
// overflow behavior is implementation-defined). The writer
// (NoteHardChain) emits exactly this shape, so strictness costs
// nothing and any foreign/hand-edited row fails validation.
bool ParseChainRow(const char* ln, char t[65], long long* r,
                   long long* a) {
    if (!ln || !t || !r || !a) return false;
    std::size_t i = 0, ti = 0;
    while (ln[i] != '\0' && ln[i] != ' ') {
        if (ti >= 64) return false;
        t[ti++] = ln[i++];
    }
    if (ti == 0 || ln[i] != ' ') return false;
    t[ti] = '\0';
    ++i;
    long long rv = 0, av = 0;
    bool dig = false;
    while (ln[i] >= '0' && ln[i] <= '9') {
        dig = true;
        int dgt = ln[i] - '0';
        if (rv > (LLONG_MAX - dgt) / 10) return false;
        rv = rv * 10 + dgt;
        ++i;
    }
    if (!dig || ln[i] != ' ') return false;
    ++i;
    dig = false;
    while (ln[i] >= '0' && ln[i] <= '9') {
        dig = true;
        int dgt = ln[i] - '0';
        if (av > (LLONG_MAX - dgt) / 10) return false;
        av = av * 10 + dgt;
        ++i;
    }
    if (!dig || ln[i] != '\0') return false;
    *r = rv;
    *a = av;
    return true;
}
bool ScanChain(const std::vector<std::string>& lns,
               const char* tag, long long* req_out,
               long long* attr_out) {
    struct Seen {
        char t[65];
        long long req;
        long long attr;
    };
    Seen seen[64];
    std::size_t nseen = 0;
    bool have = false;
    long long treq = 0, tattr = 0;
    for (std::size_t i = 0; i < lns.size(); ++i) {
        char t[65] = {0};
        long long r = 0, a = 0;
        if (!ParseChainRow(lns[i].c_str(), t, &r, &a) ||
            t[0] == '\0' || r <= 0 || a < 0 || a > r)
            return false;
        std::size_t k = 0;
        while (k < nseen &&
               std::strcmp(seen[k].t, t) != 0)
            ++k;
        if (k < nseen) {
            if (seen[k].req != r) return false;  // conflict
            if (a < seen[k].attr) return false;  // regression
            seen[k].attr = a;
        } else {
            if (nseen >= 64) return false;  // absurd: refuse
            std::memcpy(seen[nseen].t, t, sizeof(seen[nseen].t));
            seen[nseen].req = r;
            seen[nseen].attr = a;
            ++nseen;
        }
        if (tag && std::strcmp(t, tag) == 0) {
            have = true;
            treq = r;
            tattr = a;
        }
    }
    if (tag) {
        if (!have) return false;
        if (req_out) *req_out = treq;
        if (attr_out) *attr_out = tattr;
    }
    return true;
}
}  // namespace

bool G0Runner::HardChainOk() {
    std::vector<std::string> lns;
    std::string p = P("hard-chain.txt");
    // 64 KiB envelope: the chain is incident-scoped and tiny by
    // construction — oversized input refuses before rows
    // materialize (fail closed downstream: invalid chain).
    PathKind ck = StatPath(p.c_str());
    if (ck == PathKind::ABSENT) return true;  // missing = valid-empty
    if (ck != PathKind::REGULAR) return false;  // corrupt: invalid
    if (!ReadLinesCapped(p.c_str(), &lns, 65536)) return false;
    return ScanChain(lns, nullptr, nullptr, nullptr);
}
bool G0Runner::HardChainState(const char* tag, long long* req,
                              long long* attr) {
    if (!tag || !tag[0]) return false;
    std::vector<std::string> lns;
    std::string p = P("hard-chain.txt");
    if (!ReadLinesCapped(p.c_str(), &lns, 65536))
        return false;  // missing/unreadable/oversized can never
                       // vouch
    return ScanChain(lns, tag, req, attr);
}
bool G0Runner::NoteHardChain(const char* tag, long long requested,
                             long long attributed) {
    if (!tag || !tag[0] || requested <= 0) return false;
    if (attributed < 0) attributed = 0;
    if (attributed > requested) return false;
    char ln[160];
    std::snprintf(ln, sizeof(ln), "%s %lld %lld", tag,
                    requested, attributed);
    return AppendLine(P("hard-chain.txt").c_str(), ln);
}
bool G0Runner::HardCloseOnce(const char* symbol, long long qty,
                           broker::OrderSide eside, const char* hid,
                           long long epoch,
                           const char* scope_intent,
                           long long now_ns) {
    // Pre-flighted single close under a stable hard id, with a
    // deterministic incident remainder chain (doc 06 sec. 6.1b):
    // the remainder derives from the ORIGINAL chain request
    // (hard-chain.txt, write-ahead) — never by subtracting a
    // burned order's historical fill from a CURRENT broker number
    // (settled fills are gone from the broker; re-subtracting
    // them under-closes). The broker need caps each send
    // (min(remainder, need); zero need sends nothing). Per-id
    // attribution folds only the not-yet-attributed portion
    // (chain-guarded, exact across restart). GET ->
    // found-sufficient (filled >= need): adopt -> found-live:
    // adopt, the working order owns the qty -> found-short-
    // terminal: mint hard-<epoch>-<SYM>-<remaining> and
    // pre-flight THAT -> 404: POST once -> failure: journal +
    // alert, fail closed. Chain-satisfied yet broker-open alerts
    // (drift owns it — no second incident identity). Capped:
    // exhaustion freezes. Every hard path shares it, including
    // EXIT replacement.
    if (!symbol || !symbol[0] || qty <= 0 || epoch <= 0) {
        OpsRow("drift-directive",
               scope_intent ? scope_intent : "runner",
               "hard-close refused bad-args", now_ns);
        return false;
    }
    // Integrity gate FIRST (before any broker interrogation): a
    // present-but-invalid chain refuses every HARD send. Missing
    // file is valid-empty (first incident); the per-id check
    // below still vouches each broker-known id.
    if (!HardChainOk()) {
        OpsRow("drift-directive",
               scope_intent ? scope_intent : "runner",
               "hard-chain-invalid", now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "hard-chain-invalid",
              scope_intent ? scope_intent : "", now_ns);
        FreezeAdd(P("freeze.txt").c_str(), symbol);
        return false;
    }
    std::string id = hid ? hid : "";
    long long need = qty;
    // Logical remainder vs broker-capped send: the chain identity
    // owns the LOGICAL quantity (what this incident must still
    // close); each POST sends min(logical, current broker need).
    // A stranded partial send converges by re-pre-flight under
    // the SAME identity — never a second identity for one
    // remainder, never a broker-capped request recorded as truth.
    long long logical = qty;
    for (int round = 0; round < 4; ++round) {
        char hcoid[65] = {0};
        if (id.empty() || !broker::MakeClientOrderId(
                                 cfg_.venue.broker,
                                 cfg_.venue.account,
                                 cfg_.venue.context_hash, symbol,
                                 eside, id.c_str(), hcoid)) {
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner",
                   "hard-close id-unrepresentable", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-close-no-id",
                  scope_intent ? scope_intent : "", now_ns);
            return false;
        }
        broker::OrderQuery pre = adapter_.QueryOnce(hcoid);
        if (!pre.transport_ok) {
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner",
                   "hard-close lookup-failed", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-close-unknown",
                  scope_intent ? scope_intent : "", now_ns);
            return false;
        }
        NoteQuarantineSym(symbol, pre.status_raw, "HARD",
                          now_ns);
        if (!pre.found) {
            // Write-ahead ENFORCED: the chain owns this request
            // before the POST flies. The recorded request is the
            // LOGICAL remainder — never the broker-capped send.
            // An existing tag reuses its recorded request (chain
            // truth is immutable): at most an exact-duplicate row
            // is appended as crash-retry evidence, never a
            // conflicting request. A failed note freezes + refuses.
            // BURNED identity (doc 06 sec. 6.1b): a 404 on an id
            // whose chain row already carries attributed fills
            // means the broker settled/purged it — the tag is
            // single-use and must NEVER POST again. Transition to
            // the remainder identity (rem = requested -
            // attributed; rem <= 0 refuses with the
            // chain-satisfied alert) and pre-flight THAT; the
            // burned row keeps its immutable original request.
            long long req = 0, attr = 0;
            bool have = HardChainState(id.c_str(), &req, &attr);
            if (have && attr > 0) {
                long long rem = req - attr;
                if (rem <= 0) {
                    OpsRow("drift-directive",
                           scope_intent ? scope_intent : "runner",
                           "hard-chain-satisfied-broker-open",
                           now_ns);
                    Alert(P("alerts.jsonl").c_str(), "HARD",
                          "hard-chain-satisfied-broker-open",
                          scope_intent ? scope_intent : "", now_ns);
                    return false;
                }
                std::string id2 =
                    HardRemainderTag(epoch, symbol, rem);
                if (id2 == id) {
                    OpsRow("drift-directive",
                           scope_intent ? scope_intent : "runner",
                           "hard-close remainder-stuck", now_ns);
                    FreezeAdd(P("freeze.txt").c_str(), symbol);
                    return false;
                }
                char bb[280];
                std::snprintf(bb, sizeof(bb),
                                "hard-close burned %s -> %s "
                                "chain=%lld attributed=%lld",
                                id.c_str(), id2.c_str(), req,
                                attr);
                OpsRow("drift-directive",
                       scope_intent ? scope_intent : "runner", bb,
                       now_ns);
                id = id2;
                need = (rem < need) ? rem : need;
                logical = rem;
                continue;  // pre-flight the remainder identity
            }
            if (!have) {
                req = logical;
                if (!NoteHardChain(id.c_str(), req, 0)) {
                    OpsRow("drift-directive",
                           scope_intent ? scope_intent : "runner",
                           "hard-chain-unwritable", now_ns);
                    Alert(P("alerts.jsonl").c_str(), "HARD",
                          "hard-chain-unwritable",
                          scope_intent ? scope_intent : "", now_ns);
                    FreezeAdd(P("freeze.txt").c_str(), symbol);
                    return false;
                }
            } else if (attr == 0 && req == logical) {
                // Crash-retry evidence only: the exact row already
                // on file is re-noted (idempotent duplicate), so a
                // note-then-POST-fail restart leaves the same
                // proof it would have left before.
                if (!NoteHardChain(id.c_str(), req, 0)) {
                    OpsRow("drift-directive",
                           scope_intent ? scope_intent : "runner",
                           "hard-chain-unwritable", now_ns);
                    Alert(P("alerts.jsonl").c_str(), "HARD",
                          "hard-chain-unwritable",
                          scope_intent ? scope_intent : "", now_ns);
                    FreezeAdd(P("freeze.txt").c_str(), symbol);
                    return false;
                }
            }
            long long send = (req < need) ? req : need;
            broker::CloseResult c =
                adapter_.MarketClose(symbol, send, eside, hcoid);
            char tb[280];
            std::snprintf(tb, sizeof(tb),
                            "hard-close id=%s sent=%d "
                            "logical=%lld qty=%lld",
                            id.c_str(),
                            c.transport_ok ? 1 : 0, req, send);
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner", tb,
                   now_ns);
            return c.transport_ok;
        }
        broker::CloseResult c = QueryToClose(pre);
        long long filled = c.filled_qty;
        if (filled < 0) filled = 0;
        // Chain-validated exact attribution: the broker knows
        // this id, so the chain MUST vouch for it (stable request
        // + monotonic attributed). A missing/corrupt/foreign row
        // is an integrity failure — freeze + refuse, NEVER mint
        // from current broker need. Only the not-yet-attributed
        // portion folds (a crash between fill and attribute
        // re-derives the same portion exactly once).
        long long req = 0, already = 0;
        if (!HardChainState(id.c_str(), &req, &already)) {
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner",
                   "hard-chain-invalid", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-chain-invalid", id.c_str(), now_ns);
            FreezeAdd(P("freeze.txt").c_str(), symbol);
            return false;
        }
        long long portion = filled - already;
        if (portion < 0) portion = 0;
        // Monotonic authority: the chain's attributed quantity is
        // the floor for remainder derivation. A broker observation
        // that REGRESSES below already-attributed truth (poll lag,
        // correction, identity confusion) is classified — drift
        // owns the anomaly — and must never manufacture a larger
        // replacement remainder (req - regressed > req - already).
        long long eff = filled;
        if (filled < already) {
            char gb[280];
            std::snprintf(gb, sizeof(gb),
                            "hard-close id=%s fill-regressed "
                            "broker=%lld chain=%lld",
                            id.c_str(), filled, already);
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner", gb,
                   now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-close-fill-regressed", gb, now_ns);
            eff = already;
        }
        if (portion > 0) {
            // Durable-first: slots persist BEFORE the chain note
            // advances. Unpersisted slots (rolled back inside)
            // refuse with books exactly as before — the next
            // pre-flight reconstructs this same portion once.
            if (!AttributeClosedQty(symbol, portion, now_ns)) {
                OpsRow("drift-directive",
                       scope_intent ? scope_intent : "runner",
                       "hard-close-attribution-unpersisted",
                       now_ns);
                Alert(P("alerts.jsonl").c_str(), "HARD",
                      "hard-close-attribution-unpersisted",
                      scope_intent ? scope_intent : "", now_ns);
                return false;
            }
            // Slots durable, chain note failed: roll the slots
            // back to old values (best-effort) so the books stay
            // exactly as before, then freeze + refuse.
            if (!NoteHardChain(id.c_str(), req,
                               already + portion)) {
                UnattributeClosedQty(symbol, now_ns);
                OpsRow("drift-directive",
                       scope_intent ? scope_intent : "runner",
                       "hard-chain-note-failed", now_ns);
                Alert(P("alerts.jsonl").c_str(), "HARD",
                      "hard-chain-note-failed",
                      scope_intent ? scope_intent : "", now_ns);
                FreezeAdd(P("freeze.txt").c_str(), symbol);
                return false;
            }
        }
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "hard-close id=%s found state=%d "
                        "filled=%lld need=%lld",
                        id.c_str(), (int)c.state, filled, need);
        OpsRow("drift-directive",
               scope_intent ? scope_intent : "runner", tb,
               now_ns);
        if (filled >= need) return true;  // sufficient
        if (c.state == broker::CloseState::PENDING ||
            c.state == broker::CloseState::PARTIAL ||
            c.state == broker::CloseState::UNKNOWN)
            return true;  // working/ambiguous: adopted, never
                          // re-sent (its fills attribute back)
        // Terminal-short: the id is burned (Alpaca client ids are
        // per-order unique — it can never carry another POST).
        // Remainder = ORIGINAL chain request minus landed (chain
        // truth, validated above — the current broker need only
        // caps the send). Landed floors at the chain-attributed
        // quantity: a regressing broker observation never inflates
        // the remainder (classified above). No chain row is
        // unreachable here: the found id passed validation, so
        // req > 0 holds.
        long long rem = req - eff;
        if (rem <= 0) {
            // Chain satisfied, yet the broker still shows need:
            // poll lag or foreign exposure — drift owns it (no
            // second incident identity, never a blind re-send).
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner",
                   "hard-chain-satisfied-broker-open", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-chain-satisfied-broker-open",
                  scope_intent ? scope_intent : "", now_ns);
            return false;
        }
        long long send = (rem < need) ? rem : need;
        std::string id2 =
            HardRemainderTag(epoch, symbol, rem);
        if (id2 == id) {
            OpsRow("drift-directive",
                   scope_intent ? scope_intent : "runner",
                   "hard-close remainder-stuck", now_ns);
            FreezeAdd(P("freeze.txt").c_str(), symbol);
            return false;
        }
        char rb[280];
        std::snprintf(rb, sizeof(rb),
                        "hard-close remainder %s -> %s "
                        "chain=%lld send=%lld",
                        id.c_str(), id2.c_str(), rem, send);
        OpsRow("drift-directive",
               scope_intent ? scope_intent : "runner", rb,
               now_ns);
        id = id2;
        need = send;
        logical = rem;  // the new identity owns the full logical
                        // remainder; the next POST caps it again
    }
    OpsRow("drift-directive", scope_intent ? scope_intent : "runner",
           "hard-close remainder-exhausted", now_ns);
    FreezeAdd(P("freeze.txt").c_str(), symbol);
    return false;
}
bool G0Runner::CoveredBySlot(const char* symbol) const {
    if (!symbol) return false;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (std::strcmp(s.intent.symbol, symbol) != 0) continue;
        if (s.m.filled_qty - s.m.exit_closed_qty > 0) return true;
    }
    return false;
}

long long G0Runner::HardAdoptExit(Slot& s, long long epoch,
                                long long now_ns) {
    // Doc-06-sec.-6.1b adopt-or-replace: the owned exit is
    // reconciled, never canceled to make room, never bypassed.
    // Live (or filled-full) -> adopt: journal, no orders. Dead /
    // absent -> replace the unlanded remainder under the incident
    // hard id (pre-flighted, shared with every hard path for the
    // symbol — the pre-flight, not a cancel, is what prevents two
    // closes). Landed qty attributes to entries oldest-first, so
    // the replacement sizes off provable remainder, never intent.
    // Returns the qty still exposed (0 when adopted, landed-full,
    // or replaced-working; the unfixable remainder otherwise) so
    // callers reconciling MANY exits sum exposure, never sample
    // the first.
    if (!s.active || s.done ||
        s.intent.kind != jev::risk::IntentKind::EXIT)
        return 0;
    if (s.m.client_id[0] == '\0') return 0;
    broker::OrderQuery q = adapter_.QueryOnce(s.m.client_id);
    NoteQuarantine(s, q, "HARD", now_ns);
    long long rem =
        s.intent.qty_shares - s.m.exit_closed_qty;
    if (rem < 0) rem = 0;
    if (!q.transport_ok) {
        // Blind on the exit: HARD fails toward flatten (the
        // pre-flight still guards the incident id). The whole
        // remainder counts as exposed.
        OpsRow("drift-directive", s.intent.intent_id,
               "hard-adopt-exit lookup-failed", now_ns);
        return rem;
    }
    broker::OrderSide eside =
        (s.intent.side == broker::OrderSide::BUY)
            ? broker::OrderSide::SELL
            : broker::OrderSide::BUY;
    std::string hid = HardTag(epoch, s.intent.symbol);
    char tb[280];
    if (q.transport_ok && !q.found) {
        // Absent: the exit never landed — the full remainder is
        // provably uncovered. Replace under the incident id.
        std::snprintf(tb, sizeof(tb),
                        "hard-adopt-exit id=%s absent replace=%lld",
                        s.intent.intent_id, rem);
        OpsRow("drift-directive", s.intent.intent_id, tb,
               now_ns);
        if (rem > 0 &&
            HardCloseOnce(s.intent.symbol, rem, eside,
                          hid.c_str(), epoch,
                          s.intent.intent_id, now_ns))
            return 0;
        return rem;
    }
    broker::CloseResult c = QueryToClose(q);
    if (c.state == broker::CloseState::PENDING ||
        c.state == broker::CloseState::PARTIAL ||
        c.state == broker::CloseState::UNKNOWN) {
        // Working or ambiguous: adopt. No cancel (canceling the
        // owned close would strand the exposure), no second
        // close — the working order owns the outstanding qty.
        std::snprintf(tb, sizeof(tb),
                        "hard-adopt-exit id=%s state=%d filled=%lld",
                        s.intent.intent_id, (int)c.state,
                        (long long)c.filled_qty);
        OpsRow("drift-directive", s.intent.intent_id, tb,
               now_ns);
        return 0;
    }
    // Terminal (FILLED-full, FILLED-short, or DEAD): fold ONLY
    // the fresh portion beyond this order's own counted memory
    // (the router's per-current-order contract — an
    // already-counted cumulative fill never folds twice, even
    // across a crash before normal reconciliation), bump the
    // slot's cumulative ledgers to match, then replace the
    // genuinely unaccounted remainder (same incident id the
    // entry path and the slotless path share).
    long long fresh = c.filled_qty - s.m.exit_counted_qty;
    if (fresh < 0) fresh = 0;
    if (fresh > rem) fresh = rem;
    if (fresh > 0) {
        // Crash-consistent order: durable parent-entry
        // attribution lands BEFORE the EXIT counters persist. A
        // crash between the two replays safely — the entries are
        // already authoritative, the leftover drops against their
        // reduced opens, the counters advance, and nothing folds
        // twice. (The reverse order strands attribution forever:
        // durable exit-counted with un-attributed entries replays
        // to fresh = 0 and the quantity is permanently lost.)
        // Entry attribution is self-rollbacking: any failure folds
        // NOTHING (exit counters untouched) and the full remainder
        // retries next cycle (doc 06 sec. 6.1b).
        if (!AttributeClosedQty(s.intent.symbol, fresh,
                                now_ns)) {
            OpsRow("drift-directive", s.intent.intent_id,
                   "hard-adopt-exit-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-adopt-exit-unpersisted",
                  s.intent.intent_id, now_ns);
            return rem;
        }
        s.m.exit_counted_qty += fresh;
        s.m.exit_closed_qty += fresh;
        if (!PersistSlot(s)) {
            // Entries durable, exit counters not: the in-memory
            // bumps stand for this process, and a crash restarts
            // from old counters — replay re-derives the same
            // fresh, finds no remaining parent open (leftover
            // drops), and converges the counters then.
            OpsRow("drift-directive", s.intent.intent_id,
                   "hard-adopt-exit-counters-unpersisted",
                   now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-adopt-exit-counters-unpersisted",
                  s.intent.intent_id, now_ns);
            return rem;
        }
    }
    long long rest = rem - fresh;
    std::snprintf(tb, sizeof(tb),
                    "hard-adopt-exit id=%s dead replace=%lld",
                    s.intent.intent_id, rest);
    OpsRow("drift-directive", s.intent.intent_id, tb,
           now_ns);
    if (rest > 0 &&
        HardCloseOnce(s.intent.symbol, rest, eside, hid.c_str(),
                      epoch, s.intent.intent_id, now_ns))
        return 0;
    return rest;
}
void G0Runner::HardManagePosition(const char* symbol, long long qty,
                                  long long epoch, long long now_ns) {
    // Slotless open position under HARD: no intent economics on
    // file, so broker-side protection is UNVERIFIABLE (no stop/tp
    // to re-establish with — inventing them would be a sizing
    // decision, and sizing is risk-owned). Flatten once under the
    // incident hard id (pre-flighted: a pre-crash close is
    // adopted, never re-sent — and shared with the slot and exit
    // paths, so one symbol never carries two hard closes) +
    // journal + alert. The flatten attempt is the protection when
    // none can be verified.
    if (!symbol || !symbol[0] || qty == 0 || epoch <= 0) return;
    broker::OrderSide eside = (qty > 0) ? broker::OrderSide::SELL
                                        : broker::OrderSide::BUY;
    long long aq = qty > 0 ? qty : -qty;
    std::string hid = HardTag(epoch, symbol);
    char tb[280];
    std::snprintf(tb, sizeof(tb),
                    "hard-manage sym=%.15s slotless qty=%lld "
                    "protection-unverifiable flatten-only",
                    symbol, (long long)qty);
    OpsRow("drift-directive", "runner", tb, now_ns);
    Alert(P("alerts.jsonl").c_str(), "HARD", "hard-slotless",
          tb, now_ns);
    HardCloseOnce(symbol, aq, eside, hid.c_str(), epoch, "runner",
                  now_ns);
}

void G0Runner::HardManageSlot(Slot& s, long long epoch,
                            long long now_ns, bool* owned) {
    // §10.3 per-position pass (best-effort transport, journaled):
    // reconcile -> verify broker-native protection (re-establish
    // if missing and possible) -> flatten/cancel attempt. NEVER
    // destructive: failures leave protection active; the process
    // terminates right after regardless. Done-PROTECTED slots are
    // managed (they ARE live positions); only provably empty
    // terminals (CANCELLED/UNKNOWN/CLOSED) are skipped. An EXIT
    // already working the symbol is adopted-or-replaced, never
    // canceled, never bypassed (doc 06 sec. 6.1b). *owned reports
    // whether this path demonstrably owns the symbol (reconciled,
    // not blind, not frozen-waiting) so the position loop can
    // fall back to broker-sized management when it does not —
    // under the SAME incident id, so the pre-flight (not the
    // skip) keeps one close.
    if (owned) *owned = true;
    if (!s.active) return;
    if (s.m.state == exec::RouteState::CANCELLED ||
        s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
        s.m.state == exec::RouteState::CLOSED)
        return;
    if (s.m.client_id[0] == '\0') return;  // never sent: no risk
    if (s.intent.kind == jev::risk::IntentKind::EXIT) {
        if (owned)
            *owned = (HardAdoptExit(s, epoch, now_ns) == 0);
        else
            HardAdoptExit(s, epoch, now_ns);
        return;
    }
    broker::OrderQuery q = adapter_.QueryOnce(s.m.client_id);
    if (!q.transport_ok) {
        // Blind on the entry: do NOT claim ownership — the
        // position loop falls back to the authoritative broker
        // qty (same incident id, pre-flight dedupes).
        OpsRow("drift-directive", s.intent.intent_id,
               "hard-manage lookup-failed", now_ns);
        if (owned) *owned = false;
        return;
    }
    NoteQuarantine(s, q, "HARD", now_ns);
    if (IsQuarantineStatus(q.status_raw)) return;  // frozen:
                                                   // wait (owned-
                                                   // skip — the
                                                   // position
                                                   // loop also
                                                   // waits)
    {
        // EXIT coverage first (doc 06 sec. 6.1b): an in-flight EXIT
        // owns (part of) this exposure until reconciled. The check
        // itself is transport-free; the reconcile below is one GET.
        long long open =
            s.m.filled_qty - s.m.exit_closed_qty;
        bool prot = q.protection_active || q.bracket_class;
        if (!prot && q.found && open > 0) {
            // Re-establish broker-native protection if possible —
            // under the REPAIR sub-identity (never the entry id:
            // the venue rejects duplicate client_order_id). The
            // repair id is pre-flighted too: already-protected
            // adoptions skip the POST; anything else attempts
            // exactly one repair (flatten covers the rest).
            broker::OrderSide pside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            char rcoid[65] = {0};
            bool have_rid = RepairClientId(
                cfg_.venue.broker, cfg_.venue.account,
                cfg_.venue.context_hash, s.intent.symbol, pside,
                s.intent.intent_id, rcoid);
            bool ok = false;
            const char* how = "no-id";
            if (have_rid) {
                broker::OrderQuery pre = adapter_.QueryOnce(rcoid);
                NoteQuarantine(s, pre, "HARD", now_ns);
                if (pre.transport_ok && pre.found &&
                    (pre.protection_active || pre.bracket_class)) {
                    ok = true;  // repair already landed pre-crash
                    how = "adopted";
                } else if (pre.transport_ok && !pre.found) {
                    broker::ProtectedOrder po{};
                    CopyStr(po.symbol, sizeof(po.symbol),
                            s.intent.symbol);
                    po.side = s.intent.side;
                    po.qty_shares = s.m.filled_qty > 0
                                        ? s.m.filled_qty
                                        : s.intent.qty_shares;
                    po.stop_cents = s.intent.stop_cents;
                    po.tp_cents = s.intent.tp_cents;
                    CopyStr(po.client_order_id,
                            sizeof(po.client_order_id), rcoid);
                    CopyStr(po.intent_id, sizeof(po.intent_id),
                            s.intent.intent_id);
                    ok = adapter_.EstablishProtection(po);
                    how = "posted";
                } else {
                    how = "lookup-failed";
                }
            }
            char tb[280];
            std::snprintf(tb, sizeof(tb),
                            "hard-manage id=%s reprotect=%d %s",
                            s.intent.intent_id, ok ? 1 : 0, how);
            OpsRow("drift-directive", s.intent.intent_id, tb,
                   now_ns);
        }
        if (open <= 0) {
            // Nothing filled — but the order may exist unacked at
            // the broker (POST landed, ack lost). Found + UUID ->
            // attempt cancel; 404-absent -> journal it, no orders
            // exist to cancel.
            if (q.found && q.broker_order_id[0] != '\0') {
                broker::CancelResult c =
                    adapter_.Cancel(q.broker_order_id);
                char tb[280];
                std::snprintf(tb, sizeof(tb),
                                "hard-manage id=%s cancel-unfilled=%d",
                                s.intent.intent_id,
                                c.accepted ? 1 : 0);
                OpsRow("drift-directive", s.intent.intent_id, tb,
                       now_ns);
            } else if (q.found || !q.transport_ok) {
                OpsRow("drift-directive", s.intent.intent_id,
                       "hard-manage unfilled-unresolved", now_ns);
            } else {
                OpsRow("drift-directive", s.intent.intent_id,
                       "hard-manage unfilled-absent", now_ns);
            }
            return;
        }
        if (open > 0 && epoch > 0) {
            // Attempt flatten under the INCIDENT hard id (shared
            // with the exit path and the slotless path — the
            // pre-flight dedupes them into one close per symbol).
            // Exit coverage reconciles first: EVERY covering exit
            // is adopted-or-replaced (never first-only — a dead
            // first exit must not mask a live second), and only
            // the uncovered remainder closes here (never a second
            // full close, never a cancel). Quantity authority is
            // the SIGNED BROKER POSITION when the seam answers
            // (doc 06 sec. 6.1b): local open sizes only when the
            // seam is absent/failing, journaled.
            std::string hid = HardTag(epoch, s.intent.symbol);
            std::vector<std::size_t> cidx;
            long long cover_tot = 0;
            CollectCoverExits(s.intent.symbol, &cidx,
                              &cover_tot);
            long long exposed = 0;
            for (std::size_t k = 0; k < cidx.size(); ++k)
                exposed += HardAdoptExit(slots_[cidx[k]], epoch,
                                         now_ns);
            // Working cover = exit qty minus still-exposed.
            long long working = cover_tot - exposed;
            if (working < 0) working = 0;
            long long bq = 0;
            bool have_bq = BrokerQty(s.intent.symbol, &bq);
            long long uncovered = 0;
            broker::OrderSide eside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            if (have_bq) {
                // Broker authority: close the broker qty the
                // exits do not already own, in the broker
                // direction. Local/broker disagreement is drift
                // (journaled) — never a qty change.
                long long aq = bq > 0 ? bq : -bq;
                eside = (bq > 0) ? broker::OrderSide::SELL
                                 : broker::OrderSide::BUY;
                uncovered = aq - working;
                if (uncovered < 0) uncovered = 0;
                long long local_dir =
                    (s.intent.side == broker::OrderSide::BUY)
                        ? 1
                        : -1;
                long long bdir =
                    (bq > 0) ? 1 : (bq < 0 ? -1 : 0);
                char tb[280];
                std::snprintf(tb, sizeof(tb),
                                "hard-manage id=%s broker=%lld "
                                "local-open=%lld working=%lld "
                                "uncovered=%lld",
                                s.intent.intent_id, bq, open,
                                working, uncovered);
                OpsRow("drift-directive", s.intent.intent_id, tb,
                       now_ns);
                if (bq == 0 && open > 0) {
                    OpsRow("drift-directive",
                           s.intent.intent_id,
                           "hard-phantom-local no-close", now_ns);
                    Alert(P("alerts.jsonl").c_str(), "HARD",
                          "hard-phantom-local",
                          s.intent.intent_id, now_ns);
                    uncovered = 0;
                } else if (bdir != 0 && bdir != local_dir) {
                    OpsRow("drift-directive",
                           s.intent.intent_id,
                           "hard-direction-drift", now_ns);
                    Alert(P("alerts.jsonl").c_str(), "HARD",
                          "hard-direction-drift",
                          s.intent.intent_id, now_ns);
                }
            } else {
                // No seam: local sizing, journaled fallback.
                uncovered = open - working;
                if (uncovered < 0) uncovered = 0;
                OpsRow("drift-directive", s.intent.intent_id,
                       "hard-no-position-seam local-sizing",
                       now_ns);
            }
            bool sent = false;
            if (uncovered > 0 && epoch > 0) {
                sent = HardCloseOnce(s.intent.symbol, uncovered,
                                      eside, hid.c_str(), epoch,
                                      s.intent.intent_id, now_ns);
                // A failed close owns nothing: the position
                // loop retries the same incident id (pre-flight
                // dedupes — never two closes).
                if (owned) *owned = sent;
            } else if (uncovered > 0) {
                if (owned) *owned = false;
            }
            char tb[280];
            std::snprintf(tb, sizeof(tb),
                            "hard-manage id=%s flatten=%d"
                            " uncovered=%lld",
                            s.intent.intent_id, sent ? 1 : 0,
                            uncovered);
            OpsRow("drift-directive", s.intent.intent_id, tb,
                   now_ns);
        }
        return;
    }
}

bool G0Runner::HardHalted() const {
    // Fail-closed halted: a corrupt HALT node (directory in place
    // of the file) halts like a present one — never "no HALT".
    return hard_latched_ ||
           StatPath(P("HALT").c_str()) != PathKind::ABSENT;
}
bool G0Runner::HardStop(long long now_ns, const char* why,
                  bool halt_at_entry) {
    // §10.3 HARD: entries already stop at the kill gate. Verify
    // broker-native protection on every open position (re-establish
    // if missing and possible), attempt flatten/cancel, leave
    // broker-side protection ACTIVE, then terminate. Credential
    // revocation is a Phase-4 transport step (the null transport
    // cannot order by construction); the HALT file makes the stop
    // survive restart (entries stay blocked, exits stay alive).
    Alert(P("alerts.jsonl").c_str(), "HARD", "kill-hard",
          why ? why : "", now_ns);
    OpsRow("drift-directive", "runner", "hard-stop", now_ns);
    // HALT is a durable state write, not a best-effort touch: the
    // stop is claimed only once it is durably established. A
    // failed write latches HARD in memory (entries stay blocked
    // via HardHalted), journals + alerts, and returns false — the
    // stop is reported as UNPROVEN, never as completed. The
    // caller exits nonzero (main has no in-process retry loop);
    // the supervisor/operator owns recovery, and a restart
    // without the HALT file is operator territory by design.
    if (!AtomicWrite(P("HALT").c_str(), "HALT\n")) {
        hard_latched_ = true;
        OpsRow("drift-directive", "runner",
               "halt-unpersisted", now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "halt-unpersisted", why ? why : "", now_ns);
        return false;
    }
    hard_latched_ = false;
    long long epoch =
        HardEpochFor(now_ns, why, halt_at_entry);
    if (epoch <= 0) return false;  // no durable epoch: no new
                                   // incident identity (HALT
                                   // already blocks entries;
                                   // the next cycle retries
                                   // the mint)
    std::vector<char> slot_owned(slots_.size(), 0);
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        bool ow = true;
        HardManageSlot(slots_[i], epoch, now_ns, &ow);
        slot_owned[i] = ow ? 1 : 0;
    }
    // §10.3 operates on EVERY open position — including slotless
    // holdings the position list reports. Per-symbol ownership:
    // an ENTRY symbol the slot path demonstrably owned is
    // skipped; a blind/failed slot falls through to broker-sized
    // management under the SAME incident hard id (the pre-flight
    // keeps one close — the skip is an optimization, not the
    // mutual-exclusion mechanism). An exit-only symbol reconciles
    // ALL covering exits and closes only the remainder; only
    // truly uncovered symbols flatten. Frozen symbols are never
    // position-loop-closed (freeze = wait; exits stay alive via
    // their slots).
    if (deps_.list_positions) {
        Position ps[64];
        int n = 0;
        if (!SnapPositions(ps, 64, &n)) {
            OpsRow("drift-directive", "runner",
                   "hard-positions-unavailable", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-positions-unknown", "lookup failed",
                  now_ns);
        }
        for (int i = 0; i < n; ++i) {
            if (ps[i].symbol[0] == '\0' || ps[i].qty == 0)
                continue;
            if (FreezeHas(P("freeze.txt").c_str(), ps[i].symbol))
                continue;  // frozen = wait (exits stay alive via
                           // their slots — never a new close)
            if (CoveredBySlot(ps[i].symbol)) {
                // Slot-path-owned only if EVERY open ENTRY for
                // the symbol was demonstrably managed; a blind
                // slot falls through to the same incident id
                // (pre-flight dedupes — one close either way).
                bool managed = true;
                for (std::size_t k = 0; k < slots_.size();
                     ++k) {
                    const Slot& es = slots_[k];
                    if (!es.active) continue;
                    if (es.intent.kind !=
                        jev::risk::IntentKind::ENTRY)
                        continue;
                    if (std::strcmp(es.intent.symbol,
                                    ps[i].symbol) != 0)
                        continue;
                    if (es.m.filled_qty - es.m.exit_closed_qty <=
                        0)
                        continue;
                    if (k >= slot_owned.size() ||
                        !slot_owned[k]) {
                        managed = false;
                        break;
                    }
                }
                if (managed) continue;
                char fb[280];
                std::snprintf(fb, sizeof(fb),
                                "hard-manage sym=%.15s slot-blind "
                                "fallback broker=%lld",
                                ps[i].symbol, ps[i].qty);
                OpsRow("drift-directive", "runner", fb,
                       now_ns);
            }
            std::vector<std::size_t> cidx;
            long long cover_tot = 0;
            CollectCoverExits(ps[i].symbol, &cidx, &cover_tot);
            if (!cidx.empty()) {
                // Exit-owned symbol: reconcile EVERY covering
                // exit, close only the genuinely uncovered
                // remainder (a dead first exit never masks a
                // live second).
                long long exposed = 0;
                for (std::size_t k = 0; k < cidx.size(); ++k)
                    exposed += HardAdoptExit(slots_[cidx[k]],
                                             epoch, now_ns);
                long long working = cover_tot - exposed;
                if (working < 0) working = 0;
                long long aq =
                    ps[i].qty > 0 ? ps[i].qty : -ps[i].qty;
                long long uncovered = aq - working;
                if (uncovered < 0) uncovered = 0;
                if (uncovered == 0) continue;
                broker::OrderSide eside =
                    (ps[i].qty > 0) ? broker::OrderSide::SELL
                                    : broker::OrderSide::BUY;
                std::string hid =
                    HardTag(epoch, ps[i].symbol);
                char tb[280];
                std::snprintf(tb, sizeof(tb),
                                "hard-manage sym=%.15s exit-owned "
                                "broker=%lld working=%lld "
                                "uncovered=%lld",
                                ps[i].symbol, ps[i].qty, working,
                                uncovered);
                OpsRow("drift-directive", "runner", tb,
                       now_ns);
                HardCloseOnce(ps[i].symbol, uncovered, eside,
                              hid.c_str(), epoch, "runner",
                              now_ns);
                continue;
            }
            HardManagePosition(ps[i].symbol, ps[i].qty, epoch,
                               now_ns);
        }
    } else {
        OpsRow("drift-directive", "runner",
               "hard-no-position-seam", now_ns);
    }
    return false;  // terminate: supervisor must NOT restart
}

bool G0Runner::VenueOk(bool* open, bool* spread_ok) {
    if (!deps_.venue_gate) return false;  // unknown: fail closed
    bool o = false, sp = false;
    if (!deps_.venue_gate(deps_.venue_ctx, &o, &sp)) return false;
    if (open) *open = o;
    if (spread_ok) *spread_ok = sp;
    return o && sp;
}

int G0Runner::LocalNet(const char* symbol) const {
    // Signed local open per symbol over ENTRY slots with provable
    // open (filled minus closed; exits are managers, not
    // positions). PROTECTED is included: it IS the normal open
    // position (terminal only because its lifecycle is complete —
    // the shares are still live). CANCELLED/UNKNOWN_FROZEN/CLOSED
    // carry no provable open and are excluded.
    long long net = 0;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (s.m.state == exec::RouteState::CANCELLED ||
            s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
            s.m.state == exec::RouteState::CLOSED)
            continue;
        if (std::strcmp(s.intent.symbol, symbol) != 0) continue;
        long long open = s.m.filled_qty - s.m.exit_closed_qty;
        if (open < 0) open = 0;
        net += (s.intent.side == broker::OrderSide::BUY) ? open
                                                         : -open;
    }
    if (net > 999999999) net = 999999999;
    if (net < -999999999) net = -999999999;
    return (int)net;
}

void G0Runner::PositionCheck(long long now_ns) {
    // Account-level S2: authoritative broker positions vs local
    // expectation over the UNION of both symbol sets (broker-only
    // = orphan; local-only = vanished; qty mismatch = drift).
    // Drift journals + alerts + forces per-symbol re-lookup; it
    // never orders (flattening is MEDIUM/HARD-owned).
    if (!deps_.list_positions) return;  // Phase-4 seam absent
    // Elapsed on the monotonic clock (wall jumps must not
    // trigger/skip the account reconciliation rhythm).
    long long mono = MonoNs(now_ns);
    bool due = (mono - last_pos_ns_) >=
               deps_.s2_seconds * 1000000000LL;
    if (!due) return;
    last_pos_ns_ = mono;
    Position ps[64];
    int n = 0;
    if (!SnapPositions(ps, 64, &n)) {
        Alert(P("alerts.jsonl").c_str(), "S2",
              "positions-unavailable", "lookup failed", now_ns);
        return;
    }
    // Local expectation per symbol (same provable-open rule as
    // LocalNet: PROTECTED included, managers excluded).
    struct SymOpen {
        char sym[16];
        long long qty;
    };
    SymOpen local[64];
    int ln = 0;
    for (std::size_t k = 0; k < slots_.size() && ln < 64; ++k) {
        const Slot& s = slots_[k];
        if (!s.active) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (s.m.state == exec::RouteState::CANCELLED ||
            s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
            s.m.state == exec::RouteState::CLOSED)
            continue;
        long long open = s.m.filled_qty - s.m.exit_closed_qty;
        if (open <= 0) continue;
        long long signed_open =
            (s.intent.side == broker::OrderSide::BUY) ? open
                                                      : -open;
        int at = -1;
        for (int j = 0; j < ln; ++j) {
            if (std::strcmp(local[j].sym, s.intent.symbol) == 0) {
                at = j;
                break;
            }
        }
        if (at < 0) {
            CopyStr(local[ln].sym, sizeof(local[ln].sym),
                    s.intent.symbol);
            local[ln].qty = signed_open;
            ++ln;
        } else {
            local[at].qty += signed_open;
        }
    }
    bool matched[64] = {false};
    for (int i = 0; i < n; ++i) {
        if (ps[i].symbol[0] == '\0') continue;
        long long expect = 0;
        bool have_local = false;
        for (int j = 0; j < ln; ++j) {
            if (std::strcmp(local[j].sym, ps[i].symbol) == 0) {
                expect = local[j].qty;
                have_local = true;
                matched[j] = true;
                break;
            }
        }
        if (have_local && expect == ps[i].qty) continue;
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "position-drift sym=%.15s local=%lld broker=%lld%s",
                        ps[i].symbol, expect, (long long)ps[i].qty,
                        have_local ? "" : " orphan");
        Alert(P("alerts.jsonl").c_str(), "S2", "position-drift",
              tb, now_ns);
        OpsRow("drift-directive", "runner", tb, now_ns);
        for (std::size_t k = 0; k < slots_.size(); ++k) {
            Slot& s = slots_[k];
            if (!s.active || s.done) continue;
            if (std::strcmp(s.intent.symbol, ps[i].symbol) == 0)
                s.last_s2_ns = 0;  // force re-lookup this cycle
        }
    }
    for (int j = 0; j < ln; ++j) {
        if (matched[j] || local[j].qty == 0) continue;
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "position-drift sym=%.15s local=%lld broker=0 "
                        "local-only",
                        local[j].sym, local[j].qty);
        Alert(P("alerts.jsonl").c_str(), "S2", "position-drift",
              tb, now_ns);
        OpsRow("drift-directive", "runner", tb, now_ns);
        for (std::size_t k = 0; k < slots_.size(); ++k) {
            Slot& s = slots_[k];
            if (!s.active || s.done) continue;
            if (std::strcmp(s.intent.symbol, local[j].sym) == 0)
                s.last_s2_ns = 0;
        }
    }
}

void G0Runner::ReclaimDone() {
    // Done slots leave — EXCEPT live ENTRY positions: a done
    // PROTECTED slot with provable open is not history, it is the
    // local position record (S2, MEDIUM/HARD coverage, and close
    // attribution all read it). It becomes reclaimable once its
    // open attributes to zero (flatten/sweep/exit closes) — until
    // then capacity counts it as live risk.
    for (std::size_t i = 0; i < slots_.size();) {
        const Slot& s = slots_[i];
        bool live_position =
            s.active && s.done &&
            s.intent.kind == jev::risk::IntentKind::ENTRY &&
            s.m.state == exec::RouteState::PROTECTED &&
            s.m.filled_qty - s.m.exit_closed_qty > 0;
        if (s.active && s.done && !live_position) {
            slots_.erase(slots_.begin() + (int)i);
        } else {
            ++i;
        }
    }
}

bool G0Runner::DailyOps(long long now_ns) {
    long long day = now_ns / 86400000000000LL;
    if (day == last_ops_day_) return true;
    last_ops_day_ = day;
    // 00:00 verify: a mid-run chain break is HARD (forensics
    // first), exactly like a boot-time break.
    if (!JournalVerifyFile(P("journal.jsonl").c_str())) {
        Alert(P("alerts.jsonl").c_str(), "HARD", "journal-chain-break",
              "mid-run chain fails VerifyChain",
              deps_.now_ns(deps_.clock_ctx));
        return false;
    }
    int y = 0;
    unsigned mo = 0, dd = 0;
    CivilFromDays(day, &y, &mo, &dd);
    char stamp[16];
    std::snprintf(stamp, sizeof(stamp), "%04d%02u%02u", y, mo, dd);
    // Dated journal copy (the live file keeps chaining — the copy
    // is the retention unit, never a rotation that forks the
    // chain).
    CopyFileBytes(P("journal.jsonl").c_str(),
             (cfg_.dir + "/journal-" + stamp + ".jsonl").c_str());
    int kept = 0, pruned = 0;
    if (!RetainJournals(cfg_.dir.c_str(), day, &kept, &pruned))
        Alert(P("alerts.jsonl").c_str(), "OPS", "retention-failed",
              stamp, now_ns);
    MkDirIfMissing((cfg_.dir + "/backup").c_str());
    if (!BackupFile(P("journal.jsonl").c_str(),
                    (cfg_.dir + "/backup/journal-" + stamp +
                     ".jsonl")
                        .c_str()))
        Alert(P("alerts.jsonl").c_str(), "OPS", "backup-failed",
              stamp, now_ns);
    Summary sm;
    if (SummarizeJournal(P("journal.jsonl").c_str(), &sm)) {
        char sline[256];
        if (FormatSummary(sm, sline, sizeof(sline))) {
            std::string s = std::string(stamp) + " " + sline + "\n";
            if (!AppendLine(P("summary.txt").c_str(), s.c_str()))
                Alert(P("alerts.jsonl").c_str(), "OPS",
                      "summary-failed", stamp, now_ns);
        }
    }
    return true;
}

bool G0Runner::AllFlat() {
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        // PROTECTED counts: it is a live position until its open
        // is attributed to zero (flatten/sweep closes attribute
        // back — an unattributed PROTECTED is provably NOT flat).
        if (s.m.state == exec::RouteState::CANCELLED ||
            s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
            s.m.state == exec::RouteState::CLOSED)
            continue;
        if (s.m.filled_qty - s.m.exit_closed_qty > 0) return false;
    }
    if (deps_.list_positions) {
        Position ps[64];
        int n = 0;
        if (!SnapPositions(ps, 64, &n))
            return false;  // unknown != flat
        for (int i = 0; i < n; ++i) {
            if (ps[i].qty != 0) return false;
        }
    }
    return true;
}

bool G0Runner::AttributeClosedQty(const char* symbol, long long qty,
                                   long long now_ns) {
    // An authoritative close quantity (flatten EXIT done-CLOSED,
    // sweep-order FILLED/PARTIAL) belongs to same-symbol ENTRY
    // slots, oldest first. Without this the entry machine keeps
    // claiming provable open after its position closed and S2
    // drifts on healthy flat forever. Leftover with no local
    // expectation is dropped (broker truth already rules S2).
    // Two-phase, durable-first: takes are computed read-only,
    // then each slot is mutated+persisted. ANY persist failure
    // rolls back in-memory takes everywhere AND re-persists
    // already-written slots to old values (best-effort), then
    // returns false — the caller must not advance dependent
    // durable state, so the next pre-flight reconstructs exactly.
    n_attr_takes_ = 0;  // any stale take list dies here
    if (!symbol || !symbol[0] || qty <= 0) return false;
    struct Take {
        std::size_t idx;
        long long take;
        long long old_closed;
    };
    Take takes[64];
    std::size_t ntake = 0;
    long long rem = qty;
    for (std::size_t i = 0; i < slots_.size() && rem > 0; ++i) {
        Slot& s = slots_[i];
        if (!s.active) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (s.m.state == exec::RouteState::CANCELLED ||
            s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
            s.m.state == exec::RouteState::CLOSED)
            continue;
        if (std::strcmp(s.intent.symbol, symbol) != 0) continue;
        long long open = s.m.filled_qty - s.m.exit_closed_qty;
        if (open <= 0) continue;
        long long take = (open < rem) ? open : rem;
        if (ntake >= 64) break;  // absurd: refuse the rest
        takes[ntake].idx = i;
        takes[ntake].take = take;
        takes[ntake].old_closed = s.m.exit_closed_qty;
        ++ntake;
        rem -= take;
    }
    for (std::size_t k = 0; k < ntake; ++k) {
        Slot& s = slots_[takes[k].idx];
        s.m.exit_closed_qty += takes[k].take;
        if (PersistSlot(s)) {
            char tb[280];
            std::snprintf(tb, sizeof(tb),
                            "close-attributed id=%s qty=%lld",
                            s.intent.intent_id, takes[k].take);
            OpsRow("reconcile", s.intent.intent_id, tb, now_ns);
            continue;
        }
        // Persist failed: roll back in-memory everywhere, and
        // re-persist the already-written slots to old values
        // (best-effort) so durable books are exactly as before.
        for (std::size_t j = 0; j < ntake; ++j)
            slots_[takes[j].idx].m.exit_closed_qty =
                takes[j].old_closed;
        n_attr_takes_ = 0;
        bool rback = true;
        for (std::size_t j = 0; j < k; ++j) {
            if (!PersistSlot(slots_[takes[j].idx])) rback = false;
        }
        char fb[280];
        std::snprintf(fb, sizeof(fb),
                        "close-attribution-unpersisted sym=%s "
                        "qty=%lld rolledback=%d",
                        symbol, qty, rback ? 1 : 0);
        OpsRow("reconcile", symbol, fb, now_ns);
        if (!rback) {
            // Durable rollback itself failed: books may diverge —
            // freeze LOUD (forensic journal rows above own it).
            FreezeAdd(P("freeze.txt").c_str(), symbol);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "attribution-rollback-failed", symbol,
                  now_ns);
        }
        return false;
    }
    // Exact take list for the immediate UnattributeClosedQty
    // rollback (chain-note failure path only).
    n_attr_takes_ = 0;
    for (std::size_t k = 0;
         k < ntake && n_attr_takes_ < 64; ++k) {
        attr_takes_[n_attr_takes_].slot = takes[k].idx;
        attr_takes_[n_attr_takes_].take = takes[k].take;
        ++n_attr_takes_;
    }
    return true;
}
void G0Runner::UnattributeClosedQty(const char* symbol,
                                    long long now_ns) {
    // Exact inverse of the last successful AttributeClosedQty
    // (per-slot take amounts, NOT a blind oldest-first pass —
    // slots may carry pre-existing closed from normal reconcile).
    // Used ONLY when the chain note failed after slots went
    // durable — restoring all-old books so the next pre-flight
    // reconstructs exactly. Any persist failure freezes LOUD.
    if (!symbol || !symbol[0] || n_attr_takes_ == 0) {
        n_attr_takes_ = 0;
        return;
    }
    for (std::size_t k = 0; k < n_attr_takes_; ++k) {
        if (attr_takes_[k].slot >= slots_.size()) continue;
        Slot& s = slots_[attr_takes_[k].slot];
        if (std::strcmp(s.intent.symbol, symbol) != 0) continue;
        if (s.m.exit_closed_qty < attr_takes_[k].take)
            s.m.exit_closed_qty = 0;
        else
            s.m.exit_closed_qty -= attr_takes_[k].take;
        if (!PersistSlot(s)) {
            FreezeAdd(P("freeze.txt").c_str(), symbol);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "unattribute-persist-failed", symbol,
                  now_ns);
            n_attr_takes_ = 0;
            return;
        }
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "close-unattributed id=%s qty=%lld",
                        s.intent.intent_id, attr_takes_[k].take);
        OpsRow("reconcile", s.intent.intent_id, tb, now_ns);
    }
    n_attr_takes_ = 0;
}

bool G0Runner::MediumPass(long long now_ns) {
    // §10.3 MEDIUM + frozen FSM (medium.txt): MEDIUM_ACTIVE ->
    // FLATTEN_PENDING -> FLATTENED | PROTECTION_ONLY. Entries stop
    // at the kill gate; every open position flattens via market
    // when the venue is open and the spread is normal, else stops/
    // TP own the risk and the flatten re-attempts every cycle.
    // Re-attempts fire ONLY from ordered-but-unacked flatten work
    // (no blind re-issue); a restart reloads the file and
    // reconciles first (pre-flight dedupe never resends).
    std::string mp = P("medium.txt");
    std::string cur;
    MediumFsmRead fr = ReadMediumFsm(mp.c_str(), &cur);
    if (fr == MediumFsmRead::CORRUPT) {
        OpsRow("reconcile", "runner", "medium-fsm-corrupt",
               now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-fsm-corrupt", "", now_ns);
        return true;  // never default a corrupt FSM to a fresh enter
    }
    if (fr == MediumFsmRead::UNKNOWN) {
        // Present regular file with unknown content — or
        // present but unreadable: corruption, never a fresh
        // incident minted over it (absent-or-empty still takes
        // the fresh path below).
        OpsRow("reconcile", "runner", "medium-fsm-unknown",
               now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-fsm-unknown", "", now_ns);
        return true;
    }
    if (cur.empty()) {
        if (!AtomicWrite(mp.c_str(), "MEDIUM_ACTIVE")) {
            OpsRow("reconcile", "runner",
                   "medium-active-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-active-unpersisted", "", now_ns);
            return true;  // no FSM, no mint: the next cycle retries
        }
        cur = "MEDIUM_ACTIVE";
        // A medium-enter IS a new incident (doc 06 sec. 6.1b):
        // mint the epoch BEFORE any sweep id derives (the crash
        // window between mint and first sweep is safe — nothing
        // was sent under the new epoch yet, so a re-mint is free).
        // Mint failure reverts the FSM so the next cycle retries
        // (an ACTIVE file with no durable epoch would strand the
        // incident id-less).
        if (MintMediumEpoch(now_ns) <= 0) {
            // Mint failure reverts the FSM so the next cycle
            // retries — but the revert itself is CHECKED: a
            // failed rollback would strand an id-less ACTIVE
            // incident, so it fails the cycle HARD and loud
            // instead of returning success (doc 06 sec. 6.1b).
            if (!AtomicWrite(mp.c_str(), "")) {
                OpsRow("reconcile", "runner",
                       "medium-rollback-unpersisted", now_ns);
                Alert(P("alerts.jsonl").c_str(), "HARD",
                      "medium-rollback-unpersisted", "", now_ns);
                return false;
            }
            return true;
        }
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "medium-enter",
              "entries stopped, flattening", now_ns);
    }
    if (cur == "FLATTENED") {
        // Terminal — unless live exposure says the file is
        // stale (a later incident with the FSM never cleared:
        // clear + fresh enter mints a new epoch; suppression of
        // a real later MEDIUM is the forbidden outcome).
        if (!MediumHasExposure()) return true;
        if (!ClearMediumFiles()) {
            OpsRow("reconcile", "runner",
                   "medium-clear-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-clear-unpersisted", "", now_ns);
        }
        if (!AtomicWrite(mp.c_str(), "MEDIUM_ACTIVE")) {
            OpsRow("reconcile", "runner",
                   "medium-active-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-active-unpersisted", "", now_ns);
            return true;  // no FSM, no mint: the next cycle retries
        }
        cur = "MEDIUM_ACTIVE";
        if (MintMediumEpoch(now_ns) <= 0) {
            // Exact revert: FLATTENED with no epoch re-runs the
            // re-enter check (exposure gate + mint retry) next
            // cycle instead of stranding an id-less ACTIVE —
            // and the revert is checked like the fresh-enter
            // one: a failed revert fails HARD, never healthy.
            if (!AtomicWrite(mp.c_str(), "FLATTENED")) {
                OpsRow("reconcile", "runner",
                       "medium-rollback-unpersisted", now_ns);
                Alert(P("alerts.jsonl").c_str(), "HARD",
                      "medium-rollback-unpersisted", "", now_ns);
                return false;
            }
            return true;
        }
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-re-enter",
              "stale FLATTENED, new incident", now_ns);
    }
    long long epoch = MediumEpoch();
    if (epoch <= 0) {
        // ACTIVE on disk with no durable epoch (failed mint, or
        // a lost incident file): this incident is id-less, so it
        // is NEVER treated as healthy — the sweep below stays
        // gated and the cycle fails loud every cycle until an
        // operator removes medium.txt for a fresh re-mint (safe:
        // nothing was ever sent under an unminted epoch).
        OpsRow("reconcile", "runner", "medium-epoch-missing",
               now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "medium-epoch-missing", "", now_ns);
        return false;
    }
    bool pending = false;  // flatten work ordered, awaiting ack
    // Local ENTRY slots flatten through the EXIT machinery
    // (EXIT submits bypass stage/freeze — old risk stays managed).
    std::size_t before = slots_.size();
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        if (FlattenOnMedium(slots_[i], now_ns) &&
            slots_.size() > before)
            pending = true;
    }
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active || s.done) continue;
        std::string fid =
            std::string(s.intent.intent_id) + "-flatten";
        if (Find(fid.c_str())) {
            pending = true;  // flatten EXIT still working
            break;
        }
    }
    // Broker-confirmed sweep: EVERY open position, venue-open +
    // spread-normal only, incident-scoped ids (doc 06 sec. 6.1b).
    // Unknown/closed venue (or absent seam, or no incident epoch)
    // = no sweep — protection stays, retry next cycle. A found
    // sweep order is reconciled, never assumed pending: its
    // FILLED/PARTIAL quantity attributes back to local entries; a
    // terminally DEAD sweep (or a FILLED sweep with the position
    // still open) mints ONE incident remainder
    // (medium-<epoch>-<SYM>-<qty> under the current broker qty —
    // pre-flighted, so each distinct id sends at most once); an
    // exhausted remainder (found-DEAD twice) journals + alerts for
    // a human instead of spinning. Locally covered symbols
    // reconcile but never send (the owned local close is the one
    // close).
    bool open = false, spread = false;
    if (epoch > 0 && VenueOk(&open, &spread) &&
        deps_.list_positions) {
        Position ps[64];
        int n = 0;
        if (!SnapPositions(ps, 64, &n)) n = 0;  // unavailable:
                                               // sweep sees
                                               // nothing (local
                                               // slots still
                                               // reconcile below)
        for (int i = 0; i < n; ++i) {
            if (ps[i].symbol[0] == '\0' || ps[i].qty == 0) continue;
            std::string sid = SweepTag(epoch, ps[i].symbol);
            char hcoid[65] = {0};
            broker::OrderSide eside = (ps[i].qty > 0)
                                          ? broker::OrderSide::SELL
                                          : broker::OrderSide::BUY;
            long long aq = ps[i].qty > 0 ? ps[i].qty : -ps[i].qty;
            if (!broker::MakeClientOrderId(
                    cfg_.venue.broker, cfg_.venue.account,
                    cfg_.venue.context_hash, ps[i].symbol, eside,
                    sid.c_str(), hcoid))
                continue;
            // Single-owner gate (doc 06 sec. 6.1b): a locally
            // covered symbol reconciles below but never SENDS —
            // the owned local close is the one close.
            bool covered = LocalCloseCovers(ps[i].symbol);
            broker::OrderQuery pre = adapter_.QueryOnce(hcoid);
            NoteQuarantineSym(ps[i].symbol, pre.status_raw,
                              "MEDIUM", now_ns);
            if (!pre.transport_ok) continue;  // retry next cycle
            if (pre.transport_ok && pre.found) {
                broker::CloseResult c = QueryToClose(pre);
                if ((c.state == broker::CloseState::FILLED ||
                     c.state == broker::CloseState::PARTIAL ||
                     c.state == broker::CloseState::DEAD) &&
                    c.filled_qty > 0 &&
                    !AttributeClosedQty(ps[i].symbol,
                                       c.filled_qty, now_ns))
                    OpsRow("reconcile", ps[i].symbol,
                           "attribution-unpersisted", now_ns);
                if (c.state == broker::CloseState::FILLED &&
                    c.filled_qty >= aq) {
                    // Fully swept by quantity — but the broker
                    // position still polls open this cycle, so stay
                    // PENDING until the poll confirms flat (a poll
                    // that never confirms is S2 drift, loud, with
                    // no spurious re-send from here).
                    pending = true;
                    continue;
                }
                if (c.state == broker::CloseState::PENDING ||
                    c.state == broker::CloseState::UNKNOWN ||
                    c.state == broker::CloseState::PARTIAL) {
                    // Live or ambiguous: await it (a PARTIAL still
                    // working is NOT a remainder — a second full
                    // order would over-close when it lands).
                    pending = true;
                    continue;
                }
                // DEAD, or FILLED-short of the live position:
                // the replacement derives from FRESH authoritative
                // exposure re-read NOW — never from the stale
                // snapshot aq that the terminal-short result
                // already disproved. Size = min(logical remainder,
                // |fresh|): flat sends nothing, drifted direction
                // sends nothing (S2 owns the anomaly), unavailable
                // fresh retries next cycle. The remainder tag
                // carries the derived size (one identity per
                // remainder, pre-flighted so each sends at most
                // once). Covered symbols reconcile (above) but
                // never mint: the owned local close carries
                // the rest.
                if (covered) {
                    pending = true;
                    continue;
                }
                long long landed = c.filled_qty;
                if (landed < 0) landed = 0;
                long long logical = aq - landed;
                if (logical < 0) logical = 0;
                long long fresh = 0;
                if (!BrokerQty(ps[i].symbol, &fresh)) {
                    OpsRow("drift-directive", "runner",
                           "medium-sweep-fresh-unavailable",
                           now_ns);
                    Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                          "medium-sweep-fresh-unavailable",
                          ps[i].symbol, now_ns);
                    pending = true;
                    continue;
                }
                long long dir =
                    (fresh > 0) ? 1 : (fresh < 0 ? -1 : 0);
                long long want =
                    (eside == broker::OrderSide::SELL) ? 1 : -1;
                if (fresh == 0) continue;  // flat: nothing to send
                if (dir != want) {
                    OpsRow("drift-directive", "runner",
                           "medium-sweep-direction-drift",
                           now_ns);
                    Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                          "medium-sweep-direction-drift",
                          ps[i].symbol, now_ns);
                    pending = true;
                    continue;
                }
                long long afresh =
                    (fresh > 0) ? fresh : -fresh;
                long long send =
                    (logical < afresh) ? logical : afresh;
                if (send <= 0) {
                    pending = true;
                    continue;
                }
                std::string rsid = SweepRemainderTag(
                    epoch, ps[i].symbol, send);
                char rhcoid[65] = {0};
                if (!broker::MakeClientOrderId(
                        cfg_.venue.broker, cfg_.venue.account,
                        cfg_.venue.context_hash, ps[i].symbol,
                        eside, rsid.c_str(), rhcoid))
                    continue;
                broker::OrderQuery rpre =
                    adapter_.QueryOnce(rhcoid);
                NoteQuarantineSym(ps[i].symbol, rpre.status_raw,
                                  "MEDIUM", now_ns);
                if (!rpre.transport_ok) continue;
                if (rpre.transport_ok && rpre.found) {
                    broker::CloseResult rc = QueryToClose(rpre);
                    if ((rc.state == broker::CloseState::FILLED ||
                         rc.state == broker::CloseState::PARTIAL) &&
                        rc.filled_qty > 0 &&
                        !AttributeClosedQty(ps[i].symbol,
                                           rc.filled_qty,
                                           now_ns))
                        OpsRow("reconcile", ps[i].symbol,
                               "attribution-unpersisted", now_ns);
                    if (rc.state == broker::CloseState::DEAD) {
                        char tb[280];
                        std::snprintf(tb, sizeof(tb),
                                        "medium-sweep-exhausted sym=%.15s",
                                        ps[i].symbol);
                        OpsRow("drift-directive", "runner", tb,
                               now_ns);
                        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                              "sweep-exhausted", tb, now_ns);
                    } else {
                        pending = true;
                    }
                    continue;
                }
                broker::CloseResult c2 = adapter_.MarketClose(
                    ps[i].symbol, send, eside, rhcoid);
                if (c2.transport_ok) {
                    pending = true;
                    char tb[280];
                    std::snprintf(tb, sizeof(tb),
                                    "medium-sweep sym=%.15s qty=%lld "
                                    "id=%.60s",
                                    ps[i].symbol, send,
                                    rsid.c_str());
                    OpsRow("drift-directive", "runner", tb,
                           now_ns);
                }
                // Lookup failure: retry next cycle (no blind send).
                continue;
            }
            if (pre.transport_ok && !pre.found) {
                if (covered) {
                    // Owned locally: wait for it (pending carries
                    // the FSM) — never a competing sweep close.
                    pending = true;
                    continue;
                }
                broker::CloseResult c = adapter_.MarketClose(
                    ps[i].symbol, aq, eside, hcoid);
                if (c.transport_ok) {
                    pending = true;
                    char tb[280];
                    std::snprintf(tb, sizeof(tb),
                                    "medium-sweep sym=%.15s qty=%lld "
                                    "id=%.60s",
                                    ps[i].symbol, aq,
                                    sid.c_str());
                    OpsRow("drift-directive", "runner", tb,
                           now_ns);
                }
                // Lookup failure: retry next cycle (no blind send).
            }
        }
    }
    if (AllFlat() && BrokerConfirmedFlat()) {
        // Certified flatten only: local flat AND broker-confirmed
        // flat (a missing/failing seam retains the in-progress
        // FSM — AllFlat alone never certifies, doc 06 sec. 6.1b).
        // A failed FSM write keeps the previous file state +
        // alerts (never a reported closure the files deny); the
        // next cycle retries.
        if (!AtomicWrite(mp.c_str(), "FLATTENED")) {
            OpsRow("reconcile", "runner",
                   "medium-flatten-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-flatten-unpersisted", "", now_ns);
            return true;
        }
        OpsRow("reconcile", "runner", "medium-flat", now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "medium-flat",
              "all positions flat", now_ns);
        return true;
    }
    // Not flat: PENDING while flatten work is outstanding OR an
    // achieved flatten covers the remaining open (completed close
    // whose entry machine still claims filled — S2/human
    // attributes it; re-flattening would over-close). ACTIVE only
    // while open risk has NO flatten coverage at all (venue
    // blocked or nothing ordered yet — retry next cycle).
    bool covered = pending;
    for (std::size_t i = 0; i < slots_.size() && !covered; ++i) {
        const Slot& s = slots_[i];
        if (!s.active || s.done) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (IsTerminalState(s.m.state)) continue;
        if (s.m.filled_qty - s.m.exit_closed_qty <= 0) continue;
        std::string fid =
            std::string(s.intent.intent_id) + "-flatten";
        const Slot* fs = Find(fid.c_str());
        if (fs && !fs->done) covered = true;
        if (JournalIntentState(cfg_.dir, fid.c_str()) == 2)
            covered = true;  // terminal close on file
    }
    // Control-state writes are load-bearing: a failed persist keeps
    // the previous file state (the rename never happened) + alerts;
    // the next cycle retries the transition from the file.
    if (covered) {
        if (cur != "FLATTEN_PENDING" &&
            !AtomicWrite(mp.c_str(), "FLATTEN_PENDING")) {
            OpsRow("reconcile", "runner",
                   "medium-fsm-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-fsm-unpersisted", "FLATTEN_PENDING",
                  now_ns);
        }
    } else if (cur != "MEDIUM_ACTIVE" &&
               !AtomicWrite(mp.c_str(), "MEDIUM_ACTIVE")) {
        OpsRow("reconcile", "runner",
               "medium-fsm-unpersisted", now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "medium-fsm-unpersisted", "MEDIUM_ACTIVE", now_ns);
    }
    return true;
}

bool G0Runner::Dispatch(Slot& s, const exec::RouteOut& o,
                        long long now_ns) {
    using exec::RouteAction;
    char body[280];
    switch (o.action) {
        case RouteAction::WRITE_JOURNAL:
            s.has_journal = true;
            if (BodyFor("intent", s.intent, s.intent.qty_shares,
                        "submit", body, sizeof(body)) &&
                JournalWrite(o.journal_kind, s.intent.intent_id, body,
                             now_ns)) {
                s.journal_ok = true;
            } else {
                s.journal_ok = false;
            }
            return false;
        case RouteAction::SEND_PROTECTED: {
            broker::ProtectedOrder po{};
            CopyStr(po.symbol, sizeof(po.symbol), s.intent.symbol);
            po.side = s.intent.side;
            po.qty_shares = s.intent.qty_shares;
            po.stop_cents = s.intent.stop_cents;
            po.tp_cents = s.intent.tp_cents;
            CopyStr(po.client_order_id, sizeof(po.client_order_id), o.next.client_id);
            CopyStr(po.intent_id, sizeof(po.intent_id), s.intent.intent_id);
            // Crash-window dedupe (doc 06 sec. 6.1: never
            // double-send): a pre-crash POST may have landed after
            // the last persisted snapshot. Query by the SAME stable
            // id first — found = adopt the ack (never re-POST);
            // 404-absent = POST; lookup failure = ambiguous ack
            // (the router reconciles under the same id, never
            // sends blind).
            s.has_ack = true;
            s.query_due = false;
            // True only when this dispatch POSTed (adopted acks and
            // read-only pre-flights never count — the persist that
            // follows is load-bearing exactly when the broker
            // changed state).
            bool posted = false;
            broker::OrderQuery pre =
                adapter_.QueryOnce(po.client_order_id);
            if (pre.transport_ok && pre.found) {
                s.ack = broker::OrderAck();
                s.ack.accepted = true;
                s.ack.transport_ok = true;
                s.ack.filled_qty = pre.filled_qty;
                if (pre.broker_order_id[0] != '\0')
                    CopyStr(s.ack.broker_order_id,
                            sizeof(s.ack.broker_order_id),
                            pre.broker_order_id);
                s.ack.protection_accepted =
                    pre.protection_active || pre.bracket_class;
                s.query_due = true;
            } else if (pre.transport_ok && !pre.found) {
                s.ack = adapter_.SubmitProtected(po);
                s.query_due = true;  // send resolved: query now due
                posted = true;
            } else {
                s.ack = broker::OrderAck();  // ambiguous: reconcile
                s.query_due = true;
            }
            return posted;
        }
        case RouteAction::QUERY_ONCE:
            s.has_query = true;
            s.query = adapter_.QueryOnce(s.m.client_id);
            return false;
        case RouteAction::EXECUTE_EXIT:
        case RouteAction::EXECUTE_EMERGENCY: {
            broker::OrderSide eside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            // Same crash-window dedupe as SEND_PROTECTED: the
            // close may already exist under this stable id —
            // adopt it via QueryToClose instead of re-POSTing.
            s.has_exit = true;
            s.has_journal = false;
            bool closed_posted = false;
            broker::OrderQuery pre =
                adapter_.QueryOnce(o.next.client_id);
            if (pre.transport_ok && pre.found) {
                NoteQuarantine(s, pre, "S2", now_ns);
                s.exit_ack = QueryToClose(pre);
            } else if (pre.transport_ok && !pre.found) {
                s.exit_ack = adapter_.MarketClose(
                    s.intent.symbol, o.exit_qty, eside,
                    o.next.client_id);
                closed_posted = true;
            } else {
                s.exit_ack =
                    broker::CloseResult();  // ambiguous: reconcile
            }
            return closed_posted;
        }
        case RouteAction::BUFFER_EMERGENCY: {
            journal::Row r;
            if (BodyFor("exit", s.intent, s.m.exit_closed_qty,
                        "emergency-buffered", body, sizeof(body)) &&
                journal::FormatRow(next_seq_, now_ns, "exit",
                                   s.intent.intent_id,
                                   PayloadHash(body).c_str(),
                                   prev_hash_.c_str(), &r) &&
                EmergencyAppend(r)) {
                prev_hash_ = r.row_hash;
                ++next_seq_;
            }
            return false;
        }
        case RouteAction::CANCEL_REMAINDER: {
            // No UUID (identity never established) -> reconcile by
            // client ID first (404 = nothing to cancel; found =
            // real UUID for DELETE). Never DELETE blind.
            if (s.m.broker_id[0] == '\0') {
                broker::OrderQuery q =
                    adapter_.QueryOnce(s.m.client_id);
                if (q.transport_ok && !q.found) {
                    s.has_journal = false;
                    s.has_cancel_result = true;  // marker: confirmed
                    s.cancel_accepted = true;    // absent-direct path
                    s.absent_cancel = true;
                    return false;
                }
                if (q.transport_ok && q.found &&
                    q.broker_order_id[0] != '\0') {
                    CopyStr(s.m.broker_id, sizeof(s.m.broker_id),
                            q.broker_order_id);
                }
            }
            s.has_cancel_result = true;
            s.absent_cancel = false;
            broker::CancelResult c =
                adapter_.Cancel(s.m.broker_id);
            s.cancel_accepted = c.accepted;
            s.cancel_failed = c.failed;
            return true;  // DELETE is broker-mutating
        }
        case RouteAction::CONFIRM_CANCELLED: {
            if (++s.confirm_tries > 6) {
                // Confirmation never lands: explicit failure, never
                // an infinite re-check loop (UNKNOWN + freeze).
                s.has_cancel_result = true;
                s.absent_cancel = false;
                s.cancel_accepted = false;
                s.cancel_failed = true;
                return false;
            }
            broker::OrderQuery q = adapter_.QueryOnce(s.m.client_id);
            if (q.transport_ok && q.found && q.cancelled) {
                s.has_journal = false;
                s.has_cancel_result = true;
                s.absent_cancel = false;
                // cancel_confirmed is fed via forced_q path below
                s.has_forced_q = true;
                s.forced_q = q;
                s.cancel_via_query = true;
            } else {
                s.has_cancel_result = true;
                s.absent_cancel = false;
                s.cancel_accepted = false;
                s.cancel_failed = false;
            }
            return false;
        }
        case RouteAction::ESTABLISH_PROTECTION: {
            broker::ProtectedOrder po{};
            CopyStr(po.symbol, sizeof(po.symbol), s.intent.symbol);
            po.side = (s.intent.side == broker::OrderSide::BUY)
                          ? broker::OrderSide::BUY
                          : broker::OrderSide::SELL;
            po.qty_shares = s.m.filled_qty > 0 ? s.m.filled_qty
                                               : s.intent.qty_shares;
            po.stop_cents = s.intent.stop_cents;
            po.tp_cents = s.intent.tp_cents;
            // Own deterministic sub-identity (never the entry id:
            // the venue rejects duplicate client_order_id). Same
            // crash-window dedupe as sends: found = adopt (an
            // existing repair proves protection only when its legs
            // do); 404 = POST once under the repair id; failure =
            // ambiguous (the router flattens — doc 06 sec. 6.1 OR).
            broker::OrderSide pside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            char rcoid[65] = {0};
            s.has_repair = true;
            s.repair_ok = false;
            if (!RepairClientId(cfg_.venue.broker,
                                cfg_.venue.account,
                                cfg_.venue.context_hash,
                                s.intent.symbol, pside,
                                s.intent.intent_id, rcoid)) {
                OpsRow("reconcile", s.intent.intent_id,
                       "repair-id-unrepresentable", now_ns);
                return false;
            }
            CopyStr(s.repair_coid, sizeof(s.repair_coid), rcoid);
            s.has_repair_id = true;
            CopyStr(po.client_order_id, sizeof(po.client_order_id),
                      rcoid);
            CopyStr(po.intent_id, sizeof(po.intent_id),
                      s.intent.intent_id);
            bool posted = false;
            broker::OrderQuery pre = adapter_.QueryOnce(rcoid);
            NoteQuarantine(s, pre, "S2", now_ns);
            if (pre.transport_ok && pre.found) {
                s.repair_ok = pre.protection_active ||
                              pre.bracket_class;
            } else if (pre.transport_ok && !pre.found) {
                s.repair_ok = adapter_.EstablishProtection(po);
                posted = true;
            }
            return posted;
        }
        case RouteAction::FLATTEN_NOW:
            FlattenOnMedium(s, now_ns);
            s.has_journal = false;
            s.journal_ok = false;
            return false;
        case RouteAction::JOURNAL_FILL:
        case RouteAction::JOURNAL_PARTIAL:
        case RouteAction::JOURNAL_CANCEL:
        case RouteAction::JOURNAL_UNKNOWN:
        case RouteAction::JOURNAL_EXIT:
        case RouteAction::JOURNAL_REPAIR: {
            const char* detail = o.reason ? o.reason : "";
            long long q = s.m.filled_qty;
            if (o.action == RouteAction::JOURNAL_EXIT)
                q = s.m.exit_closed_qty;
            s.has_journal = true;
            if (BodyFor(o.journal_kind, s.intent, q, detail, body,
                        sizeof(body)) &&
                JournalWrite(o.journal_kind, s.intent.intent_id, body,
                             now_ns)) {
                s.journal_ok = true;
            } else {
                s.journal_ok = false;
            }
            if (o.action == RouteAction::JOURNAL_UNKNOWN) {
                FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
            }
            return false;
        }
        case RouteAction::NONE:
        case RouteAction::REJECT:
        default:
            return false;
    }
}

bool G0Runner::Cycle(long long now_ns) {
    if (now_ns <= 0 || !deps_.now_ns) return false;
    // Lifecycle first, like SubmitIntent: no mutation without a
    // successful Recover (doc 06 sec. 6.1b).
    if (!recovered_ || !lock_took_) return false;
    // Deferred reclamation: done slots leave now (history stays in
    // journal + snapshots). Find-after-terminal within the SAME
    // cycle still sees the slot — the sweep only runs here and at
    // SubmitIntent, never mid-drive.
    ReclaimDone();
    // 1. STAGE re-read every cycle (demotions apply immediately).
    const char* sr = nullptr;
    if (!StageGateG0(P("STAGE").c_str(), &sr)) {
        stage_ok_ = false;
        Alert(P("alerts.jsonl").c_str(), "HARD", "stage-invalid",
              sr ? sr : "", now_ns);
    } else {
        stage_ok_ = true;
    }
    // 2. Kill/HALT (exits stay alive at every level).
    kill::KillInputs ki;
    if (deps_.kill_inputs)
        deps_.kill_inputs(deps_.kill_ctx, &ki);
    else
        ki = kill::KillInputs();
    if (HardHalted()) ki.halt_file = true;
    kill::LevelResult lr = kill::EvaluateLevel(ki);
    if (lr.level == jev::risk::KillLevel::HARD)
        return HardStop(now_ns, lr.reason, ki.halt_file);
    // A clean non-HARD cycle with no HALT ends any HARD incident:
    // truncate the epoch file (best-effort) so the next HARD mints
    // fresh instead of reusing a stale incident's ids. Clearing
    // HALT is what ends the incident — a human owns the interim.
    if (!ki.halt_file) {
        // Read-first: the common cycle pays one small read, and
        // only the transition cycle pays the truncate.
        std::vector<std::string> hlns;
        if (ReadLines(P("hard-incident.txt").c_str(), &hlns) &&
            !hlns.empty()) {
            AtomicWrite(P("hard-incident.txt").c_str(), "");
        }
        // The order chain belongs to the incident: it goes with
        // it (a new incident re-derives every id by pre-flight).
        std::vector<std::string> clns;
        if (ReadLines(P("hard-chain.txt").c_str(), &clns) &&
            !clns.empty()) {
            AtomicWrite(P("hard-chain.txt").c_str(), "");
        }
    }
    // Leaving MEDIUM with the FSM file present finalizes it once:
    // flat + BROKER-CERTIFIED -> FLATTENED, else (provably not
    // flat) PROTECTION_ONLY (stops/TP own the remainder — never a
    // silent return to normal). Uncertified-flat (no seam to prove
    // it) leaves the file in progress — AllFlat() alone never
    // certifies an incident over (doc 06 sec. 6.1b).
    // A closed incident is then AUTO-CLEARED with its epoch file
    // — but ONLY when the broker confirms flat AND (the file says
    // FLATTENED or local is flat too): never clear what cannot be
    // seen. The next automatic MEDIUM trigger re-enters fresh
    // (new epoch); no operator file edit is required.
    // Crash-mid-incident keeps in-progress files (exposure
    // present or seam blind), so its epoch is reused.
    if (lr.level != jev::risk::KillLevel::MEDIUM) {
        // Leaving MEDIUM finalizes the persisted FSM — but only
        // after the same centralized validation (a malformed
        // file is refused here too, never rewritten into a
        // legitimate-looking state).
        std::string mcur;
        MediumFsmRead mfr =
            ReadMediumFsm(P("medium.txt").c_str(), &mcur);
        if (mfr == MediumFsmRead::CORRUPT) {
            // Corrupt incident FSM while leaving MEDIUM: finalize
            // nothing, fail the cycle loud — human owns it.
            OpsRow("reconcile", "runner", "medium-fsm-corrupt",
                   now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-fsm-corrupt", "", now_ns);
            return false;
        }
        if (mfr == MediumFsmRead::UNKNOWN) {
            OpsRow("reconcile", "runner", "medium-fsm-unknown",
                   now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-fsm-unknown", "", now_ns);
            return false;
        }
        // Clear invariant (doc 06 sec. 6.1b): auto-clear runs
        // ONLY after a terminal FSM state was successfully
        // persisted AND revalidated from disk in this cycle. An
        // entry-validated FLATTENED/PROTECTION_ONLY qualifies
        // (ReadMediumFsm read it this cycle); anything else must
        // be written now and read back before any clear.
        bool term_ok =
            (mcur == "FLATTENED" || mcur == "PROTECTION_ONLY");
        if (!mcur.empty() && !term_ok) {
            if (AllFlat() && BrokerConfirmedFlat()) {
                bool wrote = AtomicWrite(P("medium.txt").c_str(),
                                         "FLATTENED");
                std::string re;
                if (wrote && ReadMediumFsm(P("medium.txt").c_str(),
                                           &re) ==
                                 MediumFsmRead::OK &&
                    re == "FLATTENED") {
                    mcur = "FLATTENED";
                    term_ok = true;
                } else {
                    Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                          "medium-fsm-unpersisted", "FLATTENED",
                          now_ns);
                }
            } else if (!AllFlat()) {
                if (!AtomicWrite(P("medium.txt").c_str(),
                                 "PROTECTION_ONLY")) {
                    Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                          "medium-fsm-unpersisted",
                          "PROTECTION_ONLY", now_ns);
                } else {
                    Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                          "protection-only",
                          "stops own the remainder", now_ns);
                    OpsRow("drift-directive", "runner",
                           "medium-protection-only", now_ns);
                }
            }
        }
        if (StatPath(P("medium.txt").c_str()) ==
                PathKind::CORRUPT) {
            // Corrupt incident FSM at auto-clear: clear nothing,
            // fail loud — human owns it.
            OpsRow("reconcile", "runner", "medium-fsm-corrupt",
                   now_ns);
            Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                  "medium-fsm-corrupt", "", now_ns);
            return false;
        }
        std::vector<std::string> clns;
        if (term_ok && ReadLines(P("medium.txt").c_str(), &clns) &&
            !clns.empty() && BrokerConfirmedFlat() &&
            (mcur == "FLATTENED" || LocalFlat())) {
            if (ClearMediumFiles()) {
                OpsRow("drift-directive", "runner",
                       "medium-incident-cleared", now_ns);
            } else {
                Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                      "medium-clear-unpersisted", "", now_ns);
            }
        }
    } else {
        if (!MediumPass(now_ns)) return false;
    }
    if (ki.halt_file && !halt_announced_) {
        Alert(P("alerts.jsonl").c_str(), "SOFT", "halt-present",
              "entries stopped, exits alive", now_ns);
        halt_announced_ = true;
    }
    if (!ki.halt_file) halt_announced_ = false;
    // 3. Stream drain (bounded per cycle) + slot match by client id.
    if (deps_.stream_read) {
        char buf[4096];
        int budget = 65536;
        while (budget > 0) {
            int n = deps_.stream_read(deps_.stream_ctx, buf,
                                      (int)sizeof(buf));
            // Transport contract: 0 <= n <= sizeof(buf). A
            // negative or overlong return is a real feed fault
            // (loud journal + alert, never silent no-data, never
            // an over-read of the stack buffer).
            if (n < 0 || n > (int)sizeof(buf)) {
                OpsRow("drift-directive", "runner",
                       "stream-read-fault", now_ns);
                Alert(P("alerts.jsonl").c_str(), "FEED",
                      "stream-read-fault", "bad read length",
                      now_ns);
                break;
            }
            if (n == 0) break;
            sse_.Feed(buf, (std::size_t)n);
            budget -= n;
        }
        SseEvent ev;
        while (sse_.Next(&ev)) {
            StreamObs so = MapTradeEvent(ev);
            if (so.kind == StreamKind::NONE) continue;
            // Account-level cursor: every successfully parsed venue
            // event advances the durable replay position — matched
            // to a live slot or not (unmatched events move only the
            // cursor, never router state; stalling on foreign orders
            // would replay forever under since_id).
            if (so.event_id[0] != '\0') {
                cursor_ = so.event_id;
                cursor_dirty_ = true;
            }
            for (std::size_t i = 0; i < slots_.size(); ++i) {
                Slot& s = slots_[i];
                if (!s.active || s.done || s.frozen) continue;
                if (!SameId(s.m.client_id, so.client_id)) continue;
                // Duplicate delivery drops at the seam: already
                // applied (== machine ULID) or already queued.
                // Overflow never silently loses position: flag +
                // force REST + alert at the slot pass below.
                if (so.event_id[0] != '\0' &&
                    std::strcmp(so.event_id, s.m.last_event_id) ==
                        0)
                    continue;
                bool dup = false;
                // ULID-less events are never deduped (no identity
                // to compare — each one stamps/shapes in turn).
                if (so.event_id[0] != '\0') {
                    for (int qi = 0; qi < s.sev_n_; ++qi) {
                        if (std::strcmp(s.sev_[qi].id, so.event_id) ==
                            0) {
                            dup = true;
                            break;
                        }
                    }
                }
                if (dup) continue;
                if (s.sev_n_ >= Slot::kStreamQ) {
                    s.stream_overflow_ = true;
                    continue;
                }
                StreamEvt qe;
                CopyStr(qe.id, sizeof(qe.id), so.event_id);
                qe.kind = so.kind;
                qe.cumulative = so.filled_qty;  // order cumulative
                qe.force = (so.kind != StreamKind::FILL);
                s.sev_[s.sev_n_++] = qe;
            }
        }
        // Parser failures are control-flow, not just a counter:
        // alert + reconcile journal row + nudge every live slot to
        // a real lookup (a good held answer still suppresses the
        // extra query — MaybeForce owns that call).
        if (sse_.errors() != sse_seen_) {
            sse_seen_ = sse_.errors();
            Alert(P("alerts.jsonl").c_str(), "FEED", "sse-error",
                  "parser dropped input; reconciling", now_ns);
            char ebody[280];
            std::snprintf(ebody, sizeof(ebody),
                            "sse-errors count=%lld", sse_seen_);
            if (jev::journal::RedactionOk(ebody))
                JournalWrite("reconcile", "runner", ebody,
                             now_ns);
            for (std::size_t i = 0; i < slots_.size(); ++i) {
                if (slots_[i].active && !slots_[i].done)
                    slots_[i].last_s2_ns = 0;
            }
        }
    }
    // 4. Drive every slot (bounded iterations; persist on change).
    // S2/refresh runs FIRST so fresh answers feed this same cycle.
    // Account position check rides the same cadence (drift journals
    // + alerts + forces per-symbol re-lookup; never orders).
    PositionCheck(now_ns);
    // Overflow (queue full dropped position) fails closed here:
    // alert + force a real lookup on the next pass.
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        Slot& s = slots_[i];
        if (!s.active || s.done || s.frozen) continue;
        if (s.stream_overflow_) {
            s.stream_overflow_ = false;
            Alert(P("alerts.jsonl").c_str(), "FEED",
                  "stream-overflow",
                  s.intent.intent_id, now_ns);
            s.last_s2_ns = 0;
        }
    }
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        Slot& s = slots_[i];
        if (!s.active || s.done || s.frozen) continue;
        MaybeForceQuery(s, now_ns);
        for (int it = 0; it < 12; ++it) {
            exec::RouteObs obs;
            bool have_answer = false;  // REST beat stream this iter
            // Identity tag (established machines only).
            if (s.m.state != exec::RouteState::IDLE &&
                s.m.client_id[0] != '\0') {
                CopyStr(obs.client_id, sizeof(obs.client_id), s.m.client_id);
            }
            obs.kill = lr.level;
            obs.feed_stale = ki.feed_stale_gt30s;
            // Stage permission rides the per-cycle STAGE verdict:
            // entries need a verified G0 file, exits never do.
            obs.stage_entry_ok = stage_ok_;
            obs.symbol_frozen =
                FreezeHas(P("freeze.txt").c_str(), s.intent.symbol);
            if (s.has_journal) {
                obs.journal_ok = s.journal_ok;
                s.has_journal = false;
            }
            if (s.has_ack) {
                obs.adapter_responded = true;
                obs.ack = s.ack;
                s.has_ack = false;
            }
            if (s.query_due) {
                obs.query_due = true;
                s.query_due = false;
            }
            if (s.has_query) {
                if (!s.query.transport_ok && s.has_forced_q &&
                    s.forced_q.transport_ok) {
                    // Stale transport noise loses to a good held
                    // answer (authoritative beats failed, any age).
                    s.has_query = false;
                } else {
                    obs.adapter_responded = true;
                    NoteQuarantine(s, s.query, "S2", now_ns);
                    obs.query = s.query;
                    s.has_query = false;
                    have_answer = true;
                    // A fresh dispatch answer supersedes any held
                    // trigger (S2/bust): drop the stale forced answer.
                    s.has_forced_q = false;
                }
            }
            if (s.has_exit) {
                obs.exit_responded = true;
                obs.exit_ack = s.exit_ack;
                s.has_exit = false;
            }
            if (s.has_cancel_result) {
                obs.adapter_responded = true;
                if (s.absent_cancel) {
                    // Client-ID lookup proved absent: definitive
                    // final-cancel observation (no UUID, no DELETE).
                    obs.cancel_confirmed = true;
                    obs.cancel_filled_qty = 0;
                } else {
                    obs.cancel_accepted = s.cancel_accepted;
                    obs.cancel_failed = s.cancel_failed;
                }
                s.has_cancel_result = false;
            }
            if (s.cancel_via_query) {
                obs.adapter_responded = true;
                obs.cancel_confirmed = true;
                if (s.has_forced_q && s.forced_q.filled_qty >= 0)
                    obs.cancel_filled_qty = s.forced_q.filled_qty;
                s.cancel_via_query = false;
                s.has_forced_q = false;
            }
            if (s.has_repair) {
                obs.adapter_responded = true;
                obs.repair_ok = s.repair_ok;
                s.has_repair = false;
            }
            if (s.executed_flag) {
                obs.executed = true;
                s.executed_flag = false;
            }
            // Crash seam: IDLE machines rebuilt from a journaled
            // row (snapshot lost pre-first-persist) skip the WRITE
            // via obs.intent_rowed; the JOURNAL_PENDING step then
            // consumes this recovery attestation (the row is IN the
            // verified chain — attested, not synthetic).
            if (s.m.state == exec::RouteState::IDLE)
                obs.intent_rowed = s.intent_rowed;
            if (s.intent_rowed &&
                s.m.state == exec::RouteState::JOURNAL_PENDING &&
                !s.has_journal) {
                obs.journal_ok = true;
                s.intent_rowed = false;
            }
            // Queue head stamps first (one event per iteration —
            // the seam never collapses several events into one).
            // ULID-less heads carry no stampable identity: a FILL
            // shapes directly from cumulative, LIFE/BUST funnel to
            // forced REST now (never parked behind a stamp that
            // cannot happen).
            while (s.sev_n_ > 0 && s.sev_[0].id[0] == '\0') {
                if (s.sev_[0].kind == StreamKind::FILL) {
                    s.has_shaping = true;
                    s.shaping_qty = s.sev_[0].cumulative;
                } else if (!s.has_forced_q ||
                           !s.forced_q.transport_ok) {
                    s.forced_q =
                        adapter_.QueryOnce(LookupIdFor(s));
                    s.has_forced_q = true;
                    s.last_s2_ns = now_ns;
                }
                ShiftStreamQ(s);
            }
            bool fed_event = (s.sev_n_ > 0);
            if (fed_event) {
                CopyStr(obs.event_id, sizeof(obs.event_id),
                        s.sev_[0].id);
            }
            // Forced REST answer: consumed where the machine reads
            // it, else held. QUERY_SENT takes the query; EXIT states
            // take the close mapping; CANCEL_SENT takes a cancelled
            // verdict as its confirmation; REPAIR_SENT takes a
            // positively proven protection verdict. Anything else
            // (or a failed lookup) holds for S2/refresh.
            bool fed_forced = false;
            if (s.has_forced_q && !fed_event) {
                if (s.m.state == exec::RouteState::QUERY_SENT) {
                    obs.adapter_responded = true;
                    NoteQuarantine(s, s.forced_q, "S2", now_ns);
                    obs.query = s.forced_q;
                    s.has_forced_q = false;
                    s.has_shaping = false;  // REST supersedes
                    fed_forced = true;
                    have_answer = true;
                } else if (s.m.state ==
                               exec::RouteState::EXIT_SENT ||
                           s.m.state ==
                               exec::RouteState::EXIT_EMERGENCY) {
                    NoteQuarantine(s, s.forced_q, "S2", now_ns);
                    broker::CloseResult c =
                        QueryToClose(s.forced_q);
                    if (c.transport_ok) {
                        obs.exit_responded = true;
                        obs.exit_ack = c;
                        s.has_forced_q = false;
                        s.has_shaping = false;  // REST supersedes
                        fed_forced = true;
                        have_answer = true;
                    }
                } else if (s.m.state ==
                               exec::RouteState::CANCEL_SENT &&
                           s.forced_q.transport_ok &&
                           s.forced_q.found && s.forced_q.cancelled) {
                    obs.adapter_responded = true;
                    obs.cancel_confirmed = true;
                    obs.cancel_filled_qty = s.forced_q.filled_qty;
                    s.has_forced_q = false;
                    s.has_shaping = false;  // REST supersedes
                    fed_forced = true;
                    have_answer = true;
                } else if (s.m.state ==
                               exec::RouteState::REPAIR_SENT &&
                           s.forced_q.transport_ok &&
                           s.forced_q.found &&
                           (s.forced_q.protection_active ||
                            s.forced_q.bracket_class)) {
                    obs.adapter_responded = true;
                    NoteQuarantine(s, s.forced_q, "S2", now_ns);
                    obs.repair_ok = true;
                    s.has_forced_q = false;
                    s.has_shaping = false;  // REST supersedes
                    fed_forced = true;
                    have_answer = true;
                }
            }
            // A stamped FILL shapes here (CUMULATIVE order qty —
            // never per-event qty). REST answers always win ties
            // (authoritative snapshot over event): shaping applies
            // only with no event stamped and no query answer pending
            // this iteration.
            if (s.has_shaping && !fed_event && !fed_forced &&
                !have_answer) {
                long long rem = s.intent.qty_shares -
                                s.m.exit_closed_qty;
                ShapedFill f = ShapeStreamFill(s.m.state, rem,
                                               s.shaping_qty);
                if (f.feed_query) {
                    obs.adapter_responded = true;
                    obs.query = f.q;
                    // The shaped event carries no UUID: never let
                    // an empty id clobber the established broker
                    // identity (cancel path needs it).
                    if (s.m.broker_id[0] != '\0') {
                        for (int bi = 0; bi < 64; ++bi)
                            obs.query.broker_order_id[bi] =
                                s.m.broker_id[bi];
                    }
                    s.has_shaping = false;
                } else if (f.feed_close) {
                    obs.exit_responded = true;
                    obs.exit_ack = f.c;
                    s.has_shaping = false;
                }
            }
            exec::RouteOut o =
                exec::RouteStep(s.m, s.intent, cfg_.venue, obs);
            // Stamp accounting on the fed head: stamped -> shape
            // (FILL cumulative) / force (LIFE/BUST) + advance the
            // durable cursor; stale/duplicate verdict -> drop.
            // Bounded compare (both fields <= 32 + NUL).
            if (fed_event && s.sev_n_ > 0) {
                bool stamped = false;
                const char* hid = s.sev_[0].id;
                for (int k = 0;
                     k < 33 && hid[k] == o.next.last_event_id[k];
                     ++k) {
                    if (hid[k] == '\0') {
                        stamped = true;
                        break;
                    }
                }
                if (stamped) {
                    if (s.sev_[0].kind == StreamKind::FILL) {
                        s.has_shaping = true;
                        s.shaping_qty = s.sev_[0].cumulative;
                    }
                    // A stamped LIFE/BUST event triggers its forced
                    // REST now (one lookup, held for consumption;
                    // S2 clock restarts so this never doubles). A
                    // held FAILED answer refreshes (stale failure
                    // never blocks fresh reconciliation); a good held
                    // answer is never stacked.
                    if (s.sev_[0].force &&
                        (!s.has_forced_q ||
                         !s.forced_q.transport_ok)) {
                        s.forced_q =
                            adapter_.QueryOnce(LookupIdFor(s));
                        s.has_forced_q = true;
                        s.last_s2_ns = now_ns;
                    }
                    if (hid[0] != '\0') {
                        cursor_ = hid;
                        cursor_dirty_ = true;
                    }
                    ShiftStreamQ(s);
                } else if (o.action == exec::RouteAction::NONE &&
                           o.reason &&
                           (std::strcmp(o.reason,
                                        "exec:stale-event") == 0 ||
                            std::strcmp(o.reason,
                                        "exec:duplicate-event") ==
                                0 ||
                            std::strcmp(o.reason,
                                        "exec:seq-conflict") == 0)) {
                    ShiftStreamQ(s);  // old news: drop
                }
            }
            bool changed = (o.next.state != s.m.state);
            s.m = o.next;
            bool mutated = Dispatch(s, o, now_ns);
            if (!PersistSlot(s)) {
                if (mutated) {
                    // Broker-mutating transport crossed a
                    // non-durable boundary (ack/close state could
                    // not be persisted): freeze LOUDLY and stop
                    // driving this slot. Continuing blind risks a
                    // post-crash double-send (identity + ack state
                    // both live only in the lost snapshot); a crash
                    // now refuses recovery instead — visible, human.
                    s.frozen = true;
                    Alert(P("alerts.jsonl").c_str(), "HARD",
                          "persist-failed", s.intent.intent_id,
                          now_ns);
                    OpsRow("unknown", s.intent.intent_id,
                           "persist-failed", now_ns);
                    break;
                }
                // Non-mutating persist failure: any journal row
                // still attests the step (crash rebuilds via the
                // rowed path or refuses) — keep driving.
            }
            if (IsTerminalState(s.m.state)) {
                // A closed EXIT proves its quantity shut: attribute
                // it to same-symbol entries (oldest first) so the
                // entry machine stops claiming provable open.
                if (s.intent.kind ==
                        jev::risk::IntentKind::EXIT &&
                    s.m.state == exec::RouteState::CLOSED &&
                    s.m.exit_closed_qty > 0 &&
                    !AttributeClosedQty(s.intent.symbol,
                                       s.m.exit_closed_qty,
                                       now_ns))
                    OpsRow("reconcile", s.intent.intent_id,
                           "attribution-unpersisted", now_ns);
                s.done = true;
                break;
            }
            // Quiescence: nothing pending that this state can
            // consume (a held-unfeedable forced answer waits for
            // S2/refresh, not for spinning — same for held stream
            // fills in non-consuming states).
            bool forced_live = false;
            if (s.has_forced_q) {
                if (s.m.state == exec::RouteState::QUERY_SENT) {
                    forced_live = true;  // failures advance budget
                } else if (s.forced_q.transport_ok) {
                    if (s.m.state == exec::RouteState::EXIT_SENT ||
                        s.m.state ==
                            exec::RouteState::EXIT_EMERGENCY) {
                        forced_live = true;
                    } else if (s.m.state ==
                                   exec::RouteState::CANCEL_SENT &&
                               s.forced_q.found &&
                               s.forced_q.cancelled) {
                        forced_live = true;
                    } else if (s.m.state ==
                                   exec::RouteState::REPAIR_SENT &&
                               s.forced_q.found &&
                               (s.forced_q.protection_active ||
                                s.forced_q.bracket_class)) {
                        forced_live = true;
                    }
                }
            }
            bool stream_live = (s.sev_n_ > 0 || s.has_shaping) &&
                               (s.m.state ==
                                    exec::RouteState::QUERY_SENT ||
                                s.m.state ==
                                    exec::RouteState::EXIT_SENT ||
                                s.m.state ==
                                    exec::RouteState::EXIT_EMERGENCY);
            // Queued stamps feed every non-terminal state (position
            // advances even while waiting), so they always count.
            if (s.sev_n_ > 0) stream_live = true;
            if (o.action == exec::RouteAction::NONE && !changed &&
                !s.has_journal && !s.has_ack && !s.has_query &&
                !s.has_exit && !s.has_cancel_result &&
                !s.has_repair && !forced_live && !stream_live &&
                !s.executed_flag && !s.cancel_via_query) {
                break;  // waiting on the world: end of iterations
            }
        }
    }
    last_cycle_ns_ = now_ns;
    // §6.3 rhythm on day roll (verify/copy/retain/backup/summary).
    if (!DailyOps(now_ns)) return false;
    // Durable cursor: a failed write journals + alerts, KEEPS the
    // dirty bit, and fails the cycle under the same contract as a
    // failed day-roll — loss would silently replay from a stale
    // position while reporting success. (A persisted cursor only
    // skips already-seen events; duplicates still drop at the
    // seam — never less.)
    if (cursor_dirty_) {
        if (!AtomicWrite(P("cursor.txt").c_str(),
                         cursor_.c_str())) {
            OpsRow("drift-directive", "runner",
                   "cursor-unpersisted", now_ns);
            Alert(P("alerts.jsonl").c_str(), "CURSOR",
                  "cursor-unpersisted", cursor_.c_str(),
                  now_ns);
            return false;
        }
        cursor_dirty_ = false;
    }
    return true;
}

bool G0Runner::Summarize(Summary* out) const {
    return SummarizeJournal(P("journal.jsonl").c_str(), out);
}

}  // namespace runner
}  // namespace jev
