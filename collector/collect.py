#!/usr/bin/env python3
"""P1.2 non-X collector: EDGAR/Fed/ECB/Treasury/BLS/FRED -> signals.jsonl.

Stdlib only. Sequential polite polls, ETag/Last-Modified cache, jittered
retries, per-source heartbeats. Dedupe/SQLite/tagging is P1.3; soak is P1.4.
Failure defaults per doc 09: errors land in heartbeats, never in signals.
"""
import hashlib
import json
import os
import random
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data", "signals")
STATE = os.path.join(ROOT, "data", "state")
from config import load as load_config

_cfg = load_config()
CONTACT = _cfg["values"].get("MIRO_CONTACT", "")
UA = f"MiroHedge/phase0 contact={CONTACT}"


def req(url, extra_headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(extra_headers or {})
    return urllib.request.Request(url, headers=h)


MAX_BODY = 8 * 1024 * 1024  # hard response cap: reject before parse
SCHEDULE_PATH = os.path.join(STATE, "schedule.json")
CACHE_PATH = os.path.join(STATE, "cache.json")
BACKOFF_S = 3600  # persistent 1h rate reduction after a 429 (C10)
MAX_IDENTITY_LEN = 256  # overlong identities are rejected, never truncated


class ConfigError(Exception):
    pass


def validate_sources_config(raw):
    """Strict parser for sources.json (top-level LIST, not {"sources":...}).
    Raises ConfigError on any shape violation. Shared by collect.py main()
    and soak_check.py so both agree on the configured universe."""
    if not isinstance(raw, list):
        raise ConfigError("sources-top-level-list")
    out = []
    seen = set()
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise ConfigError(f"sources-entry-{i}-not-object")
        for k in ("name", "kind", "url"):
            if not isinstance(s.get(k), str) or not s[k]:
                raise ConfigError(f"sources-entry-{i}-bad-{k}")
        if s["name"] in seen:
            raise ConfigError(f"sources-duplicate-name:{s['name']}")
        seen.add(s["name"])
        if s["kind"] not in ("rss", "atom", "json"):
            raise ConfigError(f"sources-entry-{i}-bad-kind")
        for k in ("poll_min", "limit"):
            if k in s and (isinstance(s[k], bool) or not isinstance(s[k], int)
                            or s[k] < 1):
                raise ConfigError(f"sources-entry-{i}-bad-{k}")
        if "needs_key" in s and not isinstance(s["needs_key"], str):
            raise ConfigError(f"sources-entry-{i}-bad-needs_key")
        if s["kind"] == "json":
            if not isinstance(s.get("id_field"), str) or not s["id_field"]:
                raise ConfigError(f"sources-entry-{i}-bad-id_field")
            for k in ("title_field", "date_field", "link_template"):
                if k in s and not isinstance(s[k], str):
                    raise ConfigError(f"sources-entry-{i}-bad-{k}")
            for k in ("drill", "text_fields"):
                if k in s and (not isinstance(s[k], list)
                                or any(not isinstance(x, str) for x in s[k])):
                    raise ConfigError(f"sources-entry-{i}-bad-{k}")
        out.append(s)
    if not out:
        raise ConfigError("sources-empty")
    return out


def load_sources():
    with open(os.path.join(HERE, "sources.json"), encoding="utf-8") as fh:
        return validate_sources_config(json.load(fh))


def load_schedule():
    """Returns (schedule, ok). A MISSING file is a normal first run.
    A PRESENT-BUT-CORRUPT file is SOURCE_SCHEDULING_UNKNOWN: callers must
    refuse to poll (fail closed), never silently reset every cadence."""
    try:
        with open(SCHEDULE_PATH, encoding="utf-8") as fh:
            raw = fh.read()
    except FileNotFoundError:
        return {}, True
    except OSError:
        return {}, False
    try:
        s = json.loads(raw)
    except ValueError:
        return {}, False
    if not isinstance(s, dict):
        return {}, False
    return s, True


def check_cache_usable():
    """A missing cache is a normal first run. A present-but-corrupt cache
    must not silently degrade ETag/Last-Modified protection: refuse to poll
    until a human repairs or removes it (audited repair)."""
    if not os.path.exists(CACHE_PATH):
        return True
    try:
        with open(CACHE_PATH, encoding="utf-8") as fh:
            c = json.load(fh)
    except (OSError, ValueError):
        return False
    return isinstance(c, dict)


def save_schedule(sched):
    os.makedirs(STATE, exist_ok=True)
    tmp = SCHEDULE_PATH + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(sched, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, SCHEDULE_PATH)


def parse_instant(s):
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo is not None else None


def fetch(url, cache_key, extra_headers=None):
    """GET with ETag/Last-Modified cache + 3 jittered retries. Returns
    (status, body, headers); status in ok | not-modified | auth-failure |
    rate-limited | source-down. HTTP classes mapped once here so every
    source kind reports the same vocabulary."""
    os.makedirs(STATE, exist_ok=True)
    cpath = CACHE_PATH
    try:
        with open(cpath, encoding="utf-8") as fh:
            cache = json.load(fh)
    except (OSError, ValueError):
        cache = {}
    if not isinstance(cache, dict):
        cache = {}
    c = cache.get(cache_key, {})
    if not isinstance(c, dict):
        c = {}
    if c.get("etag"):
        (extra_headers := extra_headers or {})["If-None-Match"] = c["etag"]
    if c.get("modified"):
        (extra_headers := extra_headers or {})["If-Modified-Since"] = c["modified"]
    delay = 15.0
    last_err = "unknown"
    for _ in range(3):
        try:
            with urllib.request.urlopen(req(url, extra_headers), timeout=30) as r:
                body = r.read(MAX_BODY + 1)
                if len(body) > MAX_BODY:
                    return "source-down", b"response over 8MiB cap", {}
                hdrs = dict(r.headers.items())
                cache[cache_key] = {"etag": hdrs.get("ETag"),
                                    "modified": hdrs.get("Last-Modified")}
                tmp = cpath + f".tmp-{os.getpid()}"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(cache, fh)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, cpath)
                return "ok", body, hdrs
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code == 304:
                return "not-modified", b"", {}
            # Non-transient: return IMMEDIATELY, never burn retries/delay
            # on auth failures or dead endpoints.
            if e.code in (401, 403):
                return "auth-failure", last_err.encode(), {}
            if e.code in (400, 404, 405, 410):
                return "source-down", last_err.encode(), {}
            if e.code == 429:
                delay *= 2
        except Exception as e:  # network, DNS, timeout: retry, then heartbeat
            last_err = f"{type(e).__name__}: {e}"
        time.sleep(delay * random.uniform(0.8, 1.2))
    if last_err.startswith("HTTP 429"):
        return "rate-limited", last_err.encode(), {}
    return "source-down", last_err.encode(), {}


