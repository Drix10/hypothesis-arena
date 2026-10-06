import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sandbox"))
import alpaca_short_probe as P

ACCT = {"status": "ACTIVE", "currency": "USD", "cash": "100000",
        "equity": "100000", "buying_power": "400000", "multiplier": "4",
        "shorting_enabled": True, "id": "secret-id"}


class Fake:
    def __init__(self, short_ok=True, frac_ok=False):
        self.calls, self.short_ok, self.frac_ok = [], short_ok, frac_ok

    def __call__(self, method, base, path, body=None):
        self.calls.append((method, path, body))
        if path == "/v2/account":
            return 200, ACCT
        if path.startswith("/v2/assets/"):
            return 200, {"shortable": True, "easy_to_borrow": path.endswith(
                "SPY"), "fractionable": True}
        if method == "POST":
            ok = self.short_ok if body["qty"] == "1" else self.frac_ok
            if ok:
                return 201, {"id": "o-" + body["qty"], "status": "accepted"}
            return 403, {"message": "fractional short not allowed"}
        if method == "DELETE":
            return 204, None
        raise AssertionError(path)


class ShortProbe(unittest.TestCase):
    def test_refuses_non_paper_base(self):
        with self.assertRaises(ValueError):
            P.run(Fake(), base="https://api.alpaca.markets")

    def test_report_and_order_discipline(self):
        f = Fake()
        ev = P.run(f)
        self.assertEqual(ev["account"]["multiplier"], "4")
        self.assertNotIn("id", ev["account"])
        self.assertEqual(len(ev["assets"]), 20)
        self.assertTrue(ev["short_1_share"]["accepted"])
        self.assertFalse(ev["short_fractional"]["accepted"])
        posts = [c for c in f.calls if c[0] == "POST"]
        self.assertEqual(len(posts), 2)
        self.assertEqual([c[2]["side"] for c in posts], ["sell", "sell"])
        self.assertEqual([c[1] for c in f.calls if c[0] == "DELETE"],
                         ["/v2/orders/o-1"])

    def test_rejected_short_is_not_cancelled(self):
        f = Fake(short_ok=False)
        ev = P.run(f)
        self.assertFalse(ev["short_1_share"]["accepted"])
        self.assertFalse([c for c in f.calls if c[0] == "DELETE"])

    def test_account_failure_places_no_order(self):
        def bad(method, base, path, body=None):
            return 401, {}
        with self.assertRaises(RuntimeError):
            P.run(bad)

    def test_no_keys_blocks(self):
        saved = {k: os.environ.pop(k, None)
                 for k in ("ALPACA_KEY_ID", "ALPACA_SECRET")}
        try:
            self.assertEqual(P.main(), 2)
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
