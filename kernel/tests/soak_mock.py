"""Compressed soak of g0_paper_loop against the mock venue with random faults.

Not part of the gate (minutes, not hours). Feeds candidates while the venue
misbehaves and samples the loop process for memory and descriptor growth.
The real 24 h soak (K9) needs a persistent host and the live paper API.

    python3 kernel/tests/soak_mock.py <g0_paper_loop_test_binary> [ticks]
"""
import os
import random
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_mock_venue as M  # noqa: E402


def sample(pid):
    rss = fds = 0
    try:
        for ln in open("/proc/%d/status" % pid):
            if ln.startswith("VmRSS:"):
                rss = int(ln.split()[1])
        fds = len(os.listdir("/proc/%d/fd" % pid))
    except OSError:
        pass
    return rss, fds


def main():
    binary = os.path.abspath(sys.argv[1])
    ticks = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    port = M.start_venue()
    M.V.reset()
    d = M.make_dir()
    open(d + "/candidates.jsonl", "w").close()
    p = subprocess.Popen([binary, d, M.CAL, "--ticks", str(ticks),
                          "--interval-s", "1"], env=M.loop_env(port),
                         stdout=subprocess.PIPE, text=True)
    rnd = random.Random(7)
    stop = threading.Event()

    def feeder():
        i = 0
        while not stop.is_set():
            i += 1
            sym = rnd.choice(["VTI", "IEF", "SPY"])
            side = "SELL" if M.V.positions.get(sym) and rnd.random() < 0.5 else "BUY"
            open(d + "/candidates.jsonl", "a").write(M.candidate(sym, side, i))
            if rnd.random() < 0.15:
                M.V.mode = rnd.choice(["ok", "outage_orders", "outage_all"])
                M.V.fail_posts = rnd.choice([0, 0, 1, 2])
            stop.wait(rnd.uniform(1, 3))

    threading.Thread(target=feeder, daemon=True).start()
    samples = []
    t0 = time.time()
    while p.poll() is None:
        time.sleep(5)
        samples.append(sample(p.pid))
    stop.set()
    rss = [s[0] for s in samples if s[0]]
    fds = [s[1] for s in samples if s[1]]
    jr = os.path.getsize(d + "/journal.jsonl") if os.path.exists(d + "/journal.jsonl") else 0
    print("rc=%d elapsed=%ds samples=%d" % (p.returncode, time.time() - t0, len(samples)))
    if rss:
        print("rss_kb first=%d max=%d last=%d" % (rss[0], max(rss), rss[-1]))
    if fds:
        print("fds first=%d max=%d last=%d" % (fds[0], max(fds), fds[-1]))
    print("decisions=%d posts=%d journal_bytes=%d" %
          (len(M.decisions(d)), M.V.posts, jr))
    ok = p.returncode in (0, 3) and (not rss or rss[-1] < rss[0] * 1.5 + 4096) \
        and (not fds or max(fds) <= fds[0] + 4)
    print("SOAK", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
