#!/usr/bin/env bash
# freeze-check: verifies the repo against plan/system-manifest.yaml (read-only).
# A mismatch is a failure; fix the repo, not the manifest.
# Usage: bash scripts/freeze-check.sh   (exit 0 = PASS, 1 = FAIL)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M="$ROOT/plan/system-manifest.yaml"
FAIL=0

ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; FAIL=1; }
# xxd is not installed everywhere (v3 O3): fall back to python3.
hex2bin() {
  if command -v xxd >/dev/null 2>&1; then xxd -r -p "$1"
  else python3 -c 'import sys;sys.stdout.buffer.write(bytes.fromhex("".join(open(sys.argv[1]).read().split())))' "$1"; fi
}

# Manifest value extractor: `key: value` (strips quotes/comments).
mval() { sed -n "s/^$1:[[:space:]]*[\"']\{0,1\}\([^\"'#]*\)[\"']\{0,1\}.*/\1/p" "$M" | head -n1 | tr -d ' '; }

[ -f "$M" ] || { echo "FAIL: manifest missing"; exit 1; }

# ---- class 1: KNOWN-BY-FREEZE must match exactly ----
JC="$(mval jev_contract)";      [ "$JC" = "jev" ] \
  && ok "manifest jev_contract=jev" \
  || bad "manifest jev_contract='$JC' (want jev)"
for f in plan/03-jev-decision-layer.md plan/07-build-roadmap.md; do
  grep -q 'contract = "jev"\|contract = jev\|jev_contract' "$ROOT/$f" \
    && ok "$f declares the jev contract" || bad "$f missing jev contract declaration"
done

# ---- code pins must equal the manifest (the fingerprint is enforced) ----
pyval() { grep -E "^$1 *= *\"" "$ROOT/collector/jev.py" | head -n1 | sed 's/.*"\([^"]*\)".*/\1/'; }
[ "$(pyval MODEL)" = "$(mval jev_model)" ] \
  && ok "jev.py MODEL == manifest" \
  || bad "jev.py MODEL '$(pyval MODEL)' vs manifest '$(mval jev_model)'"
[ "$(pyval REVISION)" = "typesafe/jev-1.13-20260917" ] \
  && ok "jev.py REVISION pinned" || bad "jev.py REVISION wrong"
[ "$(pyval PROVIDER)" = "$(mval jev_provider_name)" ] \
  && ok "jev.py PROVIDER == manifest" \
  || bad "jev.py PROVIDER vs manifest"
[ "$(pyval CONTRACT)" = "$(mval jev_contract)" ] \
  && ok "jev.py CONTRACT == manifest" \
  || bad "jev.py CONTRACT vs manifest"
[ "$(grep -E '^DAILY_CALL_CEILING *=' "$ROOT/collector/jev.py" | grep -o '[0-9]*')" = "5000" ] \
  && ok "call ceiling 5000" || bad "call ceiling moved"
[ "$(grep -E '^DAILY_CALL_ALERT *=' "$ROOT/collector/jev.py" | grep -o '[0-9]*')" = "2500" ] \
  && ok "call alert 2500" || bad "call alert moved"
for _cap in '"G0_PAPER": 150.0' '"G1_TINY": 150.0' '"G2_SCALED": 400.0' '"G3_FULL": 1000.0'; do
  grep -q "$_cap" "$ROOT/collector/jev.py" \
    && ok "jev.py stage cap $_cap" || bad "jev.py stage cap $_cap moved"
done
for _q in '("enter", "noul"' '("edge_family", "choice"' '("conviction", "score"' '("latent_risk", "noul"'; do
  grep -q "$_q" "$ROOT/collector/jev.py" \
    && ok "jev.py question $_q" || bad "jev.py question order/type moved: $_q"
done
# Kernel filter: pins, wire primitives, vectors and the veto/ingest suites.
[ -f "$ROOT/kernel/jev_wire.hpp" ] && [ -f "$ROOT/kernel/jev_filter.hpp" ] \
  && ok "kernel filter + wire present" || bad "kernel filter/wire missing"
