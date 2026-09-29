"""Global trial ledger: append-only, hash-chained JSONL. Every evaluation
registers an `open` row before results exist and a `close` row after; an
unclosed trial is abandoned but still counts. N for multiple-testing
corrections is `count_trials()`. Copy the head checkpoint off-host and pass
it to `verify` to detect tail truncation and rewrites."""
import hashlib
import json
import os
import time

from research.plane import locks

GENESIS = "0" * 64
OPEN_FIELDS = ("trial_id", "hypothesis_card_id", "prereg_hash", "family",
               "variant", "dataset_hashes", "code_hash",
               "cost_model_version", "window", "split_scheme", "runner")
CLOSE_VERDICTS = ("pass", "fail", "crashed", "abandoned", "void")
_HEX = set("0123456789abcdef")


class LedgerError(Exception):
    pass


def _canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def _digest(row):
    body = {k: v for k, v in row.items() if k != "digest"}
    return hashlib.sha256(_canon(body)).hexdigest()


def _is_hex64(s):
    return isinstance(s, str) and len(s) == 64 and set(s) <= _HEX


class TrialLedger:
    def __init__(self, path):
        self.path = path

    def rows(self):
        """Verified rows; raises LedgerError on any structural break."""
        out = []
        if not os.path.exists(self.path):
            return out
        prev = GENESIS
        with open(self.path, "rb") as fh:
            data = fh.read()
        if data and not data.endswith(b"\n"):
            raise LedgerError("ledger-torn-tail")
        for i, line in enumerate(data.split(b"\n")[:-1] if data else []):
            try:
                row = json.loads(line.decode("utf-8"))
            except ValueError:
                raise LedgerError("ledger-malformed-row:%d" % i)
            if not isinstance(row, dict) or row.get("seq") != i:
                raise LedgerError("ledger-seq-break:%d" % i)
            if row.get("prev") != prev or not _is_hex64(row.get("digest")):
                raise LedgerError("ledger-chain-break:%d" % i)
            if _digest(row) != row["digest"]:
                raise LedgerError("ledger-digest-mismatch:%d" % i)
            prev = row["digest"]
            out.append(row)
        return out

    def verify(self, checkpoint=None):
        rows = self.rows()
        if checkpoint is not None:
            cp = read_checkpoint(checkpoint)
            n = cp["count"]
            if len(rows) < n:
                raise LedgerError("ledger-truncated-vs-checkpoint")
            if n and rows[n - 1]["digest"] != cp["head"]:
                raise LedgerError("ledger-rewritten-vs-checkpoint")
            if n == 0 and cp["head"] != GENESIS:
                raise LedgerError("ledger-rewritten-vs-checkpoint")
        return len(rows)

    def count_trials(self, family=None):
        """N = distinct opened trial ids (optionally within one family)."""
        seen = set()
        for r in self.rows():
            if r["kind"] == "open" and (family is None
                                        or r["family"] == family):
                seen.add(r["trial_id"])
        return len(seen)

    def unclosed(self):
        opened, closed = {}, set()
        for r in self.rows():
            if r["kind"] == "open":
                opened[r["trial_id"]] = r
            else:
                closed.add(r["trial_id"])
        return sorted(t for t in opened if t not in closed)

    def assert_declared_n(self, declared, family=None):
        actual = self.count_trials(family)
        if declared != actual:
            raise LedgerError("declared-n-mismatch:declared=%r ledger=%d"
                              % (declared, actual))
        return actual

    def _append(self, fields, check=None):
        with locks.FileLock(self.path + ".lock", purpose="general"):
            rows = self.rows()
            if check:
                check(rows)
            prev = rows[-1]["digest"] if rows else GENESIS
            row = dict(fields)
            row.update(seq=len(rows), prev=prev, ts=int(time.time()))
            row["digest"] = _digest(row)
            line = _canon(row) + b"\n"
            d = os.path.dirname(os.path.abspath(self.path))
            os.makedirs(d, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT,
                         0o644)
            try:
                os.write(fd, line)
                os.fsync(fd)
            finally:
                os.close(fd)
            return row

    def open_trial(self, **f):
        """Register a trial BEFORE it runs. Returns the open row."""
        missing = [k for k in OPEN_FIELDS if k not in f]
        extra = [k for k in f if k not in OPEN_FIELDS]
        if missing or extra:
            raise LedgerError("open-fields:missing=%s extra=%s"
                              % (missing, extra))
        for k in ("trial_id", "hypothesis_card_id", "family", "variant",
                  "cost_model_version", "split_scheme", "runner"):
            if not isinstance(f[k], str) or not f[k]:
                raise LedgerError("open-field-type:" + k)
        if not isinstance(f["window"], (str, dict)) or not f["window"]:
            raise LedgerError("open-field-type:window")
        if not _is_hex64(f["prereg_hash"]) or not _is_hex64(f["code_hash"]):
            raise LedgerError("open-hash-shape")
        if not isinstance(f["dataset_hashes"], list) or not f["dataset_hashes"] \
                or not all(_is_hex64(h) for h in f["dataset_hashes"]):
            raise LedgerError("open-dataset-hashes")

        def unused(rows):
            if any(r["kind"] == "open" and r["trial_id"] == f["trial_id"]
                   for r in rows):
                raise LedgerError("trial-id-reused")
        return self._append(dict(f, kind="open"), unused)

    def close_trial(self, trial_id, verdict, metrics):
        if verdict not in CLOSE_VERDICTS:
            raise LedgerError("close-verdict")

        def open_only(rows):
            state = None
            for r in rows:
                if r["trial_id"] == trial_id:
                    state = "closed" if r["kind"] == "close" else "open"
            if state is None:
                raise LedgerError("close-unknown-trial")
            if state == "closed":
                raise LedgerError("close-twice")
        return self._append({"kind": "close", "trial_id": trial_id,
                             "verdict": verdict, "metrics": metrics},
                            open_only)

    def write_checkpoint(self, path):
        rows = self.rows()
        cp = {"count": len(rows),
              "head": rows[-1]["digest"] if rows else GENESIS}
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(_canon(cp) + b"\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return cp


def read_checkpoint(path):
    try:
        with open(path, "rb") as fh:
            cp = json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError):
        raise LedgerError("checkpoint-unreadable")
    if not (isinstance(cp, dict) and isinstance(cp.get("count"), int)
            and cp["count"] >= 0 and _is_hex64(cp.get("head"))):
        raise LedgerError("checkpoint-malformed")
    return cp
