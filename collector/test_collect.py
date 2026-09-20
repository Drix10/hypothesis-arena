#!/usr/bin/env python3
'''Collector failure-path acceptance: status/records can never mix, failure
modes append nothing, non-transient errors never retry, corrupt state fails
closed, identities are never coerced or truncated. Stdlib only.
Run: python3 collector/test_collect.py (no network; urlopen mocked)
'''
import io
import json
import os
import sys
import tempfile
import urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import collect  # noqa: E402

TMP = tempfile.mkdtemp()
collect.SCHEDULE_PATH = os.path.join(TMP, "schedule.json")
collect.CACHE_PATH = os.path.join(TMP, "cache.json")
collect.heartbeat = lambda *a, **k: None  # no state writes in these tests


def check(name, cond):
    assert cond, name
    print("ok " + name)


SRC = {"name": "t_json", "kind": "json", "url": "http://x/", "limit": 50,
       "drill": ["data"], "id_field": "uid", "title_field": "title",
       "date_field": "pub", "text_fields": ["a"], "link_template": ""}


REAL_FETCH = collect.fetch


def run_with(body=None, status="ok"):
    collect.fetch = lambda url, key, extra=None: (status, body or b"", {},
                                                  {})
    return collect.run_json_source(dict(SRC))


def payload(rows):
    return json.dumps({"data": rows}).encode()


# 1. 200 valid -> records appended (list, all dicts)
st, recs, _v, _sk = run_with(payload([{"uid": "u1", "title": "T",
                              "pub": "2026-09-18T00:00:00+00:00", "a": "x"}]))
check("json-200", st == "ok" and isinstance(recs, list) and len(recs) == 1
      and isinstance(recs[0], dict) and recs[0]["source_id"] == "u1")

# 2-6. every failure mode -> (status, []) and NEVER a bare string
for status, name in [("not-modified", "json-304"),
                     ("auth-failure", "json-401"),
                     ("rate-limited", "json-429"),
                     ("source-down", "json-timeout")]:
    st, recs, _v, _sk = run_with(b"", status)
    check(name, st == status and recs == [])
    check(name + "-not-string", isinstance(recs, list))

# 7. malformed JSON -> parse-failure, nothing appended
st, recs, _v, _sk = run_with(b"{nope", "ok")
check("json-malformed", st == "parse-failure" and recs == [])

# 8. drilled payload not a list -> parse-failure
st, recs, _v, _sk = run_with(json.dumps({"data": {"x": 1}}).encode(), "ok")
check("json-drill-not-list", st == "parse-failure" and recs == [])

# 9. non-string identity/date/title, float/dict summary -> row skipped,
# never coerced (floats rejected: NaN/Infinity + unstable repr)
rows = [{"uid": 42, "title": "T"},                       # int id
        {"uid": None, "title": "T"},                     # null id
        {"uid": "u2", "title": 5},                       # int title
        {"uid": "u3", "title": "T", "pub": 12345},       # int date
        {"uid": "u" * 300, "title": "T"},                # overlong id
        {"uid": "u4", "title": "T", "a": {"nested": 1}},  # dict summary
        {"uid": "u5", "title": "T", "a": 3.5},           # float summary
        {"uid": "u6", "title": "T", "a": float("nan")}]  # NaN summary
st, recs, _v, _sk = run_with(payload(rows))
check("no-coercion", st == "ok" and recs == [])
# str/int summaries still flow
st, recs, _v, _sk = run_with(payload([{"uid": "u7", "title": "T", "a": "x"},
                             {"uid": "u8", "title": "T", "a": 7}]))
check("scalar-summary", len(recs) == 2 and "a=x" in recs[0]["text"]
      and "a=7" in recs[1]["text"])

# 10. to_record rejects overlong / non-string identities (no truncation)
check("record-overlong", collect.to_record("s", {"uid": "x" * 300}) is None)
check("record-int-uid", collect.to_record("s", {"uid": 7}) is None)
check("record-full-identity",
      collect.to_record("s", {"uid": "abc", "link": "http://l"})["source_id"]
      == "abc")

# 11. fetch(): 401/403/400 return on the FIRST attempt (no retry burn)
calls = []


