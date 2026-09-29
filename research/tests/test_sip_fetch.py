import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import sip_fetch as S

NOW = datetime(2026, 9, 28, 20, 0, tzinfo=timezone.utc)
OLD = "2026-09-01T00:00:00Z"
START = "2026-01-02T00:00:00Z"


def fake(pages):
    calls = []

    def get(url, headers):
        calls.append((url, headers))
        return pages[len(calls) - 1]
    return get, calls


class SipTest(unittest.TestCase):
    def test_delay_refused_and_boundary(self):
        with self.assertRaises(S.SipError):
            S.check_end((NOW - timedelta(minutes=14)).isoformat(), NOW)
        S.check_end((NOW - timedelta(minutes=15)).isoformat(), NOW)
        with self.assertRaises(S.SipError):
            S.check_end("2026-01-01T00:00:00", NOW)  # naive

    def test_query_validation(self):
        q = S.build_query("SPY", "bars", START, OLD, "1Day", "split")
        self.assertEqual(q["feed"], "sip")
        for bad in (("SPY", "bars", START, OLD, None, "raw"),
                    ("SPY", "bars", OLD, START, "1Day", "raw"),
                    ("SPY", "bars", START, OLD, "1Day", "weird"),
                    ("S&P", "bars", START, OLD, "1Day", "raw"),
                    ("SPY", "trades", START, OLD, "1Day", "raw")):
            with self.assertRaises(S.SipError):
                S.build_query(*bad)

    def test_pagination_and_manifest(self):
        get, calls = fake([
            {"bars": {"SPY": [{"t": "a", "c": 1}]}, "next_page_token": "T"},
            {"bars": {"SPY": [{"t": "b", "c": 2}]}, "next_page_token": None}])
        rows, q = S.fetch("SPY", "bars", START, OLD, "1Day", "split",
                          http_get=get, headers={"k": "x"}, now=NOW)
        self.assertEqual(len(rows), 2)
        self.assertIn("page_token=T", calls[1][0])
        self.assertIn("feed=sip", calls[0][0])
        m = S.manifest("SPY", "bars", q, rows, "t")
        self.assertEqual(m["rows"], 2)
        self.assertEqual(m["sha256"], S.content_hash(rows))
        self.assertEqual(m["feed"], "sip")

    def test_runaway_pagination_refused(self):
        def get(url, headers):
            return {"bars": {"SPY": []}, "next_page_token": "T"}
        with self.assertRaises(S.SipError):
            S.fetch("SPY", "bars", START, OLD, "1Day", http_get=get,
                    headers={}, now=NOW)

    def test_no_credentials_fails_closed(self):
        old = {k: os.environ.pop(k, None)
               for k in ("ALPACA_KEY_ID", "ALPACA_SECRET")}
        try:
            with self.assertRaises(S.SipError):
                S.fetch("SPY", "bars", START, OLD, "1Day",
                        http_get=lambda u, h: {}, now=NOW)
        finally:
            for k, v in old.items():
                if v is not None:
                    os.environ[k] = v

    def test_write_dataset_has_no_credential_material(self):
        get, _ = fake([{"bars": {"SPY": [{"t": "a", "c": 1}]}}])
        with tempfile.TemporaryDirectory() as d:
            m = S.write_dataset("SPY", "bars", START, OLD, d, "1Day", "raw",
                                http_get=get,
                                headers={"APCA-API-KEY-ID": "SENTINEL-K"},
                                now=NOW)
            blob = ""
            for n in os.listdir(d):
                with open(os.path.join(d, n)) as fh:
                    blob += fh.read()
            self.assertNotIn("SENTINEL-K", blob)
            with open(os.path.join(
                    d, "SPY_bars_1Day_raw.manifest.json")) as fh:
                self.assertEqual(json.load(fh)["sha256"], m["sha256"])

    def test_verify_dataset_detects_tampering(self):
        get, _ = fake([{"bars": {"SPY": [{"t": "a", "c": 1}]}}])
        with tempfile.TemporaryDirectory() as d:
            S.write_dataset("SPY", "bars", START, OLD, d, "1Day", "raw",
                            http_get=get, headers={}, now=NOW)
            m = S.verify_dataset(d, "SPY", "bars", "1Day", "raw")
            self.assertEqual(m["rows"], 1)
            with open(os.path.join(d, "SPY_bars_1Day_raw.jsonl"), "a") as f:
                f.write("{}\n")
            with self.assertRaises(S.SipError):
                S.verify_dataset(d, "SPY", "bars", "1Day", "raw")

    def test_manifest_hash_is_the_file_hash(self):
        import hashlib
        get, _ = fake([{"bars": {"SPY": [{"t": "a", "c": 1}]}}])
        with tempfile.TemporaryDirectory() as d:
            m = S.write_dataset("SPY", "bars", START, OLD, d, "1Day", "raw",
                                http_get=get, headers={}, now=NOW)
            with open(os.path.join(d, "SPY_bars_1Day_raw.jsonl"), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(),
                                 m["sha256"])

    def test_hash_deterministic_and_sensitive(self):
        a = [{"t": "a", "c": 1}]
        self.assertEqual(S.content_hash(a), S.content_hash([{"c": 1, "t": "a"}]))
        self.assertNotEqual(S.content_hash(a), S.content_hash([{"t": "a", "c": 2}]))


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL SIP FETCH TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
