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
g++ $FLAGS -o tests/test_p31 tests/test_p31.cpp
./tests/test_p31 fixtures
g++ $FLAGS -o tests/test_p32 tests/test_p32.cpp
./tests/test_p32 vectors
g++ $FLAGS -o tests/test_p33 tests/test_p33.cpp
./tests/test_p33 p33 fixtures
# Slice A authority proof: the boundary is compiler-enforced, not merely
# grep-policed. Each neg_* probe must FAIL compilation for its documented
# reason; the positive control must compile, run, and exit 0 (it proves
# the toolchain is healthy, so the failures are real rejections).
for neg in auth/neg_*.cpp; do
    # set -e is on: a failing probe compile would kill the script
    # silently via the bare assignment, so capture status explicitly.
    set +e
    err="$(g++ $FLAGS -o /tmp/auth_neg "$neg" 2>&1)"
    st=$?
    set -e
    if [ $st -eq 0 ]; then
        echo "GATE FAIL: $neg compiled (authority boundary breached)"
        exit 1
    fi
    echo "$err" | grep -qiE "private|deleted|read-only|lvalue|discards qualifiers" || {
        echo "GATE FAIL: $neg failed for the wrong reason"
        echo "$err" | head -5
        exit 1
    }
done
g++ $FLAGS -o /tmp/auth_pos auth/pos_authorized.cpp
/tmp/auth_pos || { echo "GATE FAIL: authorized path broken"; exit 1; }
# Friend list pinned tight INSIDE ValidationRequest: exactly the
# construction authority plus the read-only validator. Counts are
# OCCURRENCES, not lines (a smuggled second declaration on one line must
# still trip the gate), taken over the comment-stripped region (a matching
# comment must never satisfy a positive check). Any third friend in that
# region is a second authority. The neg_friendleak probe covers access
# paths no text gate can name.
_region="$(sed -n '/^class ValidationRequest {/,/^};/p' jev_validate.hpp | sed 's|//.*||')"
[ "$(echo "$_region" | grep -o 'friend class KernelState;' | wc -l | tr -d ' ')" = "1" ] || {
    echo "GATE FAIL: KernelState friendship moved"; exit 1; }
[ "$(echo "$_region" | grep -o 'friend ValidationResult validate_jev(const ValidationRequest&);' | wc -l | tr -d ' ')" = "1" ] || {
    echo "GATE FAIL: validator friendship moved"; exit 1; }
[ "$(echo "$_region" | grep -o 'friend ' | wc -l | tr -d ' ')" = "2" ] || {
    echo "GATE FAIL: unexpected friend (authority leak)"; exit 1; }
g++ $FLAGS -o tests/fuzz_p31 tests/fuzz_p31.cpp
./tests/fuzz_p31 20000
# Slice B gate [correctness]: veto unit suite (doc 05 rule boundaries +
# composed veto+table rows on committed P3.3 artifacts).
g++ $FLAGS -o test_veto risk/test_veto.cpp risk/veto.cpp
./test_veto p33 fixtures
# Slice B JEV isolation: veto.cpp must never read bounded model answers
# (method calls or the validated type) , the frozen sec.3.2 table is the
# ONLY path from answers to size. This gate fails the build if any such
# path is introduced, including via comments naming call syntax.
for tok in '\.enter\(\)' 'latent_risk\(\)' 'conviction\(\)' 'family\(\)' \
           'ValidatedJEVAnswerSetV3'; do
    if grep -nE "$tok" risk/veto.cpp; then
        echo "GATE FAIL: JEV answer read in veto ($tok)"
        exit 1
    fi
done
# Slice B zero-malloc contract (correction): EvaluateVeto's execution +
# verdict type allocate nothing. Forbid heap vocabulary in veto.cpp
# (inputs are adapter-built upstream of the tick path; the verdict itself
# is proven fixed-storage by static_assert in veto.hpp).
if grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new" risk/veto.cpp; then
    echo "GATE FAIL: heap use in veto execution path"
    exit 1
