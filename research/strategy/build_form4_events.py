"""Human-run build of research/data/form4_events.json from SEC's quarterly
insider-transaction sets, 2016 to date (plan/data.md, plan/math.md). Downloads
missing quarters (SEC contact from MIRO_CONTACT, paced), skips zips already on
disk, and writes the dataset when every quarter is present. Only 404s on the
trailing quarters count as not yet published: the dataset is written through
the last present quarter. Any other gap or failure writes nothing.

--fill-from-filings extends the dataset past the last zip: the trailing
quarters the zips lack, through the quarter in progress, are built from the
individual Form 4 filings of the universe_symbols.txt issuers, listed from the
EDGAR quarterly form.idx and fetched as complete submission texts into
--xml-dir (a rerun skips files present; the quarter in progress re-reads its
index). Rows, classification and accepted/entry rule are those of the zip path,
and the dataset runs through the last filing date the indexes cover. Any fetch
error, a quarter without Form 4 rows or a malformed-filing rate above
MAX_PARSE_FAIL_RATE writes nothing; a 404 on a trailing quarter's index only
shortens the coverage."""
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

from research.sources import edgar_filings
from research.strategy import (build_filing_scores, customer_coverage_probe,
                               form4)

URL = ("https://www.sec.gov/files/structureddata/data/"
       "insider-transactions-data-sets/%dq%d_form345.zip")
UA_BASE = "MiroHedge/phase0"
FIRST_YEAR = 2016
INTERVAL_S = 2.0
TIMEOUT_S = 120
CHUNK = 1 << 20
OUT_NAME = "form4_events.json"
MAX_PARSE_FAIL_RATE = 0.01  # malformed filings over all fetched


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
    """Fetch one quarter to zdir through a .part file; None when stored, else
    the HTTP status or error text."""
    path = os.path.join(zdir, zip_name(y, q))
    part = path + ".part"
    sleep(INTERVAL_S)
    try:
        status, r = opener(URL % (y, q), {"User-Agent": ua}, TIMEOUT_S)
    except OSError as e:
        return "error: %s" % e
    if status != 200:
        return "HTTP %d" % status
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
    return None


def _next(y, q):
    return (y + (q == 4), q % 4 + 1)


def parse_index(text):
    """Form 4 filings from an EDGAR form.idx body: [{cik, accession, date}].
    The name holds spaces, so the three trailing fields are split off the
    right. 4/A amendments are not listed, as in the quarterly sets."""
    out = []
    for line in text.splitlines():
        if not line.startswith("4 "):
            continue
        parts = line[2:].rsplit(None, 3)
        if len(parts) != 4 or not parts[1].isdigit():
            continue
        try:
            day = datetime.date.fromisoformat(parts[2])
        except ValueError:
            continue
        out.append({"cik": int(parts[1]), "date": day,
                    "accession": parts[3].rsplit("/", 1)[-1]
                    .removesuffix(".txt")})
    return out


