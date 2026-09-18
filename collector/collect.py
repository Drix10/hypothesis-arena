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
from datetime import datetime, timezone

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


def fetch(url, cache_key, extra_headers=None):
    """GET with ETag/Last-Modified cache + 3 jittered retries. Returns
    (status, body, headers) where status is ok / not-modified / error."""
    os.makedirs(STATE, exist_ok=True)
    cpath = os.path.join(STATE, "cache.json")
    try:
        cache = json.load(open(cpath))
    except (OSError, ValueError):
        cache = {}
    c = cache.get(cache_key, {})
    if c.get("etag"):
        (extra_headers := extra_headers or {})["If-None-Match"] = c["etag"]
    if c.get("modified"):
        (extra_headers := extra_headers or {})["If-Modified-Since"] = c["modified"]
    delay = 15.0
    last_err = "unknown"
    for _ in range(3):
        try:
            with urllib.request.urlopen(req(url, extra_headers), timeout=30) as r:
                body = r.read()
                hdrs = dict(r.headers.items())
                cache[cache_key] = {"etag": hdrs.get("ETag"), "modified": hdrs.get("Last-Modified")}
                json.dump(cache, open(cpath, "w"))
                return "ok", body, hdrs
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code == 304:
                return "not-modified", b"", {}
            if e.code == 429:
                delay *= 2  # halves this source's effective rate
        except Exception as e:  # network, DNS, timeout: retry, then heartbeat
            last_err = f"{type(e).__name__}: {e}"
        time.sleep(delay * random.uniform(0.8, 1.2))
    return "error", last_err.encode(), {}


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
                "published": text(e.find("a:published", ns)) or text(e.find("a:updated", ns)),
                "summary": text(e.find("a:summary", ns)) or text(e.find("a:content", ns)),
            })
    return items


def to_record(source, it):
    uid = it.get("uid") or it.get("link") or it.get("title", "")
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
    json.dump({
        "source": name, "status": status, "detail": detail[:300],
        "items": count, "at": datetime.now(timezone.utc).isoformat(),
    }, open(os.path.join(STATE, f"{name}.heartbeat.json"), "w"))


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


def run_json_source(src):
    status, body, _ = fetch(src["url"], src["name"])
    if status == "not-modified":
        heartbeat(src["name"], "ok", "not-modified"); return []
    if status == "error":
        heartbeat(src["name"], "SOURCE_DOWN", body.decode()[:200]); return []
    try:
        payload = json.loads(body)
    except ValueError as e:
        heartbeat(src["name"], "PARSE_FAILURE", f"bad json: {e}"); return []
    items = payload
    for key in src.get("drill", []):
        items = items.get(key, []) if isinstance(items, dict) else []
    out = []
    for row in items[: src.get("limit", 50)]:
        if not isinstance(row, dict):
            continue
        out.append(to_record(src["name"], {
            "uid": str(row.get(src["id_field"], "")),
            "title": str(row.get(src.get("title_field", ""), "")),
            "link": src.get("link_template", "").format(**{k: row.get(k, "") for k in row}),
            "published": str(row.get(src.get("date_field", ""), "")) or None,
            "summary": " ".join(f"{k}={row.get(k)}" for k in src.get("text_fields", [])),
        }))
    heartbeat(src["name"], "ok", count=len(out))
    return out


def main():
    cfg = load_config()
    if cfg["status"] == "MISSING_REQUIRED_CONFIG":
        print(f"MISSING_REQUIRED_CONFIG: {','.join(cfg['missing_required'])} "
              f"-- see config/README.md; refusing to poll", file=sys.stderr)
        return 2
    sources = json.load(open(os.path.join(HERE, "sources.json")))
    total = 0
    for src in sources:
        if src.get("needs_key") and not os.environ.get(src["needs_key"]):
            heartbeat(src["name"], "SKIPPED_CONFIG", f"needs {src['needs_key']} (build-time)")
            continue
        if src["kind"] in ("rss", "atom"):
            status, body, _ = fetch(src["url"], src["name"])
            if status == "not-modified":
                heartbeat(src["name"], "ok", "not-modified"); continue
            if status == "error":
                msg = body.decode()[:200]
                code = msg.split()[1] if msg.startswith("HTTP") else ""
                if code == "403":
                    heartbeat(src["name"], "AUTH_FAILURE", msg)
                elif code == "429":
                    heartbeat(src["name"], "RATE_LIMITED", msg)
                else:
                    heartbeat(src["name"], "SOURCE_DOWN", msg)
                continue
            try:
                recs = [to_record(src["name"], it) for it in parse_feed(body)[: src.get("limit", 50)]]
            except ET.ParseError as e:
                heartbeat(src["name"], "PARSE_FAILURE", f"bad xml: {e}"); continue
            heartbeat(src["name"], "ok" if recs else "EMPTY_SUCCESS", count=len(recs))
        elif src["kind"] == "json":
            recs = run_json_source(src)
        else:
            heartbeat(src["name"], "error", f"unknown kind {src['kind']}"); continue
        if recs:
            path = append_records(recs)
            print(f"{src['name']}: {len(recs)} records -> {path}")
        total += len(recs)
        time.sleep(2)  # polite gap between sources
    print(f"total: {total} records")


if __name__ == "__main__":
    sys.exit(main())
