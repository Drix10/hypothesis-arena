#!/usr/bin/env bash
# P1.1 — freeze-check: verify the repo EXACTLY against plan/system-manifest.yaml.
# Read-only. A mismatch is a FAILURE, never an invitation to edit the manifest.
# Usage: bash scripts/freeze-check.sh   (exit 0 = PASS, exit 1 = FAIL)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M="$ROOT/plan/system-manifest.yaml"
FAIL=0

ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; FAIL=1; }

# Manifest value extractor: `key: value` (strips quotes/comments).
mval() { sed -n "s/^$1:[[:space:]]*[\"']\{0,1\}\([^\"'#]*\)[\"']\{0,1\}.*/\1/p" "$M" | head -n1 | tr -d ' '; }

[ -f "$M" ] || { echo "FAIL: manifest missing"; exit 1; }

# ---- class 1: KNOWN-BY-FREEZE must match exactly ----
QSV="$(mval question_set_version)";      [ "$QSV" = "v3" ] \
  && ok "manifest question_set_version=v3" \
  || bad "manifest question_set_version='$QSV' (want v3)"
for f in plan/03-jev-decision-layer.md plan/07-build-roadmap.md; do
  grep -q "question_set_version = v3\|question_set_version: v3\|question_set v3" "$ROOT/$f" \
    && ok "$f declares v3" || bad "$f missing v3 declaration"
done
grep -rq "question_set_version = v2" "$ROOT/plan" "$ROOT/README.md" "$ROOT/ARCHITECTURE.md" "$ROOT/TODO.md" \
  && bad "stale 'question_set_version = v2' literal present" \
  || ok "no stale v2 literal"

FSV="$(mval feature_schema_version)";    [ "$FSV" = "f2" ] \
  && ok "manifest feature_schema_version=f2" \
  || bad "manifest feature_schema_version='$FSV' (want f2)"
grep -q '"schema_version": "f2"' "$ROOT/plan/08-agentic-research-plane.md" \
  && ok "08 schema f2" || bad "08 §8.5 not f2"
grep -rq "schema f1\b" "$ROOT/plan" "$ROOT/README.md" "$ROOT/TODO.md" "$ROOT/ARCHITECTURE.md" \
  && bad "stale 'schema f1' literal present" \
  || ok "no stale f1 literal"

for i in $(seq 1 17); do
  grep -q "R$i\." "$ROOT/plan/05-risk-and-determinism.md" \
    || bad "R$i missing in doc 05"
done
[ "$FAIL" = 0 ] && ok "R1-R17 all present in doc 05"

[ "$(mval strategy_version)" = "baseline_v1" ] \
  && ok "manifest strategy_version=baseline_v1" \
  || bad "manifest strategy_version wrong"
grep -q "baseline_v1" "$ROOT/plan/12-statistical-baseline.md" \
  && ok "doc 12 baseline_v1" || bad "doc 12 missing baseline_v1"

[ "$(mval exit_profile)" = "exit_profile_v1" ] \
  && ok "manifest exit_profile_v1" \
  || bad "manifest exit_profile wrong"
for f in plan/03-jev-decision-layer.md plan/05-risk-and-determinism.md plan/06-execution-and-ops.md; do
  grep -q "exit_profile_v1" "$ROOT/$f" \
    && ok "$f exit_profile_v1" || bad "$f missing exit_profile_v1"
done

[ "$(mval research_graph_version)" = "g1" ] \
  && ok "manifest research_graph_version=g1" \
  || bad "manifest research_graph_version wrong"
grep -q "research_graph_version" "$ROOT/plan/08-agentic-research-plane.md" \
  && ok "08 graph version" || bad "08 missing research_graph_version"

[ "$(mval jev_model)" = "typesafe/jev-1.13" ] \
  && ok "manifest jev_model pinned" \
  || bad "manifest jev_model wrong"
grep -q "typesafe/jev-1.13" "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 JEV pin" || bad "03 missing JEV pin"
grep -rn "jev-latest" "$ROOT/plan" | grep -v "forbidden" | grep -q .
if [ "$?" = 0 ]; then bad "'jev-latest' used outside its prohibition";
else ok "jev-latest appears only in its prohibition"; fi

for q in enter edge_family conviction latent_risk; do
  grep -q "$q" "$ROOT/plan/03-jev-decision-layer.md" \
    || bad "03 missing question '$q'"
done
ok "4 v3 questions named in doc 03 (see above for any FAIL)"

for s in G0_PAPER G1_TINY G2_SCALED G3_FULL; do
  grep -q "$s" "$ROOT/plan/10-capital-gates-and-spend-control.md" \
    || bad "doc 10 missing stage $s"
done
ok "stage definitions in doc 10 (see above for any FAIL)"

for cap in "150" "400" '1,000' "20%"; do
  grep -q "$cap" "$ROOT/plan/10-capital-gates-and-spend-control.md" \
    || bad "doc 10 missing cap value $cap"
done
ok "capital/spend caps in doc 10 (see above for any FAIL)"

grep -q "OANDA" "$ROOT/plan/01-vision-and-scope.md" \
  && ok "01 OANDA venue" || bad "01 missing OANDA"
grep -q "Alpaca" "$ROOT/plan/01-vision-and-scope.md" \
  && ok "01 Alpaca venue" || bad "01 missing Alpaca"

grep -q "execution_max: 5" "$M" && grep -q "research_candidates: 50" "$M" \
  && ok "manifest universe limits 5/50" \
  || bad "manifest universe limits wrong"

for pin in "langgraph==1.1.6" "smolagents==1.26.0" "langfuse_client==4.15.4"; do
  grep -q "${pin%%==*}: ${pin##*==}" "$M" \
    && ok "manifest pin $pin" || bad "manifest missing pin $pin"
  disp="$(echo "$pin" | sed 's/_client//')"
  grep -q "$disp" "$ROOT/plan/08-agentic-research-plane.md" \
    && ok "08 pin $disp" || bad "08 missing pin $disp"