def _index(fetcher, y, q, today):
    """form.idx text of one quarter; a quarter that has ended is kept on disk."""
    path = os.path.join(fetcher.out_dir, "%dQTR%d.form.idx" % (y, q))
    if _quarter_end(y, q) < today and os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    body = fetcher._get(customer_coverage_probe.INDEX_URL.format(y, q))
    os.makedirs(fetcher.out_dir, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(body)
    os.replace(tmp, path)
    return body.decode("utf-8", errors="replace")


def _filing_text(fetcher, f):
    """(text, fetched) of one filing's submission text, from disk when present."""
    doc = f["accession"] + ".txt"
    path = os.path.join(fetcher.out_dir, "%010d" % f["cik"], f["accession"],
                        doc)
    fetched = not os.path.exists(path)
    if fetched:
        fetcher.fetch({"cik": f["cik"], "accession": f["accession"],
                       "form": "4", "filing_date": f["date"].isoformat(),
                       "accepted_datetime": "", "primary_document": doc})
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read(), fetched


def fill_rows(gaps, xml_dir, ciks, contact, today, transport, sleep, log):
    """(rows, through) for the gap quarters, built from the issuers' own Form 4
    filings; through is the last filing date the indexes cover, None when the
    first gap quarter has no index yet."""
    try:
        fetcher = edgar_filings.Fetcher(contact, xml_dir, transport=transport,
                                        sleep=sleep)
    except edgar_filings.FilingError as e:
        raise BuildError(str(e)) from None
    rows, through, total, bad = [], None, 0, 0
    for y, q in gaps:
        try:
            listed = parse_index(_index(fetcher, y, q, today))
        except edgar_filings.FilingError as e:
            if not str(e).startswith("HTTP 404"):
                raise BuildError("%dq%d index: %s" % (y, q, e)) from None
            log("%dq%d: index not published" % (y, q))
            break
        if not listed:
            raise BuildError("%dq%d index lists no Form 4 filings" % (y, q))
        mine = {f["accession"]: f for f in listed if f["cik"] in ciks}
        n = fresh = badq = 0
        for f in sorted(mine.values(), key=lambda f: f["accession"]):
            try:
                text, fetched = _filing_text(fetcher, f)
            except (edgar_filings.FilingError, OSError) as e:
                raise BuildError("%s: %s" % (f["accession"], e)) from None
            fresh += fetched
            try:
                got = form4.read_filing(text, f["date"])
            except ValueError:
                badq += 1
                continue
            got = [r for r in got if int(r["cik"]) in ciks]
            n += len(got)
            rows += got
        total += len(mine)
        bad += badq
        through = max([f["date"] for f in listed]
                      + [through or datetime.date.min])
        log("%dq%d: %d filings of the universe (%d fetched, %d cached), "
            "%d malformed, %d rows; index through %s"
            % (y, q, len(mine), fresh, len(mine) - fresh, badq, n,
               through.isoformat()))
    if total and bad > MAX_PARSE_FAIL_RATE * total:
        raise BuildError("%d of %d filings malformed: over the %.1f%% ceiling"
                         % (bad, total, 100 * MAX_PARSE_FAIL_RATE))
    return rows, through


def build(zdir, out, first_year=FIRST_YEAR, contact="", today=None,
          opener=None, sleep=time.sleep, log=print, xml_dir=None, ciks=None,
          transport=None):
    """0 when written; 1 when a quarter is missing for any reason but a 404 on
    the trailing quarters (nothing written). With xml_dir and ciks the trailing
    quarters the zips lack are built from the issuers' filings."""
    today = today or datetime.date.today()
    qs = quarters(first_year, today)
    have = lambda yq: os.path.exists(os.path.join(zdir, zip_name(*yq)))
    todo = [yq for yq in qs if not have(yq)]
    failed = {}
    if todo:
        if not contact.strip():
            raise BuildError("MIRO_CONTACT missing: refusing to fetch "
                             "without SEC fair-access contact")
        os.makedirs(zdir, exist_ok=True)
        ua = "%s contact=%s" % (UA_BASE, contact.strip())
        for y, q in todo:
            err = download(y, q, zdir, ua, opener or _open, sleep)
            if err:
                failed[(y, q)] = err
                log("%dq%d: %s" % (y, q, err))
    if failed:
        log("missing quarters: " + " ".join("%dq%d" % yq for yq in failed))
        keep = qs[:len(qs) - len(failed)]
        if (not keep or any(yq not in failed for yq in qs[len(keep):])
                or set(failed.values()) != {"HTTP 404"}):
            return 1
        log("warning: quarters not yet published: %s; dataset through %s"
            % (" ".join("%dq%d" % yq for yq in failed),
               _quarter_end(*keep[-1]).isoformat()))
        qs = keep
    rows = []
    for y, q in qs:
        rows += form4.read_quarter(os.path.join(zdir, zip_name(y, q)))
    through = _quarter_end(*qs[-1])
    if xml_dir:
        gaps, yq = [], _next(*qs[-1])
        while yq <= (today.year, (today.month - 1) // 3 + 1):
            gaps.append(yq)
            yq = _next(*yq)
        extra, last = fill_rows(gaps, xml_dir, ciks, contact, today,
                                transport, sleep, log)
        rows += extra
        through = max(through, last or through)
    events = form4.build_events(rows)
    through = through.isoformat()
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"through": through, "data": events}, f)
    os.replace(tmp, out)
    log("wrote %d events through %s" % (len(events), through))
    return 0


def universe_ciks(data_dir):
    """Ciks of the universe_symbols.txt issuers, mapped through reference.json.
    The symbols file is required: without it the filter would pass everyone."""
    if not os.path.exists(os.path.join(data_dir, "universe_symbols.txt")):
        raise BuildError("universe_symbols.txt missing in %s" % data_dir)
    try:
        by_symbol = build_filing_scores.read_universe(data_dir)
    except edgar_filings.FilingError as e:
        raise BuildError(str(e)) from None
    ciks = {c for cs in by_symbol.values() for c in cs}
    if not ciks:
        raise BuildError("universe_symbols.txt maps to no reference.json cik")
    return ciks


def main(argv=None, env=None, **kw):
    data = os.path.join(os.path.dirname(__file__), "..", "data")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zips", default=os.path.join(data, "form4_zips"))
    ap.add_argument("--out", default=os.path.join(data, OUT_NAME))
    ap.add_argument("--start-year", type=int, default=FIRST_YEAR)
    ap.add_argument("--fill-from-filings", action="store_true",
                    help="build the quarters the zips lack from Form 4 filings")
    ap.add_argument("--xml-dir", default=os.path.join(data, "form4_xml"))
    ap.add_argument("--data", default=data,
                    help="holds reference.json and universe_symbols.txt")
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    try:
        if a.fill_from_filings:
            kw["xml_dir"] = a.xml_dir
            kw["ciks"] = universe_ciks(a.data)
        return build(a.zips, a.out, a.start_year,
                     env.get("MIRO_CONTACT", ""), **kw)
    except (BuildError, OSError, ValueError, KeyError,
            zipfile.BadZipFile) as e:
        print("form4 build failed: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
