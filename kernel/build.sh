#!/bin/bash
# Kernel gate: build + every suite + authority/isolation/allocation greps.
# Usage: ./build.sh [normal|hardened|sanitize]
# Sanitizers: GCC ASan/UBSan runtimes do not ship for this MinGW target
# (link fails: collect2 ld error, no libasan/libubsan). The hardened mode
# below is the available substitute: libstdc++ debug containers, stack
# protector, fortify, static analyzer. Revisit on a Linux toolchain.
set -e
cd "$(dirname "$0")"
MODE="${1:-normal}"
# Freeze v3 O3: permission-denied tests (chmod 000) cannot fail closed as
# root, so a root run would be a false green. Refuse rather than skip.
if [ "$(id -u)" = "0" ]; then
    echo "GATE FAIL: run kernel/build.sh as a non-root user (chmod-000 fail-closed tests are meaningless as root)" >&2
    exit 2
fi
if [ "$MODE" = "sanitize" ]; then
    # S7-A: real ASan+UBSan runtimes on a Linux toolchain (hosted CI).
    # Same gates, same contracts; no production behavior change.
    # The --wrap,malloc allocation proofs are skipped here by design:
    # sanitizer runtimes replace the allocator (and need the shared
    # libstdc++), so link-time malloc wrapping cannot observe them.
    # Zero-heap discipline stays proven by the normal-mode gate.
    FLAGS="-std=c++17 -Wall -Wextra -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all"
    echo "--- sanitizer build (Linux ASan+UBSan, failures halt, no recovery) ---"
    SANITIZE=1
elif [ "$MODE" = "hardened" ]; then
    FLAGS="-std=c++17 -Wall -Wextra -O1 -g -D_GLIBCXX_DEBUG -D_GLIBCXX_DEBUG_PEDANTIC -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fanalyzer"
    echo "--- hardened build (no sanitizer runtimes on this toolchain) ---"
    # The compiler targets UCRT64; run its binaries with the matching runtime.
    export PATH=/c/msys64/ucrt64/bin:$PATH
else
    FLAGS="-std=c++17 -Wall -Wextra -O2"
fi
g++ $FLAGS -o tests/test_jev_filter tests/test_jev_filter.cpp
./tests/test_jev_filter jev_vectors
# Slice B gate [correctness]: veto unit suite (doc 05 rule boundaries +
# composed veto+filter rows on the committed filter vectors).
g++ $FLAGS -o test_veto risk/test_veto.cpp risk/veto.cpp
./test_veto jev_vectors
# Slice B JEV isolation: veto.cpp must never read bounded model answers
# (method calls or the validated type) , the frozen sec.3.2 table is the
# only path from answers to size. This gate fails the build if any such
# path is introduced, including via comments naming call syntax.
for tok in '\.enter\(\)' 'latent_risk\(\)' 'conviction\(\)' 'family\(\)' \
           'jev_filter'; do
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
g++ $FLAGS -o test_candidates ingest/test_candidates.cpp ingest/candidates.cpp
./test_candidates vectors
g++ $FLAGS -o test_sizing risk/test_sizing.cpp risk/sizing.cpp
./test_sizing
g++ $FLAGS -o test_measure risk/test_measure.cpp risk/measure.cpp
./test_measure
g++ $FLAGS -o test_decide exec/test_decide.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp ingest/candidates.cpp
./test_decide
g++ $FLAGS -o test_moc_plan exec/test_moc_plan.cpp exec/moc_plan.cpp
./test_moc_plan
g++ $FLAGS -o test_account runner/test_account.cpp runner/account.cpp
./test_account fixtures
g++ $FLAGS -o test_settle runner/test_settle.cpp runner/settle.cpp runner/calendar.cpp
./test_settle
g++ $FLAGS -o test_calendar runner/test_calendar.cpp runner/calendar.cpp
./test_calendar
g++ $FLAGS -o test_bars runner/test_bars.cpp runner/bars.cpp runner/calendar.cpp
./test_bars fixtures
g++ $FLAGS -o test_approved runner/test_approved.cpp runner/approved.cpp runner/calendar.cpp
./test_approved ..
# The no-filter decision path must never reach a JEV AnswerSet.
if grep -nE "AnswerSet|jev_filter|jev_wire.*Validate" exec/decide.cpp exec/decide.hpp risk/sizing.cpp risk/sizing.hpp; then
    echo "GATE FAIL: no-filter path touches the AnswerSet surface"
    exit 1
