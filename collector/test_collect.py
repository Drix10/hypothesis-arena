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
    collect.fetch = lambda url, key, extra=None: (status, body or b"", {})
    return collect.run_json_source(dict(SRC))


def payload(rows):
    return json.dumps({"data": rows}).encode()


# 1. 200 valid -> records appended (list, all dicts)
st, recs = run_with(payload([{"uid": "u1", "title": "T",
                              "pub": "2026-09-18T00:00:00+00:00", "a": "x"}]))
check("json-200", st == "ok" and isinstance(recs, list) and len(recs) == 1
      and isinstance(recs[0], dict) and recs[0]["source_id"] == "u1")

# 2-6. every failure mode -> (status, []) and NEVER a bare string
for status, name in [("not-modified", "json-304"),
                     ("auth-failure", "json-401"),
                     ("rate-limited", "json-429"),
                     ("source-down", "json-timeout")]:
    st, recs = run_with(b"", status)
    check(name, st == status and recs == [])
    check(name + "-not-string", isinstance(recs, list))

# 7. malformed JSON -> parse-failure, nothing appended
st, recs = run_with(b"{nope", "ok")
check("json-malformed", st == "parse-failure" and recs == [])

# 8. drilled payload not a list -> parse-failure
st, recs = run_with(json.dumps({"data": {"x": 1}}).encode(), "ok")
check("json-drill-not-list", st == "parse-failure" and recs == [])

# 9. non-string identity/date/title -> row skipped, never coerced
rows = [{"uid": 42, "title": "T"},                       # int id
        {"uid": None, "title": "T"},                     # null id
        {"uid": "u2", "title": 5},                       # int title
        {"uid": "u3", "title": "T", "pub": 12345},       # int date
        {"uid": "u" * 300, "title": "T"},                # overlong id
        {"uid": "u4", "title": "T", "a": {"nested": 1}}]  # dict summary val
st, recs = run_with(payload(rows))
check("no-coercion", st == "ok" and len(recs) == 1
      and recs[0]["source_id"] == "u4"
      and "{'nested': 1}" not in recs[0]["text"]
      and "a=" not in recs[0]["text"])

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
        st, body, _ = collect.fetch("http://x/", "k")
    check(f"fetch-{code}-immediate", st == want and len(calls) == attempts)

# 429 retries then succeeds
calls.clear()
with mock.patch.object(_ureq, "urlopen", boom_once_then_ok(429)):
    with mock.patch.object(collect.time, "sleep", lambda *a: None):
        st, body, _ = collect.fetch("http://x/", "k")
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

print("ALL COLLECT CHECKS PASS")
