#!/bin/bash
# Kernel gate: build, run every suite, and run the authority, isolation and
# allocation greps. Usage: ./build.sh [normal|hardened|sanitize]
# On a MinGW box the sanitizer runtimes do not link, so `hardened` is the
# substitute there: libstdc++ debug containers, stack protector, fortify and
# the static analyzer. `sanitize` needs a Linux toolchain.
set -e
cd "$(dirname "$0")"
MODE="${1:-normal}"
OUT="build"
mkdir -p "$OUT"
# The permission-denied tests (chmod 000) cannot fail closed as root, so a
# root run would be a false green. Refuse rather than skip.
if [ "$(id -u)" = "0" ]; then
    echo "GATE FAIL: run kernel/build.sh as a non-root user (chmod-000 fail-closed tests are meaningless as root)" >&2
    exit 2
fi
if [ "$MODE" = "sanitize" ]; then
    # Real ASan and UBSan runtimes on a Linux toolchain (hosted CI). The
    # --wrap,malloc allocation proofs are skipped here by design: sanitizer
    # runtimes replace the allocator (and need the shared libstdc++), so
    # link-time malloc wrapping cannot observe them. Zero-heap discipline
    # stays proven by the normal-mode gate.
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

# Risk veto: rule boundaries (plan/risk.md).
g++ $FLAGS -o "$OUT/test_veto" risk/test_veto.cpp risk/veto.cpp
"$OUT/test_veto"
# The veto never reads model output, and EvaluateVeto allocates nothing:
# heap vocabulary is forbidden in veto.cpp (inputs are built upstream of the
# tick path; the verdict itself is fixed storage by static_assert in veto.hpp).
if grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new" risk/veto.cpp; then
    echo "GATE FAIL: heap use in veto execution path"
    exit 1