class FakeResp:
    def __init__(self, body=b"{}"):
        self._b = body
        self.headers = {}
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def read(self, n=-1):
        return self._b


def boom_once_then_ok(code):
    def f(req, timeout=None):
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)
        return FakeResp()
    return f


import urllib.request as _ureq
collect.fetch = REAL_FETCH
collect.CACHE_PATH = os.path.join(TMP, "cache-fetch.json")
for code, want, attempts in [(401, "auth-failure", 1),
                             (403, "auth-failure", 1),
                             (400, "source-down", 1),
                             (404, "source-down", 1)]:
    calls.clear()
    with mock.patch.object(_ureq, "urlopen", boom_once_then_ok(code)):
        st, body, _, _ = collect.fetch("http://x/", "k")
    check(f"fetch-{code}-immediate", st == want and len(calls) == attempts)

# 429 retries then succeeds
calls.clear()
with mock.patch.object(_ureq, "urlopen", boom_once_then_ok(429)):
    with mock.patch.object(collect.time, "sleep", lambda *a: None):
        st, body, _, _ = collect.fetch("http://x/", "k")
check("fetch-429-retries", st == "ok" and len(calls) == 2)

# 12. schedule: missing = first run; corrupt = fail closed
collect.SCHEDULE_PATH = os.path.join(TMP, "sched-missing.json")
s, ok = collect.load_schedule()
check("schedule-missing", s == {} and ok is True)
bad = os.path.join(TMP, "sched-bad.json")
open(bad, "w").write("{corrupt")
collect.SCHEDULE_PATH = bad
s, ok = collect.load_schedule()
check("schedule-corrupt", s == {} and ok is False)
open(bad, "w").write("[1,2]")
s, ok = collect.load_schedule()
check("schedule-nondict", s == {} and ok is False)

# 13. cache: missing = first run; corrupt = refuse
collect.CACHE_PATH = os.path.join(TMP, "cache-missing.json")
check("cache-missing", collect.check_cache_usable() is True)
badc = os.path.join(TMP, "cache-bad.json")
open(badc, "w").write("{corrupt")
collect.CACHE_PATH = badc
check("cache-corrupt", collect.check_cache_usable() is False)

# 14. sources config validation
good = json.load(open(os.path.join(HERE, "sources.json"), encoding="utf-8"))
check("sources-real-valid", len(collect.validate_sources_config(good)) > 0)
for blob, name in [({"sources": []}, "dict-top"),
                   ([], "empty"),
                   ([{"kind": "rss", "url": "u"}], "missing-name"),
                   ([{"name": "a", "kind": "gopher", "url": "u"}], "bad-kind"),
                   ([{"name": "a", "kind": "rss", "url": "u"},
                     {"name": "a", "kind": "rss", "url": "u2"}], "dup-name"),
                   ([{"name": "j", "kind": "json", "url": "u"}], "no-id-field"),
                   ([{"name": "a", "kind": "rss", "url": "u",
                      "poll_min": "15"}], "bad-poll-min")]:
    try:
        collect.validate_sources_config(blob)
        raised = False
    except collect.ConfigError:
        raised = True
    check("sources-" + name, raised)

# 15. schedule/cache full-schema validation (valid JSON, malformed entries)
for blob, name in [({"s": ["garbage"]}, "sched-list-entry"),
                   ({"s": {"backoff_until": 123}}, "sched-bad-instant"),
                   ({"s": {"next_due": "yesterday"}}, "sched-bad-parse"),
                   ({"s": {"bogus": "2026-09-18T00:00:00+00:00"}},
                    "sched-unknown-key")]:
    try:
        collect.validate_schedule(blob)
        raised = False
    except collect.ConfigError:
        raised = True
    check("sched-" + name.split("-", 1)[1], raised)
check("sched-valid",
      collect.validate_schedule(
          {"s": {"next_due": "2026-09-18T00:00:00+00:00"}}) is not None)
for blob, name in [({"k": ["x"]}, "cache-list-entry"),
                   ({"k": {"etag": 5}}, "cache-bad-etag"),
                   ({"k": {"etag": "e", "zzz": 1}}, "cache-unknown-key")]:
    try:
        collect.validate_cache(blob)
        raised = False
    except collect.ConfigError:
        raised = True
    check(name, raised)
