// H1 integration — G0 runner tests (doc 06 sec. 6.1/6.2a/6.5,
// doc 10, doc 13 sec. 13.5). Fake transport/stream/clock/kill,
// real files in a temp dir.
//
// Determinism note: the runner answers every dispatch immediately,
// so a live machine never parks mid-cycle in-process. Cross-cycle
// parking (the case stream/S2/crash logic serves) is constructed
// exactly as production creates it: hand-written crash images
// (journal row + intent file + H1 snapshot), i.e. the durable state
// a dead process leaves behind. Recovery from those files IS the
// crash test — no timing tricks.
#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <sys/types.h>
#include <string>
#include <vector>

#include "../broker/alpaca_paper.hpp"
#include "../jev_validate.hpp"
#include "../runner/events.hpp"
#include "../runner/runner.hpp"
#include "../runner/store.hpp"

static int g_fail = 0;
static int g_count = 0;
static void Check(bool ok, const char* name) {
    ++g_count;
    if (!ok) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

// ---- fakes ---------------------------------------------------------
static long long g_now = 1800000000000000000LL;
static long long FakeNow(void*) { return g_now; }

struct Rule {
    std::string method, path_sub, body;
    int status;
};
static std::vector<Rule> g_rules;
struct Req {
    std::string method, path, body;
};
static std::vector<Req> g_log;
static jev::broker::HttpResult FakeCall(
    const jev::broker::HttpRequest& rq) {
    g_log.push_back(Req{rq.method ? rq.method : "", rq.path ? rq.path : "",
                        rq.body ? rq.body : ""});
    for (std::size_t i = 0; i < g_rules.size(); ++i) {
        if (g_log.back().method.find(g_rules[i].method) !=
                std::string::npos &&
            g_log.back().path.find(g_rules[i].path_sub) !=
                std::string::npos) {
            jev::broker::HttpResult r;
            r.status = g_rules[i].status;
            std::strncpy(r.body, g_rules[i].body.c_str(),
                         sizeof(r.body) - 1);
            g_rules.erase(g_rules.begin() + (int)i);
            return r;
        }
    }
    jev::broker::HttpResult r;  // unscripted: transport failure
    r.status = 500;
    return r;
}
static void PushRule(const char* m, const char* p, int st,
                     const char* b) {
    g_rules.push_back(Rule{m, p, b, st});
}
static int CountMethod(const char* m, const char* psub) {
    int n = 0;
    for (std::size_t i = 0; i < g_log.size(); ++i) {
        if (g_log[i].method == m &&
            g_log[i].path.find(psub) != std::string::npos)
            ++n;
    }
    return n;
}

static std::string g_stream;
static std::size_t g_stream_off = 0;
static int FakeStream(void*, char* buf, int n) {
    if (g_stream_off >= g_stream.size()) return 0;
    std::size_t left = g_stream.size() - g_stream_off;
    int take = (int)((left < (std::size_t)n) ? left : (std::size_t)n);
    std::memcpy(buf, g_stream.data() + g_stream_off, (std::size_t)take);
    g_stream_off += (std::size_t)take;
    return take;
}
static std::vector<jev::runner::Position> g_positions;
static int g_pos_fail = 0;
static int FakePositions(void*, jev::runner::Position* out, int cap) {
    if (g_pos_fail) return -1;
    int n = ((int)g_positions.size() < cap) ? (int)g_positions.size()
                                            : cap;
    for (int i = 0; i < n; ++i) out[i] = g_positions[i];
    return n;
}
static jev::runner::Position MkPos(const char* sym, long long qty) {
    jev::runner::Position p;
    std::strncpy(p.symbol, sym, 15);
    p.qty = qty;
    return p;
}
static int g_venue_open = 0, g_venue_spread = 0, g_venue_fail = 0;
static bool FakeVenue(void*, bool* open, bool* spread) {
    if (g_venue_fail) return false;
    *open = g_venue_open != 0;
    *spread = g_venue_spread != 0;
    return true;
}

static jev::kill::KillInputs g_kill;
static void FakeKill(void*, jev::kill::KillInputs* out) { *out = g_kill; }

static int g_tmpn = 0;
#ifdef _WIN32
#include <direct.h>
#include <windows.h>
static void MkDir(const std::string& d) { _mkdir(d.c_str()); }
static void RmDir(const std::string& d) { RemoveDirectoryA(d.c_str()); }
static void RemoveSandbox(const std::string& d) {
    std::string pat = d + "\\*";
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pat.c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            std::string n = fd.cFileName;
            if (n == "." || n == "..") continue;
            std::string full = d + "\\" + n;
            DWORD a = GetFileAttributesA(full.c_str());
            if (a != INVALID_FILE_ATTRIBUTES &&
                (a & FILE_ATTRIBUTE_DIRECTORY)) {
                RemoveSandbox(full);
                RemoveDirectoryA(full.c_str());
            } else {
                DeleteFileA(full.c_str());
            }
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    RemoveDirectoryA(d.c_str());
}
#else
#include <dirent.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
static void MkDir(const std::string& d) { mkdir(d.c_str(), 0700); }
static void RmDir(const std::string& d) { rmdir(d.c_str()); }
static void RemoveSandbox(const std::string& d) {
    DIR* dp = opendir(d.c_str());
    if (dp) {
        struct dirent* e = nullptr;
        while ((e = readdir(dp)) != nullptr) {
            std::string n = e->d_name;
            if (n == "." || n == "..") continue;
            std::string full = d + "/" + n;
            struct stat st;
            if (stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
                RemoveSandbox(full);
                rmdir(full.c_str());
            } else {
                std::remove(full.c_str());
            }
        }
        closedir(dp);
    }
    std::remove(d.c_str());
}
#endif
static long long FileSize(const std::string& p) {
    FILE* f = std::fopen(p.c_str(), "rb");
    if (!f) return -1;
    std::fseek(f, 0, SEEK_END);
    long long n = (long long)std::ftell(f);
    std::fclose(f);
    return n;
}
static bool Exists(const std::string& p) {
    FILE* f = std::fopen(p.c_str(), "rb");
    if (f) {
        std::fclose(f);
        return true;
    }
    return false;
}
static std::string TmpDir() {
    // Relative sandbox (std::filesystem binaries fail to start on
    // this MinGW toolchain; plain C I/O works everywhere). Removed
    // file-by-file at block end via RemoveSandbox.
    std::string d = std::string("g0tmp") + std::to_string(++g_tmpn);
    MkDir(d);
    return d;
}
static void WriteFile(const std::string& p, const std::string& b) {
    FILE* f = std::fopen(p.c_str(), "wb");
    std::fwrite(b.data(), 1, b.size(), f);
    std::fclose(f);
}
static std::string ReadWhole(const std::string& p) {
    FILE* f = std::fopen(p.c_str(), "rb");
    if (!f) return "";
    std::string out;
    char buf[4096];
    std::size_t n = 0;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0)
        out.append(buf, n);
    std::fclose(f);
    return out;
}
static void WriteStageG0(const std::string& dir) {
    std::string body =
        "G0_PAPER|human|2026-09-25T00:00:00Z|0|GENESIS";
    std::string h = jev::Sha256Hex(body);
    WriteFile(dir + "/STAGE",
              "stage: G0_PAPER\napproved_by: human\napproved_at: "
              "2026-09-25T00:00:00Z\ncapital_usd: 0\nattest_hash: " +
                  h + "\n");
}
static jev::exec::OrderIntent GoodIntent(const char* id, const char* sym,
                                         bool is_exit, long long qty) {
    jev::exec::OrderIntent in;
    std::strncpy(in.intent_id, id, 64);
    std::strncpy(in.symbol, sym, 15);
    in.side = jev::broker::OrderSide::BUY;
    in.qty_shares = qty;
    in.stop_cents = 22000;
    in.tp_cents = 24000;
    in.kind = is_exit ? jev::risk::IntentKind::EXIT
                      : jev::risk::IntentKind::ENTRY;
    return in;
}
// Real 26-char ULIDs (Crockford base32, ms + randomness) — the
// router only orders genuine ULIDs; hand-typed lookalikes of the
// wrong length fall into the caller-seq family (seq-conflict).
static std::string MkUlid(std::uint64_t ms, unsigned rand) {
    static const char* kC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    char u[27];
    std::uint64_t m = ms;
    for (int i = 9; i >= 0; --i) {
        u[i] = kC[m & 31u];
        m >>= 5;
    }
    unsigned r = rand;
    for (int i = 25; i >= 10; --i) {
        u[i] = kC[r & 31u];
        r = r * 1103515245u + 12345u;
        r >>= 7;
    }
    u[26] = '\0';
    return u;
}
struct Rig {
    std::string dir;
    jev::runner::RunnerConfig cfg;
    jev::runner::RunnerDeps deps;
    ~Rig() { RemoveSandbox(dir); }
    Rig() {
        dir = TmpDir();
        WriteStageG0(dir);
        std::strncpy(cfg.venue.broker, "alpaca-paper", 31);
        std::strncpy(cfg.venue.account, "test", 31);
        std::string ch(64, 'a');
        std::strncpy(cfg.venue.context_hash, ch.c_str(), 64);
        cfg.dir = dir;
        deps.transport = FakeCall;
        deps.stream_read = FakeStream;
        deps.now_ns = FakeNow;
        deps.kill_inputs = FakeKill;
        deps.restart_flag = true;
        g_rules.clear();
        g_log.clear();
        g_stream.clear();
        g_stream_off = 0;
        g_kill = jev::kill::KillInputs();
        g_now = 1800000000000000000LL;
        g_positions.clear();
        g_pos_fail = 0;
        g_venue_open = 0;
        g_venue_spread = 0;
        g_venue_fail = 0;
    }
};
static const char* kUuid = "0193abcd-1234-5678-9abc-def012345678";
// Bracket reply with strictly proven legs (TP limit + SL stop).
static std::string BracketReply(const char* status, const char* fq) {
    char b[1024];
    std::snprintf(b, sizeof(b),
                  "{\"id\":\"%s\",\"status\":\"%s\",\"filled_qty\":"
                  "\"%s\",\"order_class\":\"bracket\",\"take_profit\":"
                  "{\"limit_price\":\"240.00\"},\"stop_loss\":{"
                  "\"stop_price\":\"220.00\"},\"legs\":[{\"id\":"
                  "\"11111111-1111-4111-8111-111111111111\",\"type\":"
                  "\"limit\"},{\"id\":\"22222222-2222-4222-8222-"
                  "222222222222\",\"type\":\"stop\"}]}",
                  kUuid, status, fq);
    return b;
}
// By-client-ID lookup with held-as-unit bracket (legs unexpanded).
static std::string HeldReply(const char* status, const char* fq) {
    char b[1024];
    std::snprintf(b, sizeof(b),
                  "{\"id\":\"%s\",\"status\":\"%s\",\"filled_qty\":"
                  "\"%s\",\"order_class\":\"bracket\",\"take_profit\":"
                  "{\"limit_price\":\"240.00\"},\"stop_loss\":{"
                  "\"stop_price\":\"220.00\"},\"legs\":null}",
                  kUuid, status, fq);
    return b;
}
// Plain reply (no legs fields): fills without protection proof.
static std::string PlainReply(const char* status, const char* fq) {
    char b[512];
    std::snprintf(b, sizeof(b),
                  "{\"id\":\"%s\",\"status\":\"%s\",\"filled_qty\":"
                  "\"%s\"}",
                  kUuid, status, fq);
    return b;
}
static std::string DeadReply(const char* fq) {
    char b[512];
    std::snprintf(b, sizeof(b),
                  "{\"id\":\"%s\",\"status\":\"canceled\","
                  "\"filled_qty\":\"%s\"}",
                  kUuid, fq);
    return b;
}
// Hand-written crash image: journal intent row + intent file + H1
// snapshot — exactly what a dead process leaves behind. st: 2 =
// SENT_UNACKED, 3 = QUERY_SENT, 9 = EXIT_SENT.
static std::string CrashImage(const std::string& dir, const char* iid,
                              const char* sym, int side01, int kind01,
                              long long qty, int st, long long filled,
                              std::string* cid_out,
                              const char* bid = "") {
    char cid[65];
    if (!jev::broker::MakeClientOrderId(
            "alpaca-paper", "test", std::string(64, 'a').c_str(), sym,
            side01 == 1 ? jev::broker::OrderSide::SELL
                        : jev::broker::OrderSide::BUY,
            iid, cid))
        return "";
    if (cid_out) *cid_out = cid;
    // Chained append (multi-image tests rebuild EVERY image:
    // overwrite would silently leave only the last slot alive
    // and multi-slot regressions would prove nothing).
    std::string jp = dir + "/journal.jsonl";
    std::vector<jev::journal::Row> jr;
    if (!jev::runner::JournalLoad(jp.c_str(), &jr) &&
        Exists(jp.c_str()))
        return "";
    unsigned long long seq = 0;
    std::string prev = jev::journal::GenesisPrev();
    if (!jr.empty()) {
        seq = jr.back().seq + 1;
        prev = jr.back().row_hash;
    }
    jev::journal::Row r;
    std::string body = std::string("intent sym=") + sym;
    if (!jev::journal::FormatRow(
            seq, 1800000000000000000LL, "intent", iid,
            jev::Sha256Hex(body).c_str(), prev.c_str(), &r))
        return "";
    char ln[1024];
    std::snprintf(ln, sizeof(ln), "%llu|%lld|%s|%s|%s|%s|%s",
                  (unsigned long long)r.seq, (long long)r.ts_ns,
                  r.kind.c_str(), r.intent_id.c_str(),
                  r.payload_hash.c_str(), r.prev_hash.c_str(),
                  r.row_hash.c_str());
    FILE* jf = std::fopen(jp.c_str(), "ab");
    if (!jf) return "";
    std::string line = std::string(ln) + "\n";
    std::size_t w = std::fwrite(line.data(), 1, line.size(), jf);
    std::fclose(jf);
    if (w != line.size()) return "";
    char iln[128];
    std::snprintf(iln, sizeof(iln), "%s|%d|%d|%lld|22000|24000", sym,
                  side01, kind01, qty);
    WriteFile(dir + "/intent-" + std::string(iid) + ".txt", iln);
    char snap[320];
    std::snprintf(snap, sizeof(snap),
                  "H1:%d:%d:%lld:0:0:0:%s:%s:%s:%s:%d::0:0:0:0", st,
                  kind01, filled, cid, bid ? bid : "", iid, sym,
                  side01);
    WriteFile(dir + "/snap-" + std::string(iid) + ".txt", snap);
    return cid;
}
// Crash a flatten EXIT alongside its entry: intent row (chained),
// intent file, EXIT_SENT snapshot with its own stable client id —
// the "dead process sent the close, ack pending" image. The
// entry image (seq 0) must already exist.
static bool CrashFlatten(const std::string& dir, const char* fid,
                         const char* sym, long long qty) {
    std::vector<jev::journal::Row> jr;
    if (!jev::runner::JournalLoad((dir + "/journal.jsonl").c_str(),
                                  &jr) ||
        jr.empty())
        return false;
    char fcid[65];
    if (!jev::broker::MakeClientOrderId(
            "alpaca-paper", "test", std::string(64, 'a').c_str(),
            sym, jev::broker::OrderSide::BUY, fid, fcid))
        return false;
    std::string body = std::string("intent sym=") + sym;
    jev::journal::Row r;
    if (!jev::journal::FormatRow(1, 1800000000000000000LL, "intent",
                                 fid,
                                 jev::Sha256Hex(body).c_str(),
                                 jr.back().row_hash.c_str(), &r))
        return false;
    char ln[1024];
    std::snprintf(ln, sizeof(ln), "%llu|%lld|%s|%s|%s|%s|%s",
                  (unsigned long long)r.seq, (long long)r.ts_ns,
                  r.kind.c_str(), r.intent_id.c_str(),
                  r.payload_hash.c_str(), r.prev_hash.c_str(),
                  r.row_hash.c_str());
    FILE* f =
        std::fopen((dir + "/journal.jsonl").c_str(), "ab");
    if (!f) return false;
    std::string line = std::string(ln) + "\n";
    std::size_t w = std::fwrite(line.data(), 1, line.size(), f);
    std::fclose(f);
    if (w != line.size()) return false;
    char iln[128];
    std::snprintf(iln, sizeof(iln), "%s|%d|%d|%lld|22000|24000", sym,
                  0, 1, qty);
    WriteFile(dir + "/intent-" + std::string(fid) + ".txt", iln);
    char snap[320];
    std::snprintf(snap, sizeof(snap),
                  "H1:%d:%d:%lld:0:0:0:%s::%s:%s:%d::0:0:0:0", 9, 1,
                  0LL, fcid, fid, sym, 0);
    WriteFile(dir + "/snap-" + std::string(fid) + ".txt", snap);
    return true;
}
// Patch a crash image's cumulative exit ledgers through the
// frozen snapshot codec (restore, set, reserialize — no format
// duplication): models "the router already counted this fill
// before the crash" for cumulative-accounting regressions.
static bool PatchClosedCounted(const std::string& dir,
                               const char* iid, long long closed,
                               long long counted) {
    std::string p = dir + "/snap-" + iid + ".txt";
    char rec[320] = {0};
    FILE* f = std::fopen(p.c_str(), "rb");
    if (!f) return false;
    std::size_t n = std::fread(rec, 1, sizeof(rec) - 1, f);
    std::fclose(f);
    if (n == 0) return false;
    jev::exec::RouteMachine m;
    if (!jev::exec::RestoreMachine(rec, &m)) return false;
    m.exit_closed_qty = closed;
    m.exit_counted_qty = counted;
    char out[320];
    if (!jev::exec::SnapshotMachine(m, out, sizeof(out)))
        return false;
    WriteFile(p, out);
    return true;
}
// Craft one emergency/journal row line (chained): FormatRow +
// canonical serialization for mid-drain crash images.
static std::string EmgRow(std::uint64_t seq, long long ts,
                          const char* kind, const char* iid,
                          const char* body, const char* prev) {
    jev::journal::Row r;
    if (!jev::journal::FormatRow(seq, ts, kind, iid,
                                 jev::Sha256Hex(body).c_str(), prev,
                                 &r))
        return "";
    char ln[1024];
    if (!jev::runner::RowLine(r, ln, sizeof(ln))) return "";
    return ln;
}

