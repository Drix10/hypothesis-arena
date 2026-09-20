#include <cstdio>
#include <string>
#include "jev_validate.hpp"
static std::string read_all(const char* p) {
    std::string o; char b[4096]; FILE* f = fopen(p, "rb"); size_t n;
    while ((n = fread(b, 1, sizeof(b), f)) > 0) o.append(b, n); fclose(f); return o;
}
int main() {
    jev::JVal v; std::string e;
    bool ok = jev::ParseJson(read_all("vectors/v2_payload.json"), v, e);
    printf("v2 parse=%d err=%s\n", (int)ok, e.c_str());
    jev::ValidationRequest q;
    q.raw_json = read_all("vectors/v1_artifact.json");
    std::string kh = read_all("vectors/pubkey.txt");
    for (int i = 0; i < 32; i++) { unsigned u; sscanf(kh.c_str() + 2*i, "%02x", &u); q.trusted_key[i] = (uint8_t)u; }
    q.state_canon_json = read_all("vectors/v1_state_canon.json");
    q.allowed_symbols = {"EURUSD"};
    q.now_unix = 1758412810.0;
    jev::ValidationResult r = jev::validate_jev(q);
    printf("v1 valid=%d reason=%s\n", (int)r.ok(), r.reason().c_str());
    return 0;
}
