#!/bin/bash
# start.sh fresh-start preflight against a stubbed curl: open positions or open orders refuse (exit 2).
# tar is stubbed to exit 7 so a passing preflight stops before the kernel build.
set -u
here="$(dirname "$0")"
root="$(cd "$here" && cd .. && cd .. && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/home" "$tmp/loop"
: > "$tmp/loop/STAGE"
cat > "$tmp/bin/curl" <<'STUB'
#!/bin/bash
case "$*" in
    */v2/positions) printf '%s' "$STUB_POSITIONS";;
    */v2/orders\?status=open\&limit=500) printf '%s' "$STUB_ORDERS";;
    *) echo "unexpected curl: $*" >&2; exit 22;;
esac
STUB
printf '#!/bin/bash\nexit 7\n' > "$tmp/bin/tar"
printf '#!/bin/bash\nexit 1\n' > "$tmp/bin/pgrep"
chmod +x "$tmp/bin/curl" "$tmp/bin/tar" "$tmp/bin/pgrep"
fail=0

run() {  # name want_rc want_text positions orders allow_positions
    local out rc
    out="$(cd "$root" && PATH="$tmp/bin:$PATH" HOME="$tmp/home" ALPACA_KEY_ID=k ALPACA_SECRET=s \
        ALLOW_POSITIONS="$6" STUB_POSITIONS="$4" STUB_ORDERS="$5" bash ops/deploy/start.sh "$tmp/loop" 2>&1)"; rc=$?
    if [ "$rc" = "$2" ] && printf '%s' "$out" | grep -q "$3"; then echo "PASS: $1"
    else echo "FAIL: $1 (rc=$rc, want $2)"; printf '%s\n' "$out"; fail=1; fi
}

run "open order refuses" 2 "open or working orders" '[]' '[{"id":"o1"}]' 0
run "open position refuses" 2 "holds positions" '[{"symbol":"SPY"}]' '[]' 0
run "flat account passes preflight" 7 "no open positions or orders" '[]' '[]' 0
run "ALLOW_POSITIONS=1 overrides an open order" 7 "no open positions or orders" '[]' '[{"id":"o1"}]' 1
exit "$fail"