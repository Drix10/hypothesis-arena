"""Ken French daily factors: Fama-French 5 plus momentum, from the data library.

Parses the published CSV zips into dated decimal returns (the library
publishes percent). Fails closed on a malformed row, a duplicate or
out-of-order date, a gap above MAX_GAP_DAYS, or momentum missing a factor
date. The manifest records source URL, retrieval time and sha256 per file.
"""
import csv
import datetime
import hashlib
import io
import math
import re
import time
import zipfile

from sources import edgar

BASE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
FF5_URL = BASE_URL + "F-F_Research_Data_5_Factors_2x3_daily_CSV.zip"
MOM_URL = BASE_URL + "F-F_Momentum_Factor_daily_CSV.zip"
FF5_COLUMNS = ("Mkt-RF", "SMB", "HML", "RMW", "CMA", "RF")
MOM_COLUMNS = ("Mom",)

# The longest market closure (September 2001) spans 7 calendar days.
MAX_GAP_DAYS = 7
MAX_UNZIPPED_BYTES = 32 << 20

_DATE_RE = re.compile(r"^\d{8}$")


class FactorError(ValueError):
    pass


def _parse_date(text):
    if not _DATE_RE.match(text):
        raise FactorError("bad date %r" % (text,))
    try:
        return datetime.date(int(text[:4]), int(text[4:6]), int(text[6:]))
    except ValueError:
        raise FactorError("bad date %r" % (text,))


def _read_csv_text(zip_bytes):
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
            names = z.namelist()
            if len(names) != 1:
                raise FactorError("expected one file in zip, got %d"
                                  % len(names))
            if z.getinfo(names[0]).file_size > MAX_UNZIPPED_BYTES:
                raise FactorError("zip member too large")
            return z.read(names[0]).decode("ascii")
    except (zipfile.BadZipFile, UnicodeDecodeError) as e:
        raise FactorError("unreadable zip: %s" % (e,))


def parse_zip(zip_bytes, columns):
    """Return [(iso_date, {column: decimal})] in date order."""
    rows = list(csv.reader(io.StringIO(_read_csv_text(zip_bytes))))
    header = None
    for i, row in enumerate(rows):
        if row and not row[0].strip():
            if tuple(c.strip() for c in row[1:]) == tuple(columns):
                header = i
                break
    if header is None:
        raise FactorError("header %r not found" % (tuple(columns),))
    out = []
    prev = None
    for row in rows[header + 1:]:
        first = row[0].strip() if row else ""
        if not first:
            if out:
                break
            continue
        if out and len(row) == 1 and not first.isdigit():
            break  # trailing footer text
        if len(row) != len(columns) + 1:
            raise FactorError("malformed row %r" % (row,))
        d = _parse_date(first)
        vals = {}
        for name, cell in zip(columns, row[1:]):
            try:
                pct = float(cell)
            except ValueError:
                raise FactorError("malformed value %r on %s" % (cell, first))
            # -99.99 and -999 are the library's missing-value codes.
            if not math.isfinite(pct) or pct <= -99.0:
                raise FactorError("missing value %r on %s" % (cell, first))
            vals[name] = pct / 100.0
        if prev is not None:
            if d == prev:
                raise FactorError("duplicate date %s" % first)
            if d < prev:
                raise FactorError("out-of-order date %s" % first)
            if (d - prev).days > MAX_GAP_DAYS:
                raise FactorError("date gap %s to %s" % (prev, d))
        prev = d
        out.append((d.isoformat(), vals))
    if not out:
        raise FactorError("no data rows")
    return out


def merge(ff5, mom):
    """Join momentum onto every five-factor date; momentum may start earlier."""
    by_date = dict(mom)
    out = []
    for d, vals in ff5:
        if d not in by_date:
            raise FactorError("momentum missing %s" % d)
        out.append((d, dict(vals, **by_date[d])))
    return out


def fetch(contact=None, transport=None, clock=None, timeout_s=60):
    """Download both zips; return (rows, manifest). Needs MIRO_CONTACT."""
    contact = (contact or edgar.contact_from_env()).strip()
    if not contact:
        raise edgar.ConfigError("french_factors: MIRO_CONTACT missing")
    transport = transport or edgar._default_transport
    clock = clock or time.time
    headers = {"User-Agent": "%s contact=%s" % (edgar.UA_BASE, contact)}
    parsed = {}
    files = []
    for url, columns in ((FF5_URL, FF5_COLUMNS), (MOM_URL, MOM_COLUMNS)):
        status, _, body = transport(url, headers, timeout_s)
        if status != 200:
            raise FactorError("HTTP %s for %s" % (status, url))
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock()))
        files.append({"url": url, "retrieved_at": stamp,
                      "sha256": hashlib.sha256(body).hexdigest()})
        parsed[url] = parse_zip(body, columns)
    return merge(parsed[FF5_URL], parsed[MOM_URL]), {"files": files}
