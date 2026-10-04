"""Text-peer edges (plan/engine.md, link graph): firms whose 10-K Item 1
business descriptions share vocabulary. TF-IDF over one fiscal-year cohort,
cosine similarity, top-k peers above a threshold. Stdlib only, no I/O."""
import math
import re

STOPWORDS = frozenset("""
a about after all also an and any are as at be been but by can company
companies for from had has have in including into is it its may more not of
on or our such than that the their these they this to us was we were which
will with would
""".split())
_TOKEN = re.compile(r"[a-z0-9]+")


def tokenise(text):
    return [t for t in _TOKEN.findall(text.lower())
            if len(t) > 1 and t not in STOPWORDS]


def idf(token_lists):
    """Smoothed idf from this cohort only: ln((1+N)/(1+df)) + 1."""
    n = len(token_lists)
    df = {}
    for toks in token_lists:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    return {t: math.log((1 + n) / (1 + c)) + 1.0 for t, c in df.items()}


def tfidf(tokens, weights):
    tf = {}
    for t in tokens:
        tf[t] = tf.get(t, 0) + 1
    return {t: c * weights[t] for t, c in tf.items()}


def cosine(a, b):
    dot = sum(v * b[t] for t, v in sorted(a.items()) if t in b)
    na = math.sqrt(sum(v * v for _, v in sorted(a.items())))
    nb = math.sqrt(sum(v * v for _, v in sorted(b.items())))
    if na == 0 or nb == 0:
        return 0.0
    return min(1.0, dot / (na * nb))


def text_peer_edges(filings, known_at, valid_from, k=10, threshold=0.3):
    """Edge dicts for LinkStore.add, one per (firm, peer) in the firm's top-k.

    `filings` is a list of {cik, accession, item1_text, filed} for one fiscal
    year. Each edge's known_at is the later of the two filing dates and the
    `known_at` floor, so no edge is known before either filing. A pair is
    emitted in both directions only when each ranks the other in its top-k.
    """
    ciks = [f["cik"] for f in filings]
    if len(set(ciks)) != len(ciks):
        raise ValueError("duplicate-cik")
    rows = sorted(filings, key=lambda f: f["cik"])
    toks = [tokenise(f["item1_text"]) for f in rows]
    weights = idf(toks)
    vecs = [tfidf(t, weights) for t in toks]
    out = []
    for i, src in enumerate(rows):
        sims = [(cosine(vecs[i], vecs[j]), j) for j in range(len(rows))
                if j != i]
        sims = [s for s in sims if s[0] > 0 and s[0] >= threshold]
        sims.sort(key=lambda s: (-s[0], rows[s[1]]["cik"]))
        for w, j in sims[:k]:
            dst = rows[j]
            out.append({
                "edge_id": "text_peer:%s:%s:%s:%s" % (
                    src["cik"], dst["cik"], src["accession"],
                    dst["accession"]),
                "src_cik": src["cik"], "dst_cik": dst["cik"],
                "source": "text_peer", "type": "text_peer", "weight": w,
                "valid_from": valid_from, "valid_to": None,
                "known_at": max(known_at, src["filed"], dst["filed"]),
                "evidence_ids": [src["accession"], dst["accession"]],
                "extractor": "deterministic",
                "contamination_class": "deterministic",
            })
    return out
