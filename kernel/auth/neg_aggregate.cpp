// Slice A negative probe: no aggregate/braced construction path.
// Must FAIL compilation: the full-args constructor is private to
// KernelState (ordinary callers cannot manufacture requests).
#include "../jev_validate.hpp"
int main() {
    std::array<uint8_t, 32> z{};
    jev::ValidationRequest q{"{}", z, "{}", {"EURUSD"}, false, 0, 0.0,
                             jev::Mode::LIVE, "EURUSD"};
    (void)q;
    return 0;
}
