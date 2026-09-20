// Slice A negative probe: container state cannot be mutated through the
// read-only accessor (const reference into const storage).
// Must FAIL compilation: mutating a const container.
#include "../kernel_state.hpp"
int main() {
    jev::KernelState k;
    std::string w;
    jev::KernelState::Create({"EURUSD"}, w, k);
    std::array<uint8_t, 32> z{};
    jev::ValidationRequest q =
        k.request_for("{}", z, "{}", "EURUSD", 0.0, jev::Mode::REPLAY);
    q.allowed_symbols().push_back("XXX");
    return 0;
}
