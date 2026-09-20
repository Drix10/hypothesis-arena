// Slice A negative probe: friend leakage. A deliberately non-friend
// helper attempting private construction must fail. The occurrence-count
// gate catches smuggled friend DECLARATIONS it can name; this probe
// catches access PATHS no text gate can enumerate: only KernelState can
// construct, regardless of what any third party attempts.
// Must FAIL compilation: private constructor within this context.
#include "../kernel_state.hpp"
struct UnauthorizedHelper {
    static jev::ValidationRequest forge() {
        std::array<uint8_t, 32> z{};
        return jev::ValidationRequest("{}", z, "{}", {"EURUSD"}, false, 0,
                                      0.0, jev::Mode::REPLAY, "EURUSD");
    }
};
int main() {
    jev::KernelState k;
    std::string w;
    jev::KernelState::Create({"EURUSD"}, w, k);
    jev::ValidationRequest q = UnauthorizedHelper::forge();
    (void)q;
    return 0;
}