grep -q '"contract", qv) || qv != "jev"' "$ROOT/kernel/jev_filter.hpp" \
  && ok "kernel pin contract" || bad "kernel pin contract moved"
grep -q '0x00, 0x00, 0x00, 0x10};' "$ROOT/kernel/jev_wire.hpp" \
  && ok "L-table amended" || bad "L-table regressed"
_n="$(ls "$ROOT/kernel/jev_vectors"/*.artifact.json 2>/dev/null | wc -l | tr -d ' ')"
[ "$_n" = "32" ] && ok "filter vectors: 32 artifacts" || bad "filter vector count: $_n"
[ "$(grep -A1 '^universe:' "$ROOT/plan/system-manifest.yaml" | grep execution_max | grep -o '[0-9]*')" = "5" ] \
  && ok "manifest execution_max 5" || bad "manifest execution_max moved"
[ -f "$ROOT/kernel/risk/veto.cpp" ] \
  && ok "veto present" || bad "veto missing"
[ -f "$ROOT/kernel/risk/test_veto.cpp" ] \
  && ok "veto suite present" || bad "veto suite missing"
[ -f "$ROOT/kernel/ingest/features.cpp" ] \
  && ok "ingest present" || bad "ingest missing"
[ -f "$ROOT/kernel/ingest/test_features.cpp" ] \
  && ok "ingest suite present" || bad "ingest suite missing"
[ -f "$ROOT/kernel/ingest/test_noalloc.cpp" ] \
  && ok "ingest noalloc proof present" || bad "ingest noalloc proof missing"

# ---- hardening-2 contracts (fail-closed plumbing, frozen) ----
# collect.py: status/records never mix; no identity truncation/coercion;
# corrupt schedule/cache refuse to poll.
grep -q 'return "not-modified", \[\]' "$ROOT/collector/collect.py" \
  && ok "collect tuple returns" || bad "collect tuple returns moved"
! grep -q 'uid\[:256\]' "$ROOT/collector/collect.py" \
  && ok "no identity truncation" || bad "identity truncation back"
grep -q 'str(row.get' "$ROOT/collector/collect.py" \
  && bad "str() coercion back in collect" || ok "no str() coercion"
grep -q 'SOURCE_SCHEDULING_UNKNOWN' "$ROOT/collector/collect.py" \
  && ok "schedule fail-closed" || bad "schedule fail-closed moved"
grep -q 'CACHE_CORRUPT' "$ROOT/collector/collect.py" \
  && ok "cache fail-closed" || bad "cache fail-closed moved"
# jev.py: OS lock, fail-closed charge, strict confidence/state.
grep -q '_FileLock' "$ROOT/collector/jev.py" \
  && ok "jev OS lock" || bad "jev OS lock moved"
! grep -q '_SpendLock' "$ROOT/collector/jev.py" \
  && ok "mkdir-lock gone" || bad "mkdir-lock back"
grep -q 'if spent is None:' "$ROOT/collector/jev.py" \
  && ok "charge-fail HOLD" || bad "charge-fail HOLD moved"
grep -q '"confidence" in f' "$ROOT/collector/jev.py" \
  && ok "confidence presence" || bad "confidence presence moved"
grep -q '_finite_json' "$ROOT/collector/jev.py" \
  && ok "recursive state scan" || bad "recursive state scan moved"
grep -q 'allow_nan=False' "$ROOT/collector/jev.py" \
  && ok "canon fail-closed" || bad "canon fail-closed moved"
# ctx_read.py: dup keys, envelope, kind registry, unique ids.
grep -q 'object_pairs_hook' "$ROOT/collector/ctx_read.py" \
  && ok "dup-key rejection" || bad "dup-key rejection moved"
grep -q 'BUNDLE_REQUIRED' "$ROOT/collector/ctx_read.py" \
  && ok "bundle allowlist" || bad "bundle allowlist moved"
