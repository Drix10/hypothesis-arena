# P1.4 SOAK REPORT

Rules version: rules_v1 (FROZEN for the window — no classifier changes)

## Window

- Start:
- End:

## EDGAR

- polls:
- HTTP 403:
- other failures:

## Sources

| source | polls | records | empty | errors | stale |
|---|---|---|---|---|---|
| edgar_8k | | | | | |
| fed_monetary | | | | | |
| ecb_mid | | | | | |
| treasury_auctions | | | | | |
| bls_empsit | | | | | |
| fred_macro | | | | | |

## Integrity

- malformed:
- ingest crashes:
- duplicates:
- revisions:
- corrections:
- provenance failures:
- future-timestamp violations:

## Classification

- TRIGGER_CANDIDATE:
- CONTEXT:
- STALE:
- REJECTED:

## Noise (manual grade of TRIGGER_CANDIDATE population)

- candidates manually graded:
- off-topic:
- noise percentage:
- threshold: <10%
- PASS/FAIL:

## Boundary

- C++-consumable artifacts: 0
- features.jsonl emitted by P1.4: 0

## Observed defects (fix AFTER the soak, never during)

- (none yet)
