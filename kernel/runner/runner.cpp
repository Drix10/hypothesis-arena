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
    std::vector<std::string> lns;
    if (!ReadLines(P("emergency.jsonl").c_str(), &lns)) return true;
    bool any = false;
    for (std::size_t i = 0; i < lns.size(); ++i) {
        if (!lns[i].empty()) {
            any = true;
            break;
        }
    }
    if (!any) return true;
    // Single-writer: emergency rows were sequenced against the live
    // tail, so drain = move lines + verify the joined chain.
    std::vector<journal::Row> jr;
    if (!JournalLoad(P("journal.jsonl").c_str(), &jr)) return false;
    std::vector<journal::Row> er;
    for (std::size_t i = 0; i < lns.size(); ++i) {
        if (lns[i].empty()) continue;
        // Strict re-parse (same grammar as the live file).
        std::string ln = lns[i];
        journal::Row r;
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
        if (!journal::FormatRow(
                (std::uint64_t)std::stoull(f[0]),
                (std::int64_t)std::stoll(f[1]), f[2].c_str(),
                f[3].c_str(), f[4].c_str(), f[5].c_str(), &r))
            return false;
        if (r.row_hash != f[6]) return false;
        er.push_back(r);
    }
    if (er.empty()) {
        AtomicWrite(P("emergency.jsonl").c_str(), "");
        return true;
    }
    // Continuity: head links to the live tail (or genesis), then the
    // emergency rows chain among themselves.
    std::string expect_prev =
        jr.empty() ? journal::GenesisPrev() : jr.back().row_hash;
    if (er[0].prev_hash != expect_prev) return false;
    for (std::size_t i = 1; i < er.size(); ++i) {
        if (er[i].prev_hash != er[i - 1].row_hash) return false;
        if (er[i].seq != er[i - 1].seq + 1) return false;
    }
    for (std::size_t i = 0; i < er.size(); ++i) {
        char ln[1024];
        int w = std::snprintf(
            ln, sizeof(ln), "%llu|%lld|%s|%s|%s|%s|%s",
            (unsigned long long)er[i].seq, (long long)er[i].ts_ns,
            er[i].kind.c_str(), er[i].intent_id.c_str(),
            er[i].payload_hash.c_str(), er[i].prev_hash.c_str(),
            er[i].row_hash.c_str());
        if (w <= 0 || w >= static_cast<int>(sizeof(ln))) return false;
        if (!AppendLine(P("journal.jsonl").c_str(), ln)) return false;
        prev_hash_ = er[i].row_hash;
        next_seq_ = er[i].seq + 1;
    }
    return AtomicWrite(P("emergency.jsonl").c_str(), "");
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
        if (!term) ids.push_back(rows[i].intent_id);
    }
    for (std::size_t i = 0; i < ids.size(); ++i) {
        char rec[320];
        bool has_snap = LoadSnapshot(
            SnapPath(ids[i].c_str()).c_str(), rec, sizeof(rec));
        IntentDesc id;
        bool has_intent = LoadIntent(
            IntentPath(ids[i].c_str()).c_str(), &id);
        if (has_snap != has_intent) {
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
            // Intent row journaled, no crash image: the send never
            // reached a persisted state — restart the lifecycle
            // from IDLE under the registered economics.
            CopyStr(s.intent.intent_id, sizeof(s.intent.intent_id),
                      ids[i].c_str());
            CopyStr(s.intent.symbol, sizeof(s.intent.symbol), id.symbol);
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
    static const char kFrozen[] = "submit-frozen-symbol";
    static const char kStage[] = "submit-stage-refused";
    static const char kCap[] = "submit-slot-cap";
    static const char kDup[] = "submit-duplicate";
    static const char kGated[] = "submit-entry-gated";
    if (!in.intent_id[0] || !in.symbol[0] || in.qty_shares <= 0)
        return false;
    if (Find(in.intent_id)) {
        if (reason) *reason = kDup;
        return false;
    }
    if (FreezeHas(P("freeze.txt").c_str(), in.symbol)) {
        if (reason) *reason = kFrozen;
        return false;
    }
    if (!stage_ok_) {
        if (reason) *reason = kStage;
        return false;
    }
    if (slots_.size() >= (std::size_t)cfg_.max_slots) {
        if (reason) *reason = kCap;
        return false;
    }
    bool is_exit = (in.kind == jev::risk::IntentKind::EXIT);
    if (!is_exit && !EntriesAllowedNow()) {
        if (reason) *reason = kGated;
        return false;
    }
    // Durable registration FIRST (immutable economics for crash
    // recovery); a failed registration refuses the intent.
    if (!SaveIntent(IntentPath(in.intent_id).c_str(), in.symbol,
                    (in.side == broker::OrderSide::BUY) ? 0 : 1,
                    is_exit ? 1 : 0, in.qty_shares, in.stop_cents,
                    in.tp_cents)) {
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
    // Recovery-only flatten: EXIT for the filled qty under a derived
    // id (file-safe charset; too-long -> freeze + alert instead).
    std::string base = s.intent.intent_id;
    if (base.size() + 8 > 64) {
        FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
        Alert(P("alerts.jsonl").c_str(), "MEDIUM", "flatten-id-long",
              s.intent.intent_id, now_ns);
        return true;
    }
    exec::OrderIntent ex = s.intent;
    ex.kind = jev::risk::IntentKind::EXIT;
    ex.qty_shares = s.m.filled_qty;
    std::string fid = base + "-flatten";
    CopyStr(ex.intent_id, sizeof(ex.intent_id), fid.c_str());
    ex.intent_id[64] = '\0';
    const char* rs = nullptr;
    if (!SubmitIntent(ex, &rs)) {
        FreezeAdd(P("freeze.txt").c_str(), s.intent.symbol);
        return true;
    }
    s.flatten_armed = true;
    return true;
}

void G0Runner::Dispatch(Slot& s, const exec::RouteOut& o,
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
            return;
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
            } else {
                s.ack = broker::OrderAck();  // ambiguous: reconcile
                s.query_due = true;
            }
            return;
        }
        case RouteAction::QUERY_ONCE:
            s.has_query = true;
            s.query = adapter_.QueryOnce(s.m.client_id);
            return;
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
            broker::OrderQuery pre =
                adapter_.QueryOnce(o.next.client_id);
            if (pre.transport_ok && pre.found) {
                s.exit_ack = QueryToClose(pre);
            } else if (pre.transport_ok && !pre.found) {
                s.exit_ack = adapter_.MarketClose(
                    s.intent.symbol, o.exit_qty, eside,
                    o.next.client_id);
            } else {
                s.exit_ack =
                    broker::CloseResult();  // ambiguous: reconcile
            }
            return;
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
            return;
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
                    return;
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
            return;
        }
        case RouteAction::CONFIRM_CANCELLED: {
            if (++s.confirm_tries > 6) {
                // Confirmation never lands: explicit failure, never
                // an infinite re-check loop (UNKNOWN + freeze).
                s.has_cancel_result = true;
                s.absent_cancel = false;
                s.cancel_accepted = false;
                s.cancel_failed = true;
                return;
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
            return;
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
            return;
        }
        case RouteAction::FLATTEN_NOW:
            FlattenOnMedium(s, now_ns);
            s.has_journal = false;
            s.journal_ok = false;
            return;
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
            return;
        }
        case RouteAction::NONE:
        case RouteAction::REJECT:
        default:
            return;
    }
}

