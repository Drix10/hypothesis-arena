"""Download the Kenneth French daily files for Track L (stdlib only).

    python3 ops/long_history_fetch.py [--dir data/long_history] [--force]
        [--industries FILE.zip] [--factors FILE.zip]

Each file is size-checked, verified as a zip that holds a CSV/TXT member, and
written atomically; its sha256, size, URL and fetch time go in manifest.json
next to it. A later run (ops/long_history_run.py) refuses a file whose hash is
not the manifest's. Existing files that match the manifest are not refetched
unless --force. The library is public and static: one polite request per file."""
import argparse
import datetime
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DEFAULT_DIR = os.path.join(ROOT, "data", "long_history")
BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
FILES = {"industries": "49_Industry_Portfolios_daily_CSV.zip",
         "factors": "F-F_Research_Data_Factors_daily_CSV.zip"}
USER_AGENT = "hypothesis-arena-long-history/1.0 (research replication; " \
             "one request per file)"
TIMEOUT_S = 60
MIN_BYTES = 50_000
MAX_BYTES = 100 * 1024 * 1024
TRIES = 3
MANIFEST = "manifest.json"
SCHEMA = "long_history_manifest_v1"


class FetchError(Exception):
    pass


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def check_payload(name, raw):
    """Size and container sanity; raises FetchError."""
    if not (MIN_BYTES <= len(raw) <= MAX_BYTES):
        raise FetchError("%s: size %d outside [%d, %d]"
                         % (name, len(raw), MIN_BYTES, MAX_BYTES))
    if not zipfile.is_zipfile(io.BytesIO(raw)):
        raise FetchError("%s: not a zip (an error page?)" % name)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if z.testzip() is not None:
            raise FetchError("%s: corrupt zip member" % name)
        if not any(i.filename.lower().endswith((".csv", ".txt"))
                   for i in z.infolist() if not i.is_dir()):
            raise FetchError("%s: zip has no csv/txt member" % name)


def download(url, opener=None, sleep=time.sleep, tries=TRIES):
    """Bytes of `url`, retrying transient failures with a short backoff."""
    opener = opener or urllib.request.urlopen
    last = None
    for k in range(tries):
        if k:
            sleep(2.0 * k)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            resp = opener(req, timeout=TIMEOUT_S)
            try:
                raw = resp.read(MAX_BYTES + 1)
            finally:
                close = getattr(resp, "close", None)
                if close:
                    close()
            return raw
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
            if e.code < 500 and e.code != 429:
                break
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = repr(e)
    raise FetchError("%s: %s" % (url, last))


def load_manifest(dirpath):
    path = os.path.join(dirpath, MANIFEST)
    if not os.path.exists(path):
        return {"schema": SCHEMA, "files": {}}
    with open(path) as f:
        m = json.load(f)
    if m.get("schema") != SCHEMA or not isinstance(m.get("files"), dict):
        raise FetchError("manifest malformed")
    return m


def write_manifest(dirpath, manifest):
    path = os.path.join(dirpath, MANIFEST)
    tmp = path + ".part"
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def verify_file(dirpath, name, manifest=None):
    """Manifest entry when the file exists and matches its sha256, else
    FetchError."""
    manifest = manifest or load_manifest(dirpath)
    ent = manifest["files"].get(name)
    path = os.path.join(dirpath, name)
    if ent is None:
        raise FetchError("%s: not in manifest" % name)
    if not os.path.exists(path):
        raise FetchError("%s: missing" % name)
    with open(path, "rb") as f:
        if sha256_bytes(f.read()) != ent["sha256"]:
            raise FetchError("%s: sha256 differs from manifest" % name)
    return ent


def fetch_all(dirpath, names, force=False, opener=None, sleep=time.sleep,
              now=None):
    """Fetch `names` (file names under BASE) into dirpath; returns the
    manifest. Nothing is written for a file that fails its checks."""
    os.makedirs(dirpath, exist_ok=True)
    manifest = load_manifest(dirpath)
    stamp = (now or datetime.datetime.now(datetime.timezone.utc)
             ).strftime("%Y-%m-%dT%H:%M:%SZ")
    for i, name in enumerate(names):
        if not force:
            try:
                verify_file(dirpath, name, manifest)
                continue
            except FetchError:
                pass
        if i:
            sleep(1.0)
        url = BASE + name
        raw = download(url, opener, sleep)
        check_payload(name, raw)
        path = os.path.join(dirpath, name)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(raw)
        os.replace(tmp, path)
        manifest["files"][name] = {"url": url, "sha256": sha256_bytes(raw),
                                   "bytes": len(raw), "fetched_utc": stamp}
        write_manifest(dirpath, manifest)
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default=DEFAULT_DIR)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--industries", default=FILES["industries"])
    ap.add_argument("--factors", default=FILES["factors"])
    a = ap.parse_args(argv)
    try:
        m = fetch_all(a.dir, [a.industries, a.factors], force=a.force)
    except (FetchError, OSError) as e:
        print("fetch failed: %s" % e, file=sys.stderr)
        return 1
    for name in (a.industries, a.factors):
        e = m["files"][name]
        print("%s  %d bytes  sha256 %s" % (name, e["bytes"], e["sha256"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
