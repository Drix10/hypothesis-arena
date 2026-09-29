"""JEV shadow mode: logs answers, never touches candidates/journal, resumes
by offset, fails closed without a key. Provider mocked; no network."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from collector import jev
from ops import jev_shadow
from research.strategy.candidate_wire import wire_line

TMP = tempfile.mkdtemp()
jev.CACHE_DIR = os.path.join(TMP, "cache")
jev.SPEND_DIR = os.path.join(TMP, "spend")
jev.CALL_LOG = os.path.join(TMP, "calls.jsonl")
jev.KEY_PATH = os.path.join(TMP, "keys", "k.json")
jev.RETRY_DELAY_S = 0
jev.keypair()

LOOP = os.path.join(TMP, "loop")
os.makedirs(LOOP)
CAND = os.path.join(LOOP, "candidates.jsonl")


def add(sym):
    with open(CAND, "a") as f:
        f.write(wire_line("core_passive_v1", sym, 1_700_000_000 * 10**9,
                          100.0, 95.0, 110.0, family="momentum"))


def resp(enter=0.9, risk=0.1, fam="momentum"):
    return {"model": jev.REVISION, "provider": jev.PROVIDER,
            "answers": {
                "enter": {"type": "noul", "noul": enter},
                "edge_family": {"type": "choice", "choice": fam,
                                "probabilities": {fam: 0.8}},
                "conviction": {"type": "score", "score": "lean"},
                "latent_risk": {"type": "noul", "noul": risk}},
            "usage": {"cost": 0.00001}}


def rows():
    with open(os.path.join(LOOP, "jev_shadow.jsonl")) as f:
        return [json.loads(x) for x in f]


def post(r):
    return lambda body, key: (r, None)


add("AAA")
add("BBB")
before = open(CAND, "rb").read()
assert jev_shadow.run(LOOP, now=1000.0, key="k", post_fn=post(resp())) == 2
r = rows()
assert [x["symbol"] for x in r] == ["AAA", "BBB"]
assert all(x["action"] == "ANSWER" and x["shadow"] for x in r)
assert r[0]["would_block"] is False
# candidates untouched, no journal/STAGE created
assert open(CAND, "rb").read() == before
assert sorted(os.listdir(LOOP)) == ["candidates.jsonl", "jev_shadow.jsonl",
                                    "jev_shadow.offset"]
print("ok logs-and-leaves-inputs-alone")

# resume: nothing new -> nothing processed; new line -> only that one
assert jev_shadow.run(LOOP, now=1001.0, key="k", post_fn=post(resp())) == 0
add("CCC")
assert jev_shadow.run(LOOP, now=1002.0, key="k",
                      post_fn=post(resp(enter=0.2))) == 1
assert rows()[-1]["symbol"] == "CCC" and rows()[-1]["would_block"] is True
print("ok offset-resume-and-would-block")

# family mismatch is a what-if block
add("DDD")
jev_shadow.run(LOOP, now=1003.0, key="k", post_fn=post(resp(fam="macro")))
assert rows()[-1]["would_block"] is True
print("ok family-mismatch")

# half-written line is left for the next pass
with open(CAND, "a") as f:
    f.write('{"schema":"c1"')
assert jev_shadow.run(LOOP, now=1004.0, key="k", post_fn=post(resp())) == 0
print("ok partial-line-skipped")

# provider error -> HOLD row, no invented answer
LOOP2 = os.path.join(TMP, "loop2")
os.makedirs(LOOP2)
os.replace(CAND, os.path.join(LOOP2, "candidates.jsonl"))
CAND2 = os.path.join(LOOP2, "candidates.jsonl")
with open(CAND2, "r+") as f:
    lines = f.read().split("\n")
    f.seek(0)
    f.truncate()
    f.write("\n".join(lines[:-1][:1]) + "\n")
jev_shadow.run(LOOP2, now=2000.0, key="k",
               post_fn=lambda b, k: (None, "provider-http-500"))
with open(os.path.join(LOOP2, "jev_shadow.jsonl")) as f:
    h = json.loads(f.readline())
assert h["action"] == "HOLD" and "answers" not in h and "enter" not in h
print("ok provider-error-holds")
print("PASS")
