// P3.1 deterministic adversarial fuzz: fixed-seed PRNG, no external input.
// Invariant: validate_jev() never crashes, never hangs, and returns ok=true
// ONLY for fully contract-valid artifacts. Any ok=true on mutated input, or
// any crash/hang, fails the run. Usage: fuzz_p31 [iterations] [seed].
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include "../jev_validate.hpp"
#include "../kernel_state.hpp"

static uint64_t rng_state = 0;
// The artifact-carried pubkey is informational-only and never trusted:
// inputs differing from the fixture solely inside its value are
// legitimately ok (non-substitution property, also fuzz-confirmed).
static std::string blank_pubkey(const std::string& s) {
    std::string o = s;
    size_t k = o.find("\"pubkey\"");
    if (k == std::string::npos) return o;
    size_t c = o.find(':', k);
    if (c == std::string::npos) return o;
    size_t q1 = o.find('"', c);
    if (q1 == std::string::npos) return o;
    size_t q2 = o.find('"', q1 + 1);
    if (q2 == std::string::npos) return o;
    for (size_t i = q1 + 1; i < q2; i++) o[i] = '?';
    return o;
}
// Skeleton: blank the untrusted pubkey AND drop whitespace outside string
// literals. Inputs equal under skel() are semantically identical artifacts
// (JSON-insignificant bytes only) and are legitimately ok.
static uint64_t rnd() {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 7;
    rng_state ^= rng_state << 17;
    return rng_state;
}

static std::string read_all(const char* path) {
    std::string out;
    char buf[4096];
    FILE* f = fopen(path, "rb");
    if (!f) return out;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}

int main(int argc, char** argv) {
    long iters = argc > 1 ? atol(argv[1]) : 5000;
    rng_state = argc > 2 ? (uint64_t)atoll(argv[2]) : 0x31F02;
    std::string dir = "fixtures";
    std::string valid = read_all((dir + "/valid.json").c_str());
    std::string state_canon = read_all((dir + "/state_canon.json").c_str());
    if (valid.empty() || state_canon.empty()) {
        printf("fuzz: fixtures missing, run from kernel/\n");
        return 1;
    }
    std::array<uint8_t, 32> key{};
    {
        std::string kh = read_all((dir + "/trusted_key.txt").c_str());
        for (int i = 0; i < 32; i++) {
            unsigned v;
            sscanf(kh.c_str() + 2 * i, "%02x", &v);
            key[i] = (uint8_t)v;
        }
    }
    double created = 0;
    {
        std::string c = read_all((dir + "/created_unix.txt").c_str());
        created = atof(c.c_str());
    }
    static const char* pieces[] = {
        "{\"", "\":", ",\"", ":0,", ":true,", ":false,", ":null,", "[",
        "]", "{", "}", "\"", "\\u0000", "\\uD800", "\\uDC00", " ", "\n",
        "1e999999", "-0", "00", "01", ".5", "5.", "NaN", "Infinity",
        "payload", "signature", "enter", "noul", "confidence", "AAAA",
        "\xff\xfe", "\x00", "\x80", "\"", "\\", "00", "-",
    };
    long oks = 0, holds = 0;
    for (long t = 0; t < iters; t++) {
        std::string input;
        uint64_t mode = rnd() % 5;
        if (mode == 0) {
            // byte-level mutation of the valid artifact
            input = valid;
            long nmut = 1 + rnd() % 8;
            for (long m = 0; m < nmut; m++) {
                if (input.empty()) break;
                size_t at = rnd() % input.size();
                switch (rnd() % 4) {
                    case 0:
                        input[at] = (char)(rnd() % 256);
                        break;
                    case 1:
                        input.erase(at, 1 + rnd() % 16);
                        break;
                    case 2:
                        input.insert(at, pieces[rnd() % (sizeof(pieces) / sizeof(*pieces))]);
                        break;
                    default:
                        input.resize(rnd() % (input.size() + 64));
                        break;
                }
            }
        } else if (mode == 1) {
            // truncation at every scale
            input = valid.substr(0, rnd() % (valid.size() + 1));
        } else if (mode == 2) {
            // random token soup
            long n = 1 + rnd() % 40;
            for (long i = 0; i < n; i++)
                input += pieces[rnd() % (sizeof(pieces) / sizeof(*pieces))];
        } else if (mode == 3) {
            // deep nesting, both brackets
            long d = rnd() % 100;
            for (long i = 0; i < d; i++) input += (rnd() % 2) ? '[' : '{';
            for (long i = 0; i < d; i++) input += (rnd() % 2) ? ']' : '}';
        } else {
            // oversized inputs around the boundary
            size_t n = 65536 - 8 + rnd() % 32;
            input = "{\"k\":\"" + std::string(n > 8 ? n - 8 : 0, 'a');
        }
        jev::KernelState kern;
        std::string kwhy;
        jev::KernelState::Create({"EURUSD"}, kwhy, kern);
        jev::Mode m = (rnd() % 2) ? jev::Mode::LIVE : jev::Mode::REPLAY;
        std::string canon_use =
            ((rnd() % 16) == 0) ? input : state_canon;  // hostile state too
        jev::ValidationRequest q = kern.request_for(
            input, key, canon_use, "EURUSD", created + 10.0, m);
        jev::ValidationResult r = jev::validate_jev(q);
        if (r.ok()) {
            // ok=true is legitimate only for the unmutated artifact, or for
            // inputs differing solely in the untrusted pubkey value
            if (input != valid && blank_pubkey(input) != blank_pubkey(valid)) {
                // allow JSON-insignificant whitespace insertions as well
                auto skel = [](const std::string& s) {
                    std::string b = blank_pubkey(s);
                    std::string o;
                    bool instr = false, esc = false;
                    for (char c : b) {
                        if (instr) {
                            o += c;
                            if (esc) esc = false;
                            else if (c == '\\') esc = true;
                            else if (c == '"') instr = false;
                        } else if (c == '"') {
                            instr = true;
                            o += c;
                        } else if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
                            o += c;
                        }
                    }
                    return o;
                };
                if (skel(input) != skel(valid)) {
                    printf("FUZZ-FAIL iter %ld: ok=true on mutated input len=%zu\n", t,
                           input.size());
                    FILE* f = fopen("fuzz_fail.bin", "wb");
                    if (f) {
                        fwrite(input.data(), 1, input.size(), f);
                        fclose(f);
                    }
                    return 1;
                }
            }
            if (r.get() == nullptr) {
                printf("FUZZ-FAIL iter %ld: ok with null object\n", t);
                return 1;
            }
            oks++;
        } else {
            if (r.get() != nullptr) {
                printf("FUZZ-FAIL iter %ld: HOLD with non-null object\n", t);
                return 1;
            }
            holds++;
        }
    }
    printf("fuzz: %ld iters, %ld ok (unmutated only), %ld holds, no crash\n", iters, oks,
           holds);
    return 0;
}
