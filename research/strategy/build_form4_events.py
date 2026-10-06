"""Human-run build of research/data/form4_events.json from SEC's quarterly
insider-transaction sets, 2016 to date (plan/data.md, plan/math.md). Downloads
missing quarters (SEC contact from MIRO_CONTACT, paced), skips zips already on
disk, and writes the dataset only when every quarter is present."""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import form4

URL = ("https://www.sec.gov/files/structureddata/data/"
       "insider-transactions-data-sets/%dq%d_form345.zip")
UA_BASE = "MiroHedge/phase0"
FIRST_YEAR = 2016
INTERVAL_S = 2.0
TIMEOUT_S = 120
CHUNK = 1 << 20
OUT_NAME = "form4_events.json"


class BuildError(Exception):
    pass


def quarters(first_year, today):
    """(year, quarter) pairs from first_year through the last quarter that has
    ended; the quarter in progress is not yet published."""
    out = []
    for y in range(first_year, today.year + 1):
        for q in range(1, 5):
            if _quarter_end(y, q) < today:
                out.append((y, q))
    return out


def _quarter_end(y, q):
    m = 3 * q
    nxt = datetime.date(y + (m == 12), m % 12 + 1, 1)
    return nxt - datetime.timedelta(days=1)


def zip_name(y, q):
    return "%dq%d_form345.zip" % (y, q)


def _open(url, headers, timeout_s):
    """(status, readable); non-2xx is a status, transport failures raise."""
    req = urllib.request.Request(url, headers=headers)
    try:
        return 200, urllib.request.urlopen(req, timeout=timeout_s)
    except urllib.error.HTTPError as e:
        return e.code, None


def download(y, q, zdir, ua, opener, sleep):
    """Fetch one quarter to zdir through a .part file; True when stored."""
    path = os.path.join(zdir, zip_name(y, q))
    part = path + ".part"
    sleep(INTERVAL_S)
    status, r = opener(URL % (y, q), {"User-Agent": ua}, TIMEOUT_S)
    if status != 200:
        return False
    try:
        with open(part, "wb") as f:
            while True:
                b = r.read(CHUNK)
                if not b:
                    break
                f.write(b)
    finally:
        r.close()
    os.replace(part, path)
    return True


def build(zdir, out, first_year=FIRST_YEAR, contact="", today=None,
          opener=None, sleep=time.sleep, log=print):
    """0 when written; 1 when a quarter is missing (nothing written)."""
    today = today or datetime.date.today()
    qs = quarters(first_year, today)
    have = lambda yq: os.path.exists(os.path.join(zdir, zip_name(*yq)))
    todo = [yq for yq in qs if not have(yq)]
    missing = []
    if todo:
        if not contact.strip():
            raise BuildError("MIRO_CONTACT missing: refusing to fetch "
                             "without SEC fair-access contact")
        os.makedirs(zdir, exist_ok=True)
        ua = "%s contact=%s" % (UA_BASE, contact.strip())
        for y, q in todo:
            if not download(y, q, zdir, ua, opener or _open, sleep):
                missing.append("%dq%d" % (y, q))
    if missing:
        log("missing quarters: " + " ".join(missing))
        return 1
    rows = []
    for y, q in qs:
        rows += form4.read_quarter(os.path.join(zdir, zip_name(y, q)))
    events = form4.build_events(rows)
    through = _quarter_end(*qs[-1]).isoformat()
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"through": through, "data": events}, f)
    os.replace(tmp, out)
    log("wrote %d events through %s" % (len(events), through))
    return 0


def main(argv=None, env=None, **kw):
    data = os.path.join(os.path.dirname(__file__), "..", "data")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zips", default=os.path.join(data, "form4_zips"))
    ap.add_argument("--out", default=os.path.join(data, OUT_NAME))
    ap.add_argument("--start-year", type=int, default=FIRST_YEAR)
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    try:
        return build(a.zips, a.out, a.start_year,
                     env.get("MIRO_CONTACT", ""), **kw)
    except (BuildError, OSError, ValueError, KeyError,
            zipfile.BadZipFile) as e:
        print("form4 build failed: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
