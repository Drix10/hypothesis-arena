# P1.4 soak report (closed)

Rules version: `rules_v1`, unchanged for the whole window.

## Window (about 33 h observed, not 7 d)

- Start: 2026-09-18T18:54:26Z
- End: 2026-09-20T03:30:00Z (loop stopped, last recorded cycle)
- Elapsed: ~32.6h, 133 cycles at 15-min cadence
- Criterion: 30 h evidence gate (originally 7 d, shortened on observed evidence).
  Evidence hashes: `collector/SOAK_MANIFEST.json`.

## EDGAR

- polls: 133
- HTTP 403: 0
- other failures: 0

## Sources (polls × status over 133 cycles)

| source | polls | records (unique) | empty | errors | stale |
|---|---|---|---|---|---|
| edgar_8k | 133 | 120+ new events across window | 0 | 0 | 0 |
| fed_monetary | 133 | 15 | 0 | 0 | 13 (archaeology) |
| ecb_mid | 133 | 20 | 0 | 0 | 0 |
| treasury_auctions | 133 | 60+ | 0 | 0 | 0 |
| bls_empsit | 133 | 10 | 0 | 0 | 10 (archaeology) |
| fred_macro | 133 | 0 | 0 | 0 | 0 (SKIPPED_CONFIG throughout, expected) |

## Integrity

- malformed: 0
- ingest crashes: none observed; cycle-level crash/error counters were not persisted.
  Record-balance checks show no unexplained drops
  (225=105+120 day 1; 60=60+0 day 2; 60=60+0 day 3).
- duplicates: absorbed (120 day 1, replay-stable after)
- revisions: 0
- corrections: 0
- provenance failures: 0 (0 orphan correction links)
- future-timestamp violations: 0

## Classification

- TRIGGER_CANDIDATE: 100 (40 + 30 + 30)
- CONTEXT: 102 (42 + 30 + 30)
- STALE: 23
- REJECTED: 143 (143 duplicates incl. replays; 0 schema/future rejects in window)

## Noise (pre-grader + manual)

- candidates pre-graded: 115+ (all daily populations)
- auto_genuine: all | auto_noise: 0 | ambiguous: 0
- human-queue rows: 0 → no manual reviews required
- noise percentage: 0% (pre-grade; independent statistical noise study not done)
- threshold: <10%
- result: PASS

## Boundary

- C++-consumable artifacts: 0
- features.jsonl emitted by P1.4: 0

## Acceptance

- soak_check: 7/7 PASS on all three daily runs
- replay determinism: identical verdict maps on isolated re-runs

## Scope (exact)

P1.4 validates operational and data-pipeline reliability over the observed ~33 h
window. It says nothing about alpha, profitability or strategy validity.

## Defects found

Fixed after the soak, not during it:

1. Cycle-level crash/error counters were not persisted.
2. The soak deadline was process-local (`end = now + 7d` per launch), so a restart
   would extend the window.
