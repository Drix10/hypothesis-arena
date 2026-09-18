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

echo "---"
[ "$FAIL" = 0 ] && echo "FREEZE-CHECK: PASS" || echo "FREEZE-CHECK: FAIL"
exit "$FAIL"
