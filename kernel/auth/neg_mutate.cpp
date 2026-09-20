// Slice A negative probe: scalar state cannot be assigned through the
// read-only accessor (it yields a prvalue, not a mutable reference).
// Must FAIL compilation: assignment to a value, not an lvalue.
#include "../kernel_state.hpp"
int main() {
    jev::KernelState k;
    std::string w;
    jev::KernelState::Create({"EURUSD"}, w, k);
    std::array<uint8_t, 32> z{};
    jev::ValidationRequest q =
        k.request_for("{}", z, "{}", "EURUSD", 0.0, jev::Mode::REPLAY);
    q.now_unix() = 1.0;
    return 0;
}
