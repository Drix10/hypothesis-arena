# research/

Evidence and strategy plane.

- Tests run with `PYTHONWARNINGS=error python3 research/tests/<name>.py`; `research/tests/test_candidate.py` uses pytest with pinned deps. [HIGH CONFIDENCE: ci.yml]
- Every backtest goes through the harness and the trial ledger in `research/ledger/` (rule 11 in the root file). Do not edit the ledger files by hand. [HIGH CONFIDENCE: root `AGENTS.md`]
- Preregistrations in `research/prereg/` are written before the run they govern. [INFERRED: names only]
- Worker containers egress only through Squid; host-side probes use direct `urllib`/httpx. [HIGH CONFIDENCE: ARCHITECTURE.md §5]
