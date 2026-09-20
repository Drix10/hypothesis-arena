#!/bin/bash
# P3.1 gate: build + full validator suite + API-surface check.
set -e
cd "$(dirname "$0")"
g++ -std=c++17 -Wall -Wextra -O2 -o test_p31 test_p31.cpp
./test_p31 fixtures
# Acceptance 14: no downstream function may accept raw JEV JSON.
# The header exposes exactly one entry point: validate_jev().
if grep -nE "\b(evaluate|decide|decide_from_json|from_json)\s*\(" jev_validate.hpp \
    | grep -v validate_jev; then
    echo "GATE FAIL: raw-JSON downstream API present"
    exit 1
fi
echo "P3.1 GATE: PASS"
