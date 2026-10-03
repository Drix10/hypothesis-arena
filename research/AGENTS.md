# research/

The epistemic engine (`engine/`), the backtest harness and event data (`strategy/`), data adapters (`sources/`), sandbox probes (`sandbox/`), and the evidence records (`ledger/`, `prereg/`, `reports/`).

- Tests run with `PYTHONWARNINGS=error python3 research/tests/<name>.py`; `research/tests/test_candidate.py` uses pytest with pinned deps. [HIGH CONFIDENCE: ci.yml]
- Every backtest goes through the harness and the trial ledger in `research/ledger/` (rule 11 in the root file). Do not edit the ledger files by hand. [HIGH CONFIDENCE: root `AGENTS.md`]
- Preregistrations in `research/prereg/` are written before the run they govern. [INFERRED: names only]
- Worker containers egress only through Squid; host-side probes use direct `urllib`/httpx. [HIGH CONFIDENCE: ARCHITECTURE.md §5]
- Engine modules are imported with `research/` on `sys.path` (`from engine import graph`), not as `research.engine`; tests insert that path first. [HIGH CONFIDENCE: `research/tests/test_emit.py`]
- Retired sleeves' preregistrations and reports stay in `prereg/` and `reports/` as records; their code is in git history only. [HIGH CONFIDENCE: plan/02 §2.5]