def text(el):
    return "".join(el.itertext()).strip() if el is not None else ""


def parse_feed(body):
    """RSS 2.0 or Atom -> list of {uid, title, link, published, summary}."""
    root = ET.fromstring(body)
    tag = root.tag.lower()
    items = []
    if tag.endswith("rss") or root.find("channel") is not None:
        for it in root.iter("item"):
            items.append({
                "uid": text(it.find("guid")) or text(it.find("link")),
                "title": text(it.find("title")),
                "link": text(it.find("link")),
                "published": text(it.find("pubDate")),
                "summary": text(it.find("description")),
            })
    else:  # atom
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for e in root.findall("a:entry", ns):
            link = e.find("a:link", ns)
            items.append({
                "uid": text(e.find("a:id", ns)),
                "title": text(e.find("a:title", ns)),
                "link": link.get("href") if link is not None else "",
                # published ONLY: <updated> is modification time, never an
                # authoritative publication instant (kept as metadata).
                "published": text(e.find("a:published", ns)) or None,
                "updated": text(e.find("a:updated", ns)) or None,
                "summary": text(e.find("a:summary", ns)) or text(e.find("a:content", ns)),
            })
    return items


def to_record(source, it):
    """Feed item -> canonical record, or None when no stable identity
    exists (uid or link required; title fallback removed — two distinct
    events with identical titles must never collapse into one ID).
    Overlong identities are REJECTED (counted upstream as skipped), never
    truncated: silent truncation can collide two distinct events."""
    uid = it.get("uid") or it.get("link") or ""
    if not isinstance(uid, str) or not uid:
        return None
    if len(uid) > MAX_IDENTITY_LEN:
        return None
    title = it.get("title", "")
    if not isinstance(title, str):
        return None
    body = it.get("summary") or ""
    if not isinstance(body, str):
        return None
    body = body[:2000]
    link = it.get("link") or ""
    if not isinstance(link, str):
        return None
    links = [link] if link else []
    wc = len((title + " " + body).split())
    rid = f"{source}:{hashlib.sha256(uid.encode()).hexdigest()[:16]}"
    return {
        "id": rid,
        "source": source,
        "source_id": uid,
        "url": link,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "published_at": it.get("published") or None,
        "published_estimated": not bool(it.get("published")),
        "updated_at": it.get("updated") or None,
        "title": title[:500],
        "text": body,
        "links": links,
        "word_count": wc,
        "has_external_link": bool(links),
    }


