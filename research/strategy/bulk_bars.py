"""Resumable bulk fetch of daily SIP bars for many symbols: one request per
symbol per adjustment, a few workers sharing a throttle that keeps the total
under the free tier's 200 requests per minute."""
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import a_run, sip_fetch

MIN_INTERVAL_S = 0.33
WORKERS = 6


class _Throttle:
    def __init__(self, interval):
        self.interval, self.next, self.lock = interval, 0.0, threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next)
            self.next = t + self.interval
        time.sleep(max(0.0, t - now))


def fetch_all(symbols, adjustment, outdir, start, end, log=print):
    """Returns (done, failed). Existing verified datasets are skipped."""
    a_run._load_env()
    throttle = _Throttle(MIN_INTERVAL_S)
    lock = threading.Lock()
    state = {"done": 0, "seen": 0}
    failed = []

    def one(s):
        try:
            sip_fetch.verify_dataset(outdir, s, "bars", "1Day", adjustment)
            ok = True
        except (OSError, ValueError):
            ok = False
            for attempt in range(4):
                try:
                    throttle.wait()
                    sip_fetch.write_dataset(s, "bars", start, end, outdir,
                                            "1Day", adjustment)
                    ok = True
                    break
                except Exception as e:
                    if attempt == 3:
                        with lock:
                            failed.append((s, type(e).__name__))
                    else:
                        time.sleep(2 * (attempt + 1))
        with lock:
            state["seen"] += 1
            state["done"] += ok
            if state["seen"] % 200 == 0:
                log(f"{adjustment} {state['seen']}/{len(symbols)} "
                    f"done={state['done']} failed={len(failed)}")

    with ThreadPoolExecutor(WORKERS) as ex:
        list(ex.map(one, symbols))
    return state["done"], failed
