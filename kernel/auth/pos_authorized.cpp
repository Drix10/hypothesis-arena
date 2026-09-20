// Slice A positive control: the authorized path compiles, links, runs.
// Must compile AND exit 0: request_for() manufactures the request,
// validate_jev() reads it, and a COPY of an authorized request validates
// identically (copying allowed, mutation impossible).
#include <cstdio>
#include "../kernel_state.hpp"
int main() {
    jev::KernelState k;
    std::string w;
    if (!jev::KernelState::Create({"EURUSD"}, w, k)) {
        printf("FAIL kernel-setup\n");
        return 1;
    }
    std::array<uint8_t, 32> z{};
    jev::ValidationRequest q =
        k.request_for("{bad", z, "{}", "EURUSD", 0.0, jev::Mode::REPLAY);
    jev::ValidationResult r = jev::validate_jev(q);
    if (r.ok()) {
        printf("FAIL garbage-accepted\n");
        return 1;
    }
    jev::ValidationRequest q2 = q;  // copy an authorized request
    jev::ValidationResult r2 = jev::validate_jev(q2);
    if (r2.ok() || r2.reason() != r.reason()) {
        printf("FAIL copy-diverged\n");
        return 1;
    }
    printf("auth-positive: ok\n");
    return 0;
}