check("cache-valid",
      collect.validate_cache({"k": {"etag": "e", "modified": None}})
      is not None)

# 16. MAIN-LOOP regression: a 304/failed second source must not re-emit the
# first source's records (per-source `recs` isolation through real main()).
RSS_ONE = (b'<?xml version="1.0"?><rss version="2.0"><channel>'
           b'<item><guid>g1</guid><title>T1</title><link>http://l1</link>'
           b'<pubDate>Thu, 18 Sep 2026 00:00:00 GMT</pubDate>'
           b'<description>body one</description></item>'
           b'</channel></rss>')


def run_main(status2):
    srcs = [{"name": "s1", "kind": "rss", "url": "http://s1/",
             "limit": 10, "poll_min": 15},
            {"name": "s2", "kind": "rss", "url": "http://s2/",
             "limit": 10, "poll_min": 15}]
    calls = {"fetch": 0}

    def fake_fetch(url, key, extra=None):
        calls["fetch"] += 1
        if "s1" in url:
            return "ok", RSS_ONE, {}, {}
        return status2, b"x", {}, {}
    appended = []
    saved = (collect.fetch, collect.load_sources, collect.load_schedule,
             collect.heartbeat, collect.append_records,
             collect.save_schedule, collect.load_config,
             collect.check_cache_usable, collect.STATE,
             collect.CACHE_PATH, collect.SCHEDULE_PATH)
    collect.STATE = os.path.join(TMP, "stateMain")
    # Fresh state files: earlier tests leave corrupt-path fixtures behind
    # (schedule-corrupt/cache-corrupt); main() must see a clean slate here.
    collect.CACHE_PATH = os.path.join(TMP, "cache-main.json")
    collect.SCHEDULE_PATH = os.path.join(TMP, "schedule-main.json")
    collect.fetch = fake_fetch
    collect.load_sources = lambda: srcs
    collect.load_schedule = lambda: ({}, True)
    collect.heartbeat = lambda *a, **k: None
    collect.append_records = lambda recs: appended.extend(recs) or "p"
    collect.save_schedule = lambda s: None
    collect.load_config = lambda: {"status": "CONFIG_OK", "values": {},
                                   "missing_required": []}
    collect.check_cache_usable = lambda: True
    try:
        with mock.patch("time.sleep", lambda *a: None):
            collect.main()
    finally:
        (collect.fetch, collect.load_sources, collect.load_schedule,
         collect.heartbeat, collect.append_records,
         collect.save_schedule, collect.load_config,
         collect.check_cache_usable, collect.STATE,
         collect.CACHE_PATH, collect.SCHEDULE_PATH) = saved
    return appended


for status2 in ["not-modified", "auth-failure", "rate-limited",
                "source-down"]:
    got = run_main(status2)
    check("main-isolation-" + status2,
          len(got) == 1 and got[0]["source"] == "s1"
          and got[0]["source_id"] == "g1")

# 17. source-config allowlist: unknown keys rejected, inert notes kept
try:
    collect.validate_sources_config([{"name": "a", "kind": "rss",
                                      "url": "u", "poll_mni": 15}])
    raised = False
except collect.ConfigError:
    raised = True
check("sources-unknown-key", raised)
check("sources-inert-notes",
      len(collect.validate_sources_config(
          [{"name": "a", "kind": "rss", "url": "u",
            "note": "human comment", "class_hint": "x"}])) == 1)

# 18. singleton: concurrent collect.py refuses (in-process + cross-process)
import subprocess as _sp
_saved_state = collect.STATE
collect.STATE = os.path.join(TMP, "stateLock")
_holder = collect._SingletonLock(os.path.join(collect.STATE,
                                               "collector.lock"))
assert _holder.acquire()
check("singleton-second-refuses", collect.main() == 3)
_p = _sp.run(
    [sys.executable, "-c",
     "import sys; sys.path.insert(0, %r); import collect; "
     "collect.STATE = %r; "
     "sys.exit(0 if collect._SingletonLock("
     "collect.STATE + '/collector.lock').acquire() else 1)"
     % (HERE, collect.STATE)], capture_output=True)
