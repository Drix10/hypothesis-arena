#!/bin/bash
# Human sign-off for the G0_PAPER stage (plan/10 10.5). Writes <dir>/STAGE.
# Run it yourself; it is deliberately interactive and never called by tooling.
#   scripts/sign-stage.sh <loop_dir>
set -e
dir="${1:?usage: sign-stage.sh <loop_dir>}"
[ -d "$dir" ] || { echo "no such directory: $dir" >&2; exit 2; }
[ ! -e "$dir/STAGE" ] || { echo "STAGE already exists in $dir" >&2; exit 2; }
phrase="I APPROVE G0_PAPER: PAPER TRADING, ZERO CAPITAL"
echo "This authorizes the runner in $dir to place orders on the Alpaca PAPER account."
echo "No real capital is involved. To proceed type exactly:"
echo "  $phrase"
read -r reply
[ "$reply" = "$phrase" ] || { echo "not confirmed" >&2; exit 1; }
by="human-$(id -un)"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
hash="$(printf '%s' "G0_PAPER|$by|$at|0|GENESIS" | sha256sum | cut -d' ' -f1)"
umask 077
printf 'stage: G0_PAPER\napproved_by: %s\napproved_at: %s\ncapital_usd: 0\nattest_hash: %s\n' \
    "$by" "$at" "$hash" > "$dir/STAGE"
echo "wrote $dir/STAGE"
