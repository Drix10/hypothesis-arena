// H1 integration — G0 runner implementation. See runner.hpp for
// the ownership boundary. Deterministic under injected seams;
// single-writer (the operator starts one instance per dir).
#include "runner.hpp"

#include <cstdio>
#include <cstring>

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
    // SubmitIntent enforces slots_.size() <= max_slots, so this
    // capacity is never exceeded: Slot& refs stay valid when
    // MEDIUM-flatten appends mid-cycle (no reallocation, ever).
    slots_.reserve((std::size_t)(cfg_.max_slots > 0 ? cfg_.max_slots
                                                     : 16));
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
    if (!deps_.now_ns) {
        if (reason) *reason = "recover-no-clock";
        return false;
    }
    if (!StageGateG0(P("STAGE").c_str(), nullptr)) {
        if (reason) *reason = kStage;
        return false;
    }
    stage_ok_ = true;
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
    // Durable stream cursor (missing = first run, empty cursor).
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
    slots_.clear();
    std::vector<std::string> ids;
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
        if (term) continue;
        // Deduplicate (a duplicated intent row is itself a chain
        // anomaly: first wins, alerted, never two slots).
        bool seen = false;
        for (std::size_t k = 0; k < ids.size(); ++k) {
            if (ids[k] == rows[i].intent_id) {
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
    }
    for (std::size_t i = 0; i < ids.size(); ++i) {
        char rec[320];
        bool has_snap = LoadSnapshot(
            SnapPath(ids[i].c_str()).c_str(), rec, sizeof(rec));
        IntentDesc id;
        bool has_intent = LoadIntent(
            IntentPath(ids[i].c_str()).c_str(), &id);
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
                if (slots_.size() >= (std::size_t)cfg_.max_slots)
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
        if (slots_.size() >= (std::size_t)cfg_.max_slots) break;
        Slot s;
        if (has_snap) {
            exec::RouteMachine m;
            if (!exec::RestoreMachine(rec, &m)) {
                if (reason) *reason = kSnap;
                return false;
            }
            if (IsTerminalState(m.state)) continue;
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
    if (slots_.size() >= (std::size_t)cfg_.max_slots) {
        // One deferred sweep before refusing: completed work frees
        // capacity (long runs never wedge on history).
        ReclaimDone();
    }
    if (slots_.size() >= (std::size_t)cfg_.max_slots) {
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
    } else if (!SaveIntent(ipath.c_str(), in.symbol,
                            (in.side == broker::OrderSide::BUY) ? 0
                                                                : 1,
                            is_exit ? 1 : 0, in.qty_shares,
                            in.stop_cents, in.tp_cents)) {
        if (reason) *reason = kGated;
        return false;
    }
    Slot s;
    s.intent = in;
    s.m = exec::RouteMachine();
    s.m.kind = in.kind;
    s.active = true;
    s.last_s2_ns = deps_.now_ns ? deps_.now_ns(deps_.clock_ctx) : 0;
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
    bool halt = FileExists(P("HALT").c_str());
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
    // budget still bounds router-emitted QUERY_ONCE).
    bool due = (now_ns - s.last_s2_ns) >=
               deps_.s2_seconds * 1000000000LL;
    if (!due) return;
    s.forced_q = adapter_.QueryOnce(s.m.client_id);
    s.has_forced_q = true;
    s.last_s2_ns = now_ns;
}

bool G0Runner::FlattenOnMedium(Slot& s, long long now_ns) {
    if (!s.active || s.done) return true;
    if (s.intent.kind != jev::risk::IntentKind::ENTRY) return true;
    if (IsTerminalState(s.m.state)) return true;
    if (s.m.filled_qty <= 0) return true;  // nothing to flatten
    if (s.flatten_armed) return true;
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
    int js = JournalIntentState(cfg_.dir, fid0.c_str());
    if (js == 2) {
        s.flatten_armed = true;
        return true;
    }
    if (js == 1) {
        FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM",
              "flatten-orphan", s.intent.intent_id, now_ns);
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

void G0Runner::HardManageSlot(Slot& s, long long now_ns) {
    // §10.3 per-position pass (best-effort transport, journaled):
    // reconcile -> verify broker-native protection (re-establish
    // if missing and possible) -> flatten/cancel attempt. NEVER
    // destructive: failures leave protection active; the process
    // terminates right after regardless.
    if (!s.active || s.done || IsTerminalState(s.m.state)) return;
    if (s.m.client_id[0] == '\0') return;  // never sent: no risk
    broker::OrderQuery q = adapter_.QueryOnce(s.m.client_id);
    if (!q.transport_ok) {
        OpsRow("drift-directive", s.intent.intent_id,
               "hard-manage lookup-failed", now_ns);
        return;
    }
    bool is_exit = (s.intent.kind == jev::risk::IntentKind::EXIT);
    if (!is_exit) {
        long long open =
            s.m.filled_qty - s.m.exit_closed_qty;
        bool prot = q.protection_active || q.bracket_class;
        if (!prot && q.found && open > 0) {
            // Re-establish broker-native protection if possible.
            broker::ProtectedOrder po{};
            CopyStr(po.symbol, sizeof(po.symbol), s.intent.symbol);
            po.side = s.intent.side;
            po.qty_shares = s.m.filled_qty > 0 ? s.m.filled_qty
                                               : s.intent.qty_shares;
            po.stop_cents = s.intent.stop_cents;
            po.tp_cents = s.intent.tp_cents;
            CopyStr(po.client_order_id, sizeof(po.client_order_id),
                      s.m.client_id);
            CopyStr(po.intent_id, sizeof(po.intent_id),
                      s.intent.intent_id);
            bool ok = adapter_.EstablishProtection(po);
            char tb[280];
            std::snprintf(tb, sizeof(tb),
                            "hard-manage id=%s reprotect=%d",
                            s.intent.intent_id, ok ? 1 : 0);
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
        if (open > 0) {
            // Attempt flatten under a deterministic hard id
            // (single pass — the process terminates after).
            std::string hid =
                std::string("hard-") + s.intent.intent_id;
            if (hid.size() > 64) hid.resize(64);
            char hcoid[65] = {0};
            broker::OrderSide eside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            if (broker::MakeClientOrderId(
                    cfg_.venue.broker, cfg_.venue.account,
                    cfg_.venue.context_hash, s.intent.symbol, eside,
                    hid.c_str(), hcoid)) {
                broker::CloseResult c = adapter_.MarketClose(
                    s.intent.symbol, open, eside, hcoid);
                char tb[280];
                std::snprintf(tb, sizeof(tb),
                                "hard-manage id=%s flatten=%d",
                                s.intent.intent_id,
                                c.transport_ok ? 1 : 0);
                OpsRow("drift-directive", s.intent.intent_id, tb,
                       now_ns);
            }
        }
        return;
    }
    // EXIT in flight: cancel attempt (never a second close — the
    // machine owns closes; HARD only tries to stop the remainder).
    if (s.m.broker_id[0] != '\0') {
        broker::CancelResult c = adapter_.Cancel(s.m.broker_id);
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "hard-manage id=%s cancel=%d",
                        s.intent.intent_id,
                        c.accepted ? 1 : 0);
        OpsRow("drift-directive", s.intent.intent_id, tb, now_ns);
    } else {
        OpsRow("drift-directive", s.intent.intent_id,
               "hard-manage exit-no-uuid", now_ns);
    }
}

bool G0Runner::HardStop(long long now_ns, const char* why) {
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
    FILE* hf = std::fopen(P("HALT").c_str(), "ab");
    if (hf) std::fclose(hf);
    for (std::size_t i = 0; i < slots_.size(); ++i)
        HardManageSlot(slots_[i], now_ns);
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
    // Signed local open per symbol over ENTRY slots only
    // (filled minus closed; exits are managers, not positions).
    long long net = 0;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active || s.done) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (IsTerminalState(s.m.state)) continue;
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
    // expectation (orphans + qty mismatch both count as drift).
    // Drift journals + alerts + forces per-symbol re-lookup; it
    // never orders (flattening is MEDIUM/HARD-owned).
    if (!deps_.list_positions) return;  // Phase-4 seam absent
    bool due = (now_ns - last_pos_ns_) >=
               deps_.s2_seconds * 1000000000LL;
    if (!due) return;
    last_pos_ns_ = now_ns;
    Position ps[64];
    int n = deps_.list_positions(deps_.positions_ctx, ps, 64);
    if (n < 0) {
        Alert(P("alerts.jsonl").c_str(), "S2",
              "positions-unavailable", "lookup failed", now_ns);
        return;
    }
    for (int i = 0; i < n; ++i) {
        if (ps[i].symbol[0] == '\0') continue;
        int local = LocalNet(ps[i].symbol);
        if ((long long)local == ps[i].qty) continue;
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "position-drift sym=%.15s local=%d broker=%lld",
                        ps[i].symbol, local, (long long)ps[i].qty);
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
}

void G0Runner::ReclaimDone() {
    for (std::size_t i = 0; i < slots_.size();) {
        if (slots_[i].active && slots_[i].done) {
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
        if (!s.active || s.done) continue;
        if (s.intent.kind != jev::risk::IntentKind::ENTRY) continue;
        if (IsTerminalState(s.m.state)) continue;
        if (s.m.filled_qty - s.m.exit_closed_qty > 0) return false;
    }
    if (deps_.list_positions) {
        Position ps[64];
        int n = deps_.list_positions(deps_.positions_ctx, ps, 64);
        if (n < 0) return false;  // unknown != flat
        for (int i = 0; i < n; ++i) {
            if (ps[i].qty != 0) return false;
        }
    }
    return true;
}

void G0Runner::MediumPass(long long now_ns) {
    // §10.3 MEDIUM + frozen FSM (medium.txt): MEDIUM_ACTIVE ->
    // FLATTEN_PENDING -> FLATTENED | PROTECTION_ONLY. Entries stop
    // at the kill gate; every open position flattens via market
    // when the venue is open and the spread is normal, else stops/
    // TP own the risk and the flatten re-attempts every cycle.
    // Re-attempts fire ONLY from ordered-but-unacked flatten work
    // (no blind re-issue); a restart reloads the file and
    // reconciles first (pre-flight dedupe never resends).
    std::string mp = P("medium.txt");
    std::vector<std::string> lns;
    std::string cur;
    if (ReadLines(mp.c_str(), &lns) && !lns.empty()) cur = lns[0];
    if (cur != "MEDIUM_ACTIVE" && cur != "FLATTEN_PENDING" &&
        cur != "FLATTENED" && cur != "PROTECTION_ONLY")
        cur.clear();
    if (cur.empty()) {
        AtomicWrite(mp.c_str(), "MEDIUM_ACTIVE");
        cur = "MEDIUM_ACTIVE";
        OpsRow("demotion", "runner", "medium-enter", now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "medium-enter",
              "entries stopped, flattening", now_ns);
    }
    if (cur == "FLATTENED") return;  // terminal: nothing to do
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
    // spread-normal only. Unknown/closed venue (or absent seam) =
    // no sweep — protection stays, retry next cycle.
    bool open = false, spread = false;
    if (VenueOk(&open, &spread) && deps_.list_positions) {
        Position ps[64];
        int n = deps_.list_positions(deps_.positions_ctx, ps, 64);
        for (int i = 0; n >= 0 && i < n; ++i) {
            if (ps[i].symbol[0] == '\0' || ps[i].qty == 0) continue;
            std::string sid = std::string("sweep-") + ps[i].symbol;
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
            broker::OrderQuery pre = adapter_.QueryOnce(hcoid);
            if (pre.transport_ok && pre.found) {
                pending = true;  // already flattening: await ack
                continue;
            }
            if (pre.transport_ok && !pre.found) {
                broker::CloseResult c = adapter_.MarketClose(
                    ps[i].symbol, aq, eside, hcoid);
                if (c.transport_ok) {
                    pending = true;
                    char tb[280];
                    std::snprintf(tb, sizeof(tb),
                                    "medium-sweep sym=%.15s qty=%lld",
                                    ps[i].symbol, aq);
                    OpsRow("drift-directive", "runner", tb,
                           now_ns);
                }
                // Lookup failure: retry next cycle (no blind send).
            }
        }
    }
    if (AllFlat()) {
        AtomicWrite(mp.c_str(), "FLATTENED");
        OpsRow("reconcile", "runner", "medium-flat", now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "medium-flat",
              "all positions flat", now_ns);
        return;
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
    if (covered) {
        if (cur != "FLATTEN_PENDING")
            AtomicWrite(mp.c_str(), "FLATTEN_PENDING");
    } else if (cur != "MEDIUM_ACTIVE") {
        AtomicWrite(mp.c_str(), "MEDIUM_ACTIVE");
    }
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
            CopyStr(po.client_order_id, sizeof(po.client_order_id), s.m.client_id);
            CopyStr(po.intent_id, sizeof(po.intent_id), s.intent.intent_id);
            s.has_repair = true;
            s.repair_ok = adapter_.EstablishProtection(po);
            return true;  // repair POST is broker-mutating
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
    if (FileExists(P("HALT").c_str())) ki.halt_file = true;
    kill::LevelResult lr = kill::EvaluateLevel(ki);
    if (lr.level == jev::risk::KillLevel::HARD)
        return HardStop(now_ns, lr.reason);
    // Leaving MEDIUM with the FSM file present finalizes it once:
    // flat -> FLATTENED, else PROTECTION_ONLY (stops/TP own the
    // remainder — never a silent return to normal).
    if (lr.level != jev::risk::KillLevel::MEDIUM) {
        std::vector<std::string> mlns;
        if (ReadLines(P("medium.txt").c_str(), &mlns) &&
            !mlns.empty() && mlns[0] != "FLATTENED" &&
            mlns[0] != "PROTECTION_ONLY") {
            if (AllFlat()) {
                AtomicWrite(P("medium.txt").c_str(), "FLATTENED");
            } else {
                AtomicWrite(P("medium.txt").c_str(),
                            "PROTECTION_ONLY");
                Alert(P("alerts.jsonl").c_str(), "MEDIUM",
                      "protection-only",
                      "stops own the remainder", now_ns);
                OpsRow("drift-directive", "runner",
                       "medium-protection-only", now_ns);
            }
        }
    } else {
        MediumPass(now_ns);
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
            if (n <= 0) break;
            sse_.Feed(buf, (std::size_t)n);
            budget -= n;
        }
        SseEvent ev;
        while (sse_.Next(&ev)) {
            StreamObs so = MapTradeEvent(ev);
            if (so.kind == StreamKind::NONE) continue;
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
                        adapter_.QueryOnce(s.m.client_id);
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
                    obs.query = s.forced_q;
                    s.has_forced_q = false;
                    s.has_shaping = false;  // REST supersedes
                    fed_forced = true;
                    have_answer = true;
                } else if (s.m.state ==
                               exec::RouteState::EXIT_SENT ||
                           s.m.state ==
                               exec::RouteState::EXIT_EMERGENCY) {
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
                            adapter_.QueryOnce(s.m.client_id);
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
    // Durable cursor: best-effort (loss only replays more —
    // duplicates drop at the seam — never less).
    if (cursor_dirty_) {
        AtomicWrite(P("cursor.txt").c_str(), cursor_.c_str());
        cursor_dirty_ = false;
    }
    return true;
}

bool G0Runner::Summarize(Summary* out) const {
    return SummarizeJournal(P("journal.jsonl").c_str(), out);
}

}  // namespace runner
}  // namespace jev
