"""Resumable download of SEC Financial Statement Data Sets and the SEC
company-ticker map into data/fsds/. Quarters already present are skipped."""
import datetime
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
OUT = os.path.join(ROOT, "data", "fsds")
URL = "https://www.sec.gov/files/dera/data/financial-statement-data-sets/{}q{}.zip"
TICKERS = "https://www.sec.gov/files/company_tickers.json"
FIRST_YEAR = 2014


def user_agent():
    from collector.config import load
    contact = load()["values"].get("MIRO_CONTACT")
    if not contact:
        raise RuntimeError("MISSING_REQUIRED_CONFIG:MIRO_CONTACT")
    return f"MiroHedge/research contact={contact}"


def quarters(today=None):
    today = today or datetime.date.today()
    for y in range(FIRST_YEAR, today.year + 1):
        for q in range(1, 5):
            if datetime.date(y, 3 * q - 2, 1) <= today:
                yield y, q


def _get(url, ua, dest):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        want = int(r.headers.get("Content-Length") or -1)
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if want >= 0 and os.path.getsize(tmp) != want:
        raise urllib.error.URLError("short-read")
    os.replace(tmp, dest)


def _valid(path):
    try:
        with zipfile.ZipFile(path) as z:
            return z.testzip() is None and "num.txt" in z.namelist()
    except (OSError, zipfile.BadZipFile):
        return False


def fetch_all(log=print):
    """Returns (present, missing) lists of 'YYYYqQ' names."""
    os.makedirs(OUT, exist_ok=True)
    ua = user_agent()
    present, missing = [], []
    for y, q in quarters():
        name = f"{y}q{q}"
        dest = os.path.join(OUT, name + ".zip")
        if not os.path.exists(dest) or not _valid(dest):
            for attempt in range(4):
                try:
                    _get(URL.format(y, q), ua, dest)
                    if _valid(dest):
                        break
                except (urllib.error.URLError, OSError) as e:
                    log(f"{name} attempt {attempt}: {getattr(e, 'code', e)}")
                    if getattr(e, "code", None) == 404:
                        break
                time.sleep(2 * (attempt + 1))
            if not os.path.exists(dest) or not _valid(dest):
                if os.path.exists(dest):
                    os.remove(dest)
                missing.append(name)
                continue
        present.append(name)
    dest = os.path.join(OUT, "company_tickers.json")
    if not os.path.exists(dest):
        _get(TICKERS, ua, dest)
    return present, missing


if __name__ == "__main__":
    p, m = fetch_all(lambda s: print(s, flush=True))
    print("present", len(p), "missing", m)
