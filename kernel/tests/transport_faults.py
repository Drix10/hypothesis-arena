"""Fault injection against the real libcurl transport.

Runs test_transport_faults (built with G0_TEST_BASE) against a local mock of
the Alpaca paper API and checks how each fault is classified. The mock never
leaves loopback; the production build has no base-URL override.

    python3 kernel/tests/transport_faults.py <path-to-test_transport_faults>
"""
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time

FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures")
BRACKET = open(os.path.join(FIX, "alpaca_bracket_reply.json")).read()
ACCOUNT = open(os.path.join(FIX, "alpaca_account.json")).read()
KEY, SECRET = "TESTKEYID0001", "TESTSECRET0001"


class Mock(http.server.BaseHTTPRequestHandler):
    log = []
    scenario = None

    def log_message(self, *a):
        pass

    def _send(self, code, body="", headers=()):
        data = body.encode()
        self.send_response(code)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        Mock.log.append((self.command, self.path, dict(self.headers), body))
        sc = Mock.scenario
        if sc == "ok":
            if self.command == "DELETE":
                return self._send(204)
            return self._send(200, BRACKET if self.command == "POST" or
                              "client_order_id" in self.path else ACCOUNT)
        if sc in ("429", "401", "403", "422", "500"):
            if self.command == "DELETE" and sc == "422":
                return self._send(422, '{"message":"order not cancelable"}')
            return self._send(int(sc), '{"message":"x"}',
                              [("Retry-After", "1")] if sc == "429" else [])
        if sc == "reset":
            self.send_response(200)
            self.send_header("Content-Length", "5000")
            self.end_headers()
            self.wfile.write(BRACKET[:300].encode())
            self.wfile.flush()
            self.connection.close()
            return
        if sc == "hang":
            time.sleep(4)
            return
        if sc == "redirect":
            return self._send(302, "", [("Location", "http://127.0.0.1:1/evil")])
        if sc == "big":
            return self._send(200, "x" * 300000)
        if sc == "garbage":
            return self._send(200, "not json at all")
        if sc == "truncated":
            return self._send(200, BRACKET[:1500])
        if sc == "trickle":
            data = BRACKET.encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            for i in range(0, len(data), 400):
                self.wfile.write(data[i:i + 400])
                self.wfile.flush()
                time.sleep(0.05)
            return
        if sc == "notfound":
            return self._send(404, '{"message":"order not found"}')
        self._send(500)

    do_GET = do_POST = do_DELETE = _handle


def run(binary, port, op, scenario, timeout_ms="1500"):
    Mock.scenario = scenario
    Mock.log = []
    env = dict(os.environ, ALPACA_KEY_ID=KEY, ALPACA_SECRET=SECRET,
               G0_TEST_BASE="http://127.0.0.1:%d" % port,
               G0_TEST_TIMEOUT_MS=timeout_ms)
    return subprocess.run([binary, op], env=env, capture_output=True,
                          text=True, timeout=30).stdout.strip()


CASES = [
    ("submit", "ok", r"transport_ok=1 accepted=1 protected=1 reject=0 auth=0 rate=0"),
    ("submit", "429", r"accepted=0 .*rate=1"),
    ("submit", "401", r"accepted=0 .*auth=1"),
    ("submit", "422", r"accepted=0 protected=0 reject=1"),
    ("submit", "403", r"reject=1 auth=0 rate=0 reason=buying-power"),
    ("submit", "500", r"transport_ok=0 accepted=0 protected=0 reject=0 auth=0 rate=0"),
    ("submit", "reset", r"transport_ok=0 accepted=0 protected=0 reject=0"),
    ("submit", "hang", r"transport_ok=0 accepted=0 protected=0 reject=0"),
    ("submit", "redirect", r"transport_ok=0 accepted=0 protected=0 reject=0"),
    ("submit", "big", r"transport_ok=0 accepted=0"),
    ("submit", "garbage", r"transport_ok=0 accepted=0"),
    ("submit", "truncated", r"protected=0"),
    ("submit", "trickle", r"transport_ok=1 accepted=1 protected=1"),
    ("query", "ok", r"found=1 protected=1 cancelled=0"),
    ("query", "notfound", r"found=0"),
    ("query", "reset", r"found=0"),
    ("cancel", "ok", r"accepted=1 failed=0"),
    ("cancel", "422", r"accepted=0 failed=1"),
    ("cancel", "500", r"accepted=0 failed=0"),
    ("cancel", "hang", r"accepted=0 failed=0"),
    ("rest", "ok", r"ok=1 status=200"),
    ("rest", "500", r"ok=1 status=500"),
    ("rest", "reset", r"ok=0 status=0"),
    ("rest", "big", r"ok=0"),
]


def main():
    binary = sys.argv[1]
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    srv.daemon_threads = True
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    fails = 0
    for op, sc, pat in CASES:
        got = run(binary, port, op, sc)
        if re.search(pat, got) is None:
            fails += 1
            print("FAIL %s/%s: %r (want /%s/)" % (op, sc, got, pat))
    # Credentials ride headers only, and the request is well formed.
    run(binary, port, "submit", "ok")
    m, path, hdr, body = Mock.log[0]
    checks = {
        "method-post": m == "POST",
        "path": path == "/v2/orders",
        "key-header": hdr.get("APCA-API-KEY-ID") == KEY,
        "secret-header": hdr.get("APCA-API-SECRET-KEY") == SECRET,
        "no-creds-in-path": KEY not in path and SECRET not in path,
        "no-creds-in-body": KEY not in body and SECRET not in body,
        "body-json": json.loads(body)["client_order_id"] == "c" * 64,
    }
    for name, ok in checks.items():
        if not ok:
            fails += 1
            print("FAIL request/" + name)
    total = len(CASES) + len(checks)
    print("CHECKS: %d/%d PASS" % (total - fails, total))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
