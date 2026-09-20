#!/bin/bash
# P3.1 gate: build + full validator suite + fuzz + API-surface check.
# Usage: ./build.sh [normal|hardened]
# Sanitizers: GCC ASan/UBSan runtimes do NOT ship for this MinGW target
# (link fails: collect2 ld error, no libasan/libubsan). The hardened mode
# below is the available substitute: libstdc++ debug containers, stack
# protector, fortify, static analyzer. Revisit on a Linux toolchain.
set -e
cd "$(dirname "$0")"
MODE="${1:-normal}"
if [ "$MODE" = "hardened" ]; then
    FLAGS="-std=c++17 -Wall -Wextra -O1 -g -D_GLIBCXX_DEBUG -D_GLIBCXX_DEBUG_PEDANTIC -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fanalyzer"
    echo "--- hardened build (no sanitizer runtimes on this toolchain) ---"
    # The compiler targets UCRT64; run its binaries with the matching runtime.
    export PATH=/c/msys64/ucrt64/bin:$PATH
else
    FLAGS="-std=c++17 -Wall -Wextra -O2"
fi
g++ $FLAGS -o test_p31 test_p31.cpp
./test_p31 fixtures
g++ $FLAGS -o test_p32 test_p32.cpp
./test_p32 vectors
g++ $FLAGS -o test_p33 test_p33.cpp
./test_p33 p33 fixtures
g++ $FLAGS -o fuzz_p31 fuzz_p31.cpp
./fuzz_p31 20000
# Acceptance: no downstream function may accept raw JEV JSON.
# The header exposes exactly one entry point: validate_jev().
if grep -nE "\b(evaluate|decide|decide_from_json|from_json)\s*\(" jev_validate.hpp \
    | grep -v validate_jev; then
    echo "GATE FAIL: raw-JSON downstream API present"
    exit 1
fi
# P3.3: the decision table consumes the typed object only (never raw JSON
# or parsed AnswerSet values smuggled around the validator).
if grep -nE "EvaluateDecision[^(]*\([^)]*std::string" decision_table.hpp; then
    echo "GATE FAIL: decision table takes raw strings"
    exit 1
fi
# No confidence accessor may exist on any decision object (P3.4/b quarantine).
if grep -nE "confidence\s*\(\s*\)" jev_validate.hpp jev_state.hpp kernel_state.hpp decision_table.hpp; then
    echo "GATE FAIL: confidence accessor present"
    exit 1
fi
# Confidence must never be READ on any kernel path (comments may name it).
if grep -nE "\.confidence|->confidence" jev_state.hpp kernel_state.hpp decision_table.hpp; then
    echo "GATE FAIL: confidence read on kernel path"
    exit 1
fi
# P3.2 interop: test_p32.cpp must never invoke Python (committed files only).
if grep -nE "popen|system\(|python" test_p32.cpp; then
    echo "GATE FAIL: test_p32 depends on Python"
    exit 1
fi
# P3.3 replay/table suite: committed files only, same rule.
if grep -nE "popen|system\(|python" test_p33.cpp; then
    echo "GATE FAIL: test_p33 depends on Python"
    exit 1
fi
echo "P3.1 GATE ($MODE): PASS"
