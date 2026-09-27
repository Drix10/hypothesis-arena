"""S2 point-in-time universe artifact (explicit, versioned, content-hashed).

S2 scope decision (documented, not silent): the equities sleeve runs on
AAPL + MSFT over 2023-01-01..2025-01-01. Both were continuous S&P-500
members across the whole window with no splits/mergers/ticker changes
inside it (AAPL 4:1 split was 2020-08, outside; prices split-adjusted by
the source). Cash dividends are NOT adjusted (documented limitation: small
ex-div gaps read as price moves). Any run that cannot name its universe
hash is void (doc 12 BASE1).
"""
import hashlib
import json

UNIVERSE_VERSION = "universe_s2_v1"
SYMBOLS = ["AAPL", "MSFT"]
WINDOW = ("2023-01-01", "2025-01-01")
LIQ_MIN_MEDIAN_DAILY_USD = 50_000_000.0


def build_artifact(outdir="data/s2_raw"):
    artifact = {
        "universe_version": UNIVERSE_VERSION,
        "window": {"start": WINDOW[0], "end": WINDOW[1]},
        "members": [
            {"symbol": "AAPL",
             "membership": "continuous S&P-500 across window",
             "corp_actions_in_window": "none (split 2020-08 outside window; "
                                       "cash dividends unadjusted — see limits)",
             "liquidity_filter": f"median daily $vol > ${LIQ_MIN_MEDIAN_DAILY_USD:,.0f}"},
            {"symbol": "MSFT",
             "membership": "continuous S&P-500 across window",
             "corp_actions_in_window": "none (cash dividends unadjusted — see limits)",
             "liquidity_filter": f"median daily $vol > ${LIQ_MIN_MEDIAN_DAILY_USD:,.0f}"},
        ],
        "limits": ["cash dividends unadjusted", "IEX feed (no SIP)",
                   "spread unknown -> 1bp-floor cost legs (lower bound)",
                   "FX sleeve NOT in this artifact (source pending)"],
    }
    blob = json.dumps(artifact, sort_keys=True).encode()
    artifact["artifact_hash"] = hashlib.sha256(blob).hexdigest()
    path = f"{outdir}/universe_s2_v1.json"
    json.dump(artifact, open(path, "w"), indent=2)
    print("universe:", path, artifact["artifact_hash"][:16])
    return artifact
