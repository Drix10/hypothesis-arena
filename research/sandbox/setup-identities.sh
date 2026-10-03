#!/bin/bash
# Linux deployment only: create the trading identities (plan/engine.md).
# NOT run on dev hosts. After running, execute the isolation test:
#   setpriv --reuid=miroresearch --regid=miroresearch --clear-groups \
#     python3 research/tests/test_isolation.py --tree /srv/mirohedge
set -euo pipefail
for u in mirotrade mirostrat miroresearch mirohuman; do
  id "$u" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$u"
done
TREE="${1:-/srv/mirohedge}"
mkdir -p "$TREE"/{journal,features,signals,stage,creds/broker,creds/sources}
chown mirotrade:mirotrade "$TREE"/journal "$TREE"/stage "$TREE"/creds/broker
chown miroresearch:miroresearch "$TREE"/features "$TREE"/signals "$TREE"/creds/sources
chmod 700 "$TREE"/journal "$TREE"/stage "$TREE"/creds/broker "$TREE"/creds/sources
chmod 755 "$TREE"/features "$TREE"/signals
echo "identities ready under $TREE"

# --- isolation probes ---
# Fixture secrets (placeholders; production values are placed by the human at
# build, never in git) + deny/allow probes. The run fails unless every
# deny-probe denies and every allow-probe succeeds.
[ "$(id -u)" -eq 0 ] || { echo "FATAL: run as root"; exit 2; }
umask 077
# fixture only when no real key is deployed: never clobber a production
# credential by re-running this script on a live host
if [ ! -e "$TREE/creds/broker/broker.key" ]; then
  echo "BROKER_KEY_PLACEHOLDER_DEPLOYMENT_FIXTURE" > "$TREE/creds/broker/broker.key"
  chmod 600 "$TREE/creds/broker/broker.key"
  chown mirotrade:mirotrade "$TREE/creds/broker/broker.key"
  echo "fixture broker.key installed (placeholder)"
else
  echo "broker.key already deployed: fixture NOT overwritten"
fi
PASS=0
FAIL=0
probe() { # $1=desc $2=want-exit $3...=command
  local desc="$1" want="$2"; shift 2
  set +e
  "$@" > /dev/null 2>&1
  local got=$?
  set -e
  if [ "$got" -eq "$want" ]; then echo "PASS: $desc (exit $got)"; PASS=$((PASS+1));
  else echo "FAIL: $desc (want $want, got $got)"; FAIL=$((FAIL+1)); fi
}
as() { local u="$1"; shift; setpriv --reuid="$u" --regid="$u" --clear-groups "$@"; }
for u in mirotrade mirostrat miroresearch; do
  grps=$(id -Gn "$u")
  if [ "$grps" = "$u" ]; then echo "PASS: $u private group only"; PASS=$((PASS+1));
  else echo "FAIL: $u extra groups: $grps"; FAIL=$((FAIL+1)); fi
done
probe "miroresearch cannot read broker.key" 1 as miroresearch test -r "$TREE/creds/broker/broker.key"
probe "mirostrat cannot read broker.key" 1 as mirostrat test -r "$TREE/creds/broker/broker.key"
probe "miroresearch cannot list creds/broker" 1 as miroresearch test -x "$TREE/creds/broker"
probe "mirotrade reads own broker.key" 0 as mirotrade test -r "$TREE/creds/broker/broker.key"
probe "miroresearch writes own features dir" 0 as miroresearch test -w "$TREE/features"
echo "--- repo isolation check as miroresearch ---"
REPO="${REPO:-/mnt/c/Users/ggdri/Downloads/hypothesis-arena}"
as miroresearch python3 "$REPO/research/tests/test_isolation.py" --tree "$TREE" || FAIL=$((FAIL+1))
echo "---"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