fi
# Slice C gate [correctness]: ingest suite (sec.4.5 rejection tests + f2
# boundaries + retention + rate window).
g++ $FLAGS -o test_features ingest/test_features.cpp ingest/features.cpp
./test_features
# Slice C zero-malloc contract: validation + retention allocate nothing
# (comments stripped: the discipline note names the forbidden tokens).
# U8()/JVal::find are forbidden in the ingest path: both build key
# temporaries that may heap-allocate through helpers defined elsewhere,
# invisible to a vocabulary grep. Lookup runs via FindAscii.
if sed 's|//.*||' ingest/features.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new|U8\(|\.find\("; then
    echo "GATE FAIL: heap use in ingest execution path"
    exit 1
fi
# Slice C runtime proof (not only grep): wrapped-malloc counter around
# the validation path must stay zero. Static libstdc++ so operator new
# resolves to the wrapped malloc.
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc ingest/test_noalloc.cpp ingest/features.cpp
./test_noalloc
# Slice D gate [correctness + drill]: kill evaluation, entry gate,
# MEDIUM flatten FSM, HARD ordered sequence, persistence round-trip
# (doc 10 sec. 10.3, R16; evaluation/actuation boundary per packet v2).
g++ $FLAGS -o test_kill kill/test_kill.cpp kill/switch.cpp
./test_kill
# Slice D zero-malloc contract: evaluation + FSM + persistence allocate
# nothing (comments stripped: the discipline note names the tokens).
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc_kill kill/test_noalloc_kill.cpp kill/switch.cpp
./test_noalloc_kill
# H1 gate [correctness + drill]: router lifecycle, journal chain,
# broker recipe + Alpaca protected-entry semantics (doc 06 sec. 6.1,
# packet v3: lifecycle-only router, journal-before-order, E1).
g++ $FLAGS -o test_router exec/test_router.cpp exec/router.cpp broker/adapter.cpp
./test_router
g++ $FLAGS -o test_journal log/test_journal.cpp log/journal.cpp
./test_journal
g++ $FLAGS -o test_broker broker/test_broker.cpp broker/adapter.cpp broker/alpaca_paper.cpp
./test_broker
g++ $FLAGS -o test_drills exec/test_drills.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
./test_drills
# H1 zero-malloc contract: the router STEP CORE allocates nothing
# (identity minting at IDLE is documented cycle-path and excluded
# here; the loop covers the IDLE-reject path + every post-identity
# state x observation shape).
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc_exec exec/test_noalloc_exec.cpp exec/router.cpp broker/adapter.cpp
./test_noalloc_exec
if sed 's|//.*||' exec/router.hpp exec/router.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new"; then
    echo "GATE FAIL: heap use in router step core"
    exit 1
fi
# H1 isolation: no model-answer reads, no confidence, no risk-path
# computation tokens, no clocks, no network affordances in H1 kernel
# files (comments stripped; journal/broker std::string is documented
# cycle-path, same class as Slice E).
for tok in '\.enter\(\)' 'latent_risk\(\)' 'conviction\(\)' 'family\(\)' \
           'ValidatedJEVAnswerSetV3' 'confidence' 'StageScale' \
           'PendingNotional' 'ReservedRisk' 'BuyingPower' \
           'DriftSelection' 'EvaluateVeto' 'clock\(' 'chrono' \
           'gettime' 'socket' 'popen' 'system\(' 'curl' 'getaddrinfo'; do
    if sed 's|//.*||' exec/router.hpp exec/router.cpp log/journal.hpp log/journal.cpp broker/adapter.hpp broker/adapter.cpp broker/alpaca_paper.hpp broker/alpaca_paper.cpp | grep -nE "$tok"; then
        echo "GATE FAIL: forbidden path in H1 ($tok)"
        exit 1
    fi
done
if sed 's|//.*||' kill/switch.hpp kill/switch.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new"; then
    echo "GATE FAIL: heap use in kill evaluation path"
    exit 1
fi
# Slice D isolation: evaluation never reads JEV answers, confidence, or
# any network/process/research affordance (comments stripped; the test
# files are allowed clocks for the non-blocking proof, switch.* never).
for tok in '\.enter\(\)' 'latent_risk\(\)' 'conviction\(\)' 'family\(\)' \
           'ValidatedJEVAnswerSetV3' 'confidence' 'popen' 'system\(' \
           'socket' 'getaddrinfo' 'curl' 'clock\(' 'time\(' 'chrono'; do
    if sed 's|//.*||' kill/switch.hpp kill/switch.cpp | grep -nE "$tok"; then
        echo "GATE FAIL: forbidden path in kill ($tok)"
        exit 1
    fi
done
# Slice E gate [correctness]: STAGE chain verify, corruption fails to
# G0_PAPER (doc 10 sec. 10.1 legacy bootstrap).
g++ $FLAGS -o test_stage stage/test_stage.cpp stage/stage.cpp
./test_stage
# Slice F gate [correctness]: feed ring/gap/backoff/session (doc 04
# sec. 4.2.2, Alpaca paper poll path; machinery only, never authority).
g++ $FLAGS -o test_feed feed/test_feed.cpp feed/feed.cpp
./test_feed
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc_feed feed/test_noalloc_feed.cpp feed/feed.cpp
./test_noalloc_feed
# Slice F allocation contract: heap-once lives in the TickRing
# constructor (a 64k member array would blow the thread stack); the
# tick path itself allocates nothing.
[ "$(sed 's|//.*||' feed/feed.cpp | grep -o 'new ' | wc -l | tr -d ' ')" = "1" ] || {
    echo "GATE FAIL: heap use beyond ring construction"; exit 1; }
if sed 's|//.*||' feed/feed.cpp | grep -nE "malloc|calloc|realloc|strdup|std::string|std::vector"; then
    echo "GATE FAIL: heap use in feed tick path"; exit 1;
fi
# Slice G gate [correctness]: frozen Snapshot validation, canonical
# determinism (10k -> 1 hash), mutation sensitivity, golden bytes
# (doc 04 sec. 4.2.3; context_hash != state_hash, frozen).
g++ $FLAGS -o test_context ctx/test_context.cpp ctx/context.cpp
./test_context
# Slice G vocabulary: regime/calib/source/session/stage sets are
# frozen mirrors — the gate enforces each EXACT definition line once
# (a second spelling anywhere trips the count) and forbids parallel
# stage literals (stage vocabulary lives in Slice E only).
[ "$(grep -c 's == "trend" || s == "range" || s == "volatile"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: regime vocabulary moved/duplicated"; exit 1; }
[ "$(grep -c 's == "pass" || s == "insufficient" || s == "breach"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: calib vocabulary moved/duplicated"; exit 1; }
[ "$(grep -c 's == "healthy" || s == "stale" || s == "failed"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: source vocabulary moved/duplicated"; exit 1; }
# The retired G-local spellings must not reappear as literals.
if grep -nE '"fresh"|"absent"|"invalid"' ctx/snapshot.hpp ctx/context.cpp; then
    echo "GATE FAIL: retired source vocabulary present"; exit 1;
fi
[ "$(grep -c 's == "open" || s == "closed" || s == "holiday"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: session vocabulary moved/duplicated"; exit 1; }
if grep -nE '"G1_TINY"|"G2_SCALED"|"G3_FULL"' ctx/snapshot.hpp ctx/context.cpp; then
    echo "GATE FAIL: stage literals outside Slice E"; exit 1;
fi
[ "$(grep -c 'stage::IsKnownStage' ctx/context.cpp)" = "1" ] || {
    echo "GATE FAIL: stage check moved/duplicated"; exit 1; }
# Slice F/G resource proof: wrapped-malloc counter around the tick
# path (ring + gaps + backoff + session) must stay zero. Context
# assembly/hashing is cycle-path with a bounded-output assertion in
# test_context, not part of this proof.
# Slice E authority: effective stage is the verified file stage or
# G0_PAPER — no promotion path may exist here. The G1+/G2/G3 literals
# appear only as known-vocabulary checks/tests.
if grep -nE "effective\s*=\s*\"G[123]" stage/stage.cpp; then
    echo "GATE FAIL: stage escalation assignment present"
    exit 1
fi
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
if grep -nE "popen|system\(|python" tests/test_p32.cpp; then
    echo "GATE FAIL: test_p32 depends on Python"
    exit 1
fi
# P3.3 replay/table suite: committed files only, same rule.
if grep -nE "popen|system\(|python" tests/test_p33.cpp; then
    echo "GATE FAIL: test_p33 depends on Python"
    exit 1
fi
echo "P3.1 GATE ($MODE): PASS"
