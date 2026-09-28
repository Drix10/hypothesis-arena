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

    def test_offset_dedupe_and_partial_line(self):
        self.w(row(code="a") + row(code="b") + '{"ts_ns":')
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual((r["sent"], len(self.got)), (2, 2))
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(r["sent"], 0)            # no dupes
        self.w('3,"level":"HARD","code":"c","detail":""}\n')
        A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(len(self.got), 3)        # partial completed later

    def test_failure_retries_same_line(self):
        self.w(row(code="a"))

        def boom(m):
            raise OSError("down")
        r = A.run_once(self.p, self.s, boom)
        self.assertTrue(r["failed"])
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(len(self.got), 1)         # at-least-once

    def test_malformed_and_level_floor(self):
        self.w("garbage\n" + row(level="INFO") + row(level="BAD") +
               '{"ts_ns":0,"level":"HARD","code":"z"}\n' + row(level="WARN"))
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual((r["sent"], r["skipped"], r["malformed"]), (1, 1, 3))

    def test_truncation_resets_and_cap(self):
        self.w(row() * 25)
        r = A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(r["sent"], A.MAX_PER_RUN)
        A.run_once(self.p, self.s, self.got.append)
        self.assertEqual(len(self.got), 25)        # remainder next pass
        self.w(row(code="new"), "w")               # rotated smaller
        A.run_once(self.p, self.s, self.got.append)
        self.assertIn("new", self.got[-1])

    def test_https_only_and_missing_file(self):
        with self.assertRaises(A.RelayError):
            A.webhook_sender("http://x")
        r = A.run_once(os.path.join(self.d.name, "none"), self.s,
                       self.got.append)
        self.assertEqual(r["sent"], 0)


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL ALERT RELAY TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
