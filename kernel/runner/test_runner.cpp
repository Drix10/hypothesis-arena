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
            DeleteFileA((d + "\\" + n).c_str());
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    RemoveDirectoryA(d.c_str());
}
#else
#include <dirent.h>
#include <unistd.h>
static void MkDir(const std::string& d) { mkdir(d.c_str(), 0700); }
static void RmDir(const std::string& d) { rmdir(d.c_str()); }
static void RemoveSandbox(const std::string& d) {
    DIR* dp = opendir(d.c_str());
    if (dp) {
        struct dirent* e = nullptr;
        while ((e = readdir(dp)) != nullptr) {
            std::string n = e->d_name;
            if (n == "." || n == "..") continue;
            std::remove((d + "/" + n).c_str());
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
                              std::string* cid_out) {
    char cid[65];
    if (!jev::broker::MakeClientOrderId(
            "alpaca-paper", "test", std::string(64, 'a').c_str(), sym,
            side01 == 1 ? jev::broker::OrderSide::SELL
                        : jev::broker::OrderSide::BUY,
            iid, cid))
        return "";
    if (cid_out) *cid_out = cid;
    jev::journal::Row r;
    std::string body = std::string("intent sym=") + sym;
    if (!jev::journal::FormatRow(
            0, 1800000000000000000LL, "intent", iid,
            jev::Sha256Hex(body).c_str(),
            jev::journal::GenesisPrev().c_str(), &r))
        return "";
    char ln[1024];
    std::snprintf(ln, sizeof(ln), "%llu|%lld|%s|%s|%s|%s|%s",
                  (unsigned long long)r.seq, (long long)r.ts_ns,
                  r.kind.c_str(), r.intent_id.c_str(),
                  r.payload_hash.c_str(), r.prev_hash.c_str(),
                  r.row_hash.c_str());
    WriteFile(dir + "/journal.jsonl", ln + std::string("\n"));
    char iln[128];
    std::snprintf(iln, sizeof(iln), "%s|%d|%d|%lld|22000|24000", sym,
                  side01, kind01, qty);
    WriteFile(dir + "/intent-" + std::string(iid) + ".txt", iln);
    char snap[320];
    std::snprintf(snap, sizeof(snap),
                  "H1:%d:%d:%lld:0:0:0:%s::%s:%s:%d::0:0:0:0", st,
                  kind01, filled, cid, iid, sym, side01);
    WriteFile(dir + "/snap-" + std::string(iid) + ".txt", snap);
    return cid;
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
        jev::runner::SseEvent f;
        f.id = "01J000000000000000000000009";
        f.type = "partial_fill";
        f.data =
            "{\"client_order_id\":\"abc123\",\"qty\":\"40\"}";
        auto mf = jev::runner::MapTradeEvent(f);
        Check(mf.kind == jev::runner::StreamKind::FILL &&
                  mf.filled_qty == 40 &&
                  std::string(mf.client_id) == "abc123" &&
                  std::string(mf.event_id) ==
                      "01J000000000000000000000009",
              "map-fill");
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
            "{\"client_order_id\":\"abc123\",\"qty\":\"x\"}";
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
            "event: partial_fill\ndata: {\"client_order_id\":\"" +
            cid + "\",\"qty\":\"40\"}\n\n";
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
            "data: {\"client_order_id\":\"" +
            cid + "\",\"qty\":\"40\"}\n\n";
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
            "data: {\"client_order_id\":\"" +
            cid + "\",\"qty\":\"40\"}\n\n";
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
    if (g_fail == 0)
        std::printf("RUNNER SUITE: ALL PASS (%d checks)\n", g_count);
    return g_fail ? 1 : 0;
}
