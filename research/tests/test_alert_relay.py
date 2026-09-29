import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import alert_relay as A


def row(level="HARD", code="x", detail="d", ts=1):
    return json.dumps({"ts_ns": ts, "level": level, "code": code,
                       "detail": detail}) + "\n"


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.p = os.path.join(self.d.name, "alerts.jsonl")
        self.s = os.path.join(self.d.name, "st.json")
        self.got = []

    def tearDown(self):
        self.d.cleanup()

    def w(self, txt, mode="a"):
        with open(self.p, mode) as f:
            f.write(txt)

    def test_redaction(self):
        m = A.redact("key=ABCD1234 Bearer xyz APCA-API-SECRET-KEY: s "
                     "https://u:p@h/x " + "A" * 40)
        for bad in ("ABCD1234", "xyz", "u:p@", "A" * 24):
            self.assertNotIn(bad, m)
        self.assertLessEqual(len(A.redact("z " * 500)), A.MAX_MSG)

    def test_redaction_shapes(self):
        cases = ["eyJhbGciOi.eyJzdWIiOjE.sig123", "Authorization: Basic dXNlcjpwYXNz",
                 "PKTEST1234567890ABCD", "sk-abc12345", "api_key = 'abc def'",
                 "secret_token=zzz", "ghp_" + "a" * 24]
        for c in cases:
            m = A.redact("x " + c + " y")
            self.assertIn("[redacted]", m)
            for leak in ("dXNlcjpwYXNz", "TEST1234567890", "abc12345", "def'",
                         "zzz", "eyJzdWIi"):
                self.assertNotIn(leak, m)

    def test_kernel_levels_are_delivered(self):
        self.w(row(level="S2") + row(level="OPS") + row(level="CURSOR") +
               row(level="FEED") + row(level="info"))
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual((r["sent"], r["malformed"]), (4, 1))

    def test_oversized_line_is_bounded(self):
        self.w("x" * (A.MAX_READ + 10) + "\n" + row(code="after"))
        A.run_once(self.p, self.s, self.got.append)
        A.run_once(self.p, self.s, self.got.append)
        self.assertTrue(any("after" in m for m in self.got))

    def test_rotation_to_larger_file_resets(self):
        self.w(row(code="old1") + row(code="old2"))
        A.run_once(self.p, self.s, self.got.append)
        self.w(row(code="new1", detail="x" * 200) + row(code="new2") +
               row(code="new3"), "w")
        A.run_once(self.p, self.s, self.got.append)
        self.assertEqual([m.split(":")[0][-4:] for m in self.got[2:]],
                         ["new1", "new2", "new3"])

    def test_webhook_targets_are_public_https_only(self):
        for bad in ("http://x.example", "https://127.0.0.1/h",
                    "https://169.254.169.254/", "https://10.0.0.1/",
                    "https://localhost/h", "ftp://x"):
            with self.assertRaises(A.RelayError):
                A.webhook_sender(bad)
        A.webhook_sender("https://hooks.example.com/x")

    def test_offset_dedupe_and_partial_line(self):
        self.w(row(code="a") + row(code="b") + '{"ts_ns":')
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual((r["sent"], len(self.got)), (2, 2))
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(r["sent"], 0)
        self.w('3,"level":"HARD","code":"c","detail":""}\n')
        A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(len(self.got), 3)
    def test_failure_retries_same_line(self):
        self.w(row(code="a"))

        def boom(m):
            raise OSError("down")
        r = A.run_once(self.p, self.s, boom)
        self.assertTrue(r["failed"])
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(len(self.got), 1)

    def test_malformed_and_level_floor(self):
        self.w("garbage\n" + row(level="INFO") + row(level="bad") +
               '{"ts_ns":0,"level":"HARD","code":"z"}\n' + row(level="WARN"))
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual((r["sent"], r["skipped"], r["malformed"]), (1, 1, 3))

    def test_truncation_resets_and_cap(self):
        self.w(row() * 25)
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(r["sent"], A.MAX_PER_RUN)
        A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(len(self.got), 25)
        self.w(row(code="new"), "w")
        A.run_once(self.p, self.s, self.got.append)
        self.assertIn("new", self.got[-1])

    def test_https_only_and_missing_file(self):
        with self.assertRaises(A.RelayError):
            A.webhook_sender("http://x")
        r = A.run_once(os.path.join(self.d.name, "none"), self.s,
                       self.got.append)
        self.assertEqual(r["sent"], 0)


if __name__ == "__main__":
    unittest.main()
