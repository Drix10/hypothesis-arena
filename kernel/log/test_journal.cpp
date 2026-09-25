// H1 gate [correctness]: journal chain + redaction.
// Usage: ./test_journal
#include <cstdio>

#include "journal.hpp"

static int g_fail = 0;
static int g_count = 0;

static void Check(bool cond, const char* name) {
    ++g_count;
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

int main() {
    using jev::journal::FormatRow;
    using jev::journal::GenesisPrev;
    using jev::journal::RedactionOk;
    using jev::journal::Row;
    using jev::journal::VerifyChain;
    using jev::journal::VerifyRow;
    const char* hex64 =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    // 1. well-formed row verifies
    Row r;
    Check(FormatRow(0, 1000, "intent", "i-1", hex64,
                    GenesisPrev().c_str(), &r) &&
              VerifyRow(r),
          "row-roundtrip");
    // 2. admission rejects
    {
        Row q;
        Check(!FormatRow(0, 1000, "nope", "i-1", hex64,
                         GenesisPrev().c_str(), &q),
              "reject-kind");
        Check(!FormatRow(0, 1000, "intent", "", hex64,
                         GenesisPrev().c_str(), &q),
              "reject-empty-intent");
        Check(!FormatRow(0, 1000, "intent", "i-1", "zz",
                         GenesisPrev().c_str(), &q),
              "reject-bad-payload");
        Check(!FormatRow(0, 0, "intent", "i-1", hex64,
                         GenesisPrev().c_str(), &q),
              "reject-bad-ts");
        Check(!FormatRow(0, 1000, "intent", "i-1", hex64,
                         GenesisPrev().c_str(), nullptr),
              "reject-null-out");
    }
    // 3. tamper detection: any digest/field edit breaks VerifyRow
    {
        Row t = r;
        t.row_hash[0] = (t.row_hash[0] == 'a') ? 'b' : 'a';
        Check(!VerifyRow(t), "tamper-hash");
        t = r;
        t.payload_hash[3] = (t.payload_hash[3] == 'a') ? 'b' : 'a';
        Check(!VerifyRow(t), "tamper-payload");
        t = r;
        t.intent_id += "x";
        Check(!VerifyRow(t), "tamper-intent");
    }
    // 4. chain links seq + prev correctly; breaks fail
    {
        Row c[3];
        bool ok = FormatRow(0, 1000, "intent", "i-1", hex64,
                            GenesisPrev().c_str(), &c[0]);
        ok = ok && FormatRow(1, 2000, "fill", "i-1", hex64,
                             c[0].row_hash.c_str(), &c[1]);
        ok = ok && FormatRow(2, 3000, "exit", "i-1", hex64,
                             c[1].row_hash.c_str(), &c[2]);
        Check(ok && VerifyChain(c, 3), "chain-links");
        Check(!VerifyChain(nullptr, 1), "chain-null");
        Check(VerifyChain(c, 0), "chain-empty");
        Row b[3] = {c[0], c[1], c[2]};
        b[2].prev_hash = GenesisPrev();
        Check(!VerifyChain(b, 3), "chain-prev-break");
        Row s[3] = {c[0], c[1], c[2]};
        // Re-sequence the tail: rows 1,1 instead of 1,2.
        Row re;
        FormatRow(1, 3000, "exit", "i-1", hex64,
                  c[0].row_hash.c_str(), &re);
        s[1] = c[1];
        s[2] = re;
        Check(!VerifyChain(s, 3), "chain-seq-break");
        Row g[2] = {c[0], c[1]};
        g[0].prev_hash = hex64;  // first row must link genesis
        Check(!VerifyChain(g, 2), "chain-genesis-break");
    }
    // 5. all frozen kinds format
    {
        const char* kinds[] = {"intent",  "fill",   "partial", "cancel",
                               "unknown", "exit",   "drift-directive",
                               "demotion", "reconcile", "repair"};
        bool ok = true;
        for (std::size_t i = 0; i < 10; ++i) {
            Row k;
            ok = ok && FormatRow(i, 1000 + (int)i, kinds[i], "i-9",
                                 hex64, GenesisPrev().c_str(), &k) &&
                 VerifyRow(k);
        }
        Check(ok, "all-kinds");
    }
    // 6. redaction gate
    {
        Check(RedactionOk("fill 100 AAPL @ 23110"), "redact-clean");
        Check(!RedactionOk(nullptr), "redact-null");
        Check(!RedactionOk("key=ALPACA123"), "redact-alpaca");
        Check(!RedactionOk("api_key=x"), "redact-apikey");
        Check(!RedactionOk("use secret y"), "redact-secret");
        Check(!RedactionOk("Bearer abc"), "redact-bearer");
        char big[300];
        for (int i = 0; i < 299; ++i) big[i] = 'z';
        big[299] = '\0';
        Check(!RedactionOk(big), "redact-overlong");
    }
    if (g_fail == 0) std::printf("JOURNAL SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