fi
# Ingest: rejection tests, boundaries, retention and the rate window.
g++ $FLAGS -o "$OUT/test_features" ingest/test_features.cpp ingest/features.cpp
"$OUT/test_features"
g++ $FLAGS -o "$OUT/test_candidates" ingest/test_candidates.cpp ingest/candidates.cpp
"$OUT/test_candidates" vectors
g++ $FLAGS -o "$OUT/test_sizing" risk/test_sizing.cpp risk/sizing.cpp
"$OUT/test_sizing"
g++ $FLAGS -o "$OUT/test_measure" risk/test_measure.cpp risk/measure.cpp
"$OUT/test_measure"
g++ $FLAGS -o "$OUT/test_decide" exec/test_decide.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp ingest/candidates.cpp
"$OUT/test_decide"
g++ $FLAGS -o "$OUT/test_moc_plan" exec/test_moc_plan.cpp exec/moc_plan.cpp
"$OUT/test_moc_plan"
g++ $FLAGS -o "$OUT/test_account" runner/test_account.cpp runner/account.cpp
"$OUT/test_account" fixtures
g++ $FLAGS -o "$OUT/test_settle" runner/test_settle.cpp runner/settle.cpp runner/calendar.cpp
"$OUT/test_settle"
g++ $FLAGS -o "$OUT/test_calendar" runner/test_calendar.cpp runner/calendar.cpp
"$OUT/test_calendar"
g++ $FLAGS -o "$OUT/test_bars" runner/test_bars.cpp runner/bars.cpp runner/calendar.cpp
"$OUT/test_bars" fixtures
g++ $FLAGS -o "$OUT/test_approved" runner/test_approved.cpp runner/approved.cpp runner/calendar.cpp
"$OUT/test_approved" ..
# Ingest zero-malloc contract: validation and retention allocate nothing
# (comments stripped: the discipline note names the forbidden tokens).
# U8() and JVal::find are forbidden in the ingest path: both build key
# temporaries that may heap-allocate through helpers defined elsewhere,
# invisible to a vocabulary grep. Lookup runs via FindAscii.
if sed 's|//.*||' ingest/features.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new|U8\(|\.find\("; then
    echo "GATE FAIL: heap use in ingest execution path"
    exit 1
fi
# Runtime proof, not only grep: a wrapped-malloc counter around the
# validation path must stay zero. Static libstdc++ so operator new resolves
# to the wrapped malloc.
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o "$OUT/test_noalloc" ingest/test_noalloc.cpp ingest/features.cpp
"$OUT/test_noalloc"
fi
# Kill switch: evaluation, entry gate, MEDIUM flatten state machine, HARD
# ordered sequence and the persistence round trip.
g++ $FLAGS -o "$OUT/test_kill" kill/test_kill.cpp kill/switch.cpp
"$OUT/test_kill"
# Kill zero-malloc contract: evaluation, state machine and persistence
# allocate nothing (comments stripped: the discipline note names the tokens).
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o "$OUT/test_noalloc_kill" kill/test_noalloc_kill.cpp kill/switch.cpp
"$OUT/test_noalloc_kill"
fi
# Router lifecycle, journal chain, broker recipe and Alpaca protected-entry
# semantics: lifecycle-only router, journal before order.
g++ $FLAGS -o "$OUT/test_router" exec/test_router.cpp exec/router.cpp broker/adapter.cpp
"$OUT/test_router"
g++ $FLAGS -o "$OUT/test_journal" log/test_journal.cpp log/journal.cpp
"$OUT/test_journal"
g++ $FLAGS -o "$OUT/test_broker" broker/test_broker.cpp broker/adapter.cpp broker/alpaca_paper.cpp
"$OUT/test_broker"
g++ $FLAGS -o "$OUT/test_shapes" broker/test_shapes.cpp broker/adapter.cpp broker/alpaca_paper.cpp
"$OUT/test_shapes" fixtures
g++ $FLAGS -o "$OUT/test_drills" exec/test_drills.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
"$OUT/test_drills"
# Runner integration: durable journal, snapshots, freeze file, STAGE file,
# HALT, alerts, REST and stream reconcile, cadence, emergency buffer, kill
# flatten and crash recovery. The runner is cycle-path (files, std::string and
# std::vector allowed): the zero-malloc gates cover the decision core, not
# durability. main.cpp compiles as the production entry (null transport means
# fail closed).
g++ $FLAGS -o "$OUT/test_runner" runner/test_runner.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
"$OUT/test_runner"
g++ $FLAGS -o "$OUT/test_paper_loop" runner/test_paper_loop.cpp runner/paper_loop.cpp runner/bars.cpp runner/calendar.cpp runner/account.cpp runner/settle.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp risk/measure.cpp ingest/candidates.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
"$OUT/test_paper_loop" fixtures
g++ $FLAGS -o "$OUT/kernel_runner" runner/main.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp log/journal.cpp kill/switch.cpp
# Live paper transport (libcurl): compiled and linked only when WITH_CURL=1;
# the smoke tool needs ALPACA_KEY_ID and ALPACA_SECRET and is run by hand.
if [ -n "${WITH_CURL:-}" ]; then
g++ $FLAGS -DWITH_CURL -o "$OUT/kernel_runner_paper" runner/main.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp broker/adapter.cpp broker/alpaca_paper.cpp broker/http_curl.cpp broker/ws_stream.cpp log/journal.cpp kill/switch.cpp -lcurl
g++ $FLAGS -DWITH_CURL -o "$OUT/paper_loop" runner/paper_loop_main.cpp runner/paper_loop.cpp runner/bars.cpp runner/calendar.cpp runner/account.cpp runner/settle.cpp runner/approved.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp risk/measure.cpp ingest/candidates.cpp broker/adapter.cpp broker/alpaca_paper.cpp broker/http_curl.cpp broker/ws_stream.cpp log/journal.cpp kill/switch.cpp -lcurl
g++ $FLAGS -o "$OUT/smoke_paper" broker/smoke_paper.cpp broker/http_curl.cpp broker/alpaca_paper.cpp broker/adapter.cpp broker/ws_stream.cpp -lcurl
g++ $FLAGS -o "$OUT/live_drill" broker/live_drill.cpp broker/http_curl.cpp broker/alpaca_paper.cpp broker/adapter.cpp broker/ws_stream.cpp -lcurl
g++ $FLAGS -DTEST_BASE -o "$OUT/test_ws_stream" broker/test_ws_stream.cpp broker/ws_stream.cpp -lcurl
"$OUT/test_ws_stream" unit
python3 tests/ws_faults.py "$OUT/test_ws_stream"
g++ $FLAGS -DTEST_BASE -o "$OUT/test_transport_faults" broker/test_transport_faults.cpp broker/http_curl.cpp broker/alpaca_paper.cpp broker/adapter.cpp -lcurl
python3 tests/transport_faults.py "$OUT/test_transport_faults"
g++ $FLAGS -DWITH_CURL -DTEST_BASE -o "$OUT/paper_loop_mock" runner/paper_loop_main.cpp runner/paper_loop.cpp runner/bars.cpp runner/calendar.cpp runner/account.cpp runner/settle.cpp runner/approved.cpp runner/runner.cpp runner/store.cpp runner/events.cpp exec/router.cpp exec/decide.cpp risk/veto.cpp risk/sizing.cpp risk/measure.cpp ingest/candidates.cpp broker/adapter.cpp broker/alpaca_paper.cpp broker/http_curl.cpp broker/ws_stream.cpp log/journal.cpp kill/switch.cpp -lcurl
python3 tests/e2e_mock_venue.py "$OUT/paper_loop_mock"
fi
# Router zero-malloc contract: the step core allocates nothing (identity
# minting at IDLE is cycle-path and excluded; the loop covers the IDLE reject
# path and every post-identity state and observation shape).
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o "$OUT/test_noalloc_exec" exec/test_noalloc_exec.cpp exec/router.cpp broker/adapter.cpp
"$OUT/test_noalloc_exec"
fi
if sed 's|//.*||' exec/router.hpp exec/router.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new"; then
    echo "GATE FAIL: heap use in router step core"
    exit 1
fi
# Router isolation: no model reads, no risk-path computation tokens, no
# clocks, no network affordances in the order-path files (comments stripped;
# journal and broker std::string is cycle-path).
for tok in 'confidence' 'StageScale' \
           'PendingNotional' 'ReservedRisk' 'BuyingPower' \
           'DriftSelection' 'EvaluateVeto' 'clock\(' 'chrono' \
           'gettime' 'socket' 'popen' 'system\(' 'curl' 'getaddrinfo'; do
    if sed 's|//.*||' exec/router.hpp exec/router.cpp log/journal.hpp log/journal.cpp broker/adapter.hpp broker/adapter.cpp broker/alpaca_paper.hpp broker/alpaca_paper.cpp | grep -nE "$tok"; then
        echo "GATE FAIL: forbidden path in order path ($tok)"
        exit 1
    fi
done
if sed 's|//.*||' kill/switch.hpp kill/switch.cpp | grep -nE "std::string|std::vector|malloc|calloc|realloc|strdup|operator new"; then
    echo "GATE FAIL: heap use in kill evaluation path"
    exit 1
fi
# Kill isolation: evaluation never reads model output or any network, process
# or research affordance (comments stripped; the test files may use clocks for
# the non-blocking proof, switch.* never).
for tok in 'confidence' 'popen' 'system\(' \
           'socket' 'getaddrinfo' 'curl' 'clock\(' 'time\(' 'chrono'; do
    if sed 's|//.*||' kill/switch.hpp kill/switch.cpp | grep -nE "$tok"; then
        echo "GATE FAIL: forbidden path in kill ($tok)"
        exit 1
    fi
done
# STAGE chain verification: corruption fails to the paper stage.
g++ $FLAGS -o "$OUT/test_stage" stage/test_stage.cpp stage/stage.cpp
"$OUT/test_stage"
# Feed: ring, gaps, backoff and session marking (machinery only, never
# authority).
g++ $FLAGS -o "$OUT/test_feed" feed/test_feed.cpp feed/feed.cpp
"$OUT/test_feed"
if [ -z "${SANITIZE:-}" ]; then
g++ $FLAGS -static-libstdc++ -static-libgcc -Wl,--wrap,malloc -Wl,--wrap,calloc -Wl,--wrap,realloc -o "$OUT/test_noalloc_feed" feed/test_noalloc_feed.cpp feed/feed.cpp
"$OUT/test_noalloc_feed"
fi
# Feed allocation contract: heap-once lives in the TickRing constructor (a 64k
# member array would blow the thread stack); the tick path itself allocates
# nothing.
[ "$(sed 's|//.*||' feed/feed.cpp | grep -o 'new ' | wc -l | tr -d ' ')" = "1" ] || {
    echo "GATE FAIL: heap use beyond ring construction"; exit 1; }
if sed 's|//.*||' feed/feed.cpp | grep -nE "malloc|calloc|realloc|strdup|std::string|std::vector"; then
    echo "GATE FAIL: heap use in feed tick path"; exit 1;
fi
# Context: snapshot validation, canonical determinism (10k identical inputs
# give one hash), mutation sensitivity and golden bytes.
g++ $FLAGS -o "$OUT/test_context" ctx/test_context.cpp ctx/context.cpp
"$OUT/test_context" vectors
# Vocabulary: the regime, source and session sets each have exactly one
# definition line (a second spelling anywhere trips the count), and stage
# literals live in the stage module only.
[ "$(grep -c 's == "trend" || s == "range" || s == "volatile"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: regime vocabulary moved/duplicated"; exit 1; }
[ "$(grep -c 's == "healthy" || s == "stale" || s == "failed"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: source vocabulary moved/duplicated"; exit 1; }
if grep -nE '"fresh"|"absent"|"invalid"' ctx/snapshot.hpp ctx/context.cpp; then
    echo "GATE FAIL: retired source vocabulary present"; exit 1;
fi
[ "$(grep -c 's == "open" || s == "closed" || s == "holiday"' ctx/snapshot.hpp)" = "1" ] || {
    echo "GATE FAIL: session vocabulary moved/duplicated"; exit 1; }
if grep -nE '"TINY"|"SCALED"|"FULL"' ctx/snapshot.hpp ctx/context.cpp; then
    echo "GATE FAIL: stage literals outside the stage module"; exit 1;
fi
[ "$(grep -c 'stage::IsKnownStage' ctx/context.cpp)" = "1" ] || {
    echo "GATE FAIL: stage check moved/duplicated"; exit 1; }
# Stage authority: the effective stage is the verified file stage or PAPER;
# no promotion path may exist here. The other stage literals appear only as
# known-vocabulary checks and tests.
if grep -nE "effective\s*=\s*\"(TINY|SCALED|FULL)" stage/stage.cpp; then
    echo "GATE FAIL: stage escalation assignment present"
    exit 1
fi
echo "KERNEL GATE ($MODE): PASS"