int main() {
    using jev::runner::G0Runner;
    // 0. Event seam units: SSE framing + classification + shaping.
    {
        jev::runner::SseParser p;
        const char* raw =
            ": comment\nid: 01J000000000000000000000001\n"
            "event: partial_fill\ndata: {\"a\":1}\n\n"
            "event: trade_bust\ndata: {\"b\":2}\n\n";
        p.Feed(raw, std::strlen(raw));
        jev::runner::SseEvent e1;
        Check(p.Next(&e1) && e1.id == "01J000000000000000000000001" &&
                  e1.type == "partial_fill" && e1.data == "{\"a\":1}",
              "sse-first");
        jev::runner::SseEvent e2;
        Check(p.Next(&e2) && e2.id.empty() && e2.type == "trade_bust",
              "sse-second");
        Check(!p.Next(nullptr) && p.errors() == 0, "sse-clean");
        // Split feeds + overlong resync.
        jev::runner::SseParser q;
        q.Feed("event: fill\nda", 14);
        const char* tail = "ta: {\"c\":3}\n\n";
        q.Feed(tail, std::strlen(tail));
        jev::runner::SseEvent e3;
        Check(q.Next(&e3) && e3.type == "fill" &&
                  e3.data == "{\"c\":3}",
              "sse-split");
        jev::runner::SseParser w;
        std::string big(5000, 'x');
        w.Feed(("data: " + big + "\n\n").c_str(), big.size() + 9);
        jev::runner::SseEvent e4;
        Check(!w.Next(&e4) && w.errors() == 1, "sse-overlong");
        // Classification: fill/life/bust/unknown/untagged.
        // Payloads use the real trade-event shape: per-event qty
        // beside the nested order object carrying the CUMULATIVE
        // filled_qty (the ONLY quantity the seam may use).
        jev::runner::SseEvent f;
        f.id = "01J000000000000000000000009";
        f.type = "partial_fill";
        f.data =
            "{\"event\":\"partial_fill\",\"order\":{\"client_"
            "order_id\":\"abc123\",\"filled_qty\":\"40\"},"
            "\"qty\":\"40\"}";
        auto mf = jev::runner::MapTradeEvent(f);
        Check(mf.kind == jev::runner::StreamKind::FILL &&
                  mf.filled_qty == 40 &&
                  std::string(mf.client_id) == "abc123" &&
                  std::string(mf.event_id) ==
                      "01J000000000000000000000009",
              "map-fill");
        // Cumulative wins over per-event qty: event filled 30 of
        // THIS execution, order cumulative is 70 (40 + 30). The
        // old seam read 30 here (last-write-wins understatement).
        f.data =
            "{\"event\":\"partial_fill\",\"order\":{\"client_"
            "order_id\":\"abc123\",\"filled_qty\":\"70\"},"
            "\"qty\":\"30\"}";
        auto mc = jev::runner::MapTradeEvent(f);
        Check(mc.kind == jev::runner::StreamKind::FILL &&
                  mc.filled_qty == 70,
              "map-cumulative-not-event-qty");
        // No cumulative inside the order object -> NONE: reconcile
        // instead of inventing from event qty.
        f.data =
            "{\"event\":\"partial_fill\",\"order\":{\"client_"
            "order_id\":\"abc123\"},\"qty\":\"30\"}";
        Check(jev::runner::MapTradeEvent(f).kind ==
                  jev::runner::StreamKind::NONE,
              "map-no-cumulative");
        f.type = "canceled";
        auto ml = jev::runner::MapTradeEvent(f);
        Check(ml.kind == jev::runner::StreamKind::LIFE &&
                  ml.filled_qty == 0,
              "map-life-no-verdict");
        f.type = "trade_correct";
        auto mb = jev::runner::MapTradeEvent(f);
        Check(mb.kind == jev::runner::StreamKind::BUST, "map-bust");
        f.type = "weird";
        Check(jev::runner::MapTradeEvent(f).kind ==
                  jev::runner::StreamKind::NONE,
              "map-unknown");
        f.type = "fill";
        f.data = "{\"qty\":\"40\"}";
        Check(jev::runner::MapTradeEvent(f).kind ==
                  jev::runner::StreamKind::NONE,
              "map-untagged");
        f.data =
            "{\"event\":\"partial_fill\",\"order\":{\"client_"
            "order_id\":\"abc123\",\"filled_qty\":\"x\"},"
            "\"qty\":\"40\"}";
        Check(jev::runner::MapTradeEvent(f).kind ==
                  jev::runner::StreamKind::NONE,
              "map-badqty");
        // Shaping: query/exit-flat/exit-partial/hold/invalid.
        auto sq = jev::runner::ShapeStreamFill(
            jev::exec::RouteState::QUERY_SENT, 100, 40);
        Check(sq.feed_query && !sq.feed_close &&
                  sq.q.found && sq.q.filled_qty == 40,
              "shape-query");
        auto sf = jev::runner::ShapeStreamFill(
            jev::exec::RouteState::EXIT_SENT, 100, 100);
        Check(sf.feed_close &&
                  sf.c.state == jev::broker::CloseState::FILLED,
              "shape-flat");
        auto sp = jev::runner::ShapeStreamFill(
            jev::exec::RouteState::EXIT_EMERGENCY, 100, 40);
        Check(sp.feed_close &&
                  sp.c.state == jev::broker::CloseState::PARTIAL,
              "shape-partial");
        auto sh = jev::runner::ShapeStreamFill(
            jev::exec::RouteState::SENT_UNACKED, 100, 40);
        Check(!sh.feed_query && !sh.feed_close, "shape-hold");
        auto si = jev::runner::ShapeStreamFill(
            jev::exec::RouteState::QUERY_SENT, 100, 0);
        Check(!si.feed_query, "shape-invalid");
        // QueryToClose funnel.
        jev::broker::OrderQuery qq;
        qq.transport_ok = true;
        qq.found = true;
        qq.filled_qty = 60;
        qq.close_state = jev::broker::CloseState::FILLED;
        auto qc = jev::runner::QueryToClose(qq);
        Check(qc.transport_ok && qc.filled_qty == 60 &&
                  qc.state == jev::broker::CloseState::FILLED &&
                  qc.executed,
              "q2c-fill");
        qq.cancelled = true;
        Check(jev::runner::QueryToClose(qq).state ==
                  jev::broker::CloseState::DEAD,
              "q2c-dead");
        jev::broker::OrderQuery q404;
        q404.transport_ok = true;
        auto qn = jev::runner::QueryToClose(q404);
        Check(qn.transport_ok &&
                  qn.state == jev::broker::CloseState::UNKNOWN &&
                  !qn.executed,
              "q2c-absent");
    }
    // 1. STAGE gate: missing / corrupt / non-G0 refuse; valid runs.
    {
        Rig r;
        std::remove((r.dir + "/STAGE").c_str());
        G0Runner g(r.cfg, r.deps);
        Check(!g.Recover(nullptr), "stage-missing-refuses");
        WriteFile(r.dir + "/STAGE", "stage: G0_PAPER\n");
        Check(!g.Recover(nullptr), "stage-corrupt-refuses");
        std::string body =
            "G1_TINY|human|2026-09-25T00:00:00Z|150|GENESIS";
        WriteFile(r.dir + "/STAGE",
                  "stage: G1_TINY\napproved_by: human\napproved_at: "
                  "2026-09-25T00:00:00Z\ncapital_usd: 150\n"
                  "attest_hash: " +
                      jev::Sha256Hex(body) + "\n");
        Check(!g.Recover(nullptr), "stage-nong0-refuses");
        WriteStageG0(r.dir);
        Check(g.Recover(nullptr), "stage-g0-accepts");
    }
    // 2. Entry happy E2E: intent -> pre-flight 404 -> bracket POST ->
    // query -> fill -> PROTECTED; chain verifies; exactly one POST.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "e2e-recover");
        Check(g.SubmitIntent(GoodIntent("intent-001", "AAPL", false,
                                        100),
                            nullptr),
              "e2e-submit");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "e2e-cycle");
        const auto* s = g.Find("intent-001");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::PROTECTED,
              "e2e-protected");
        Check(CountMethod("POST", "/v2/orders") == 1, "e2e-one-post");
        Check(CountMethod("GET", "by_client_order_id") == 2,
              "e2e-two-queries");
        bool shape = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find("\"order_class\":\"bracket\"") !=
                    std::string::npos &&
                g_log[i].body.find("\"client_order_id\":\"") !=
                    std::string::npos)
                shape = true;
        }
        Check(shape, "e2e-bracket-shape");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              "e2e-chain");
        Check(Exists(r.dir + "/snap-intent-001.txt"),
              "e2e-snapshot");
        Check(Exists(r.dir + "/intent-intent-001.txt"),
              "e2e-intent-file");
        jev::runner::Summary sm;
        Check(g.Summarize(&sm) && sm.rows == 2 && sm.intent == 1 &&
                  sm.fill == 1 && sm.chain_ok,
              "e2e-summary");
    }
    // 3. Crash recovery (SENT_UNACKED image + journaled row):
    // reconcile-first adopts via pre-flight; zero POSTs total.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-010", "AAPL", 0, 0, 100, 2,
                          0, &cid)
                   .empty(),
              "cr-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "cr-recover");
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "cr-cycle");
        const auto* s = g.Find("intent-010");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::PROTECTED,
              "cr-protected");
        Check(CountMethod("POST", "/v2/orders") == 0, "cr-no-post");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              "cr-chain");
    }
    // 4a. Stream fill on a parked exit (no ULID: unordered event):
    // shape (PARTIAL 40) + REST reconcile (DEAD+40) -> Y mints ->
    // Y posts exactly 60 -> CLOSED at 100. X never POSTed.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-020", "SPY", 0, 1, 100, 9,
                          0, &cid)
                   .empty(),
              "st-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "st-recover");
        g_stream =
            "event: partial_fill\ndata: {\"event\":\"partial_"
            "fill\",\"order\":{\"client_order_id\":\"" +
            cid +
            "\",\"filled_qty\":\"40\"},\"qty\":\"40\"}\n\n";
        PushRule("GET", "by_client_order_id", 200,
                 DeadReply("40").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "60").c_str());
        Check(g.Cycle(g_now), "st-cycle");
        const auto* s = g.Find("intent-020");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::CLOSED &&
                  s->m.exit_closed_qty == 100,
              "st-closed-100");
        Check(CountMethod("POST", "/v2/orders") == 1, "st-one-post");
        std::string qty;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            std::size_t p = g_log[i].body.find("\"qty\":\"");
            if (p != std::string::npos) {
                std::size_t q = p + 7;
                std::size_t e = g_log[i].body.find('"', q);
                qty = g_log[i].body.substr(q, e - q);
            }
        }
        Check(qty == "60", "st-post-60");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              "st-chain");
    }
    // 4b. ULID stream fill + dead REST: the ULID stamps (crash
    // image carries it) but the unconfirmed terminal reconciles
    // and freezes on exhaustion — never a blind mint, never a
    // resend. Fail closed, S2/human owns the remainder.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-021", "SPY", 0, 1, 100, 9,
                          0, &cid)
                   .empty(),
              "stb-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "stb-recover");
        g_stream =
            "id: 01J000000000000000000000003\nevent: partial_fill\n"
            "data: {\"event\":\"partial_fill\",\"order\":{\""
            "client_order_id\":\"" +
            cid +
            "\",\"filled_qty\":\"40\"},\"qty\":\"40\"}\n\n";
        Check(g.Cycle(g_now), "stb-cycle");
        const auto* s = g.Find("intent-021");
        Check(s && s->done &&
                  s->m.state ==
                      jev::exec::RouteState::UNKNOWN_FROZEN,
              "stb-freezes");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "stb-no-post");
        Check(s->m.exit_attempt == 0 && s->m.exit_closed_qty == 0,
              "stb-no-mint");
        FILE* f =
            std::fopen((r.dir + "/snap-intent-021.txt").c_str(), "rb");
        char snap[320] = {0};
        std::size_t n =
            f ? std::fread(snap, 1, sizeof(snap) - 1, f) : 0;
        if (f) std::fclose(f);
        Check(n > 0 &&
                  std::string(snap).find(
                      "01J000000000000000000000003") !=
                      std::string::npos,
              "st-ulid-stamped");
        // Durable cursor tracks the last stamped ULID.
        std::string cur;
        FILE* cf =
            std::fopen((r.dir + "/cursor.txt").c_str(), "rb");
        char cbuf[64] = {0};
        std::size_t cn =
            cf ? std::fread(cbuf, 1, sizeof(cbuf) - 1, cf) : 0;
        if (cf) std::fclose(cf);
        if (cn > 0) cur = cbuf;
        Check(cur == "01J000000000000000000000003",
              "st-cursor-durable");
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr) &&
                  g2.cursor() ==
                      "01J000000000000000000000003",
              "st-cursor-reloads");
    }
    // 4c. Two fills, one cycle, cumulative (40 then 70 — NOT 30):
    // both arrival orders converge identically (newest ULID wins
    // position; the queue fully drains; no POST). The shaped
    // PARTIAL is unconfirmed by definition, so with dead transport
    // both orders reconcile-exhaust identically (cf. 4b) — the
    // seam's job is preservation + cumulative sourcing, the
    // router's is authority/convergence.
    for (int ord = 0; ord < 2; ++ord) {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-022", "SPY", 0, 1,
                          100, 9, 0, &cid)
                   .empty(),
              "cc-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "cc-recover");
        std::string ua = MkUlid(100, 7);   // older publication
        std::string ub = MkUlid(200, 9);   // newer publication
        std::string ea =
            "id: " + ua + "\nevent: partial_fill\n"
            "data: {\"event\":\"partial_fill\",\"order\":{\""
            "client_order_id\":\"" +
            cid +
            "\",\"filled_qty\":\"40\"},\"qty\":\"40\"}\n\n";
        std::string eb =
            "id: " + ub + "\nevent: partial_fill\n"
            "data: {\"event\":\"partial_fill\",\"order\":{\""
            "client_order_id\":\"" +
            cid +
            "\",\"filled_qty\":\"70\"},\"qty\":\"30\"}\n\n";
        // NOTE: B's per-event qty is 30 while cumulative is 70 —
        // the old seam shaped 30 here (last-write-wins).
        g_stream = (ord == 0) ? (ea + eb) : (eb + ea);
        Check(g.Cycle(g_now), "cc-cycle");
        const auto* s = g.Find("intent-022");
        Check(s && s->done &&
                  s->m.state ==
                      jev::exec::RouteState::UNKNOWN_FROZEN &&
                  std::string(s->m.last_event_id) == ub &&
                  s->sev_n_ == 0,
              ord == 0 ? "cc-ordered-converges"
                       : "cc-reversed-converges");
        // S2 + the reconcile-exhaust retries (all 500): identical
        // count in both orders proves identical convergence.
        Check(CountMethod("GET", "by_client_order_id") == 3,
              ord == 0 ? "cc-same-lookups" : "cc-same-lookups-rev");
        Check(CountMethod("POST", "/v2/orders") == 0,
              ord == 0 ? "cc-no-post" : "cc-no-post-rev");
    }
    // 4d. Duplicate delivery: the same ULID twice stamps once.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-023", "SPY", 0, 1,
                          100, 9, 0, &cid)
                   .empty(),
              "du-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "du-recover");
        std::string ud = MkUlid(300, 11);
        std::string one =
            "id: " + ud + "\nevent: partial_fill\n"
            "data: {\"event\":\"partial_fill\",\"order\":{\""
            "client_order_id\":\"" +
            cid +
            "\",\"filled_qty\":\"40\"},\"qty\":\"40\"}\n\n";
        g_stream = one + one;  // venue redelivers
        Check(g.Cycle(g_now), "du-cycle");
        const auto* s = g.Find("intent-023");
        // One stamp + one shape (the redelivery drops at the seam):
        // same reconcile-exhaust terminal as a single delivery.
        Check(s && s->done &&
                  s->m.state ==
                      jev::exec::RouteState::UNKNOWN_FROZEN &&
                  std::string(s->m.last_event_id) == ud &&
                  s->sev_n_ == 0,
              "du-stamps-once");
    }
    // 4e. Queue overflow (9 events, cap 8): position is never
    // silently lost — alert + a real lookup on the NEXT cycle
    // (S2 already fired this cycle, so the nudge must cause one
    // more). LIFE events (no shaping, just stamp + forced REST)
    // keep the slot parked so the lookup count is exact: S2#1 +
    // nudge#2 + one refresh per stamped head (8). No POST ever.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-024", "SPY", 0, 1,
                          100, 9, 0, &cid)
                   .empty(),
              "ov-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ov-recover");
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "ov-cycle1");  // S2 GET#1
        Check(CountMethod("GET", "by_client_order_id") == 1,
              "ov-s2-first");
        g_stream.clear();
        for (int k = 0; k < 9; ++k) {
            std::string uk = MkUlid(400 + (std::uint64_t)k, 13);
            g_stream += "id: " + uk +
                        "\nevent: accepted\ndata: "
                        "{\"event\":\"accepted\",\"order\":{\""
                        "client_order_id\":\"" +
                        cid + "\"}}" + "\n\n";
        }
        Check(g.Cycle(g_now), "ov-cycle2");
        FILE* af =
            std::fopen((r.dir + "/alerts.jsonl").c_str(), "rb");
        char abuf[4096] = {0};
        std::size_t an =
            af ? std::fread(abuf, 1, sizeof(abuf) - 1, af) : 0;
        if (af) std::fclose(af);
        Check(an > 0 &&
                  std::string(abuf).find("stream-overflow") !=
                      std::string::npos,
              "ov-alerts");
        Check(CountMethod("GET", "by_client_order_id") == 10,
              "ov-forces-rest");
        const auto* os = g.Find("intent-024");
        Check(os && !os->done &&
                  os->m.state == jev::exec::RouteState::EXIT_SENT &&
                  os->sev_n_ == 0,
              "ov-parked-drained");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "ov-no-post");
    }
    // 4f. Parser failure (overlong line): alert + reconcile row +
    // a real lookup on the next cycle (nudge proven, not assumed).
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-025", "SPY", 0, 1,
                          100, 9, 0, &cid)
                   .empty(),
              "pe-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "pe-recover");
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "pe-cycle1");  // S2 GET#1
        g_stream = std::string(5000, 'x') + "\n\n";
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "pe-cycle2");
        FILE* af =
            std::fopen((r.dir + "/alerts.jsonl").c_str(), "rb");
        char abuf[4096] = {0};
        std::size_t an =
            af ? std::fread(abuf, 1, sizeof(abuf) - 1, af) : 0;
        if (af) std::fclose(af);
        Check(an > 0 &&
                  std::string(abuf).find("sse-error") !=
                      std::string::npos,
              "pe-alerts");
        std::vector<jev::journal::Row> rows;
        Check(jev::runner::JournalLoad(
                      (r.dir + "/journal.jsonl").c_str(), &rows) &&
                  !rows.empty() &&
                  rows.back().kind == "reconcile",
              "pe-reconcile-row");
        Check(CountMethod("GET", "by_client_order_id") == 2,
              "pe-nudges-s2");
    }
    // 5. Exit E2E + dead remainder: X posts 100 -> DEAD+40 -> Y posts
    // exactly 60 -> CLOSED at 100.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ex-recover");
        Check(g.SubmitIntent(GoodIntent("intent-030", "SPY", true,
                                        100),
                            nullptr),
              "ex-submit");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 DeadReply("40").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "60").c_str());
        Check(g.Cycle(g_now), "ex-cycle");
        const auto* s = g.Find("intent-030");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::CLOSED &&
                  s->m.exit_closed_qty == 100,
              "ex-closed-100");
        std::vector<std::string> qtys;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            std::size_t p = g_log[i].body.find("\"qty\":\"");
            if (p != std::string::npos) {
                std::size_t q = p + 7;
                std::size_t e = g_log[i].body.find('"', q);
                qtys.push_back(g_log[i].body.substr(q, e - q));
            }
        }
        Check(qtys.size() == 2 && qtys[0] == "100" && qtys[1] == "60",
              "ex-qtys-100-60");
    }
    // 6. HALT mid-position: entries stop, outstanding exit completes.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "h-recover");
        Check(g.SubmitIntent(GoodIntent("intent-040", "SPY", true,
                                        100),
                            nullptr),
              "h-submit-exit");
        WriteFile(r.dir + "/HALT", "operator stop\n");
        const char* rs = nullptr;
        Check(!g.SubmitIntent(GoodIntent("intent-042", "SPY", false,
                                         100),
                              &rs),
              "h-entry-refused");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "h-cycle");
        const auto* s = g.Find("intent-040");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::CLOSED,
              "h-exit-alive");
    }
    // 7. UNKNOWN freezes the symbol: naked accept -> cancel -> DELETE
    // refused (422) -> UNKNOWN + freeze file -> new intents refused.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "f-recover");
        Check(g.SubmitIntent(GoodIntent("intent-050", "AAPL", false,
                                        100),
                            nullptr),
              "f-submit");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("DELETE", "/v2/orders/", 422,
                 "{\"error\":\"refused\"}");
        Check(g.Cycle(g_now), "f-cycle");
        const auto* s = g.Find("intent-050");
        Check(s && s->done &&
                  s->m.state ==
                      jev::exec::RouteState::UNKNOWN_FROZEN,
              "f-unknown");
        Check(jev::runner::FreezeHas((r.dir + "/freeze.txt").c_str(),
                                     "AAPL"),
              "f-frozen");
        const char* rs = nullptr;
        Check(!g.SubmitIntent(GoodIntent("intent-051", "AAPL", false,
                                         10),
                              &rs),
              "f-new-refused");
    }
    // 8. S2 cadence on a parked exit (transport down): one forced
    // lookup per due window, machine untouched, zero POSTs; transport
    // up completes it with no resend.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-060", "SPY", 0, 1, 100, 9,
                          0, &cid)
                   .empty(),
              "s2-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "s2-recover");
        Check(g.Cycle(g_now), "s2-cycle1");  // forced GET#1 (500)
        Check(CountMethod("GET", "by_client_order_id") == 1,
              "s2-first");
        g_now += 100LL * 1000000000LL;
        Check(g.Cycle(g_now), "s2-cycle2");
        Check(CountMethod("GET", "by_client_order_id") == 1,
              "s2-quiet");
        g_now += 901LL * 1000000000LL;
        Check(g.Cycle(g_now), "s2-cycle3");
        Check(CountMethod("GET", "by_client_order_id") == 2,
              "s2-fires");
        const auto* s = g.Find("intent-060");
        Check(s && !s->done &&
                  s->m.state == jev::exec::RouteState::EXIT_SENT,
              "s2-parked");
        Check(CountMethod("POST", "/v2/orders") == 0, "s2-no-post");
        g_now += 901LL * 1000000000LL;  // S2 due again: refresh
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "s2-cycle4");
        const auto* s2 = g.Find("intent-060");
        Check(s2 && s2->done &&
                  s2->m.state == jev::exec::RouteState::CLOSED,
              "s2-closed");
        Check(CountMethod("POST", "/v2/orders") == 0, "s2-no-resend");
    }
    // 9. trade_bust forces REST (never an ordinary fill): parked exit
    // + bust -> lookup fires, no terminal on the event itself.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-070", "SPY", 0, 1, 100, 9,
                          0, &cid)
                   .empty(),
              "b-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "b-recover");
        Check(g.Cycle(g_now), "b-cycle1");  // S2 forced GET#1 (500)
        g_stream =
            "id: 01J000000000000000000000002\nevent: trade_bust\n"
            "data: {\"event\":\"trade_bust\",\"order\":{\""
            "client_order_id\":\"" +
            cid +
            "\",\"filled_qty\":\"40\"},\"qty\":\"40\"}\n\n";
        Check(g.Cycle(g_now), "b-cycle2");
        Check(CountMethod("GET", "by_client_order_id") == 2,
              "b-forces-rest");
        const auto* s = g.Find("intent-070");
        Check(s && !s->done &&
                  s->m.state == jev::exec::RouteState::EXIT_SENT,
              "b-no-terminal-on-bust");
        // Transport up + S2 due: the forced lookup refreshes and
        // the close completes with no resend.
        g_now += 901LL * 1000000000LL;
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "b-cycle3");
        const auto* s3 = g.Find("intent-070");
        Check(s3 && s3->done &&
                  s3->m.state == jev::exec::RouteState::CLOSED,
              "b-closed");
        Check(CountMethod("POST", "/v2/orders") == 0, "b-no-post");
    }
    // 10. Emergency buffer: journal unwritable (path is a dir) ->
    // EXIT executes, row buffers durably -> restore writability ->
    // Recover drains -> chain verifies, emergency file empty.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "eb-recover");
        Check(g.SubmitIntent(GoodIntent("intent-080", "SPY", true,
                                        100),
                            nullptr),
              "eb-submit");
        std::remove((r.dir + "/journal.jsonl").c_str());
        MkDir(r.dir + "/journal.jsonl");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "eb-cycle");
        const auto* s = g.Find("intent-080");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::CLOSED,
              "eb-closed");
        Check(Exists(r.dir + "/emergency.jsonl"),
              "eb-buffered");
        RmDir(r.dir + "/journal.jsonl");
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "eb-recover2");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              "eb-chain");
        Check(FileSize(r.dir + "/emergency.jsonl") == 0,
              "eb-drained");
    }
    // 11. Redaction gate: secret-shaped bodies never journal.
    {
        Check(!jev::journal::RedactionOk("qty=10 secret=abc"),
              "rd-gate");
        Check(jev::journal::RedactionOk("qty=10 note=fill"),
              "rd-clean");
    }
    // 12. Retention + backup: 120-day file pruned, 10-day kept,
    // unparseable kept, backup byte-identical.
    {
        Rig r;
        WriteFile(r.dir + "/journal-20200101.jsonl", "a\n");
        WriteFile(r.dir + "/journal-20260920.jsonl", "b\n");
        WriteFile(r.dir + "/notes.txt", "keep\n");
        long long today = jev::runner::UnixDay(2026, 9, 25);
        int kept = 0;
        int pruned = 0;
        Check(jev::runner::RetainJournals(r.dir.c_str(), today, &kept,
                                          &pruned),
              "rt-runs");
        Check(pruned == 1 && kept == 1, "rt-counts");
        Check(!Exists(r.dir + "/journal-20200101.jsonl"),
              "rt-pruned");
        Check(Exists(r.dir + "/notes.txt"),
              "rt-keeps-other");
        Check(jev::runner::BackupFile(
                  (r.dir + "/journal-20260920.jsonl").c_str(),
                  (r.dir + "/journal-20260920.bak").c_str()),
              "bk-ok");
        Check(Exists(r.dir + "/journal-20260920.bak"),
              "bk-exists");
    }
    // 13. Paper fill model exactness (frozen doc 06): BUY mid+spread
    // (min 1bp), SELL mirror.
    {
        jev::broker::Quote q;
        q.mid_cents = 10000;
        q.spread_cents = 20;
        Check(jev::broker::PaperFillPrice(jev::broker::OrderSide::BUY,
                                          q) == 10020,
              "pf-buy-spread");
        Check(jev::broker::PaperFillPrice(jev::broker::OrderSide::SELL,
                                          q) == 9980,
              "pf-sell-spread");
        q.spread_cents = 0;
        Check(jev::broker::PaperFillPrice(jev::broker::OrderSide::BUY,
                                          q) == 10001,
              "pf-buy-min");
        Check(jev::broker::PaperFillPrice(jev::broker::OrderSide::SELL,
                                          q) == 9999,
              "pf-sell-min");
    }
    // 14. MEDIUM kill flattens open risk: crafted open filled entry
    // (PARTIAL_AWAIT crash image) + spend tier 3 -> flatten EXIT
    // issued for exactly the filled qty -> closes; the entry slot
    // itself stays open (S2/human owns it).
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-090", "AAPL", 0, 0, 100, 5,
                          40, &cid)
                   .empty(),
              "m-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "m-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        // Flatten's sweep-ownership check (both side-tags absent)
        // precedes its own pre-flight.
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "40").c_str());
        Check(g.Cycle(g_now), "m-cycle");
        const auto* f = g.Find("intent-090-flatten");
        Check(f && f->done &&
                  f->m.state == jev::exec::RouteState::CLOSED &&
                  f->m.exit_closed_qty == 40,
              "m-flattened");
        const auto* e = g.Find("intent-090");
        Check(e && !e->done, "m-entry-untouched");
        std::string qty;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            std::size_t p = g_log[i].body.find("\"qty\":\"");
            if (p != std::string::npos) {
                std::size_t q = p + 7;
                std::size_t e = g_log[i].body.find('"', q);
                qty = g_log[i].body.substr(q, e - q);
            }
        }
        Check(qty == "40", "m-flatten-qty-40");
    }
    // 15. Corrupt journal refuses startup (HARD, forensics first).
    {
        Rig r;
        WriteFile(r.dir + "/journal.jsonl",
                  "0|1|intent|x|00|00|ff\n");
        G0Runner g(r.cfg, r.deps);
        Check(!g.Recover(nullptr), "jb-refuses");
        Check(Exists(r.dir + "/alerts.jsonl"),
              "jb-alerts");
    }
    // 16. HARD manages old risk before terminating (sec. 10.3):
    // crafted open ENTRY (filled 100, no protection) + HARD kill
    // -> reprotect POST + flatten POST, hard journal rows, HALT
    // file, cycle returns false (supervisor must not restart).
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-100", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "hd-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hd-recover");
        g_kill.drift_unresolvable = true;  // HARD
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"accepted\","
                 "\"filled_qty\":\"100\"}");
        // Repair pre-flight (own sub-id): absent -> POST the OCO.
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "100").c_str());
        // Hard-close pre-flight (stable hard id): absent -> POST.
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(!g.Cycle(g_now), "hd-terminates");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "hd-reprotect-plus-flatten");
        // The repair OCO rides its OWN sub-identity (never the
        // entry id the venue would reject as a duplicate).
        std::string repair_coid;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (g_log[i].body.find("order_class") ==
                    std::string::npos ||
                g_log[i].body.find("oco") == std::string::npos)
                continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                repair_coid = g_log[i].body.substr(p, 80);
        }
        Check(!repair_coid.empty() &&
                  repair_coid.find(cid) == std::string::npos,
              "hd-repair-own-id");
        Check(Exists(r.dir + "/HALT"), "hd-halt-survives");
        std::vector<jev::journal::Row> rows;
        int hard_rows = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "drift-directive") ++hard_rows;
            }
        }
        Check(hard_rows >= 2, "hd-journaled");
        // Restart: HALT blocks entries, exits stay submittable.
        g_kill = jev::kill::KillInputs();
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "hd-restart");
        Check(!g2.SubmitIntent(GoodIntent("intent-101", "AAPL",
                                          false, 10),
                               nullptr),
              "hd-entry-blocked");
        Check(g2.SubmitIntent(GoodIntent("intent-102", "AAPL",
                                         true, 10),
                              nullptr),
              "hd-exit-alive");
    }
    // 17. HARD on an EXIT with UUID: the owned exit is ADOPTED
    // (reconciled, never canceled to make room, never bypassed).
    // A live exit journals its adoption with zero DELETEs and zero
    // new closes; the process still terminates with HALT.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-110", "SPY", 0, 1, 100,
                          9, 0, &cid,
                          "0193abcd-1234-5678-9abc-def012345678")
                   .empty(),
              "hx-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hx-recover");
        g_kill.broker_auth_fail = true;  // HARD
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "hx-terminates");
        Check(CountMethod("DELETE", "/v2/orders/") == 0,
              "hx-no-cancel");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "hx-no-second-close");
        Check(Exists(r.dir + "/HALT"), "hx-halt-survives");
        std::vector<jev::journal::Row> rows;
        int hard_rows = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "drift-directive")
                    ++hard_rows;
            }
        }
        Check(hard_rows >= 2, "hx-adopt-journaled");
    }
    // 18. HARD on a never-filled ENTRY: found -> cancel attempt;
    // 404-absent -> journaled, nothing to cancel. Either way the
    // process terminates (false) with zero entry-side POSTs.
    for (int hcase = 0; hcase < 2; ++hcase) {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-120", "AAPL", 0, 0, 100,
                          2, 0, &cid)
                   .empty(),
              "hu-image");
        // SENT_UNACKED, filled 0: POST may have landed, ack lost.
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hu-recover");
        g_kill.determinism_fail = true;  // HARD
        if (hcase == 0) {
            PushRule("GET", "by_client_order_id", 200,
                     HeldReply("accepted", "0").c_str());
            PushRule("DELETE", "/v2/orders/", 204, "");
        } else {
            PushRule("GET", "by_client_order_id", 404, "{}");
        }
        Check(!g.Cycle(g_now), "hu-terminates");
        Check(CountMethod("DELETE", "/v2/orders/") ==
                  (hcase == 0 ? 1 : 0),
              hcase == 0 ? "hu-cancel-found" : "hu-no-cancel-404");
        Check(CountMethod("POST", "/v2/orders") == 0,
              hcase == 0 ? "hu-no-post" : "hu-no-post404");
    }
    // 19. Exit gating + intent permanence: EXIT bypasses freeze /
    // stage; ids are safe-grammar, permanent, and non-reusable.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "xg-recover");
        Check(jev::runner::FreezeAdd((r.dir + "/freeze.txt").c_str(),
                                     "AAPL"),
              "xg-freeze");
        Check(!g.SubmitIntent(GoodIntent("intent-130", "AAPL",
                                         false, 10),
                              nullptr),
              "xg-entry-frozen");
        Check(g.SubmitIntent(GoodIntent("intent-131", "AAPL",
                                        true, 10),
                             nullptr),
              "xg-exit-despite-freeze");
        // Demoted stage: entries stop, exits still manage.
        WriteFile(r.dir + "/STAGE", "garbage\n");
        Check(g.Cycle(g_now), "xg-cycle");
        Check(!g.SubmitIntent(GoodIntent("intent-132", "SPY",
                                         false, 10),
                              nullptr),
              "xg-entry-destaged");
        Check(g.SubmitIntent(GoodIntent("intent-133", "SPY",
                                        true, 10),
                             nullptr),
              "xg-exit-despite-stage");
        // Path traversal never touches the filesystem.
        const char* rs = nullptr;
        Check(!g.SubmitIntent(GoodIntent("../evil", "SPY", false,
                                         10),
                              &rs),
              "xg-bad-id");
        Check(!Exists(r.dir + "/intent-..-evil.txt") &&
                  !Exists(r.dir + "/intent-../evil.txt"),
              "xg-no-escape");
    }
    // 20. Intent-id permanence across restarts.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "xp-recover");
        Check(g.SubmitIntent(GoodIntent("intent-140", "AAPL",
                                        false, 100),
                             nullptr),
              "xp-submit");
        // Same id, different economics while live: refused (dup).
        Check(!g.SubmitIntent(GoodIntent("intent-140", "AAPL",
                                         false, 200),
                              nullptr),
              "xp-dup-refused-live");
        // Restart before any journal row: identical economics is
        // an idempotent crash-retry (no duplicate registration).
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "xp-recover2");
        Check(g2.SubmitIntent(GoodIntent("intent-140", "AAPL",
                                         false, 100),
                              nullptr),
              "xp-retry-allowed");
        Check(g2.Cycle(g_now), "xp-cycle");  // journals intent
        // Restart after the intent row: the slot is rebuilt, so a
        // resubmit is refused (live dup today; already-registered
        // once done slots reclaim in the lifecycle pass).
        G0Runner g3(r.cfg, r.deps);
        Check(g3.Recover(nullptr), "xp-recover3");
        Check(!g3.SubmitIntent(GoodIntent("intent-140", "AAPL",
                                          false, 100),
                               nullptr),
              "xp-resubmit-refused");
    }
    // 21. Position drift: orphan + mismatch journal/alert/force;
    // agreement stays quiet.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        g_positions.push_back(MkPos("AAPL", 40));  // orphan
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "pd-recover");
        Check(g.Cycle(g_now), "pd-cycle");
        FILE* af =
            std::fopen((r.dir + "/alerts.jsonl").c_str(), "rb");
        char abuf[4096] = {0};
        std::size_t an =
            af ? std::fread(abuf, 1, sizeof(abuf) - 1, af) : 0;
        if (af) std::fclose(af);
        Check(an > 0 &&
                  std::string(abuf).find("position-drift") !=
                      std::string::npos,
              "pd-orphan-alerts");
        std::vector<jev::journal::Row> rows;
        bool drift_row = false;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "drift-directive")
                    drift_row = true;
            }
        }
        Check(drift_row, "pd-orphan-row");
    }
    // 22. Local/broker agreement: no drift rows, no alerts.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-150", "AAPL", 0, 0, 100,
                          5, 40, &cid)
                   .empty(),
              "pa-image");
        g_positions.push_back(MkPos("AAPL", 40));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "pa-recover");
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "pa-cycle");
        Check(!Exists(r.dir + "/alerts.jsonl"), "pa-quiet");
        std::vector<jev::journal::Row> rows;
        bool drift_row = false;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "drift-directive")
                    drift_row = true;
            }
        }
        Check(!drift_row, "pa-no-row");
    }
    // 23. Qty mismatch forces a real re-lookup of that symbol.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-160", "AAPL", 0, 0, 100,
                          5, 40, &cid)
                   .empty(),
              "pm-image");
        g_positions.push_back(MkPos("AAPL", 100));  // vs local 40
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "pm-recover");
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "pm-cycle1");  // S2 GET#1
        g_now += 901LL * 1000000000LL;
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "pm-cycle2");  // drift GET#2
        Check(CountMethod("GET", "by_client_order_id") == 2,
              "pm-forces-reloukup");
    }
    // 24. MEDIUM single close (doc 06 sec. 6.1b): one 100-share
    // position with local ENTRY coverage gets EXACTLY one close —
    // the local flatten EXIT. The broker sweep reconciles (pre-
    // flights) but never sends for the covered symbol; the
    // flatten's drive closes and attributes the entry to zero.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 1;
        g_venue_spread = 1;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-170", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "ms-image");
        g_positions.push_back(MkPos("AAPL", 100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ms-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        // Flatten's sweep-ownership check (both side-tags, absent)
        // + sweep pre-flight (absent, covered -> wait) + entry
        // forced query (ambiguous, parks) + flatten pre-flight.
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 500, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "ms-cycle");
        // Exactly one close POST (the flatten) — the sweep sent
        // nothing for its covered symbol.
        Check(CountMethod("POST", "/v2/orders") == 1,
              "ms-one-close");
        // The single POST is the flatten (MarketClose carries no
        // order_class body); a sweep send would be POST #2.
        int market_posts = 0;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find("order_class") ==
                    std::string::npos)
                ++market_posts;
        }
        Check(market_posts == 1, "ms-flatten-only-send");
        Check(g.Find("intent-170-flatten") != nullptr,
              "ms-local-flatten");
        // The flatten's close attributed back to the entry (open
        // zeroed — the entry machine stops claiming the shares).
        const auto* me = g.Find("intent-170");
        Check(me && me->m.filled_qty - me->m.exit_closed_qty == 0,
              "ms-attributed");
        FILE* mf =
            std::fopen((r.dir + "/medium.txt").c_str(), "rb");
        char mbuf[64] = {0};
        std::size_t mn =
            mf ? std::fread(mbuf, 1, sizeof(mbuf) - 1, mf) : 0;
        if (mf) std::fclose(mf);
        Check(mn > 0 && std::string(mbuf) == "FLATTEN_PENDING",
              "ms-pending");
    }
    // 25. MEDIUM venue-closed: no sweep (FSM still tracks the
    // ordered local flatten as PENDING — ACTIVE means nothing
    // ordered yet). Local flatten still issued (its own broker
    // refuse is safe).
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 0;  // closed
        g_venue_spread = 1;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-171", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "mc-image");
        g_positions.push_back(MkPos("AAPL", 100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "mc-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        // Flatten's sweep-ownership check first (both side-tags
        // absent — no sweep owns the symbol), then its own
        // pre-flight + close + query.
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "mc-cycle");
        std::vector<jev::journal::Row> rows;
        bool sweep_row = false;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "drift-directive")
                    sweep_row = true;
            }
        }
        Check(!sweep_row, "mc-no-sweep");
        Check(g.Find("intent-171-flatten") != nullptr,
              "mc-local-flatten");
        FILE* mf =
            std::fopen((r.dir + "/medium.txt").c_str(), "rb");
        char mbuf[64] = {0};
        std::size_t mn =
            mf ? std::fread(mbuf, 1, sizeof(mbuf) - 1, mf) : 0;
        if (mf) std::fclose(mf);
        Check(mn > 0 && std::string(mbuf) == "FLATTEN_PENDING",
              "mc-pending-no-sweep");
    }
    // 26. MEDIUM all-flat: FSM lands FLATTENED, no orders sent.
    {
        Rig r;
        r.deps.list_positions = FakePositions;  // empty = flat
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 1;
        g_venue_spread = 1;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "mf-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        Check(g.Cycle(g_now), "mf-cycle");
        Check(g_log.empty(), "mf-no-transport");
        FILE* mf =
            std::fopen((r.dir + "/medium.txt").c_str(), "rb");
        char mbuf[64] = {0};
        std::size_t mn =
            mf ? std::fread(mbuf, 1, sizeof(mbuf) - 1, mf) : 0;
        if (mf) std::fclose(mf);
        Check(mn > 0 && std::string(mbuf) == "FLATTENED",
              "mf-flat");
    }
    // 27. MEDIUM restart: PENDING reloads, no second flatten EXIT.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 1;
        g_venue_spread = 1;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-172", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "mr-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "mr-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        // Flatten's sweep-ownership check (both side-tags absent)
        // precedes its own pre-flight.
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "mr-cycle1");
        const auto* mf1 = g.Find("intent-172-flatten");
        Check(mf1 && mf1->done &&
                  mf1->m.state == jev::exec::RouteState::CLOSED,
              "mr-flatten-closed");
        // Completed flatten is never re-ordered: restart sees the
        // terminal exit row, submits nothing, freezes nothing.
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "mr-recover2");
        Check(g2.Cycle(g_now), "mr-cycle2");
        Check(g2.Find("intent-172-flatten") == nullptr,
              "mr-no-resubmit");
        Check(g2.slots() == 1, "mr-entry-only");
        Check(!Exists(r.dir + "/freeze.txt"),
              "mr-no-spurious-freeze");
        FILE* mmf =
            std::fopen((r.dir + "/medium.txt").c_str(), "rb");
        char mmbuf[64] = {0};
        std::size_t mmn =
            mmf ? std::fread(mmbuf, 1, sizeof(mmbuf) - 1, mmf) : 0;
        if (mmf) std::fclose(mmf);
        Check(mmn > 0 && std::string(mmbuf) == "FLATTENED",
              "mr-flattened");
    }
    // 27b. In-flight flatten across restart: crafted adopted
    // close (EXIT_SENT, no terminal row) reloads, parks on dead
    // transport, and MEDIUM never orders a second flatten — the
    // journal keeps exactly ONE fid intent row, zero POSTs.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-174", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "mi-image");
        Check(CrashFlatten(r.dir, "intent-174-flatten", "AAPL",
                           100),
              "mi-flatten-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "mi-recover");
        Check(g.slots() == 2, "mi-both-reload");
        g_kill.spend_tier = 3;  // MEDIUM
        PushRule("GET", "by_client_order_id", 500, "{}");
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "mi-cycle");
        Check(g.Find("intent-174-flatten") != nullptr,
              "mi-flatten-survives");
        Check(g.slots() == 2, "mi-no-second-flatten");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "mi-no-resend");
        std::vector<jev::journal::Row> rows;
        int fid_intents = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "intent" &&
                    rows[i].intent_id == "intent-174-flatten")
                    ++fid_intents;
            }
        }
        Check(fid_intents == 1, "mi-one-registration");
    }
    // 28. Leaving MEDIUM with open risk: PROTECTION_ONLY, alerted.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-173", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "mp-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "mp-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "40").c_str());
        Check(g.Cycle(g_now), "mp-cycle1");
        g_kill = jev::kill::KillInputs();  // MEDIUM clears
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "mp-cycle2");
        FILE* mf =
            std::fopen((r.dir + "/medium.txt").c_str(), "rb");
        char mbuf[64] = {0};
        std::size_t mn =
            mf ? std::fread(mbuf, 1, sizeof(mbuf) - 1, mf) : 0;
        if (mf) std::fclose(mf);
        Check(mn > 0 && std::string(mbuf) == "PROTECTION_ONLY",
              "mp-protection-only");
    }
    // 29. Emergency drain crash seams: for a 2-row buffer, every
    // mid-drain crash image (applied 0, 1, 2 rows) converges to
    // exactly one chain + an empty buffer. Live starter rows come
    // from CrashImage (valid files for the slot rebuild).
    for (int applied = 0; applied <= 2; ++applied) {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-180", "AAPL", 0, 0, 100,
                          2, 0, &cid)
                   .empty(),
              "dr-image");
        std::vector<jev::journal::Row> jr0;
        Check(jev::runner::JournalLoad(
                      (r.dir + "/journal.jsonl").c_str(), &jr0) &&
                  jr0.size() == 1,
              "dr-row0");
        std::string e1 = EmgRow(
            1, g_now, "partial", "intent-180", "p1",
            jr0[0].row_hash.c_str());
        jev::journal::Row pr1;
        Check(jev::runner::ParseRowLine(e1.c_str(), &pr1),
              "dr-parse1");
        std::string e2 = EmgRow(2, g_now, "partial", "intent-180",
                               "p2", pr1.row_hash.c_str());
        Check(!e1.empty() && !e2.empty(), "dr-crafted");
        // Crash image: `applied` rows already in the journal AND
        // still heading the buffer (append-then-remove torn).
        std::string journal = ReadWhole(r.dir + "/journal.jsonl");
        std::string emg = e1 + "\n" + e2 + "\n";
        if (applied >= 1) journal += e1 + "\n";
        if (applied >= 2) journal += e2 + "\n";
        WriteFile(r.dir + "/journal.jsonl", journal.c_str());
        WriteFile(r.dir + "/emergency.jsonl", emg.c_str());
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "dr-recover");
        std::vector<jev::journal::Row> rows;
        Check(jev::runner::JournalLoad(
                      (r.dir + "/journal.jsonl").c_str(), &rows) &&
                  rows.size() == 3 && rows[0].seq == 0 &&
                  rows[1].seq == 1 && rows[2].seq == 2 &&
                  rows[1].prev_hash == rows[0].row_hash &&
                  rows[2].prev_hash == rows[1].row_hash,
              applied == 0 ? "dr-converge-0"
              : applied == 1 ? "dr-converge-1"
                             : "dr-converge-2");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              applied == 0 ? "dr-chain-0"
              : applied == 1 ? "dr-chain-1"
                             : "dr-chain-2");
        FILE* ef =
            std::fopen((r.dir + "/emergency.jsonl").c_str(), "rb");
        char ebuf[64] = {0};
        std::size_t en =
            ef ? std::fread(ebuf, 1, sizeof(ebuf) - 1, ef) : 999;
        if (ef) std::fclose(ef);
        Check(en == 0, applied == 0 ? "dr-empty-0"
                        : applied == 1 ? "dr-empty-1"
                                       : "dr-empty-2");
    }
    // 30. Broken emergency head refuses recovery (fail closed).
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-181", "AAPL", 0, 0, 100,
                          2, 0, &cid)
                   .empty(),
              "dx-image");
        WriteFile(r.dir + "/emergency.jsonl",
                  "1|2|partial|intent-181|00|GARBAGE|ff\n");
        G0Runner g(r.cfg, r.deps);
        Check(!g.Recover(nullptr), "dx-refuses");
    }
    // 31. Crash between the journaled intent row and the first
    // snapshot: recovery attests the row (IDLE skips WRITE —
    // exactly ONE intent row ever) and the lifecycle completes.
    // (The row is hand-placed: a live cycle would drive past the
    // torn state instead of parking in it.)
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "rw-recover");
        Check(g.SubmitIntent(GoodIntent("intent-190", "AAPL",
                                        false, 100),
                             nullptr),
              "rw-submit");
        std::string row0 = EmgRow(
            0, g_now, "intent", "intent-190", "submit",
            jev::journal::GenesisPrev().c_str());
        Check(!row0.empty(), "rw-row0");
        WriteFile(r.dir + "/journal.jsonl", row0 + "\n");
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "rw-recover2");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g2.Cycle(g_now), "rw-cycle2");
        const auto* s = g2.Find("intent-190");
        Check(s && s->done &&
                  s->m.state == jev::exec::RouteState::PROTECTED,
              "rw-protected");
        std::vector<jev::journal::Row> rows;
        int intent_rows = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "intent" &&
                    rows[i].intent_id == "intent-190")
                    ++intent_rows;
            }
        }
        Check(intent_rows == 1, "rw-one-row");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "rw-one-post");
    }
    // 32. Half registrations refuse: a journaled row with NEITHER
    // crash image nor intent file is S2/human territory; with the
    // file present the rowed path recovers.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hr-recover");
        Check(g.SubmitIntent(GoodIntent("intent-191", "AAPL",
                                        false, 100),
                             nullptr),
              "hr-submit");
        std::string row0 = EmgRow(
            0, g_now, "intent", "intent-191", "submit",
            jev::journal::GenesisPrev().c_str());
        Check(!row0.empty(), "hr-row0");
        WriteFile(r.dir + "/journal.jsonl", row0 + "\n");
        Check(std::remove((r.dir + "/intent-intent-191.txt").c_str()) ==
                  0,
              "hr-tear-file");
        G0Runner g2(r.cfg, r.deps);
        Check(!g2.Recover(nullptr), "hr-refuses-no-file");
        WriteFile(r.dir + "/intent-intent-191.txt",
                  "AAPL|0|0|100|22000|24000\n");
        G0Runner g3(r.cfg, r.deps);
        Check(g3.Recover(nullptr), "hr-rowed-recovers");
    }
    // 33. Duplicate intent rows: first wins, one slot, alerted —
    // never two slots driving one id.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "dd-recover");
        Check(g.SubmitIntent(GoodIntent("intent-192", "AAPL",
                                        false, 100),
                             nullptr),
              "dd-submit");
        std::string row0 = EmgRow(
            0, g_now, "intent", "intent-192", "submit",
            jev::journal::GenesisPrev().c_str());
        jev::journal::Row pr0;
        Check(jev::runner::ParseRowLine(row0.c_str(), &pr0),
              "dd-parse");
        std::string row1 = EmgRow(1, g_now, "intent", "intent-192",
                                 "submit", pr0.row_hash.c_str());
        Check(!row0.empty() && !row1.empty(), "dd-rows");
        WriteFile(r.dir + "/journal.jsonl",
                  (row0 + "\n" + row1 + "\n").c_str());
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "dd-recover2");
        Check(g2.slots() == 1 &&
                  g2.Find("intent-192") != nullptr,
              "dd-one-slot");
        FILE* af =
            std::fopen((r.dir + "/alerts.jsonl").c_str(), "rb");
        char abuf[4096] = {0};
        std::size_t an =
            af ? std::fread(abuf, 1, sizeof(abuf) - 1, af) : 0;
        if (af) std::fclose(af);
        Check(an > 0 &&
                  std::string(abuf).find("recover-dup-intent") !=
                      std::string::npos,
              "dd-alerted");
    }
    // 34. Long-run capacity with position records: live PROTECTED
    // slots are NOT reclaimed (they are the local position) — so
    // the entry cap binds open risk (5th entry refused at
    // max_slots=4), exits bypass the entry cap (refusing an exit
    // strands risk), and closed lifecycles reclaim (20 closes,
    // admission never wedges on history).
    {
        Rig r;
        r.cfg.max_slots = 4;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "lc-recover");
        bool all_ok = true;
        // Four opens fill the entry cap (one shared cycle drives
        // all four; rules are consumed per slot in submit order).
        for (int k = 0; k < 4; ++k) {
            char iid[32];
            std::snprintf(iid, sizeof(iid), "intent-2%02d", k);
            if (!g.SubmitIntent(GoodIntent(iid, "AAPL", false, 100),
                                nullptr)) {
                all_ok = false;
                break;
            }
        }
        for (int k = 0; k < 4; ++k) {
            PushRule("GET", "by_client_order_id", 404, "{}");
            PushRule("POST", "/v2/orders", 200,
                     BracketReply("accepted", "0").c_str());
            PushRule("GET", "by_client_order_id", 200,
                     HeldReply("filled", "100").c_str());
        }
        if (!g.Cycle(g_now)) all_ok = false;
        for (int k = 0; all_ok && k < 4; ++k) {
            char iid[32];
            std::snprintf(iid, sizeof(iid), "intent-2%02d", k);
            const auto* s = g.Find(iid);
            if (!s || !s->done ||
                s->m.state != jev::exec::RouteState::PROTECTED)
                all_ok = false;
        }
        Check(all_ok, "lc-four-open");
        // Fifth ENTRY refused: the cap binds open risk.
        Check(!g.SubmitIntent(GoodIntent("intent-299", "AAPL",
                                         false, 100),
                              nullptr),
              "lc-cap-binds-entries");
        // EXIT bypasses the entry cap and closes (pre-flight 404
        // + filled close; the done-hook attributes the parent to
        // zero, making it reclaimable).
        int closed = 0;
        for (int k = 0; k < 4; ++k) {
            char iid[32], xid[32];
            std::snprintf(iid, sizeof(iid), "intent-2%02d", k);
            std::snprintf(xid, sizeof(xid), "intent-3%02d", k);
            if (!g.SubmitIntent(GoodIntent(xid, "AAPL", true, 100),
                                nullptr))
                break;
            PushRule("GET", "by_client_order_id", 404, "{}");
            PushRule("GET", "by_client_order_id", 404, "{}");
            PushRule("POST", "/v2/orders", 200,
                     HeldReply("filled", "100").c_str());
            if (!g.Cycle(g_now)) break;
            const auto* x = g.Find(xid);
            if (!x || !x->done ||
                x->m.state != jev::exec::RouteState::CLOSED)
                break;
            const auto* p = g.Find(iid);
            if (!p || p->m.filled_qty - p->m.exit_closed_qty != 0)
                break;
            ++closed;
        }
        Check(closed == 4, "lc-exits-close");
        // Sixteen more full lifecycles: admission never wedges.
        for (int k = 0; k < 16; ++k) {
            char iid[32], xid[32];
            std::snprintf(iid, sizeof(iid), "intent-4%02d", k);
            std::snprintf(xid, sizeof(xid), "intent-5%02d", k);
            if (!g.SubmitIntent(GoodIntent(iid, "AAPL", false, 100),
                                nullptr))
                break;
            PushRule("GET", "by_client_order_id", 404, "{}");
            PushRule("POST", "/v2/orders", 200,
                     BracketReply("accepted", "0").c_str());
            PushRule("GET", "by_client_order_id", 200,
                     HeldReply("filled", "100").c_str());
            if (!g.Cycle(g_now)) break;
            if (!g.SubmitIntent(GoodIntent(xid, "AAPL", true, 100),
                                nullptr))
                break;
            PushRule("GET", "by_client_order_id", 404, "{}");
            PushRule("GET", "by_client_order_id", 404, "{}");
            PushRule("POST", "/v2/orders", 200,
                     HeldReply("filled", "100").c_str());
            if (!g.Cycle(g_now)) break;
            const auto* x = g.Find(xid);
            if (!x || !x->done ||
                x->m.state != jev::exec::RouteState::CLOSED)
                break;
            ++closed;
        }
        Check(closed == 20, "lc-twenty-closes");
        Check(g.slots() <= 4, "lc-bounded");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              "lc-chain");
    }
    // 35. Snapshot failure across a mutating send freezes loudly:
    // exactly one POST, journal intact, zero further transport.
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "pz-recover");
        Check(g.SubmitIntent(GoodIntent("intent-200", "AAPL",
                                        false, 100),
                             nullptr),
              "pz-submit");
        // Block the snapshot path with a directory.
