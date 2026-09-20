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
BACKOFF_S = 3600  # persistent 1h rate reduction after a 429 (C10)


def load_schedule():
    try:
        s = json.load(open(SCHEDULE_PATH, encoding="utf-8"))
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


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
    cpath = os.path.join(STATE, "cache.json")
    try:
        cache = json.load(open(cpath))
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
            if e.code in (401, 403):
                return "auth-failure", last_err.encode(), {}
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
    events with identical titles must never collapse into one ID)."""
    uid = it.get("uid") or it.get("link") or ""
    if not uid:
        return None
    title = it.get("title", "")
    body = (it.get("summary") or "")[:2000]
    links = [it["link"]] if it.get("link") else []
    wc = len((title + " " + body).split())
    rid = f"{source}:{hashlib.sha256(uid.encode()).hexdigest()[:16]}"
    return {
        "id": rid,
        "source": source,
        "source_id": uid[:256],
        "url": it.get("link", ""),
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


def run_json_source(src):
    status, body, _ = fetch(src["url"], src["name"])
    if status == "not-modified":
        heartbeat(src["name"], "ok", "not-modified"); return []
    if status != "ok":
        heartbeat(src["name"], {"auth-failure": "AUTH_FAILURE",
                                  "rate-limited": "RATE_LIMITED"}.get(
                                      status, "SOURCE_DOWN"),
                                  body.decode(errors="replace")[:200])
        return status  # caller persists backoff on rate-limited
    try:
        payload = json.loads(body)
    except ValueError as e:
        heartbeat(src["name"], "PARSE_FAILURE", f"bad json: {e}"); return []
    items = payload
    for key in src.get("drill", []):
        items = items.get(key, []) if isinstance(items, dict) else []
    out, skipped = [], 0
    for row in items[: src.get("limit", 50)]:
        if not isinstance(row, dict):
            skipped += 1
            continue
        rec = to_record(src["name"], {
            "uid": str(row.get(src["id_field"], "")),
            "title": str(row.get(src.get("title_field", ""), "")),
            "link": safe_link(src, row),
            "published": str(row.get(src.get("date_field", ""), "")) or None,
            "summary": " ".join(f"{k}={row.get(k)}" for k in src.get("text_fields", [])),
        })
        if rec is None:
            skipped += 1
            continue
        out.append(rec)
    heartbeat(src["name"], "ok" if out else "EMPTY_SUCCESS",
                f"skipped_no_identity={skipped}" if skipped else "", count=len(out))
    return out


def main():
    cfg = load_config()
    if cfg["status"] == "MISSING_REQUIRED_CONFIG":
        print(f"MISSING_REQUIRED_CONFIG: {','.join(cfg['missing_required'])} "
              f"-- set MIRO_CONTACT (see .env.example); refusing to poll", file=sys.stderr)
        return 2
    sources = json.load(open(os.path.join(HERE, "sources.json")))
    sched = load_schedule()
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
            res = run_json_source(src)
            if res == "rate-limited":
                entry["backoff_until"] = \
                    (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
                recs = []
            else:
                recs = res
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
