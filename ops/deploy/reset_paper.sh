#!/bin/bash
# Flatten the Alpaca PAPER account: cancel every open order, close every position.
# Paper only (the URL is fixed). Run it yourself before a fresh run:
#   bash ops/deploy/reset_paper.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
envval() {
    [ -f .env ] || return 0
    sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' .env \
        | sed -n -E "s/^(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" | head -1 \
        | sed -E "s/[[:space:]]+#.*\$//; s/[[:space:]]+\$//; s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"
}
k="${ALPACA_KEY_ID:-$(envval ALPACA_KEY_ID)}"; s="${ALPACA_SECRET:-$(envval ALPACA_SECRET)}"
[ -n "$k" ] && [ -n "$s" ] || { echo "ALPACA_KEY_ID/ALPACA_SECRET missing" >&2; exit 2; }
api=https://paper-api.alpaca.markets
h=(-H "APCA-API-KEY-ID: $k" -H "APCA-API-SECRET-KEY: $s")
bash ops/deploy/start.sh stop >/dev/null || true
curl -fsS -m 30 -X DELETE "${h[@]}" "$api/v2/orders" >/dev/null
sleep 4
curl -fsS -m 30 -X DELETE "${h[@]}" "$api/v2/positions?cancel_orders=true" >/dev/null
for i in 1 2 3 4 5 6; do
    sleep 3
    [ "$(curl -fsS -m 15 "${h[@]}" "$api/v2/positions")" = "[]" ] && { echo "paper account is flat"; exit 0; }
done
echo "positions still open (market closed or orders pending); check the dashboard" >&2; exit 1