#ifdef _WIN32
        _mkdir((r.dir + "/snap-intent-200.txt").c_str());
#else
        mkdir((r.dir + "/snap-intent-200.txt").c_str(), 0700);
#endif
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "0").c_str());
        Check(g.Cycle(g_now), "pz-cycle");
        const auto* s = g.Find("intent-200");
        Check(s && s->frozen, "pz-frozen");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "pz-one-post");
        Check(jev::runner::JournalVerifyFile(
                  (r.dir + "/journal.jsonl").c_str()),
              "pz-chain");
        int gets = CountMethod("GET", "by_client_order_id");
        int posts = CountMethod("POST", "/v2/orders");
        Check(g.Cycle(g_now), "pz-cycle2");
        Check(CountMethod("GET", "by_client_order_id") == gets &&
                  CountMethod("POST", "/v2/orders") == posts,
              "pz-no-further-transport");
    }
    // 36. §6.1 pre-send durability: a failed intent registration
    // refuses the submit with zero transport (nothing unsent can
    // exist without its durable identity).
    {
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ps-recover");
#ifdef _WIN32
        _mkdir((r.dir + "/intent-intent-201.txt").c_str());
#else
        mkdir((r.dir + "/intent-intent-201.txt").c_str(), 0700);
#endif
        Check(!g.SubmitIntent(GoodIntent("intent-201", "AAPL",
                                         false, 100),
                              nullptr),
              "ps-refused");
        Check(g_log.empty(), "ps-zero-transport");
    }
    // 37. §6.3 rhythm on day roll: verify + dated copy + backup +
    // summary; ancient dated copies prune; a mid-run break refuses.
    {
        int cy = 0;
        unsigned cm = 0, cd = 0;
        jev::runner::CivilFromDays(0, &cy, &cm, &cd);
        Check(cy == 1970 && cm == 1 && cd == 1, "ops-epoch");
        jev::runner::CivilFromDays(19358, &cy, &cm, &cd);
        Check(cy == 2023 && cm == 1 && cd == 1, "ops-known-date");
        Rig r;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ops-recover");
        std::string orow = EmgRow(
            0, g_now, "intent", "intent-ops", "submit",
            jev::journal::GenesisPrev().c_str());
        Check(!orow.empty(), "ops-row");
        WriteFile(r.dir + "/journal.jsonl", orow + "\n");
        Check(g.Cycle(g_now), "ops-cycle1");
        long long day = g_now / 86400000000000LL;
        jev::runner::CivilFromDays(day, &cy, &cm, &cd);
        char stamp[16];
        std::snprintf(stamp, sizeof(stamp), "%04d%02u%02u", cy, cm,
                      cd);
        Check(Exists(r.dir + "/journal-" + stamp + ".jsonl"),
              "ops-dated-copy");
        Check(Exists(r.dir + "/summary.txt"), "ops-summary");
        Check(Exists(r.dir + "/backup/journal-" + stamp + ".jsonl"),
              "ops-backup");
        // Ancient copy prunes on the next roll; then corruption on
        // the roll after refuses the cycle (mid-run HARD).
        WriteFile(r.dir + "/journal-20000101.jsonl", "x\n");
        g_now += 2LL * 86400000000000LL;
        Check(g.Cycle(g_now), "ops-cycle2");
        Check(!Exists(r.dir + "/journal-20000101.jsonl"),
              "ops-pruned");
        std::string bad = ReadWhole(r.dir + "/journal.jsonl");
        WriteFile(r.dir + "/journal.jsonl",
                  (bad + "GARBAGE\n").c_str());
        g_now += 2LL * 86400000000000LL;
        Check(!g.Cycle(g_now), "ops-break-refuses");
    }
    // 38. P0 HARD on ordinary protected holdings: the PROTECTED
    // slot survives reclamation (it is the position record), so
    // HARD manages it through the slot path — protection verified
    // (no blind reprotect), flatten under the pre-flighted hard
    // intent id, and the position sweep stays out (one position,
    // one close).
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hp-recover");
        Check(g.SubmitIntent(GoodIntent("intent-300", "AAPL",
                                        false, 100),
                             nullptr),
              "hp-submit");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "hp-cycle1");
        const auto* hp = g.Find("intent-300");
        Check(hp && hp->done &&
                  hp->m.state == jev::exec::RouteState::PROTECTED,
              "hp-protected");
        Check(g.Cycle(g_now), "hp-cycle2");
        // The position record survives: still findable, still open.
        hp = g.Find("intent-300");
        Check(hp && hp->m.filled_qty - hp->m.exit_closed_qty ==
                         100,
              "hp-position-record");
        int posts_before = CountMethod("POST", "/v2/orders");
        g_kill.drift_unresolvable = true;  // HARD
        g_positions.push_back(MkPos("AAPL", 100));
        g_now += 901LL * 1000000000LL;
        // Entry order found WITH protection: no reprotect POST —
        // straight to the pre-flighted hard flatten.
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(!g.Cycle(g_now), "hp-terminates");
        Check(CountMethod("POST", "/v2/orders") ==
                  posts_before + 1,
              "hp-close-sent");
        char htag[64];
        std::snprintf(htag, sizeof(htag), "hard-%lld-AAPL",
                        g_now);
        char hcoid[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL, htag,
                  hcoid),
              "hp-coid");
        char hpos[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL, "hard-pos-AAPL",
                  hpos),
              "hp-poscoid");
        bool saw_hard_get = false, saw_pos_get = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "GET") continue;
            if (g_log[i].path.find(hcoid) != std::string::npos)
                saw_hard_get = true;
            if (g_log[i].path.find(hpos) != std::string::npos)
                saw_pos_get = true;
        }
        Check(saw_hard_get, "hp-preflighted-id");
        Check(!saw_pos_get, "hp-one-close-only");
        Check(Exists(r.dir + "/HALT"), "hp-halt");
    }
    // 38b. Slotless from birth: no slots ever, HARD still flattens
    // the listed position and terminates.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hs-recover");
        g_kill.broker_auth_fail = true;  // HARD
        g_positions.push_back(MkPos("SPY", 50));
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "50").c_str());
        Check(!g.Cycle(g_now), "hs-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hs-close-sent");
        Check(Exists(r.dir + "/HALT"), "hs-halt");
    }
    // 39. P0 HARD never blind-resends an issued close: the
    // hard-close pre-flight finds the FILLED close and adopts it
    // (exactly one repair POST across the whole HARD event).
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-305", "AAPL", 0, 0, 100,
                          2, 100, &cid)
                   .empty(),
              "hr-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hr-recover");
        g_kill.drift_unresolvable = true;  // HARD
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "100").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "100").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(!g.Cycle(g_now), "hr-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hr-one-post");
        char htag[64];
        std::snprintf(htag, sizeof(htag), "hard-%lld-AAPL",
                        g_now);
        char hcoid[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL, htag,
                  hcoid),
              "hr-coid");
        int hard_gets = 0;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "GET" &&
                g_log[i].path.find(hcoid) != std::string::npos)
                ++hard_gets;
        }
        Check(hard_gets == 1, "hr-preflight-once");
        // Second HARD event (human-supervised): the close
        // pre-flight still finds it — still zero close POSTs —
        // and the entry (fully attributed closed in event 1,
        // exact books) is now zero-open: no repair repost, just
        // the designed cancel attempt on the stray unfilled.
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "hr-recover2");
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "100").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "100").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(!g2.Cycle(g_now), "hr-terminates2");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hr-no-close-resend");
        Check(CountMethod("DELETE", "/v2/orders/") == 1,
              "hr-cancel-stray");
    }
    // 40. P0 repair rides its OWN sub-identity (never the entry
    // id): naked fill -> pre-flight 404 -> one OCO POST carrying
    // the repair coid; a REPAIR_SENT restart re-derives the id and
    // adopts without resending.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-310", "AAPL", 0, 0, 100,
                          3, 100, &cid)
                   .empty(),
              "rp-image");
        char rcoid[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL,
                  "intent-310-repair", rcoid),
              "rp-coid");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "rp-recover");
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("filled", "100").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "100").c_str());
        Check(g.Cycle(g_now), "rp-cycle");
        const auto* rs = g.Find("intent-310");
        Check(rs && rs->done &&
                  rs->m.state == jev::exec::RouteState::PROTECTED,
              "rp-repaired");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "rp-one-post");
        bool repair_carries_own = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find(rcoid) != std::string::npos &&
                g_log[i].body.find(cid) == std::string::npos)
                repair_carries_own = true;
        }
        Check(repair_carries_own, "rp-own-id");
    }
    // 40b. REPAIR_SENT restart: the repair id is re-derived (pure
    // function), the forced lookup hits the repair order, and no
    // second POST fires.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-311", "AAPL", 0, 0, 100,
                          12, 100, &cid)
                   .empty(),
              "rr-image");
        char rcoid[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL,
                  "intent-311-repair", rcoid),
              "rr-coid");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "rr-recover");
        PushRule("GET", "by_client_order_id", 200,
                 BracketReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "rr-cycle");
        const auto* rs = g.Find("intent-311");
        Check(rs && rs->done &&
                  rs->m.state == jev::exec::RouteState::PROTECTED,
              "rr-adopted");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "rr-no-resend");
        bool queried_repair = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "GET" &&
                g_log[i].path.find(rcoid) != std::string::npos)
                queried_repair = true;
        }
        Check(queried_repair, "rr-repair-lookup");
    }
    // 41. P1 S2 union semantics: (a) PROTECTED +100 vs broker
    // +100 = quiet; (b) local-only = drift; (c) broker-only =
    // drift; (d) short agreement = quiet.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "s2-recover");
        Check(g.SubmitIntent(GoodIntent("intent-320", "AAPL",
                                        false, 100),
                             nullptr),
              "s2-submit");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 BracketReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        Check(g.Cycle(g_now), "s2-cycle1");
        const auto* sp = g.Find("intent-320");
        Check(sp &&
                  sp->m.state == jev::exec::RouteState::PROTECTED,
              "s2-protected");
        g_positions.push_back(MkPos("AAPL", 100));
        g_now += 901LL * 1000000000LL;
        Check(g.Cycle(g_now), "s2-cycle2");
        std::string al = ReadWhole(r.dir + "/alerts.jsonl");
        Check(al.find("position-drift") == std::string::npos,
              "s2-quiet-on-agreement");
    }
    {
        // (b) local open, broker silent.
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-321", "AAPL", 0, 0, 100,
                          2, 100, &cid)
                   .empty(),
              "s2b-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "s2b-recover");
        Check(g.Cycle(g_now), "s2b-cycle");
        std::string al = ReadWhole(r.dir + "/alerts.jsonl");
        Check(al.find("local-only") != std::string::npos,
              "s2b-local-only-drift");
    }
    {
        // (c) broker position, no local expectation.
        Rig r;
        r.deps.list_positions = FakePositions;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "s2c-recover");
        g_positions.push_back(MkPos("SPY", 50));
        Check(g.Cycle(g_now), "s2c-cycle");
        std::string al = ReadWhole(r.dir + "/alerts.jsonl");
        Check(al.find("orphan") != std::string::npos,
              "s2c-orphan-drift");
    }
    {
        // (d) short agreement is quiet (signed exposure).
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-322", "AAPL", 1, 0, 100,
                          2, 100, &cid)
                   .empty(),
              "s2d-image");
        g_positions.push_back(MkPos("AAPL", -100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "s2d-recover");
        Check(g.Cycle(g_now), "s2d-cycle");
        std::string al = ReadWhole(r.dir + "/alerts.jsonl");
        Check(al.find("position-drift") == std::string::npos,
              "s2d-short-quiet");
    }
    // 42. P1 sweep lifecycle: a live PARTIAL parks (no second
    // order); a DEAD sweep mints one deterministic remainder
    // (sweep-<SYM>-<qty>); an exhausted remainder alerts instead
    // of spinning.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 1;
        g_venue_spread = 1;
        g_positions.push_back(MkPos("AAPL", 100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "sw-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"partially_filled\","
                 "\"filled_qty\":\"40\"}");
        Check(g.Cycle(g_now), "sw-cycle1");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "sw-partial-parks");
        // Dead base sweep -> one incident remainder under
        // medium-<epoch>-AAPL-100.
        PushRule("GET", "by_client_order_id", 200,
                 DeadReply("40").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("accepted", "0").c_str());
        Check(g.Cycle(g_now), "sw-cycle2");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "sw-remainder-sent");
        char rtag[64];
        std::snprintf(rtag, sizeof(rtag),
                        "medium-%lld-AAPL-100", g_now);
        char rcoid[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL, rtag,
                  rcoid),
              "sw-coid");
        bool remainder_carries = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find(rcoid) != std::string::npos)
                remainder_carries = true;
        }
        Check(remainder_carries, "sw-remainder-id");
        // Exhausted remainder: found-DEAD twice -> alert, no POST.
        PushRule("GET", "by_client_order_id", 200,
                 DeadReply("40").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 DeadReply("0").c_str());
        Check(g.Cycle(g_now), "sw-cycle3");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "sw-no-spin");
        std::string al = ReadWhole(r.dir + "/alerts.jsonl");
        Check(al.find("sweep-exhausted") != std::string::npos,
              "sw-exhausted-alert");
    }
    // 43. P1 full lifecycle vocabulary: every documented
    // trade-event word maps (identity-only, forces REST — never a
    // verdict, never NONE).
    {
        const char* lifes[17] = {
            "new", "pending_new", "accepted", "calculated",
            "held", "stopped", "canceled", "rejected",
            "expired", "done_for_day", "replaced", "suspended",
            "pending_cancel", "pending_replace",
            "order_replace_rejected", "order_cancel_rejected",
            "restated"};
        for (int li = 0; li < 17; ++li) {
            jev::runner::SseEvent ev;
            ev.id = MkUlid(1900000000000ULL, (unsigned)li);
            ev.type = lifes[li];
            ev.data = "{\"client_order_id\":\"ord-1\","
                        "\"order\":{\"filled_qty\":\"5\"}}";
            jev::runner::StreamObs so =
                jev::runner::MapTradeEvent(ev);
            char ln[48];
            std::snprintf(ln, sizeof(ln), "life-%s", lifes[li]);
            Check(so.kind == jev::runner::StreamKind::LIFE,
                  ln);
        }
    }
    // 44. P1 account-level cursor: a foreign order's valid event
    // advances the durable replay position even though no slot
    // matches it; restart resumes after the last venue event.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-340", "AAPL", 0, 0, 100,
                          3, 0, &cid)
                   .empty(),
              "cu-image");
        std::string ua = MkUlid(1900000000000ULL, 7);
        std::string ub = MkUlid(1900000000001ULL, 9);
        g_stream =
            "id: " + ua + "\nevent: restated\ndata: "
            "{\"client_order_id\":\"foreign-9\"}\n\n" +
            "id: " + ub + "\nevent: fill\ndata: "
            "{\"client_order_id\":\"" + cid + "\","
            "\"order\":{\"filled_qty\":\"50\"}}\n\n";
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "cu-recover");
        Check(g.Cycle(g_now), "cu-cycle");
        Check(g.cursor() == ub, "cu-advanced-past-foreign");
        Check(ReadWhole(r.dir + "/cursor.txt") == ub,
              "cu-durable");
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "cu-recover2");
        Check(g2.cursor() == ub, "cu-resumed");
    }
    // 45. P1 restart friction: without the operator flag entries
    // are refused (exits still accepted); with it they flow.
    {
        Rig r;
        r.deps.restart_flag = false;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "rf-recover");
        Check(!g.SubmitIntent(GoodIntent("intent-350", "AAPL",
                                         false, 100),
                              nullptr),
              "rf-entry-blocked");
        Check(g.SubmitIntent(GoodIntent("intent-351", "AAPL",
                                        true, 100),
                             nullptr),
              "rf-exit-alive");
        r.deps.restart_flag = true;
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "rf-recover2");
        Check(g2.SubmitIntent(GoodIntent("intent-352", "AAPL",
                                         false, 100),
                              nullptr),
              "rf-flag-resumes");
    }
    // 46. HARD with an unreadable position list fails loudly
    // (unknown != flat: journal + alert, then terminate).
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        g_pos_fail = 1;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hu2-recover");
        g_kill.broker_auth_fail = true;  // HARD
        Check(!g.Cycle(g_now), "hu2-terminates");
        std::string al = ReadWhole(r.dir + "/alerts.jsonl");
        Check(al.find("hard-positions-unknown") !=
                  std::string::npos,
              "hu2-unknown-alert");
    }
    // T2. Converse ownership (doc 06 sec. 6.1b): a live
    // incident-sweep close blocks the local flatten (arm + wait,
    // zero POSTs); when the sweep lands FILLED-full, attribution
    // zeroes the entry and the FSM finalizes — one position, one
    // close, across the handoff.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 1;
        g_venue_spread = 1;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-400", "AAPL", 0, 0, 100,
                          5, 100, &cid)
                   .empty(),
              "ow-image");
        g_positions.push_back(MkPos("AAPL", 100));
        // Hand-crafted live incident: FSM mid-flight + epoch file
        // (exact runner byte format: no trailing newline).
        WriteFile(r.dir + "/medium.txt", "FLATTEN_PENDING");
        char ebe[32];
        std::snprintf(ebe, sizeof(ebe), "%lld", g_now);
        WriteFile(r.dir + "/medium-incident.txt",
                  std::string(ebe) + "\n");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ow-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        // Cycle 1: flatten's sweep check finds the live sweep
        // (PENDING) -> arm, no submit; sweep pre-flight finds it
        // too -> await, no send; entry force parks.
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "ow-cycle1");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "ow-no-competing-close");
        Check(g.Find("intent-400-flatten") == nullptr,
              "ow-no-flatten-submitted");
        // Cycle 2: the sweep lands FILLED-full -> attribution
        // zeroes the entry; the armed flatten never fires. Still
        // zero POSTs. (The broker position still polls open this
        // cycle — honest reconcile-then-settle across polls.)
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        PushRule("GET", "by_client_order_id", 500, "{}");
        Check(g.Cycle(g_now), "ow-cycle2");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "ow-still-no-close");
        const auto* oe = g.Find("intent-400");
        Check(oe && oe->m.filled_qty - oe->m.exit_closed_qty ==
                         0,
              "ow-attributed");
        Check(ReadWhole(r.dir + "/medium.txt") ==
                  "FLATTEN_PENDING",
              "ow-await-settle");
        // Cycle 3: the broker poll shows flat -> FSM finalizes.
        g_positions.clear();
        Check(g.Cycle(g_now), "ow-cycle3");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "ow-quiet-close");
        Check(ReadWhole(r.dir + "/medium.txt") ==
                  "FLATTENED",
              "ow-finalized");
    }
    // T3. HARD with an ENTRY + a live EXIT on one position: the
    // owned exit is adopted — never canceled, never bypassed with
    // a second close. Zero DELETEs, zero POSTs, HALT, journaled.
    {
        Rig r;
        std::string cid, xid;
        Check(!CrashImage(r.dir, "intent-410", "AAPL", 0, 0, 100,
                          2, 100, &cid)
                   .empty(),
              "hx2-entry");
        Check(!CrashImage(r.dir, "intent-411", "AAPL", 0, 1, 100,
                          9, 0, &xid)
                   .empty(),
              "hx2-exit");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hx2-recover");
        g_kill.drift_unresolvable = true;  // HARD
        // Entry order found WITH protection (skip reprotect) +
        // exit live in both visit orders (slot loop order is
        // journal order, but either order converges).
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "hx2-terminates");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "hx2-no-second-close");
        Check(CountMethod("DELETE", "/v2/orders/") == 0,
              "hx2-no-cancel");
        Check(Exists(r.dir + "/HALT"), "hx2-halt");
        std::vector<jev::journal::Row> rows;
        int hard_rows = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "drift-directive")
                    ++hard_rows;
            }
        }
        Check(hard_rows >= 3, "hx2-adopt-journaled");
    }
    // T3b. HARD on exit-only broker exposure (no ENTRY slot): the
    // position loop adopts the working EXIT instead of flattening
    // slotless beside it — no hard-slotless alert, no POST.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string xid;
        Check(!CrashImage(r.dir, "intent-412", "AAPL", 0, 1, 100,
                          9, 0, &xid)
                   .empty(),
              "hx3-exit");
        g_positions.push_back(MkPos("AAPL", 100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hx3-recover");
        g_kill.broker_auth_fail = true;  // HARD
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "hx3-terminates");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "hx3-no-close");
        Check(ReadWhole(r.dir + "/alerts.jsonl").find(
                  "hard-slotless") == std::string::npos,
              "hx3-no-slotless-flatten");
        Check(Exists(r.dir + "/HALT"), "hx3-halt");
    }
    // T3c. HARD on a dead EXIT (never landed): the remainder
    // replaces under the ONE incident hard id — exactly one POST
    // carrying the incident coid.
    {
        Rig r;
        std::string xid;
        Check(!CrashImage(r.dir, "intent-413", "AAPL", 0, 1, 100,
                          9, 0, &xid)
                   .empty(),
              "hx4-exit");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hx4-recover");
        g_kill.drift_unresolvable = true;  // HARD
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "100").c_str());
        Check(!g.Cycle(g_now), "hx4-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hx4-one-replace");
        char htag[64];
        std::snprintf(htag, sizeof(htag), "hard-%lld-AAPL",
                        g_now);
        char hcoid[65] = {0};
        Check(jev::broker::MakeClientOrderId(
                  "alpaca-paper", "test",
                  std::string(64, 'a').c_str(), "AAPL",
                  jev::broker::OrderSide::SELL, htag, hcoid),
              "hx4-coid");
        bool carries = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find(hcoid) != std::string::npos)
                carries = true;
        }
        Check(carries, "hx4-incident-id");
        Check(Exists(r.dir + "/HALT"), "hx4-halt");
    }
    // T4/R1. Incident identity + AUTOMATIC re-entry (doc 06 sec.
    // 6.1b): two MEDIUM incidents on one symbol send two REAL
    // closes under two distinct incident ids — the second never
    // adopts the first's historical fill, and NO operator file
    // deletion happens between them (the runner auto-clears the
    // closed incident).
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        g_venue_open = 1;
        g_venue_spread = 1;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ii-recover");
        g_kill.spend_tier = 3;  // MEDIUM
        g_positions.push_back(MkPos("AAPL", 100));
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(g.Cycle(g_now), "ii-cycle1");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "ii-first-close");
        std::string coid1;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                coid1 = g_log[i].body.substr(p, 96);
        }
        Check(!coid1.empty(), "ii-first-id");
        // End incident 1: flat books + kill cleared -> the runner
        // AUTO-CLEARS the closed incident (FSM + epoch files go
        // empty, journaled) — no manual deletion.
        g_kill = jev::kill::KillInputs();
        g_positions.clear();
        Check(g.Cycle(g_now), "ii-cycle2");
        Check(ReadWhole(r.dir + "/medium.txt").empty(),
              "ii-auto-cleared");
        Check(ReadWhole(r.dir + "/medium-incident.txt").empty(),
              "ii-epoch-cleared");
        // Incident 2: fresh exposure, later. Fresh enter mints a
        // new epoch and really sends.
        g_positions.push_back(MkPos("AAPL", 100));
        g_kill.spend_tier = 3;
        g_now += 60000000000LL;
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(g.Cycle(g_now), "ii-cycle3");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "ii-second-close");
        std::string coid2;
        int posts = 0;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (++posts < 2) continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                coid2 = g_log[i].body.substr(p, 96);
        }
        Check(!coid2.empty() && coid2 != coid1,
              "ii-distinct-incident-id");
        char ebe[32];
        std::snprintf(ebe, sizeof(ebe), "%lld", g_now);
        Check(ReadWhole(r.dir + "/medium-incident.txt") ==
                  std::string(ebe),
              "ii-epoch-advanced");
    }
    // T5. HARD incident identity: crash-mid-HARD reuses the epoch
    // (the in-flight close pre-flights found — never resent); a
    // clean cycle after HALT-clear ends the incident, so the next
    // HARD mints fresh and really closes.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hi-recover");
        g_kill.broker_auth_fail = true;  // HARD #1
        g_positions.push_back(MkPos("SPY", 50));
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "50").c_str());
        Check(!g.Cycle(g_now), "hi-hard1");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hi-first-close");
        std::string coid1;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                coid1 = g_log[i].body.substr(p, 96);
        }
        Check(!coid1.empty(), "hi-first-id");
        char ebe[32];
        std::snprintf(ebe, sizeof(ebe), "%lld", g_now);
        Check(ReadWhole(r.dir + "/hard-incident.txt").find(ebe) ==
                  0,
              "hi-epoch-minted");
        // Crash-mid-HARD restart (HALT still present): the close
        // pre-flights FOUND -> adopted, zero new POSTs, same epoch.
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "hi-recover2");
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "50").c_str());
        Check(!g2.Cycle(g_now), "hi-hard2");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hi-no-resend");
        Check(ReadWhole(r.dir + "/hard-incident.txt").find(ebe) ==
                  0,
              "hi-epoch-reused");
        // Operator ends the incident: HALT cleared + clean cycle
        // truncates the file; the next HARD mints fresh.
        std::remove((r.dir + "/HALT").c_str());
        g_kill = jev::kill::KillInputs();
        g_positions.clear();
        Check(g2.Cycle(g_now), "hi-clean");
        Check(ReadWhole(r.dir + "/hard-incident.txt").empty(),
              "hi-incident-cleared");
        g_kill.broker_auth_fail = true;  // HARD #2
        g_positions.push_back(MkPos("SPY", 50));
        g_now += 60000000000LL;
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 HeldReply("filled", "50").c_str());
        Check(!g2.Cycle(g_now), "hi-hard3");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "hi-second-close");
        std::string coid2;
        int posts = 0;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (++posts < 2) continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                coid2 = g_log[i].body.substr(p, 96);
        }
        Check(!coid2.empty() && coid2 != coid1,
              "hi-distinct-incident-id");
    }
    // R2. HARD quantity authority (doc 06 sec. 6.1b): the SIGNED
    // broker position sizes the close — local +100 vs broker +50
    // closes 50 (not 100); vs +150 closes 150 (nothing unmanaged);
    // vs -100 closes BUY 100 (the actual exposure) + drift alert;
    // flat local vs broker +100 closes 100. Exactly one POST each.
    for (int rc = 0; rc < 4; ++rc) {
        Rig r;
        r.deps.list_positions = FakePositions;
        long long bq = (rc == 0)   ? 50
                       : (rc == 1) ? 150
                       : (rc == 2) ? -100
                                   : 100;
        g_positions.push_back(MkPos("AAPL", bq));
        std::string cid;
        if (rc < 3) {
            Check(!CrashImage(r.dir, "intent-500", "AAPL", 0,
                              0, 100, 2, 100, &cid)
                       .empty(),
                  "bq-image");
        }
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "bq-recover");
        g_kill.drift_unresolvable = true;  // HARD
        if (rc < 3) {
            // Entry order found WITH protection (reprotect
            // skipped — this case is about close qty, not
            // protection).
            PushRule("GET", "by_client_order_id", 200,
                     HeldReply("filled", "100").c_str());
        }
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "bq-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "bq-one-close");
        char wantq[32], wants[32];
        std::snprintf(wantq, sizeof(wantq), "\"qty\":\"%lld\"",
                        bq > 0 ? bq : -bq);
        std::snprintf(wants, sizeof(wants), "\"side\":\"%s\"",
                        bq > 0 ? "sell" : "buy");
        bool gotq = false, gots = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (g_log[i].body.find(wantq) != std::string::npos)
                gotq = true;
            if (g_log[i].body.find(wants) != std::string::npos)
                gots = true;
        }
        Check(gotq, "bq-broker-qty");
        Check(gots, "bq-broker-side");
        if (rc == 2) {
            Check(ReadWhole(r.dir + "/alerts.jsonl").find(
                      "hard-direction-drift") !=
                      std::string::npos,
                  "bq-drift-alert");
        }
        Check(Exists(r.dir + "/HALT"), "bq-halt");
    }
    // R3. HARD remainder identity (doc 06 sec. 6.1b): primary 100
    // fills 40 then dies -> restart under the SAME incident
    // (HALT present, epoch reused) sends exactly one 60-share
    // remainder under hard-<epoch>-<SYM>-60 (never reusing the
    // burned primary id); a further restart sends nothing.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hrc-recover");
        g_kill.broker_auth_fail = true;  // HARD #1
        g_positions.push_back(MkPos("AAPL", 100));
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "hrc-hard1");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hrc-primary-sent");
        std::string coid1;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                coid1 = g_log[i].body.substr(p, 96);
        }
        Check(!coid1.empty(), "hrc-primary-id");
        // Restart, same incident (HALT kept) with the broker
        // REALISTICALLY settled (40 of the 100 closed -> +60):
        // the primary pre-flights FILLED-40 terminal, and the
        // chain (original 100 - landed 40), capped by the live
        // broker need (60), sends exactly one 60-share remainder
        // under the new deterministic identity (60 - 40 = 20
        // would leave 40 exposed — the old domain bug).
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "hrc-recover2");
        g_positions.clear();
        g_positions.push_back(MkPos("AAPL", 60));
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "40").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g2.Cycle(g_now), "hrc-hard2");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "hrc-one-remainder");
        std::string coid2;
        int posts = 0;
        bool qty60 = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (++posts < 2) continue;
            std::size_t p =
                g_log[i].body.find("client_order_id");
            if (p != std::string::npos)
                coid2 = g_log[i].body.substr(p, 96);
            if (g_log[i].body.find("\"qty\":\"60\"") !=
                std::string::npos)
                qty60 = true;
        }
        Check(!coid2.empty() && coid2 != coid1,
              "hrc-remainder-distinct-id");
        Check(qty60, "hrc-remainder-60");
        // Third cycle, broker still +60: primary FILLED-40 +
        // remainder FILLED-60 both sufficient -> zero new orders.
        G0Runner g3(r.cfg, r.deps);
        Check(g3.Recover(nullptr), "hrc-recover3");
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "40").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "60").c_str());
        Check(!g3.Cycle(g_now), "hrc-hard3");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "hrc-no-resend");
        // Fourth cycle, broker fully settled (flat): quiet.
        G0Runner g4(r.cfg, r.deps);
        Check(g4.Recover(nullptr), "hrc-recover4");
        g_positions.clear();
        Check(!g4.Cycle(g_now), "hrc-hard4");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "hrc-settled-quiet");
    }
    // R4. Multiple EXIT coherence (doc 06 sec. 6.1b): ENTRY +100
    // with EXIT A 50 DEAD + EXIT B 50 LIVE under HARD reconciles
    // BOTH exits — A's 50 replaces (one legitimate POST), B's 50
    // adopts, and NO second 100-share close fires while B lives.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid, aid, bid;
        Check(!CrashImage(r.dir, "intent-510", "AAPL", 0, 0,
                          100, 2, 100, &cid)
                   .empty(),
              "mx-entry");
        Check(!CrashImage(r.dir, "intent-511", "AAPL", 0, 1,
                          50, 9, 0, &aid)
                   .empty(),
              "mx-a");
        Check(!CrashImage(r.dir, "intent-512", "AAPL", 0, 1,
                          50, 9, 0, &bid)
                   .empty(),
              "mx-b");
        g_positions.push_back(MkPos("AAPL", 100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "mx-recover");
        g_kill.drift_unresolvable = true;  // HARD
        // Journal order: entry, A, B. Entry order protected;
        // A absent (replace posts under the incident id); B
        // live (adopts); the entry close computes zero; both
        // exit branches adopt (A finds its own replace live).
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "100").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "mx-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "mx-one-replace");
        bool big = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (g_log[i].body.find("\"qty\":\"100\"") !=
                std::string::npos)
                big = true;
        }
        Check(!big, "mx-no-double-close");
        Check(Exists(r.dir + "/HALT"), "mx-halt");
    }
    // R3x. Same chain rule, EXIT-originated: EXIT 100 dies with
    // 40 landed -> replace 60 under the incident id -> THAT
    // order dies terminal-40 -> exactly one 20-share remainder
    // under a fresh deterministic id (chain 60 - 40), then quiet.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string xid;
        Check(!CrashImage(r.dir, "intent-520", "AAPL", 0, 1,
                          100, 9, 0, &xid)
                   .empty(),
              "hx-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hx-recover");
        g_kill.broker_auth_fail = true;  // HARD #1
        g_positions.push_back(MkPos("AAPL", 100));
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"canceled\","
                 "\"filled_qty\":\"40\"}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"canceled\","
                 "\"filled_qty\":\"40\"}");
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "hx-hard1");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hx-replace-60");
        bool qty60 = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find("\"qty\":\"60\"") !=
                    std::string::npos)
                qty60 = true;
        }
        Check(qty60, "hx-replace-qty");
        // Restart, broker settled to +60, the replace itself now
        // terminal-40: chain (60 - 40) sends exactly one 20.
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "hx-recover2");
        g_positions.clear();
        g_positions.push_back(MkPos("AAPL", 60));
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"canceled\","
                 "\"filled_qty\":\"40\"}");
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "40").c_str());
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"canceled\","
                 "\"filled_qty\":\"40\"}");
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "40").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g2.Cycle(g_now), "hx-hard2");
        Check(CountMethod("POST", "/v2/orders") == 2,
              "hx-one-remainder-20");
        bool qty20 = false;
        int posts = 0;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method != "POST") continue;
            if (++posts < 2) continue;
            if (g_log[i].body.find("\"qty\":\"20\"") !=
                std::string::npos)
                qty20 = true;
        }
        Check(qty20, "hx-remainder-qty");
    }
    // MS. MEDIUM teardown certification (doc 06 sec. 6.1b): a
    // missing or failing position seam is UNKNOWN — a FLATTENED
    // incident + epoch are RETAINED, never cleared; once the
    // seam confirms flat the clear is automatic; the next MEDIUM
    // trigger mints fresh. No operator file edit anywhere.
    {
        Rig r;
        // No seam, no slots (locally flat by vacuity).
        WriteFile(r.dir + "/medium.txt", "FLATTENED");
        WriteFile(r.dir + "/medium-incident.txt",
                  "1799999999000000000\n");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ms-recover");
        // (a) missing seam: retained.
        Check(g.Cycle(g_now), "ms-cycle1");
        Check(ReadWhole(r.dir + "/medium.txt") ==
                  "FLATTENED",
              "ms-retained-no-seam");
        Check(ReadWhole(r.dir + "/medium-incident.txt") ==
                  "1799999999000000000\n",
              "ms-epoch-retained");
        // (b-d) share one seam-bound runner (deps bind at
        // construction; the seam itself fails or heals live).
        r.deps.list_positions = FakePositions;
        r.deps.venue_gate = FakeVenue;
        G0Runner g2(r.cfg, r.deps);
        Check(g2.Recover(nullptr), "ms-recover2");
        // (b) failing seam: retained.
        g_pos_fail = 1;
        Check(g2.Cycle(g_now), "ms-cycle2");
        Check(ReadWhole(r.dir + "/medium.txt") ==
                  "FLATTENED",
              "ms-retained-failing-seam");
        Check(ReadWhole(r.dir + "/medium-incident.txt") ==
                  "1799999999000000000\n",
              "ms-epoch-retained-2");
        // (c) seam restored, broker flat: automatic clear.
        g_pos_fail = 0;
        Check(g2.Cycle(g_now), "ms-cycle3");
        Check(ReadWhole(r.dir + "/medium.txt").empty(),
              "ms-auto-cleared");
        Check(ReadWhole(r.dir + "/medium-incident.txt").empty(),
              "ms-epoch-cleared");
        // (d) later MEDIUM trigger: fresh epoch + real close.
        g_venue_open = 1;
        g_venue_spread = 1;
        g_positions.push_back(MkPos("AAPL", 100));
        g_kill.spend_tier = 3;  // MEDIUM
        g_now += 60000000000LL;
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(g2.Cycle(g_now), "ms-cycle4");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "ms-fresh-close");
        char mbe[32];
        std::snprintf(mbe, sizeof(mbe), "%lld", g_now);
        Check(ReadWhole(r.dir + "/medium-incident.txt") ==
                  std::string(mbe),
              "ms-fresh-epoch");
    }
    // HB. HARD slot-blind fallback (doc 06 sec. 6.1b): the entry
    // query transport-fails, so the slot path owns nothing — the
    // position loop still flattens the authoritative broker
    // position under the SAME incident id (the pre-flight, not
    // the skip, keeps one close). Exactly one POST.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-550", "AAPL", 0, 0,
                          100, 2, 100, &cid)
                   .empty(),
              "hb-image");
        g_positions.push_back(MkPos("AAPL", 100));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "hb-recover");
        g_kill.drift_unresolvable = true;  // HARD
        PushRule("GET", "by_client_order_id", 500, "{}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "hb-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "hb-one-fallback-close");
        bool qty100 = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find("\"qty\":\"100\"") !=
                    std::string::npos)
                qty100 = true;
        }
        Check(qty100, "hb-broker-qty");
        Check(Exists(r.dir + "/HALT"), "hb-halt");
    }
    // EC. Cumulative-fill crash seam (router contract:
    // exit_closed is cumulative, exit_counted is per-current-
    // order): EXIT 50 with 40 already counted pre-crash dies
    // DEAD-40 -> HARD must NOT fold another share (entry open
    // stays exactly 10) and must replace exactly the 10 genuinely
    // unaccounted shares. One 10-share POST, exact books.
    {
        Rig r;
        r.deps.list_positions = FakePositions;
        std::string cid, xid;
        Check(!CrashImage(r.dir, "intent-530", "AAPL", 0, 0,
                          50, 2, 50, &cid)
                   .empty(),
              "ec-entry");
        Check(!CrashImage(r.dir, "intent-531", "AAPL", 0, 1,
                          50, 9, 0, &xid)
                   .empty(),
              "ec-exit");
        Check(PatchClosedCounted(r.dir, "intent-530", 40, 0),
              "ec-entry-patch");
        Check(PatchClosedCounted(r.dir, "intent-531", 40, 40),
              "ec-exit-patch");
        g_positions.push_back(MkPos("AAPL", 10));
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "ec-recover");
        g_kill.drift_unresolvable = true;  // HARD
        PushRule("GET", "by_client_order_id", 200,
                 HeldReply("filled", "50").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"canceled\","
                 "\"filled_qty\":\"40\"}");
        PushRule("GET", "by_client_order_id", 404, "{}");
        PushRule("POST", "/v2/orders", 200,
                 PlainReply("accepted", "0").c_str());
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"canceled\","
                 "\"filled_qty\":\"40\"}");
        PushRule("GET", "by_client_order_id", 200,
                 PlainReply("accepted", "0").c_str());
        Check(!g.Cycle(g_now), "ec-terminates");
        Check(CountMethod("POST", "/v2/orders") == 1,
              "ec-one-replace");
        bool qty10 = false;
        for (std::size_t i = 0; i < g_log.size(); ++i) {
            if (g_log[i].method == "POST" &&
                g_log[i].body.find("\"qty\":\"10\"") !=
                    std::string::npos)
                qty10 = true;
        }
        Check(qty10, "ec-remainder-qty");
        const auto* ee = g.Find("intent-530");
        Check(ee && ee->m.filled_qty - ee->m.exit_closed_qty ==
                         10,
              "ec-exact-books");
        Check(Exists(r.dir + "/HALT"), "ec-halt");
    }
    // T7. Quarantine (doc 06 locked): a done_for_day entry freezes
    // its symbol on first sighting (one row), waits (no mint, no
    // terminal), and repeats stay silent.
    {
        Rig r;
        std::string cid;
        Check(!CrashImage(r.dir, "intent-420", "AAPL", 0, 0, 100,
                          3, 50, &cid)
                   .empty(),
              "qz-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "qz-recover");
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"done_for_day\","
                 "\"filled_qty\":\"50\"}");
        Check(g.Cycle(g_now), "qz-cycle1");
        Check(ReadWhole(r.dir + "/freeze.txt").find("AAPL") !=
                  std::string::npos,
              "qz-frozen");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "qz-no-mint");
        std::vector<jev::journal::Row> rows;
        int qrows = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "reconcile") ++qrows;
            }
        }
        Check(qrows == 1, "qz-one-row");
        // Second sighting (next S2 cadence): silent.
        g_now += 901LL * 1000000000LL;
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"done_for_day\","
                 "\"filled_qty\":\"50\"}");
        Check(g.Cycle(g_now), "qz-cycle2");
        rows.clear();
        qrows = 0;
        if (jev::runner::JournalLoad(
                (r.dir + "/journal.jsonl").c_str(), &rows)) {
            for (std::size_t i = 0; i < rows.size(); ++i) {
                if (rows[i].kind == "reconcile") ++qrows;
            }
        }
        Check(qrows == 1, "qz-silent-repeat");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "qz-still-no-mint");
    }
    // T7b. A replaced EXIT mints NO new identity (the replacement
    // id is unknown — never silently adopted, never duplicated):
    // freeze + wait, zero POSTs.
    {
        Rig r;
        std::string xid;
        Check(!CrashImage(r.dir, "intent-421", "AAPL", 0, 1, 100,
                          9, 0, &xid)
                   .empty(),
              "qz2-image");
        G0Runner g(r.cfg, r.deps);
        Check(g.Recover(nullptr), "qz2-recover");
        PushRule("GET", "by_client_order_id", 200,
                 "{\"id\":\"0193abcd-1234-5678-9abc-"
                 "def012345678\",\"status\":\"replaced\","
                 "\"filled_qty\":\"10\"}");
        Check(g.Cycle(g_now), "qz2-cycle");
        Check(CountMethod("POST", "/v2/orders") == 0,
              "qz2-no-sub-identity");
        Check(ReadWhole(r.dir + "/freeze.txt").find("AAPL") !=
                  std::string::npos,
              "qz2-frozen");
    }
    if (g_fail == 0)
        std::printf("RUNNER SUITE: ALL PASS (%d checks)\n", g_count);
    return g_fail ? 1 : 0;
}
