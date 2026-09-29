"""WebSocket trade_updates client against a loopback mock (RFC 6455 subset).

Drives test_ws_stream (built with G0_TEST_BASE) through the handshake, auth
refusal, fragmentation, pings, garbage, oversize frames and a dropped
connection. Loopback only.

    python3 kernel/tests/ws_faults.py <path-to-test_ws_stream>
"""
import base64
import hashlib
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
KEY, SECRET = "TESTKEYID0001", "TESTSECRET0001"


def frame(op, payload, fin=True):
    b = bytes([(0x80 if fin else 0) | op])
    n = len(payload)
    if n < 126:
        b += bytes([n])
    elif n < 65536:
        b += bytes([126]) + struct.pack(">H", n)
    else:
        b += bytes([127]) + struct.pack(">Q", n)
    return b + payload


def read_frame(sock):
    def need(n):
        d = b""
        while len(d) < n:
            c = sock.recv(n - len(d))
            if not c:
                raise EOFError
            d += c
        return d
    h = need(2)
    op, n = h[0] & 0x0F, h[1] & 0x7F
    if n == 126:
        n = struct.unpack(">H", need(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", need(8))[0]
    mask = need(4) if h[1] & 0x80 else b"\0\0\0\0"
    data = bytearray(need(n))
    for i in range(n):
        data[i] ^= mask[i % 4]
    return op, bytes(data)


def trade(ev, cid, filled):
    return json.dumps({"stream": "trade_updates", "data": {
        "event": ev, "execution_id": "e", "order": {
            "id": "o", "client_order_id": cid, "filled_qty": filled,
            "symbol": "SPY"}}}).encode()


class Server:
    """scenario: ok | badauth | drop_after_listen"""

    def __init__(self, scenario):
        self.scenario = scenario
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self.saw_auth = None
        self.saw_listen = False
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self.serve, args=(c,), daemon=True).start()

    def serve(self, c):
        try:
            req = b""
            while b"\r\n\r\n" not in req:
                req += c.recv(4096)
            key = re.search(rb"Sec-WebSocket-Key: (.*)\r\n", req, re.I).group(1).strip()
            acc = base64.b64encode(hashlib.sha1(key + GUID.encode()).digest())
            c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                      b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
            op, data = read_frame(c)
            self.saw_auth = json.loads(data)
            ok = (self.scenario != "badauth" and
                  self.saw_auth.get("key") == KEY and
                  self.saw_auth.get("secret") == SECRET)
            st = "authorized" if ok else "unauthorized"
            c.sendall(frame(1, json.dumps({"stream": "authorization", "data": {
                "action": "authenticate", "status": st}}).encode()))
            if not ok:
                time.sleep(0.5)
                return
            op, data = read_frame(c)
            self.saw_listen = json.loads(data).get("action") == "listen"
            c.sendall(frame(2, json.dumps({"stream": "listening", "data": {
                "streams": ["trade_updates"]}}).encode()))
            time.sleep(0.3)
            if self.scenario == "drop_after_listen":
                c.sendall(frame(2, trade("new", "before-drop", "0")))
                time.sleep(0.2)
                c.close()
                return
            c.sendall(frame(9, b"ping"))                       # ping
            c.sendall(frame(1, b"garbage not json"))            # garbage
            c.sendall(frame(1, json.dumps({"stream": "other"}).encode()))
            c.sendall(frame(2, trade("new", "cid-1", "0")))
            m = trade("partial_fill", "cid-1", "2")             # fragmented
            c.sendall(frame(2, m[:20], fin=False) + frame(0, m[20:40], fin=False)
                      + frame(0, m[40:]))
            c.sendall(frame(1, b" " * 70000 + trade("fill", "huge", "1")))
            c.sendall(frame(2, trade("fill", "cid-1", "5")))
            c.sendall(frame(2, trade("fill", 'bad"cid', "5")))
            time.sleep(1.5)
            c.sendall(frame(8, b""))                            # close
            time.sleep(0.2)
        except (EOFError, OSError):
            pass
        finally:
            c.close()


def run(binary, port, seconds):
    env = dict(os.environ, ALPACA_KEY_ID=KEY, ALPACA_SECRET=SECRET,
               G0_TEST_WS_BASE="http://127.0.0.1:%d/stream" % port)
    return subprocess.run([binary, "live", str(seconds)], env=env, capture_output=True,
                          text=True, timeout=60).stdout.strip()


def main():
    binary = sys.argv[1]
    res = []

    def check(name, ok, info=""):
        res.append(ok)
        if not ok:
            print("FAIL %s %s" % (name, info))

    s = Server("ok")
    out = run(binary, s.port, 4)
    check("handshake-auth-listen", s.saw_auth and s.saw_auth.get("action") == "auth" and s.saw_listen, out)
    check("live-then-close", "changes=" in out and "reconnects=" in out, out)
    sse = out.split("sse=", 1)[-1]
    check("new-event", "event: new|data: {\"order\":{\"client_order_id\":\"cid-1\",\"filled_qty\":\"0\"}}||" in sse, sse)
    check("fragmented-message-reassembled",
          "event: partial_fill|data: {\"order\":{\"client_order_id\":\"cid-1\",\"filled_qty\":\"2\"}}||" in sse, sse)
    check("fill-event", "event: fill|data: {\"order\":{\"client_order_id\":\"cid-1\",\"filled_qty\":\"5\"}}||" in sse, sse)
    check("garbage-and-oversize-dropped", "huge" not in sse and "bad" not in sse and "garbage" not in sse, sse)
    m = re.search(r"dropped=(\d+)", out)
    check("drops-counted", m and int(m.group(1)) >= 3, out)

    s2 = Server("badauth")
    out = run(binary, s2.port, 4)
    check("badauth-no-events", "sse=" in out and out.endswith("sse=") and "live=0" in out, out)
    check("badauth-not-hammered", s2.connections == 1, "connections=%d" % s2.connections)

    s3 = Server("drop_after_listen")
    out = run(binary, s3.port, 8)
    check("drop-delivers-then-reconnects", "before-drop" in out and s3.connections >= 2, "%s conns=%d" % (out, s3.connections))

    out = run(binary, 1, 3)  # nothing listening
    check("down-is-quiet", "live=0" in out and out.endswith("sse="), out)

    print("CHECKS: %d/%d PASS" % (sum(res), len(res)))
    sys.exit(0 if all(res) else 1)


if __name__ == "__main__":
    main()
