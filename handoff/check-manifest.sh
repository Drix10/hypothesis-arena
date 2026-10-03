#!/usr/bin/env bash
# check-manifest: verifies the code against plan/system-manifest.yaml (read-only).
# A mismatch is a failure; fix the code or edit the manifest with the doc.
# Usage: bash scripts/check-manifest.sh   (exit 0 = PASS, 1 = FAIL)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M="$ROOT/plan/system-manifest.yaml"
FAIL=0

ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

[ -f "$M" ] || { echo "FAIL: manifest missing"; exit 1; }

# Top-level scalar: `key: value` (strips quotes and trailing comments).
top() { sed -n "s/^$1:[[:space:]]*[\"']\{0,1\}\([^\"'#]*\)[\"']\{0,1\}.*/\1/p" "$M" | head -n1 | tr -d ' '; }
# List: `key: [a, b, c]` -> a b c.
list() { sed -n "s/^$1:[[:space:]]*\[\(.*\)\].*/\1/p" "$M" | head -n1 | tr -d ',' ; }
# Nested scalar one level down: nested <block> <key>.
nested() { awk -v b="$1" -v k="$2" '$0 ~ "^"b":" {in_b=1; next} in_b && /^[^ ]/ {in_b=0} in_b && $1 == k":" {print $2; exit}' "$M"; }

# Plan docs listed in the manifest exist.
for d in $(list plan_docs); do
  [ -f "$ROOT/plan/$d.md" ] && ok "plan/$d.md" || bad "plan/$d.md missing"
done

# Candidate and feature schema values match the writer and the kernel gate.
CS="$(top candidate_schema)"
grep -q "^SCHEMA = \"$CS\"" "$ROOT/research/strategy/candidate_wire.py" \
  && ok "candidate schema in candidate_wire.py" || bad "candidate schema != $CS in candidate_wire.py"
grep -q "\"$CS\"" "$ROOT/kernel/ingest/candidates.cpp" \
  && ok "candidate schema in the kernel gate" || bad "candidate schema != $CS in the kernel gate"
FS="$(top feature_schema)"
grep -q "^SCHEMA = \"$FS\"" "$ROOT/collector/ctx_read.py" \
  && ok "feature schema in ctx_read.py" || bad "feature schema != $FS in ctx_read.py"
grep -q "AsciiEq(schema->s, \"$FS\")" "$ROOT/kernel/ingest/features.cpp" \
  && ok "feature schema in the kernel ingest" || bad "feature schema != $FS in the kernel ingest"

# Exit rules are the ones the kernel decides on.
for r in $(list exit_rules); do
  grep -q "\"$r\"" "$ROOT/kernel/exec/decide.cpp" \
    && ok "exit rule $r in decide.cpp" || bad "exit rule $r missing from decide.cpp"
done

# Stage vocabulary matches the kernel's stage module.
for s in $(list stages); do
  grep -q "\"$s\"" "$ROOT/kernel/stage/stage.hpp" \
    && ok "stage $s in the kernel" || bad "stage $s missing from the kernel"
done

# Model spend caps match the governor.
for s in paper tiny scaled full; do
  want="$(nested model_spend_caps_usd_30d "$s")"
  have="$(sed -n "s/.*\"$s\": \([0-9.]*\).*/\1/p" "$ROOT/research/engine/spend.py" | head -n1)"
  [ "${have%.0}" = "$want" ] && ok "spend cap $s = $want" || bad "spend cap $s: manifest $want, spend.py $have"
done

# Execution universe maximum matches the paper-stage symbol cap in the veto.
want="$(nested universe execution_max)"
grep -q "return {1, 1, $want};" "$ROOT/kernel/risk/veto.hpp" \
  && ok "execution_max $want" || bad "execution_max != $want in veto.hpp"

# Framework pins match the engine requirements (the Langfuse client pin is
# documented only: the engine does not import it yet).
for pin in "langgraph:langgraph" "smolagents:smolagents"; do
  key="${pin%%:*}"; pkg="${pin##*:}"
  want="$(nested framework_pins "$key")"
  grep -q "^$pkg==$want" "$ROOT/research/requirements.txt" \
    && ok "pin $pkg==$want" || bad "pin $pkg==$want missing from research/requirements.txt"
done

# No code path may write an escalated stage.
if grep -nE "effective\s*=\s*\"(TINY|SCALED|FULL)" "$ROOT/kernel/stage/stage.cpp"; then
  bad "stage escalation assignment present"
else
  ok "no stage escalation in stage.cpp"
fi

echo "---"
[ "$FAIL" = 0 ] && echo "CHECK-MANIFEST: PASS" || echo "CHECK-MANIFEST: FAIL"
exit "$FAIL"