def heartbeat(name, status, detail="", count=0):
    """Source-status vocabulary (doc 09 source_status, P1.3 invariant #7):
    ok | EMPTY_SUCCESS | SKIPPED_CONFIG | SOURCE_DOWN | AUTH_FAILURE |
    RATE_LIMITED | PARSE_FAILURE | STALE. SKIPPED_CONFIG (FRED, no key) is a
    config state, never data absence: it must not become features_absent."""
    os.makedirs(STATE, exist_ok=True)
    tmp = os.path.join(STATE, f"{name}.heartbeat.json.tmp-{os.getpid()}")
    dest = os.path.join(STATE, f"{name}.heartbeat.json")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({
            "source": name, "status": status, "detail": detail[:300],
            "items": count, "at": datetime.now(timezone.utc).isoformat(),
        }, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, dest)


def append_records(records):
    os.makedirs(DATA, exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = os.path.join(DATA, f"{day}.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return path


def safe_link(src, row):
    """link_template.format() must never crash the poll: unknown
    placeholders degrade to an empty link (identity then falls back to uid
    or the row is skipped), never KeyError."""
    try:
        return src.get("link_template", "").format(
            **{k: row.get(k, "") for k in row})
    except (KeyError, IndexError, ValueError):
        return ""


def _req_str(row, key):
    """Required string field: nonempty str, else None (row skipped).
    Never str(None)/str(42): a malformed upstream schema must not become a
    seemingly valid identity."""
    v = row.get(key)
    if not isinstance(v, str) or not v:
        return None
    return v


def _opt_str(row, key):
    """Optional string field: absent/None/empty -> None; wrong type ->
    INVALID (row skipped), never coerced."""
    v = row.get(key)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, str):
        return False  # INVALID sentinel (None means legitimately absent)
    return v or None


def _summary_text(row, keys):
    """Summary from scalar values only. Dicts/lists are dropped, never
    stringified into canonical text."""
    parts = []
    for k in keys:
        v = row.get(k)
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (str, int, float)):
            continue
        parts.append(f"{k}={v}")
    return " ".join(parts)


def run_json_source(src):
    """Returns (status, records-list). The tuple is structural: main() can
    NEVER mistake a status string for records (a bare string return used to
    be iterated char-by-char into the event stream). Only a list reaches
    append_records()."""
    status, body, _ = fetch(src["url"], src["name"])
    if status == "not-modified":
        heartbeat(src["name"], "ok", "not-modified")
        return "not-modified", []
    if status != "ok":
        heartbeat(src["name"], {"auth-failure": "AUTH_FAILURE",
                                  "rate-limited": "RATE_LIMITED"}.get(
                                      status, "SOURCE_DOWN"),
                                  body.decode(errors="replace")[:200])
        return status, []  # caller persists backoff on rate-limited
    try:
        payload = json.loads(body)
    except ValueError as e:
        heartbeat(src["name"], "PARSE_FAILURE", f"bad json: {e}")
        return "parse-failure", []
    items = payload
    for key in src.get("drill", []):
        items = items.get(key, []) if isinstance(items, dict) else []
    if not isinstance(items, list):
        heartbeat(src["name"], "PARSE_FAILURE",
                  "drilled payload not a list")
        return "parse-failure", []
    out, skipped = [], 0
    for row in items[: src.get("limit", 50)]:
        if not isinstance(row, dict):
            skipped += 1
            continue
        uid = _req_str(row, src["id_field"])
        title = _opt_str(row, src.get("title_field", ""))
        pub = _opt_str(row, src.get("date_field", ""))
        if uid is None or title is False or pub is False:
            skipped += 1
            continue
        rec = to_record(src["name"], {
            "uid": uid,
            "title": title or "",
            "link": safe_link(src, row),
            "published": pub,
            "summary": _summary_text(row, src.get("text_fields", [])),
        })
        if rec is None:
            skipped += 1
            continue
        out.append(rec)
    heartbeat(src["name"], "ok" if out else "EMPTY_SUCCESS",
                f"skipped_no_identity={skipped}" if skipped else "", count=len(out))
    return "ok", out


