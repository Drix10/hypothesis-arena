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
    long long v = 0;
    for (std::size_t i = 0; i < e.size(); ++i) {
        if (e[i] < '0' || e[i] > '9') return 0;
        v = v * 10 + (e[i] - '0');
        if (v <= 0) return 0;  // overflow wraps: refuse
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
    long long cap = (cfg_.max_slots > 0 ? cfg_.max_slots : 16);
    slots_.reserve((std::size_t)(cap * 2));
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
        if (term) {
            // Terminal EXITs still owe their closed quantity to the
            // parent entries when the done-hook never ran (crash
            // between the close and the attribution): re-attribute
            // from the surviving snapshot. Idempotent — capped by
            // provable open, so a hook that already ran is a no-op.
            IntentDesc xid;
            if (LoadIntent(IntentPath(rows[i].intent_id.c_str()).c_str(),
                           &xid) &&
                xid.kind == 1 && xid.symbol[0] != '\0') {
                char xrec[320];
                exec::RouteMachine xm;
                if (LoadSnapshot(
                        SnapPath(rows[i].intent_id.c_str()).c_str(),
                        xrec, sizeof(xrec)) &&
                    exec::RestoreMachine(xrec, &xm) &&
                    xm.state == exec::RouteState::CLOSED &&
                    xm.exit_closed_qty > 0)
                    AttributeClosedQty(
                        xm.symbol[0] != '\0' ? xm.symbol : xid.symbol,
                        xm.exit_closed_qty,
                        deps_.now_ns(deps_.clock_ctx));
            }
            continue;
        }
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
                if (slots_.size() >= (std::size_t)(2 * cfg_.max_slots))
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
        if (slots_.size() >= (std::size_t)(2 * cfg_.max_slots)) break;
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
    long long cap = is_exit ? cfg_.max_slots * 2 : cfg_.max_slots;
    if (cap <= 0) cap = is_exit ? 32 : 16;
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
    s.forced_q = adapter_.QueryOnce(LookupIdFor(s));
    s.has_forced_q = true;
    s.last_s2_ns = now_ns;
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
    long long old = MediumEpoch();
    long long e = now_ns > old ? now_ns : old + 1;
    char eb[32];
    std::snprintf(eb, sizeof(eb), "%lld", e);
    AtomicWrite(P("medium-incident.txt").c_str(), eb);
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
    std::vector<std::string> lns;
    long long old = 0;
    if (ReadLines(P("hard-incident.txt").c_str(), &lns))
        old = ParseEpoch(lns);
    if (old > 0 && halt_at_entry) {
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "hard-incident-resume epoch=%lld", old);
        OpsRow("drift-directive", "runner", tb, now_ns);
        return old;
    }
    long long e = now_ns > old ? now_ns : old + 1;
    char eb[128];
    std::snprintf(eb, sizeof(eb), "%lld\n%.100s", e,
                  reason ? reason : "");
    AtomicWrite(P("hard-incident.txt").c_str(), eb);
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
long long G0Runner::ExitCoverRemaining(const char* symbol,
                                       std::size_t* first) const {
    // Summed remaining qty of every active non-terminal EXIT on
    // the symbol (intent qty minus closed-to-date, floored at 0).
    // HARD closes only the uncovered remainder against this.
    long long tot = 0;
    std::size_t fi = slots_.size();
    if (!symbol || !symbol[0]) {
        if (first) *first = fi;
        return 0;
    }
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        const Slot& s = slots_[i];
        if (!s.active || s.done) continue;
        if (s.intent.kind != jev::risk::IntentKind::EXIT)
            continue;
        if (IsTerminalState(s.m.state)) continue;
        if (std::strcmp(s.intent.symbol, symbol) != 0) continue;
        long long rem =
            s.intent.qty_shares - s.m.exit_closed_qty;
        if (rem > 0) {
            tot += rem;
            if (fi == slots_.size()) fi = i;
        }
    }
    if (first) *first = fi;
    return tot;
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

