# research/

The engine (`engine/`), the backtest harness and event data (`strategy/`), data adapters (`sources/`), sandbox probes (`sandbox/`), and the evidence records (`ledger/`, `prereg/`, `reports/`).

- Tests run with `PYTHONWARNINGS=error python3 research/tests/<name>.py`.
- Every backtest goes through the harness and the trial ledger in `research/ledger/` (rule 11 in the root file). Do not edit the ledger files by hand.
- Preregistrations in `research/prereg/` are written before the run they govern.
- Worker containers egress only through Squid; host-side probes use direct `urllib`.
- Engine modules are imported with `research/` on `sys.path` (`from engine import graph`), not as `research.engine`; tests insert that path first.
- The engine's graph tests need `langgraph` (pinned in `requirements.txt`); on the Windows box run them in WSL.
