#!/bin/bash
# egress-probe.sh — Phase-D deployment box 2 (doc 08 §8.6 egress).
#
# Proves sandbox egress enforcement at the network layer (not the prompt):
#  1. allowlisted destination (www.sec.gov) transits the proxy
#     (TCP_TUNNEL in the proxy access log; any origin verdict is the
#     origin's own policy, not our boundary);
#  2. non-allowlisted destination (example.com, data.sec.gov) dies AT
#     THE PROXY with 403 (TCP_DENIED, counted in the access log);
#  3. direct egress with no proxy fails (internal-only network: no route).
#
# Topology: worker container on an --internal docker network (no external
# route possible) + squid forward proxy with an exact dstdomain allowlist
# (egress-proxy/squid.conf) attached to both the internal net and bridge.
# The worker runs with the doc-08 container spec flags.
# Idempotent; exits 0 only if all three properties hold.
# Under Git-Bash/MSYS, exempt all args from automatic path conversion:
# without this, the -v Windows host path is mangled and the proxy
# boots with the default deny-all config (observed 2026-09-23).
export MSYS2_ARG_CONV_EXCL="*"
set -u
PASS=0
FAIL=0
IMG="${IMG:-mirohedge/worker:sandbox-20260922}"
NET="${NET:-egress-inner}"
PROXY="${PROXY:-egress-proxy}"

ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
no() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

docker network inspect "$NET" > /dev/null 2>&1 || docker network create --internal "$NET" > /dev/null
# Idempotent proxy ensure (reproducible bring-up; config is the committed
# squid.conf beside this script). Windows daemon path via pwd -W.
# Loopback publish lets the supervisor drive the shipped provider code
# through the SAME squid + allowlist from the host (workers on the
# internal net are unaffected: still no route except via the proxy).
ensure_proxy() {
  HERE_WIN=$(cd "$(dirname "$0")" && pwd -W)
  docker run -d --name "$PROXY" --network "$NET" \
    -p 127.0.0.1:3128:3128 \
    -v "$HERE_WIN/egress-proxy/squid.conf":/etc/squid/squid.conf:ro \
    sameersbn/squid > /dev/null
  sleep 8
}
if ! docker inspect "$PROXY" > /dev/null 2>&1; then
  ensure_proxy
elif [ -z "$(docker port "$PROXY" 2>/dev/null)" ]; then
  docker rm -f "$PROXY" > /dev/null
  ensure_proxy
fi
docker network inspect bridge 2>/dev/null | grep -q "$PROXY" || \
  docker network connect bridge "$PROXY" > /dev/null

OUT=$(docker run --rm --network "$NET" --user 65532:65532 --read-only \
  --cap-drop=ALL --pids-limit 64 --memory=2g --cpus=1.0 \
  -e PROXY_HOST="$PROXY" "$IMG" python -c "
import os
import requests
ph = os.environ.get('PROXY_HOST', 'egress-proxy')
px = {'http': 'http://%s:3128' % ph, 'https': 'http://%s:3128' % ph}
def probe(name, url, proxies, ua=True):
    try:
        h = {'User-Agent': 'MiroHedge/0 evidence@example.invalid'} if ua else {}
        r = requests.get(url, proxies=proxies, timeout=25, headers=h)
        print('%s -> HTTP %d' % (name, r.status_code))
    except Exception as e:
        s = str(e)
        if 'Tunnel connection failed: 403' in s:
            print('%s -> PROXY-DENY-403' % name)
        else:
            print('%s -> CONN-FAIL %s' % (name, type(e).__name__))
probe('allowed', 'https://www.sec.gov/submissions/CIK0000320193.json', px)
probe('denied-host', 'https://example.com/', px)
probe('denied-subdomain', 'https://data.sec.gov/submissions/CIK0000320193.json', px)
probe('direct', 'https://www.sec.gov/', {})
" 2>&1)
echo "$OUT"
echo "$OUT" | grep -q "^allowed -> HTTP" && ok "allowlisted host transits proxy (origin verdict, not proxy-deny)" || no "allowlisted host blocked by proxy"
echo "$OUT" | grep -q "^denied-host -> PROXY-DENY-403" && ok "non-allowlisted host dies at proxy 403" || no "non-allowlisted host not denied"
echo "$OUT" | grep -q "^denied-subdomain -> PROXY-DENY-403" && ok "non-allowlisted subdomain dies at proxy 403 (exact allowlist)" || no "subdomain leaked"
echo "$OUT" | grep -q "^direct -> CONN-FAIL" && ok "direct egress fails (no route on internal net)" || no "direct egress succeeded"

# NOTE: log path uses // to suppress Git-Bash/MSYS path conversion; counts
# span rotated logs so long-running proxies still report.
LOGHITS=$(docker exec "$PROXY" sh -c 'cat //var/log/squid/access.log* 2>/dev/null' 2>/dev/null || true)
DENIED=$(echo "$LOGHITS" | grep -c "TCP_DENIED/403" || true)
TUNNEL=$(echo "$LOGHITS" | grep -c "TCP_TUNNEL/200" || true)
echo "proxy access log: TCP_DENIED/403=$DENIED TCP_TUNNEL/200=$TUNNEL"
[ "$DENIED" -ge 2 ] && ok "proxy log counts >=2 denies" || no "proxy log deny count <2"

echo "---"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