fi
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
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc ingest/test_noalloc.cpp ingest/features.cpp
./test_noalloc
fi
# Slice D gate [correctness + drill]: kill evaluation, entry gate,
# MEDIUM flatten FSM, HARD ordered sequence, persistence round-trip
# (doc 10 sec. 10.3, R16; evaluation/actuation boundary per packet v2).
g++ $FLAGS -o test_kill kill/test_kill.cpp kill/switch.cpp
./test_kill
# Slice D zero-malloc contract: evaluation + FSM + persistence allocate
# nothing (comments stripped: the discipline note names the tokens).
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc_kill kill/test_noalloc_kill.cpp kill/switch.cpp
./test_noalloc_kill
fi
# H1 gate [correctness + drill]: router lifecycle, journal chain,
# broker recipe + Alpaca protected-entry semantics (doc 06 sec. 6.1,
# packet v3: lifecycle-only router, journal-before-order, E1).
g++ $FLAGS -o test_router exec/test_router.cpp exec/router.cpp broker/adapter.cpp
./test_router
g++ $FLAGS -o test_journal log/test_journal.cpp log/journal.cpp
./test_journal
g++ $FLAGS -o test_broker broker/test_broker.cpp broker/adapter.cpp broker/alpaca_paper.cpp
./test_broker
g++ $FLAGS -o test_shapes broker/test_shapes.cpp broker/adapter.cpp broker/alpaca_paper.cpp
./test_shapes fixtures
g++ $FLAGS -o test_drills exec/test_drills.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
./test_drills
# H1 integration gate [correctness + drill]: G0 runner — durable
# journal/snapshots/freeze/STAGE/HALT/alerts, REST+stream reconcile,
# S2 cadence, emergency buffer, kill flatten, crash recovery
# (doc 06 sec. 6.1/6.2a/6.5, doc 10, doc 13 sec. 13.5 Slice H1).
# The runner is cycle-path (files, std::string/vector allowed — the
# noalloc gates cover the decision core, not durability). main.cpp
# compiles as the production entry (transport null = fail closed).
g++ $FLAGS -o test_runner runner/test_runner.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
./test_runner
g++ $FLAGS -o test_paper_loop runner/test_paper_loop.cpp runner/paper_loop.cpp runner/bars.cpp runner/calendar.cpp runner/account.cpp runner/settle.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp risk/measure.cpp ingest/candidates.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
./test_paper_loop fixtures
g++ $FLAGS -o g0_runner runner/main.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
# Live paper transport (libcurl): compiled and linked only when WITH_CURL=1;
# the smoke tool needs ALPACA_KEY_ID/ALPACA_SECRET and is run by hand.
if [ -n "${WITH_CURL:-}" ]; then
g++ $FLAGS -DG0_WITH_CURL -o g0_runner_paper runner/main.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp broker/http_curl.cpp broker/ws_stream.cpp log/journal.cpp kill/switch.cpp -lcurl
g++ $FLAGS -DG0_WITH_CURL -o g0_paper_loop runner/paper_loop_main.cpp runner/paper_loop.cpp runner/bars.cpp runner/calendar.cpp runner/account.cpp runner/settle.cpp runner/approved.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp risk/measure.cpp ingest/candidates.cpp broker/adapter.cpp broker/alpaca_paper.cpp broker/http_curl.cpp broker/ws_stream.cpp log/journal.cpp kill/switch.cpp -lcurl
g++ $FLAGS -o smoke_paper broker/smoke_paper.cpp broker/http_curl.cpp broker/alpaca_paper.cpp broker/adapter.cpp broker/ws_stream.cpp -lcurl
g++ $FLAGS -o live_drill broker/live_drill.cpp broker/http_curl.cpp broker/alpaca_paper.cpp broker/adapter.cpp broker/ws_stream.cpp -lcurl
g++ $FLAGS -DG0_TEST_BASE -o test_ws_stream broker/test_ws_stream.cpp broker/ws_stream.cpp -lcurl
./test_ws_stream unit
python3 tests/ws_faults.py ./test_ws_stream
g++ $FLAGS -DG0_TEST_BASE -o test_transport_faults broker/test_transport_faults.cpp broker/http_curl.cpp broker/alpaca_paper.cpp broker/adapter.cpp -lcurl
python3 tests/transport_faults.py ./test_transport_faults
g++ $FLAGS -DG0_WITH_CURL -DG0_TEST_BASE -o g0_paper_loop_mock runner/paper_loop_main.cpp runner/paper_loop.cpp runner/bars.cpp runner/calendar.cpp runner/account.cpp runner/settle.cpp runner/approved.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp risk/measure.cpp ingest/candidates.cpp broker/adapter.cpp broker/alpaca_paper.cpp broker/http_curl.cpp broker/ws_stream.cpp log/journal.cpp kill/switch.cpp -lcurl
python3 tests/e2e_mock_venue.py ./g0_paper_loop_mock
fi
# H1 zero-malloc contract: the router step core allocates nothing
# (identity minting at IDLE is documented cycle-path and excluded
# here; the loop covers the IDLE-reject path + every post-identity
# state x observation shape).
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc_exec exec/test_noalloc_exec.cpp exec/router.cpp broker/adapter.cpp
./test_noalloc_exec
fi
if sed 's|//.*||' exec/router.hpp exec/router.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new"; then
    echo "GATE FAIL: heap use in router step core"
    exit 1
fi
# H1 isolation: no model-answer reads, no confidence, no risk-path
# computation tokens, no clocks, no network affordances in H1 kernel
# files (comments stripped; journal/broker std::string is documented
# cycle-path, same class as Slice E).
for tok in '\.enter\(\)' 'latent_risk\(\)' 'conviction\(\)' 'family\(\)' \
           'confidence' 'StageScale' \
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
           'confidence' 'popen' 'system\(' \
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
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o test_noalloc_feed feed/test_noalloc_feed.cpp feed/feed.cpp
./test_noalloc_feed
fi
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
./test_context vectors
# Slice G vocabulary: regime/calib/source/session/stage sets are
# frozen mirrors — the gate enforces each exact definition line once
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
# The filter is the single entry point for model answers: nothing outside
# it, its test and the veto composition test may call it.
if grep -rnE "jev_filter::Validate" --include=*.cpp --include=*.hpp . \
    | grep -v "^./jev_filter.hpp\|^./tests/test_jev_filter.cpp\|^./risk/test_veto.cpp"; then
    echo "GATE FAIL: JEV filter called from an unexpected place"
    exit 1
fi
# Confidence must never be read on any kernel path (comments may name it).
if grep -nE "\.confidence|->confidence" jev_filter.hpp; then
    echo "GATE FAIL: confidence read on kernel path"
    exit 1
fi
echo "KERNEL GATE ($MODE): PASS"