done

# ---- class 2+3: placeholders must be EXACTLY the authorized ones ----
grep -q 'plan_hash: "TO_BE_COMPUTED_AT_FREEZE"' "$M" \
  && ok "plan_hash deferred (freeze procedure generates it)" \
  || bad "plan_hash placeholder altered"
grep -q 'jev_provider: TBD_AT_KEY' "$M" \
  && ok "jev_provider build-time placeholder" \
  || bad "jev_provider placeholder altered"
grep -q 'jev_revision: typesafe/jev-1.13-20260917' "$M" \
  && ok "jev_revision pinned (verified live 2026-09-20)" \
  || bad "jev_revision not pinned"
grep -q 'jev_provider_name: TypeSafe' "$M" \
  && ok "jev_provider_name pinned (verified live 2026-09-20)" \
  || bad "jev_provider_name not pinned"
grep -q 'research_models: TBD_AT_BUILD' "$M" \
  && ok "research_models build-time placeholder" \
  || bad "research_models placeholder altered"
grep -q 'forex_live: TBD_AT_G1_MANIFEST' "$M" \
  && grep -q 'stocks_live: TBD_AT_G2_MANIFEST' "$M" \
  && ok "live venues deferred to G-manifests" \
  || bad "live-venue placeholders altered"

# ---- anything else TBD-like in the spec = FAIL ----
if grep -rn "TO_BE_[A-Z_]*\|:[[:space:]]*TBD\([^A-Z_/]\|$\|/\)" "$ROOT/plan" --include="*.md" | grep -q .; then
  bad "stray TBD/TO_BE value in plan docs"
else
  ok "no stray TBD/TO_BE placeholders in plan docs"
fi

# ---- boundary law + 02 split sanity (frozen contracts P1.1 guards) ----
grep -q "ONLY research artifact" "$ROOT/plan/04-cpp-deterministic-core.md" \
  && ok "04 boundary law" || bad "04 boundary law missing"
grep -q "Boundary law" "$ROOT/plan/09-osint-and-free-data.md" \
  && ok "09 boundary law" || bad "09 boundary law missing"
grep -q "NON-PRODUCTION / HISTORICAL" "$ROOT/plan/02-twitter-alpha-system.md" \
  && ok "02 archive/production split" || bad "02 split banner missing"

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
[ "$(pyval QVERSION)" = "$(mval question_set_version)" ] \
  && ok "jev.py QVERSION == manifest" \
  || bad "jev.py QVERSION vs manifest"
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
for _pin in 'typesafe/jev-1.13' 'typesafe/jev-1.13-20260917' '"TypeSafe"' 'answerset_v1'; do
  grep -q "$_pin" "$ROOT/kernel/jev_validate.hpp" \
    && ok "kernel pin $_pin" || bad "kernel pin moved: $_pin"
done

# ---- committed P3.2 vectors are self-consistent (no Python needed) ----
for _v in v1 v2; do
  _hex="$ROOT/kernel/vectors/${_v}_canonical.hex"
  _hash="$ROOT/kernel/vectors/${_v}_response_hash.txt"
  _sig="$ROOT/kernel/vectors/${_v}_signature.txt"
  if [ -f "$_hex" ] && [ -f "$_hash" ] && [ -f "$_sig" ]; then
    _recomputed="$(xxd -r -p "$_hex" | sha256sum | cut -d' ' -f1)"
    [ "$_recomputed" = "$(cat "$_hash")" ] \
      && ok "vectors ${_v}: sha256(canonical) == response_hash" \
      || bad "vectors ${_v}: hash mismatch"
    [ "$(wc -c < "$_sig" | tr -d ' ')" = "128" ] \
      && ok "vectors ${_v}: 128-hex signature present" \
      || bad "vectors ${_v}: signature shape"
  else
    bad "vectors ${_v}: files missing"
  fi
done
[ "$(cat "$ROOT/kernel/vectors/pubkey.txt" 2>/dev/null)" = "$(cat "$ROOT/kernel/fixtures/trusted_key.txt" 2>/dev/null)" ] \
  && ok "vectors pubkey == P3.1 trusted key" \
  || bad "vectors pubkey drifted from trusted key"

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
grep -q 'comma-joined sorted' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 decision-key recipe" || bad "03 decision-key recipe moved"
! grep -q '15:55 ET' "$ROOT/plan/03-jev-decision-layer.md" \
  && ok "03 no hard-coded exit" || bad "03 hard-coded exit back"

# plan/03: exact decision-key recipe, no hard-coded clock exit.
grep -q 'comma-joined sorted' "$ROOT/plan/03-jev-decision-layer.md" \
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
grep -q 'exp <= now' "$ROOT/collector/jev.py" \
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
grep -q 'HISTORICAL / NON-PRODUCTION' "$ROOT/plan/02-twitter-alpha-system.md" \
  && ok "02 X banner" || bad "02 banner moved"
grep -q 'broker ‖ account ‖ context_hash' "$ROOT/plan/04-cpp-deterministic-core.md" \
  && ok "04 intent recipe" || bad "04 intent stale"
grep -q 'context_hash.*≠.*state_hash\|context_hash` ≠' "$ROOT/plan/04-cpp-deterministic-core.md" \
  && ok "04 hash distinction" || bad "04 hash distinction moved"
grep -q 'the kernel mints' "$ROOT/plan/03-jev-decision-layer.md" \
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

echo "---"
[ "$FAIL" = 0 ] && echo "FREEZE-CHECK: PASS" || echo "FREEZE-CHECK: FAIL"
exit "$FAIL"