grep -q 'SOURCE_KINDS' "$ROOT/collector/ctx_read.py" \
  && ok "kind registry" || bad "kind registry moved"
grep -q 'bundle-duplicate-feature-id' "$ROOT/collector/ctx_read.py" \
  && ok "unique feature ids" || bad "unique feature ids moved"
# classify.py: corrections uniqueness, record allowlist.
grep -q 'UNIQUE(source, amending_id, base_id)' "$ROOT/collector/classify.py" \
  && ok "corrections unique" || bad "corrections unique moved"
grep -q 'KNOWN_FIELDS' "$ROOT/collector/classify.py" \
  && ok "record allowlist" || bad "record allowlist moved"
# plan/03: exact decision-key recipe, no hard-coded clock exit.
grep -q 'cid | symbol | snapshot_epoch | price_s' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 decision-key recipe" || bad "03 decision-key recipe moved"
! grep -q '15:55 ET' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 no hard-coded exit" || bad "03 hard-coded exit back"

# plan/03: exact decision-key recipe, no hard-coded clock exit.
grep -q 'cid | symbol | snapshot_epoch | price_s' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 decision-key recipe" || bad "03 decision-key recipe moved"
! grep -q '15:55 ET' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 no hard-coded exit" || bad "03 hard-coded exit back"
# 2xR demands calibration_gate == pass (insufficient never sizes up).
grep -q 'calibration_gate == pass' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 max-gate pass" || bad "03 max-gate weakened"
! grep -q 'calibration_gate ≠ breach' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 no weak gate" || bad "03 weak gate back"
# single promotion minimum: 200 decisions + 100 closed trades.
grep -q '200 decisions + 100 closed' "$ROOT/README.md" \
  && ok "README 100-trade gate" || bad "README trade gate stale"
! grep -q '200 decisions + 60' "$ROOT/README.md" "$ROOT/plan/11-calibration-and-self-improvement.md" \
  && ok "no 60-trade gate" || bad "60-trade gate back"
# hardening-3 plumbing.
grep -q 'recs = \[\]  # fresh per source' "$ROOT/collector/collect.py" \
  && ok "collect recs isolation" || bad "collect recs isolation moved"
grep -q 'def validate_schedule' "$ROOT/collector/collect.py" \
  && ok "schedule schema" || bad "schedule schema moved"
grep -q 'def validate_cache' "$ROOT/collector/collect.py" \
  && ok "cache schema" || bad "cache schema moved"
grep -q '"hold", row' "$ROOT/collector/jev.py" \
  && ok "money-gate shape" || bad "money-gate shape moved"
grep -q '_money_gate(state, key, post_fn, now)' "$ROOT/collector/jev.py" \
  && ok "money gate serialized" || bad "money gate moved"
grep -q 'MONEY_GATE_TIMEOUT' "$ROOT/collector/jev.py" \
  && ok "gate timeout" || bad "gate timeout moved"
grep -q 'TMP_LEDGER_RE' "$ROOT/collector/jev.py" \
  && ok "exact temp pattern" || bad "temp pattern moved"
grep -q 'expires_at.*created' "$ROOT/collector/jev.py" \
  && ok "cache expiry coherence" || bad "expiry coherence moved"
grep -q 'SOURCE_KINDS' "$ROOT/collector/ctx_read.py" \
  && ok "kind registry" || bad "kind registry moved"
grep -q 'OPTIONAL_BOOL' "$ROOT/collector/classify.py" \
  && ok "exhaustive types" || bad "exhaustive types moved"
grep -q 'poll-log-integrity' "$ROOT/collector/soak_check.py" \
  && ok "poll integrity" || bad "poll integrity moved"
grep -q '\-\-as-of' "$ROOT/collector/classify.py" \
  && ok "as-of replay" || bad "as-of replay moved"

# hardening-4 plumbing.
grep -q 'MAX_AUTHORIZED_CALL_USD' "$ROOT/collector/jev.py" \
  && ok "per-call reservation" || bad "per-call reservation moved"
