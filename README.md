# MiroHedge

Systematic fund for forex majors + US-listed stocks. Free public information in,
calibrated decisions out, C++ execution. Paper-only until gated promotion.

## Status

Phase 0 closed (freeze v2, signed). P1.1 freeze-check 39/39 PASS. P1.3
canonical layer done + hardened (16 checks green). Next: P1.4 7-day soak.

## Layout

```text
plan/                  # the spec; if it is not here, we do not build it
  00-INDEX.md          #    read first: map + trust rules
  01..12-*.md          #    vision, signals, JEV v3, C++ core, risk R1-R17,
                       #    execution, roadmap, research plane, sources,
                       #    capital gates, calibration, statistical baseline
  system-manifest.yaml #    canonical build fingerprint (code verifies against this)
collector/             # P1.2/P1.3: non-X collector + SQLite canonical layer (stdlib only)
  collect.py           #    EDGAR / Fed / ECB / Treasury / BLS (+ FRED key-gated) -> signals.jsonl
  classify.py          #    signals -> SQLite truth -> deterministic classified feed
  audit.py             #    machine-readable baseline report
  test_pipeline.py     #    16 checks: python3 collector/test_pipeline.py
scripts/
  freeze-check.sh      # P1.1: verify repo against system-manifest.yaml (39 checks)
data/                  # runtime only, gitignored: signals/, state/, classified/, canonical.db
```

## Run

```bash
bash scripts/freeze-check.sh          # must print FREEZE-CHECK: PASS
python3 collector/collect.py          # poll sources -> data/signals/<day>.jsonl
python3 collector/classify.py data/signals/<day>.jsonl   # -> data/classified/
python3 collector/audit.py data/signals/<day>.jsonl      # baseline report
python3 collector/test_pipeline.py    # 16 checks, all must pass
```

Contact for SEC UA: `MIRO_CONTACT` env. FRED key: `FRED_API_KEY` env (skipped cleanly without).

## Rules

- `plan/` wins over this README. Docs 08-11 never weaken 01-07.
- X disabled in v1 (history in doc 02 only). No Selenium. No paid data for core.
- `signals.jsonl` is an event log, SQLite is truth, classification is
  deterministic (no LLM), `features.jsonl` is a future research-plane artifact.
- No code path promotes capital. Demotion is automatic.
- Live checklist: `TODO.md`. Build order: `plan/07-build-roadmap.md`.

Branches: `main` (this fund). `arena` (archived WEEX hackathon bot lineage).
