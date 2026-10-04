"""Common-ownership edges for the link graph (plan/engine.md): source
ownership, type common_owner, built from 13F holdings. Pure and deterministic;
no network, no clock reads."""
import itertools

from research.sources import form13f

DEFAULT_THRESHOLD = 0.01


def _day(text):
    """ISO date to the YYYYMMDD integer the link store uses for times."""
    return int(text.replace("-", ""))


def _filings(rows, as_of):
    """cik -> (period, filing_date, rows) of the filer's latest filing made on
    or before as_of, matching form13f.overlap."""
    best = {}
    for r in rows:
        if r["filing_date"] > as_of:
            continue
        key = (r["period"], r["filing_date"])
        if r["cik"] not in best or key > best[r["cik"]][0]:
            best[r["cik"]] = (key, [])
        if key == best[r["cik"]][0]:
            best[r["cik"]][1].append(r)
    return {cik: (k[0], k[1], rs) for cik, (k, rs) in best.items()}


def _evidence_id(row):
    return row.get("accession") or "%s:%s" % (row["cik"], row["period"])


def ownership_edges(rows, issuers, as_of, threshold=DEFAULT_THRESHOLD,
                    overlap_fn=form13f.overlap):
    """Edge dicts for LinkStore.add, one per issuer pair whose overlap is at or
    above threshold.

    rows are form13f holding rows; issuers maps cusip to issuer cik; as_of is
    an ISO date and only filings with filing_date <= as_of are used. weight is
    the overlap. evidence_ids are the sorted accession numbers of the filings
    of the filers holding both, or '<filer_cik>:<period>' for a row without an
    'accession' key. valid_from is the latest period of report among them and
    known_at the latest filing date, both as YYYYMMDD integers. Pairs are
    ordered by (src_cik, dst_cik, cusips). overlap_fn is injectable so tests
    can count comparisons.
    """
    filings = _filings(rows, as_of)
    holders = {}
    for cik in sorted(filings):
        cusips = sorted({r["cusip"] for r in filings[cik][2]
                         if r["cusip"] in issuers})
        # lean: pairs are built per filer, quadratic in one filer's mapped
        # holdings; switch to a sparse matrix product if a filer lists
        # thousands of mapped issuers.
        for pair in itertools.combinations(cusips, 2):
            holders.setdefault(pair, []).append(cik)
    edges = []
    for (a, b), ciks in sorted(holders.items(),
                               key=lambda kv: (sorted((issuers[kv[0][0]],
                                                       issuers[kv[0][1]])),
                                               kv[0])):
        if issuers[a] == issuers[b]:
            continue
        subset = [r for cik in ciks for r in filings[cik][2]]
        weight = overlap_fn(subset, a, b, as_of)
        if weight < threshold:
            continue
        held = [r for r in subset if r["cusip"] in (a, b)]
        src, dst = sorted((issuers[a], issuers[b]))
        edges.append({
            "edge_id": "common_owner:%s:%s:%s:%s" % (src, dst, a, b),
            "src_cik": src,
            "dst_cik": dst,
            "source": "ownership",
            "type": "common_owner",
            "weight": weight,
            "valid_from": max(_day(filings[c][0]) for c in ciks),
            "valid_to": None,
            "known_at": max(_day(filings[c][1]) for c in ciks),
            "evidence_ids": sorted({_evidence_id(r) for r in held}),
            "extractor": "deterministic",
            "contamination_class": "deterministic",
        })
    return edges
