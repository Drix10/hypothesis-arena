"""Bitemporal link-graph store (plan/engine.md, link graph): append-only,
hash-chained JSONL of firm-to-firm edges. A caller-given path or in-memory
list of lines is the only storage; times are integers in one caller-chosen unit."""
import hashlib
import json
import math
import os

GENESIS = "0" * 64
SOURCES = ("supply_chain", "text_peer", "news", "ownership", "learned")
TYPES = ("customer", "supplier", "competitor", "partner", "licensor",
         "text_peer", "co_mention", "common_owner", "learned")
CONTAMINATION = ("deterministic", "extraction", "judgment")
EDGE_FIELDS = ("edge_id", "src_cik", "dst_cik", "source", "type", "weight",
               "valid_from", "valid_to", "known_at", "evidence_ids",
               "extractor", "contamination_class")
_HEX = set("0123456789abcdef")


class LinkStoreError(Exception):
    pass


def _canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def _digest(row):
    body = {k: v for k, v in row.items() if k != "digest"}
    return hashlib.sha256(_canon(body)).hexdigest()


def _is_hex64(s):
    return isinstance(s, str) and len(s) == 64 and set(s) <= _HEX


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _text(v):
    return isinstance(v, str) and bool(v)


def _validate(e):
    missing = [k for k in EDGE_FIELDS if k not in e]
    extra = [k for k in e if k not in EDGE_FIELDS]
    if missing or extra:
        raise LinkStoreError("edge-fields:missing=%s extra=%s"
                             % (missing, extra))
    for k in ("edge_id", "src_cik", "dst_cik"):
        if not _text(e[k]):
            raise LinkStoreError("edge-field-type:" + k)
    if e["source"] not in SOURCES:
        raise LinkStoreError("edge-source")
    if e["type"] not in TYPES:
        raise LinkStoreError("edge-type")
    w = e["weight"]
    if isinstance(w, bool) or not isinstance(w, (int, float)) \
            or not math.isfinite(w):
        raise LinkStoreError("edge-weight")
    if not _is_int(e["valid_from"]) or not _is_int(e["known_at"]):
        raise LinkStoreError("edge-time")
    if e["valid_to"] is not None and (not _is_int(e["valid_to"])
                                      or e["valid_to"] <= e["valid_from"]):
        raise LinkStoreError("edge-valid-window")
    ev = e["evidence_ids"]
    if not isinstance(ev, list) or not ev or not all(_text(x) for x in ev):
        raise LinkStoreError("edge-evidence-missing")
    x = e["extractor"]
    if not (x == "deterministic"
            or (_text(x) and x.startswith("reader:") and len(x) > 7)):
        raise LinkStoreError("edge-extractor")
    if e["contamination_class"] not in CONTAMINATION:
        raise LinkStoreError("edge-contamination-class")


class LinkStore:
    def __init__(self, storage):
        """`storage` is a file path (str) or a list of JSON lines (str)."""
        if isinstance(storage, str):
            self.path, self._lines = storage, None
        elif isinstance(storage, list):
            self.path, self._lines = None, storage
        else:
            raise LinkStoreError("storage-type")

    def _read(self):
        if self._lines is not None:
            return [ln.encode("utf-8") for ln in self._lines]
        if not os.path.exists(self.path):
            return []
        with open(self.path, "rb") as fh:
            data = fh.read()
        if data and not data.endswith(b"\n"):
            raise LinkStoreError("store-torn-tail")
        return data.split(b"\n")[:-1] if data else []

    def rows(self):
        """Verified rows; raises LinkStoreError on any structural break."""
        out, prev = [], GENESIS
        for i, line in enumerate(self._read()):
            try:
                row = json.loads(line.decode("utf-8"))
            except ValueError:
                raise LinkStoreError("store-malformed-row:%d" % i)
            if not isinstance(row, dict) or row.get("seq") != i:
                raise LinkStoreError("store-seq-break:%d" % i)
            if row.get("prev") != prev or not _is_hex64(row.get("digest")):
                raise LinkStoreError("store-chain-break:%d" % i)
            if _digest(row) != row["digest"]:
                raise LinkStoreError("store-digest-mismatch:%d" % i)
            prev = row["digest"]
            out.append(row)
        return out

    def head(self):
        """(row count, head digest); keep a copy off-store to detect tail
        truncation."""
        rows = self.rows()
        return len(rows), rows[-1]["digest"] if rows else GENESIS

    def verify(self, head=None):
        rows = self.rows()
        if head is not None:
            n, digest = head
            if len(rows) < n:
                raise LinkStoreError("store-truncated-vs-head")
            got = rows[n - 1]["digest"] if n else GENESIS
            if got != digest:
                raise LinkStoreError("store-rewritten-vs-head")
        return len(rows)

    # lean: single writer, no file lock; add engine.locks.FileLock if two
    # processes ever append to one store.
    def _append(self, edge):
        _validate(edge)
        rows = self.rows()
        row = dict(edge, seq=len(rows),
                   prev=rows[-1]["digest"] if rows else GENESIS)
        row["digest"] = _digest(row)
        line = _canon(row)
        if self._lines is not None:
            self._lines.append(line.decode("ascii"))
            return row
        os.makedirs(os.path.dirname(os.path.abspath(self.path)),
                    exist_ok=True)
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, line + b"\n")
            os.fsync(fd)
        finally:
            os.close(fd)
        return row

    def add(self, **edge):
        """Append the first row of an edge; edge_id must be new."""
        if any(r.get("edge_id") == edge.get("edge_id") for r in self.rows()):
            raise LinkStoreError("edge-id-reused")
        return self._append(edge)

    def _latest(self, edge_id):
        latest = None
        for r in self.rows():
            if r["edge_id"] == edge_id:
                latest = r
        if latest is None:
            raise LinkStoreError("edge-unknown")
        return {k: latest[k] for k in EDGE_FIELDS}

    def supersede(self, edge_id, known_at, evidence_ids, **changes):
        """Append a replacement row for an existing edge."""
        bad = [k for k in changes
               if k in ("edge_id", "known_at", "evidence_ids")
               or k not in EDGE_FIELDS]
        if bad:
            raise LinkStoreError("supersede-fields:%s" % bad)
        edge = self._latest(edge_id)
        edge.update(changes, known_at=known_at, evidence_ids=evidence_ids)
        return self._append(edge)

    def retire(self, edge_id, valid_to, known_at, evidence_ids):
        """End an edge's validity at `valid_to`, learned at `known_at`."""
        if valid_to is None:
            raise LinkStoreError("edge-valid-window")
        return self.supersede(edge_id, known_at, evidence_ids,
                              valid_to=valid_to)

    def edges(self, as_of_valid, as_of_known):
        """Edges the engine knew at `as_of_known` and the world held at
        `as_of_valid`. The latest-known row per edge_id decides; ties go to
        the later append."""
        best = {}
        for r in self.rows():
            if r["known_at"] > as_of_known:
                continue
            cur = best.get(r["edge_id"])
            if cur is None or r["known_at"] >= cur["known_at"]:
                best[r["edge_id"]] = r
        out = []
        for r in best.values():
            if r["valid_from"] <= as_of_valid and (
                    r["valid_to"] is None or as_of_valid < r["valid_to"]):
                out.append({k: r[k] for k in EDGE_FIELDS})
        return sorted(out, key=lambda e: e["edge_id"])