def main():
    cfg = load_config()
    if cfg["status"] == "MISSING_REQUIRED_CONFIG":
        print(f"MISSING_REQUIRED_CONFIG: {','.join(cfg['missing_required'])} "
              f"-- set MIRO_CONTACT (see .env.example); refusing to poll", file=sys.stderr)
        return 2
    try:
        sources = load_sources()
    except (OSError, ValueError, ConfigError) as e:
        print(f"SOURCES_CONFIG_INVALID: {e} -- refusing to poll",
              file=sys.stderr)
        return 2
    sched, sched_ok = load_schedule()
    if not sched_ok:
        print("SOURCE_SCHEDULING_UNKNOWN: corrupt schedule.json -- "
              "refusing to poll; repair or remove after audit",
              file=sys.stderr)
        return 2
    if not check_cache_usable():
        print("CACHE_CORRUPT: state/cache.json present but invalid -- "
              "refusing to poll; repair or remove after audit",
              file=sys.stderr)
        return 2
    now = datetime.now(timezone.utc)
    total = 0
    for src in sources:
        name = src["name"]
        if src.get("needs_key") and not os.environ.get(src["needs_key"]):
            heartbeat(name, "SKIPPED_CONFIG", f"needs {src['needs_key']} (build-time)")
            continue
        # C9/C10: persisted per-source cadence + 1h 429 backoff.
        entry = sched.get(name, {})
        if not isinstance(entry, dict):
            entry = {}
        backoff_until = parse_instant(entry.get("backoff_until"))
        if backoff_until and backoff_until > now:
            heartbeat(name, "RATE_LIMITED",
                        f"backoff until {entry['backoff_until']}")
            continue
        next_due = parse_instant(entry.get("next_due"))
        if next_due and next_due > now:
            heartbeat(name, "ok",
                        f"cadence-skip next_due={entry['next_due']}")
            continue
        if src["kind"] in ("rss", "atom"):
            status, body, _ = fetch(src["url"], name)
            if status == "not-modified":
                heartbeat(name, "ok", "not-modified")
            elif status != "ok":
                msg = body.decode(errors="replace")[:200]
                heartbeat(name, {"auth-failure": "AUTH_FAILURE",
                                 "rate-limited": "RATE_LIMITED"}.get(
                                     status, "SOURCE_DOWN"), msg)
                if status == "rate-limited":
                    entry["backoff_until"] = \
                        (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            else:
                try:
                    items = [r for r in (to_record(name, it) for it in
                                        parse_feed(body)[: src.get("limit", 50)])
                             if r is not None]
                except ET.ParseError as e:
                    heartbeat(name, "PARSE_FAILURE", f"bad xml: {e}")
                    items = None
                if items is not None:
                    heartbeat(name, "ok" if items else "EMPTY_SUCCESS",
                                count=len(items))
                    recs = items
                else:
                    recs = []
        elif src["kind"] == "json":
            status, recs = run_json_source(src)
            if status == "rate-limited":
                entry["backoff_until"] = \
                    (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
                recs = []
            assert isinstance(recs, list), "contract: records only"
        else:
            heartbeat(name, "PARSE_FAILURE", f"unknown kind {src['kind']}"); continue
        entry["next_due"] = (datetime.now(timezone.utc) +
                               timedelta(minutes=src.get("poll_min", 15))).isoformat()
        bu = parse_instant(entry.get("backoff_until"))
        if bu and bu <= datetime.now(timezone.utc):
            entry.pop("backoff_until", None)
        sched[name] = entry
        save_schedule(sched)
        if recs:
            path = append_records(recs)
            print(f"{name}: {len(recs)} records -> {path}")
        total += len(recs)
        time.sleep(2)  # polite gap between sources
    print(f"total: {total} records")


if __name__ == "__main__":
    sys.exit(main())