grep -q 'artifact-expired' "$ROOT/collector/jev.py" \
  && ok "cache expiry admission" || bad "cache expiry moved"
grep -q 'CLOCK_SKEW_S' "$ROOT/collector/jev.py" \
  && ok "artifact skew bound" || bad "skew bound moved"
grep -q 'ALLOWED_SOURCE_KEYS' "$ROOT/collector/collect.py" \
  && ok "source allowlist" || bad "source allowlist moved"
grep -q 'commit_validators' "$ROOT/collector/collect.py" \
  && ok "deferred validators" || bad "deferred validators moved"
grep -q '_SingletonLock' "$ROOT/collector/collect.py" \
  && ok "collector singleton" || bad "singleton moved"
grep -q 'COLLECT_ALREADY_RUNNING' "$ROOT/collector/collect.py" \
  && ok "already-running" || bad "already-running moved"
grep -q 'URLError, OSError, http.client.HTTPException' "$ROOT/collector/collect.py" \
  && ok "narrow network errors" || bad "narrow errors moved"
grep -q 'MISSED_RANGE' "$ROOT/collector/soak.py" \
  && ok "missed-range" || bad "missed-range moved"
grep -q 'iter_poll_rows' "$ROOT/collector/soak_check.py" \
  && ok "poll reader" || bad "poll reader moved"
grep -q 'PRAGMA integrity_check' "$ROOT/collector/soak_check.py" \
  && ok "pragma check" || bad "pragma moved"
grep -q 'classified-integrity' "$ROOT/collector/soak_check.py" \
  && ok "classified integrity" || bad "classified integrity moved"
grep -q 'audit-present' "$ROOT/collector/soak_check.py" \
  && ok "audit present" || bad "audit present moved"
grep -q 'ORDER BY first_seen_at, rowid' "$ROOT/collector/classify.py" \
  && ok "revision tiebreak" || bad "tiebreak moved"
grep -q 'temporal_violation' "$ROOT/collector/classify.py" \
  && ok "temporal ordering" || bad "temporal moved"
grep -q 'WATERMARK_REQUIRED' "$ROOT/collector/ctx_read.py" \
  && ok "watermark envelope" || bad "watermark moved"
grep -q 'history-nonmonotonic' "$ROOT/collector/ctx_read.py" \
  && ok "history monotonic" || bad "monotonic moved"
grep -q 'MAX_SYMBOLS' "$ROOT/collector/ctx_read.py" \
  && ok "symbol bound" || bad "symbol bound moved"
# pass-4 doc reconciliation pins.
grep -q 'HISTORICAL / NON-PRODUCTION' "$ROOT/plan/09-osint-and-free-data.md" \
  && ok "09 X historical" || bad "09 X table back"
! grep -q '| X-Lists tail (doc 02) |' "$ROOT/plan/09-osint-and-free-data.md" \
  && ok "09 X row moved" || bad "09 X row still in tier table"
grep -q 'HISTORICAL / NON-PRODUCTION' "$ROOT/plan/02-strategy-book.md" \
  && ok "02 X banner" || bad "02 banner moved"
grep -q 'broker ‖ account ‖ context_hash' "$ROOT/plan/04-cpp-deterministic-core.md" \
  && ok "04 intent recipe" || bad "04 intent stale"
grep -q 'context_hash.*≠.*state_hash\|context_hash` ≠' "$ROOT/plan/04-cpp-deterministic-core.md" \
  && ok "04 hash distinction" || bad "04 hash distinction moved"
grep -q 'Kernel-owned values (expected cid' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 hash distinction" || bad "03 hash distinction moved"
grep -q 'latest input bar must fall within the last 2' "$ROOT/plan/05-risk-and-determinism.md" \
  && ok "R6 data age" || bad "R6 age moved"