bool G0Runner::HardCloseOnce(const char* symbol, long long qty,
                           broker::OrderSide eside, const char* hid,
                           const char* scope_intent,
                           long long now_ns) {
    // Pre-flighted single close under a stable hard id: GET ->
    // found: adopt the close state (an in-flight close is
    // journaled, never re-sent — the process dies right after) ->
    // 404: POST exactly once -> transport failure: journal +
    // alert, fail closed. Any id, any caller, same rule.
    char hcoid[65] = {0};
    if (!hid || !hid[0] || !broker::MakeClientOrderId(
                               cfg_.venue.broker, cfg_.venue.account,
                               cfg_.venue.context_hash, symbol,
                               eside, hid, hcoid)) {
        OpsRow("drift-directive", scope_intent,
               "hard-close id-unrepresentable", now_ns);
        Alert(P("alerts.jsonl").c_str(), "HARD",
              "hard-close-no-id", scope_intent, now_ns);
        return false;
    }
    broker::OrderQuery pre = adapter_.QueryOnce(hcoid);
    if (pre.transport_ok && pre.found) {
        NoteQuarantineSym(symbol, pre.status_raw, "HARD", now_ns);
        broker::CloseResult c = QueryToClose(pre);
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "hard-close id=%s found state=%d filled=%lld",
                        hid, (int)c.state, (long long)c.filled_qty);
        OpsRow("drift-directive", scope_intent, tb, now_ns);
        return c.state == broker::CloseState::FILLED &&
               c.filled_qty >= qty;
    }
    if (pre.transport_ok && !pre.found) {
        broker::CloseResult c =
            adapter_.MarketClose(symbol, qty, eside, hcoid);
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "hard-close id=%s sent=%d", hid,
                        c.transport_ok ? 1 : 0);
        OpsRow("drift-directive", scope_intent, tb, now_ns);
        return c.transport_ok;
    }
    OpsRow("drift-directive", scope_intent,
           "hard-close lookup-failed", now_ns);
    Alert(P("alerts.jsonl").c_str(), "HARD",
          "hard-close-unknown", scope_intent, now_ns);
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

void G0Runner::HardAdoptExit(Slot& s, long long epoch,
                            long long now_ns) {
    // Doc-06-sec.-6.1b adopt-or-replace: the owned exit is
    // reconciled, never canceled to make room, never bypassed.
    // Live (or filled-full) -> adopt: journal, no orders. Dead /
    // absent -> replace the unlanded remainder under the incident
    // hard id (pre-flighted, shared with every hard path for the
    // symbol — the pre-flight, not a cancel, is what prevents two
    // closes). Landed qty attributes to entries oldest-first, so
    // the replacement sizes off provable remainder, never intent.
    if (!s.active || s.done ||
        s.intent.kind != jev::risk::IntentKind::EXIT)
        return;
    if (s.m.client_id[0] == '\0') return;
    broker::OrderQuery q = adapter_.QueryOnce(s.m.client_id);
    NoteQuarantine(s, q, "HARD", now_ns);
    if (!q.transport_ok) {
        OpsRow("drift-directive", s.intent.intent_id,
               "hard-adopt-exit lookup-failed", now_ns);
        return;
    }
    long long rem =
        s.intent.qty_shares - s.m.exit_closed_qty;
    if (rem < 0) rem = 0;
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
        if (rem > 0)
            HardCloseOnce(s.intent.symbol, rem, eside,
                          hid.c_str(), s.intent.intent_id,
                          now_ns);
        return;
    }
    broker::CloseResult c = QueryToClose(q);
    if ((c.state == broker::CloseState::FILLED &&
         c.filled_qty >= rem) ||
        c.state == broker::CloseState::PENDING ||
        c.state == broker::CloseState::PARTIAL ||
        c.state == broker::CloseState::UNKNOWN) {
        // Working, ambiguous, or landed-full: adopt. No cancel
        // (canceling the owned close would strand the exposure),
        // no second close.
        std::snprintf(tb, sizeof(tb),
                        "hard-adopt-exit id=%s state=%d filled=%lld",
                        s.intent.intent_id, (int)c.state,
                        (long long)c.filled_qty);
        OpsRow("drift-directive", s.intent.intent_id, tb,
               now_ns);
        return;
    }
    // DEAD or FILLED-short: fold the landed qty to entries, then
    // replace only the provable remainder (same incident id the
    // entry path and the slotless path share).
    long long landed = c.filled_qty;
    if (landed < 0) landed = 0;
    if (landed > rem) landed = rem;
    if (landed > 0)
        AttributeClosedQty(s.intent.symbol, landed, now_ns);
    long long rest = rem - landed;
    std::snprintf(tb, sizeof(tb),
                    "hard-adopt-exit id=%s dead replace=%lld",
                    s.intent.intent_id, rest);
    OpsRow("drift-directive", s.intent.intent_id, tb, now_ns);
    if (rest > 0)
        HardCloseOnce(s.intent.symbol, rest, eside, hid.c_str(),
                      s.intent.intent_id, now_ns);
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
    HardCloseOnce(symbol, aq, eside, hid.c_str(), "runner",
                  now_ns);
}

