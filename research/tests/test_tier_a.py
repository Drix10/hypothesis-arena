import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.sources import tier_a


class MeasureLeaks(unittest.TestCase):
    def test_error_never_echoes_the_url(self):
        r = tier_a.measure(
            "https://x.invalid/p?api_key=SECRETKEY123 \n&z=1", timeout=1)
        self.assertEqual(r["status"], "DOWN")
        self.assertNotIn("SECRETKEY123", str(r))


if __name__ == "__main__":
    unittest.main()
