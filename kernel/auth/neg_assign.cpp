// Slice A negative probe: copy-assignment is deleted (an authorized
// request cannot be overwritten with another, let alone mutated).
// Must FAIL compilation: use of deleted copy-assignment.
#include "../kernel_state.hpp"
int main() {
    jev::KernelState k;
    std::string w;
    jev::KernelState::Create({"EURUSD"}, w, k);
    std::array<uint8_t, 32> z{};
    jev::ValidationRequest q =
        k.request_for("{}", z, "{}", "EURUSD", 0.0, jev::Mode::REPLAY);
    jev::ValidationRequest q2 =
        k.request_for("{}", z, "{}", "EURUSD", 0.0, jev::Mode::REPLAY);
    q = q2;
    return 0;
}