void G0Runner::HardManageSlot(Slot& s, long long epoch,
                            long long now_ns) {
    // §10.3 per-position pass (best-effort transport, journaled):
    // reconcile -> verify broker-native protection (re-establish
    // if missing and possible) -> flatten/cancel attempt. NEVER
    // destructive: failures leave protection active; the process
    // terminates right after regardless. Done-PROTECTED slots are
    // managed (they ARE live positions); only provably empty
    // terminals (CANCELLED/UNKNOWN/CLOSED) are skipped. An EXIT
    // already working the symbol is adopted-or-replaced, never
    // canceled, never bypassed (doc 06 sec. 6.1b).
    if (!s.active) return;
    if (s.m.state == exec::RouteState::CANCELLED ||
        s.m.state == exec::RouteState::UNKNOWN_FROZEN ||
        s.m.state == exec::RouteState::CLOSED)
        return;
    if (s.m.client_id[0] == '\0') return;  // never sent: no risk
    if (s.intent.kind == jev::risk::IntentKind::EXIT) {
        HardAdoptExit(s, epoch, now_ns);
        return;
    }
    broker::OrderQuery q = adapter_.QueryOnce(s.m.client_id);
    if (!q.transport_ok) {
        OpsRow("drift-directive", s.intent.intent_id,
               "hard-manage lookup-failed", now_ns);
        return;
    }
    NoteQuarantine(s, q, "HARD", now_ns);
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
            // Exit coverage reconciles first: the owned exit is
            // adopted, and only the uncovered remainder closes here
            // (never a second full close, never a cancel).
            broker::OrderSide eside =
                (s.intent.side == broker::OrderSide::BUY)
                    ? broker::OrderSide::SELL
                    : broker::OrderSide::BUY;
            std::string hid = HardTag(epoch, s.intent.symbol);
            std::size_t fi = slots_.size();
            long long cover =
                ExitCoverRemaining(s.intent.symbol, &fi);
            long long uncovered = open;
            if (cover > 0 && fi < slots_.size()) {
                Slot& e = slots_[fi];
                broker::OrderQuery eq =
                    adapter_.QueryOnce(e.m.client_id);
                NoteQuarantine(e, eq, "HARD", now_ns);
                if (!eq.transport_ok) {
                    // Blind on the exit: HARD fails toward flatten
                    // (ambiguity journaled — the pre-flight still
                    // guards the incident id).
                    OpsRow("drift-directive",
                           s.intent.intent_id,
                           "hard-exit-unknown close-full-open",
                           now_ns);
                } else if (!eq.found) {
                    // The exit never landed: zero coverage, the
                    // full open closes (its replacement is
                    // subsumed — same incident id, no collision).
                    cover = 0;
                    OpsRow("drift-directive",
                           s.intent.intent_id,
                           "hard-exit-absent close-full-open",
                           now_ns);
                } else {
                    broker::CloseResult ec = QueryToClose(eq);
                    bool live =
                        ec.state ==
                            broker::CloseState::PENDING ||
                        ec.state ==
                            broker::CloseState::PARTIAL ||
                        ec.state ==
                            broker::CloseState::UNKNOWN;
                    if (live) {
                        // Working: the whole covering qty closes
                        // under its own id — adopt, close the rest.
                        cover = cover > open ? open : cover;
                    } else {
                        // Dead/short: only landed qty counts.
                        long long landed = ec.filled_qty;
                        if (landed < 0) landed = 0;
                        if (landed > e.intent.qty_shares)
                            landed = e.intent.qty_shares;
                        cover = landed;
                    }
                    char tb[280];
                    std::snprintf(tb, sizeof(tb),
                                    "hard-exit-covers id=%s exit=%s "
                                    "live=%d cover=%lld open=%lld",
                                    s.intent.intent_id,
                                    e.intent.intent_id,
                                    live ? 1 : 0, cover, open);
                    OpsRow("drift-directive",
                           s.intent.intent_id, tb, now_ns);
                    uncovered = open - cover;
                    if (uncovered < 0) uncovered = 0;
                }
            }
            bool sent = false;
            if (uncovered > 0) {
                sent = HardCloseOnce(s.intent.symbol, uncovered,
                                      eside, hid.c_str(),
                                      s.intent.intent_id, now_ns);
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
    FILE* hf = std::fopen(P("HALT").c_str(), "ab");
    if (hf) std::fclose(hf);
    long long epoch =
        HardEpochFor(now_ns, why, halt_at_entry);
    for (std::size_t i = 0; i < slots_.size(); ++i)
        HardManageSlot(slots_[i], epoch, now_ns);
    // §10.3 operates on EVERY open position — including slotless
    // holdings the position list reports. Per-symbol ownership:
    // an ENTRY with provable open was managed by its slot path;
    // an in-flight EXIT is adopted-or-replaced (never a second
    // close); only truly uncovered symbols flatten here — all
    // under the one incident hard id, so the paths pre-flight
    // each other instead of stacking closes.
    if (deps_.list_positions) {
        Position ps[64];
        int n = deps_.list_positions(deps_.positions_ctx, ps, 64);
        if (n < 0) {
            OpsRow("drift-directive", "runner",
                   "hard-positions-unavailable", now_ns);
            Alert(P("alerts.jsonl").c_str(), "HARD",
                  "hard-positions-unknown", "lookup failed",
                  now_ns);
        }
        for (int i = 0; n >= 0 && i < n; ++i) {
            if (ps[i].symbol[0] == '\0' || ps[i].qty == 0)
                continue;
            if (CoveredBySlot(ps[i].symbol)) continue;
            std::size_t fi = slots_.size();
            if (ExitCoverRemaining(ps[i].symbol, &fi) > 0 &&
                fi < slots_.size()) {
                HardAdoptExit(slots_[fi], epoch, now_ns);
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
        int n = deps_.list_positions(deps_.positions_ctx, ps, 64);
        if (n < 0) return false;  // unknown != flat
        for (int i = 0; i < n; ++i) {
            if (ps[i].qty != 0) return false;
        }
    }
    return true;
}

void G0Runner::AttributeClosedQty(const char* symbol, long long qty,
                                   long long now_ns) {
    // An authoritative close quantity (flatten EXIT done-CLOSED,
    // sweep-order FILLED/PARTIAL) belongs to same-symbol ENTRY
    // slots, oldest first. Without this the entry machine keeps
    // claiming provable open after its position closed and S2
    // drifts on healthy flat forever. Leftover with no local
    // expectation is dropped (broker truth already rules S2).
    if (!symbol || !symbol[0] || qty <= 0) return;
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
        s.m.exit_closed_qty += take;
        rem -= take;
        PersistSlot(s);  // best-effort: the journal row attests
        char tb[280];
        std::snprintf(tb, sizeof(tb),
                        "close-attributed id=%s qty=%lld",
                        s.intent.intent_id, take);
        OpsRow("reconcile", s.intent.intent_id, tb, now_ns);
    }
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
        // A medium-enter IS a new incident (doc 06 sec. 6.1b):
        // mint the epoch BEFORE any sweep id derives (the crash
        // window between mint and first sweep is safe — nothing
        // was sent under the new epoch yet, so a re-mint is free).
        MintMediumEpoch(now_ns);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "medium-enter",
              "entries stopped, flattening", now_ns);
    }
    if (cur == "FLATTENED") return;  // terminal: nothing to do
    long long epoch = MediumEpoch();
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
        int n = deps_.list_positions(deps_.positions_ctx, ps, 64);
        for (int i = 0; n >= 0 && i < n; ++i) {
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
                     c.state == broker::CloseState::PARTIAL) &&
                    c.filled_qty > 0)
                    AttributeClosedQty(ps[i].symbol, c.filled_qty,
                                       now_ns);
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
                // deterministic incident remainder under the
                // CURRENT broker qty — pre-flighted, so each
                // distinct id sends at most once. Covered symbols
                // reconcile (above) but never mint: the owned
                // local close carries the rest.
                if (covered) {
                    pending = true;
                    continue;
                }
                std::string rsid = SweepRemainderTag(
                    epoch, ps[i].symbol, aq);
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
                        rc.filled_qty > 0)
                        AttributeClosedQty(ps[i].symbol,
                                           rc.filled_qty, now_ns);
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
                    ps[i].symbol, aq, eside, rhcoid);
                if (c2.transport_ok) {
                    pending = true;
                    char tb[280];
                    std::snprintf(tb, sizeof(tb),
                                    "medium-sweep sym=%.15s qty=%lld "
                                    "id=%.60s",
                                    ps[i].symbol, aq,
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
    }
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
                    s.m.exit_closed_qty > 0)
                    AttributeClosedQty(s.intent.symbol,
                                       s.m.exit_closed_qty,
                                       now_ns);
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