bool G0Runner::Cycle(long long now_ns) {
    if (now_ns <= 0 || !deps_.now_ns) return false;
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
    if (lr.level == jev::risk::KillLevel::HARD) {
        Alert(P("alerts.jsonl").c_str(), "HARD", "kill-hard",
              lr.reason, now_ns);
        return false;
    }
    bool medium =
        (lr.level == jev::risk::KillLevel::MEDIUM);
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
                if (!s.active || s.done) continue;
                if (!SameId(s.m.client_id, so.client_id)) continue;
                if (so.event_id[0]) {
                    CopyStr(s.pending_event, sizeof(s.pending_event), so.event_id);
                }
                if (so.kind == StreamKind::FILL) {
                    s.has_stream_fill = true;
                    s.stream_fill_qty = so.filled_qty;
                } else {
                    s.force_flag = true;  // LIFE/BUST: REST now
                }
            }
        }
    }
    // 4. Drive every slot (bounded iterations; persist on change).
    // S2/refresh runs FIRST so fresh answers feed this same cycle.
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        Slot& s = slots_[i];
        if (!s.active || s.done) continue;
        if (medium) FlattenOnMedium(s, now_ns);
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
            // Pending stream event stamps first (position only).
            if (s.pending_event[0]) {
                CopyStr(obs.event_id, sizeof(obs.event_id),
                        s.pending_event);
            }
            // Forced REST answer: consumed where the machine reads
            // it, else held. QUERY_SENT takes the query; EXIT states
            // take the close mapping; CANCEL_SENT takes a cancelled
            // verdict as its confirmation; REPAIR_SENT takes a
            // positively proven protection verdict. Anything else
            // (or a failed lookup) holds for S2/refresh.
            bool fed_forced = false;
            if (s.has_forced_q && !s.pending_event[0]) {
                if (s.m.state == exec::RouteState::QUERY_SENT) {
                    obs.adapter_responded = true;
                    obs.query = s.forced_q;
                    s.has_forced_q = false;
                    s.has_stream_fill = false;  // REST supersedes
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
                        s.has_stream_fill = false;  // REST supersedes
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
                    s.has_stream_fill = false;  // REST supersedes
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
                    s.has_stream_fill = false;  // REST supersedes
                    fed_forced = true;
                    have_answer = true;
                }
            }
            // Stream fill shaped per state (after any stamp step).
            // REST answers always win ties (authoritative snapshot
            // over event): shaping applies only with no query
            // answer pending this iteration.
            if (s.has_stream_fill && !s.pending_event[0] &&
                !fed_forced && !have_answer) {
                long long rem = s.intent.qty_shares -
                                s.m.exit_closed_qty;
                ShapedFill f =
                    ShapeStreamFill(s.m.state, rem, s.stream_fill_qty);
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
                    s.has_stream_fill = false;
                } else if (f.feed_close) {
                    obs.exit_responded = true;
                    obs.exit_ack = f.c;
                    s.has_stream_fill = false;
                }
            }
            exec::RouteOut o =
                exec::RouteStep(s.m, s.intent, cfg_.venue, obs);
            // Stamp accounting: a consumed pending event clears.
            // Bounded compare (both fields <= 32 + NUL).
            if (s.pending_event[0]) {
                bool stamped = false;
                for (int k = 0;
                     k < 33 &&
                     s.pending_event[k] == o.next.last_event_id[k];
                     ++k) {
                    if (s.pending_event[k] == '\0') {
                        stamped = true;
                        break;
                    }
                }
                if (stamped) {
                    s.pending_event[0] = '\0';
                    // A stamped LIFE/BUST event triggers its forced
                    // REST now (one lookup, held for consumption;
                    // S2 clock restarts so this never doubles). A held
                    // FAILED answer refreshes (stale failure never
                    // blocks fresh reconciliation); a good held answer
                    // is never stacked.
                    if (s.force_flag &&
                        (!s.has_forced_q ||
                         !s.forced_q.transport_ok)) {
                        s.forced_q =
                            adapter_.QueryOnce(s.m.client_id);
                        s.has_forced_q = true;
                        s.last_s2_ns = now_ns;
                    }
                    s.force_flag = false;
                } else if (o.action == exec::RouteAction::NONE &&
                           o.reason &&
                           (std::strcmp(o.reason,
                                        "exec:stale-event") == 0 ||
                            std::strcmp(o.reason,
                                        "exec:duplicate-event") ==
                                0)) {
                    s.pending_event[0] = '\0';  // old news: drop
                    s.force_flag = false;
                }
            }
            bool changed = (o.next.state != s.m.state);
            s.m = o.next;
            Dispatch(s, o, now_ns);
            PersistSlot(s);
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
            bool stream_live = (s.has_stream_fill ||
                                s.pending_event[0] ||
                                s.force_flag) &&
                               (s.m.state ==
                                    exec::RouteState::QUERY_SENT ||
                                s.m.state ==
                                    exec::RouteState::EXIT_SENT ||
                                s.m.state ==
                                    exec::RouteState::EXIT_EMERGENCY);
            // Pending stamps feed every non-terminal state (position
            // advances even while waiting), so they always count.
            if (s.pending_event[0]) stream_live = true;
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
    return true;
}

bool G0Runner::Summarize(Summary* out) const {
    return SummarizeJournal(P("journal.jsonl").c_str(), out);
}

}  // namespace runner
}  // namespace jev