check("singleton-cross-process", _p.returncode == 1)
_holder.release()
_p2 = _sp.run(
    [sys.executable, "-c",
     "import sys; sys.path.insert(0, %r); import collect; "
     "collect.STATE = %r; "
     "sys.exit(0 if collect._SingletonLock("
     "collect.STATE + '/collector.lock').acquire() else 1)"
     % (HERE, collect.STATE)], capture_output=True)
check("singleton-reacquire", _p2.returncode == 0)
collect.STATE = _saved_state

# 19. durable-first commit point: parse-failure banks nothing; success
# banks validators/schedule ONLY after the sink; sink failure aborts with
# neither banked (re-fetchable, no 304 masking).
from datetime import datetime as _dt, timezone as _tz
_NOW = _dt(2026, 9, 18, 12, 0, tzinfo=_tz.utc)
collect.CACHE_PATH = os.path.join(TMP, "cache-commit.json")
collect.SCHEDULE_PATH = os.path.join(TMP, "sched-commit.json")
collect.DATA = os.path.join(TMP, "signals-commit")
for _f in (collect.CACHE_PATH, collect.SCHEDULE_PATH):
    if os.path.exists(_f):
        os.remove(_f)
_no_sleep = mock.patch.object(collect.time, "sleep", lambda *a: None)
_bad_validators = {"etag": '"BAD"', "modified": "Thu, 18 Sep 2026"}
collect.fetch = lambda url, key, extra=None: ("ok", b"{nope", {},
                                              _bad_validators)
with _no_sleep:
    _n = collect._poll_source(dict(SRC), {}, _NOW, [])
_cache_after_bad = {}
if os.path.exists(collect.CACHE_PATH):
    _cache_after_bad = json.load(open(collect.CACHE_PATH, encoding="utf-8"))
check("commit-nothing-on-parse-failure",
      _n == 0 and _cache_after_bad.get("t_json") is None)
_good_validators = {"etag": '"GOOD"', "modified": None}
collect.fetch = lambda url, key, extra=None: (
    "ok", payload([{"uid": "u9", "title": "T", "a": "x"}]), {},
    _good_validators)
_sched = {}
with _no_sleep:
    _n = collect._poll_source(dict(SRC), _sched, _NOW, [])
_cache_after_good = json.load(open(collect.CACHE_PATH, encoding="utf-8"))
check("commit-after-sink",
      _n == 1 and _cache_after_good.get("t_json") == _good_validators
      and _sched.get("t_json", {}).get("next_due"))
# sink failure: validators AND schedule stay untouched (loss re-fetchable)
_saved_append = collect.append_records
collect.append_records = lambda recs: (_ for _ in ()).throw(
    OSError("disk full"))
_sched2 = {}
try:
    with _no_sleep:
        collect._poll_source(dict(SRC), _sched2, _NOW, [])
    raised = False
except collect.ConfigError as e:
    raised = "signals-append-failed" in str(e)
finally:
    collect.append_records = _saved_append
_cache_after_fail = json.load(open(collect.CACHE_PATH, encoding="utf-8"))
check("sink-failure-banks-nothing",
      raised and _cache_after_fail.get("t_json") == _good_validators
      and _sched2 == {})
collect.fetch = REAL_FETCH

# 20. narrow exceptions: programming errors propagate, never source-down
collect.CACHE_PATH = os.path.join(TMP, "cache-exc.json")
with mock.patch.object(_ureq, "urlopen", side_effect=TypeError("boom")):
    try:
        collect.fetch("http://x/", "k")
        raised = False
    except TypeError:
        raised = True
check("programming-error-loud", raised)

# 21. records contract is explicit (no assert): non-list fails loudly
_saved_rjs = collect.run_json_source
collect.run_json_source = lambda src: ("ok", "notalist", {}, 0)
try:
    collect._poll_source(dict(SRC), {}, collect.datetime.now(
        collect.timezone.utc), [])
    raised = False
except collect.ConfigError:
    raised = True
finally:
    collect.run_json_source = _saved_rjs
check("records-contract-explicit", raised)

print("ALL COLLECT CHECKS PASS")
