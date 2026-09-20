// Slice A negative probe: default construction is absent (deleted).
// Must FAIL compilation: 'ValidationRequest()' is deleted.
#include "../jev_validate.hpp"
int main() {
    jev::ValidationRequest q;
    (void)q;
    return 0;
}