grep -q 'at least 25 of the last' "$ROOT/plan/05-risk-and-determinism.md" \
  && ok "R7 coverage" || bad "R7 coverage moved"
grep -q 'FLATTEN_PENDING' "$ROOT/plan/10-capital-gates-and-spend-control.md" \
  && ok "medium FSM" || bad "medium FSM moved"
grep -q 'ONE pooled Holm' "$ROOT/plan/11-calibration-and-self-improvement.md" \
  && ok "Holm family" || bad "Holm family moved"
grep -q 'DAILY portfolio returns' "$ROOT/plan/11-calibration-and-self-improvement.md" \
  && ok "return frequency" || bad "return frequency moved"
grep -q 'universe_vN' "$ROOT/plan/12-statistical-baseline.md" \
  && ok "universe artifact" || bad "universe artifact moved"
grep -q 'FROZEN-DESIGN' "$ROOT/README.md" \
  && ok "README states" || bad "README states moved"
# pass-5 durability pins.
grep -q 'ambiguous-transport' "$ROOT/collector/jev.py" \
  && ok "ambiguous no-retry" || bad "ambiguous moved"
grep -q '"cached", row, hit' "$ROOT/collector/jev.py" \
  && ok "single-flight" || bad "single-flight moved"
grep -q 'unknown-cost' "$ROOT/collector/jev.py" \
  && ok "unknown-cost hold" || bad "unknown-cost moved"
grep -q 'evidence-persist-failed' "$ROOT/collector/jev.py" \
  && ok "persist containment" || bad "persist moved"
grep -q '_validate_answerset_artifact' "$ROOT/collector/jev.py" \
  && ok "shared validator" || bad "shared validator moved"
grep -q 'signals-append-failed' "$ROOT/collector/collect.py" \
  && ok "commit point" || bad "commit point moved"
grep -q 'ClassifyAbort' "$ROOT/collector/classify.py" \
  && ok "classify abort" || bad "classify abort moved"
grep -q 'signals-integrity' "$ROOT/collector/classify.py" \
  && ok "signals abort" || bad "signals abort moved"
grep -q 'def project_day' "$ROOT/collector/classify.py" \
  && ok "projection rebuild" || bad "projection moved"
grep -q 'date(first_seen_at)' "$ROOT/collector/classify.py" \
  && ok "projection query" || bad "projection query moved"
grep -q 'SOAK_ALREADY_RUNNING' "$ROOT/collector/soak.py" \
  && ok "soak singleton" || bad "soak singleton moved"
grep -q 'MISSED_RANGE' "$ROOT/collector/soak.py" \
  && ok "missed-range" || bad "missed-range moved"
grep -q 'started_at' "$ROOT/collector/soak.py" \
  && ok "cycle timestamps" || bad "cycle timestamps moved"
grep -q 'signals-integrity' "$ROOT/collector/soak_check.py" \
  && ok "signals verdict" || bad "signals verdict moved"
grep -q 'history-future' "$ROOT/collector/ctx_read.py" \
  && ok "history future" || bad "history future moved"
grep -q 'ingested-before-observed' "$ROOT/collector/ctx_read.py" \
  && ok "provenance order" || bad "provenance order moved"
grep -q 'BUDGET-DEPENDENT' "$ROOT/plan/13-cpp-kernel-build.md" \
  && ok "13 gate semantics" || bad "13 gate moved"
grep -q 'AMBIGUOUS-TRANSPORT EXCEPTION' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 ambiguity" || bad "03 ambiguity moved"
grep -q 'DURABLE-FIRST' "$ROOT/plan/09-osint-and-free-data.md" \
  && ok "09 commit order" || bad "09 order moved"
grep -q 'Absolute MEANS absolute' "$ROOT/plan/10-capital-gates-and-spend-control.md" \
  && ok "10 absolute" || bad "10 absolute moved"

echo "---"
[ "$FAIL" = 0 ] && echo "FREEZE-CHECK: PASS" || echo "FREEZE-CHECK: FAIL"
exit "$FAIL"