# MiroHedge

A systematic fund for US stocks and ETFs, cash account, long only, run on
paper first. Every strategy must pass a backtest gate net of all costs before
it is allowed near money. A C++ kernel applies fixed risk rules and places the
orders. AI is used for research and as an optional filter, and it stays only
if it improves results after its own cost.

## How a trade is decided

```
free public data (SEC, FRED, Treasury, BLS, BEA) + market data
        |
strategy sleeve (deterministic code) -> candidate: symbol, side, exit rule
        |
optional JEV filter (kept only if it beats "take every candidate")
        |
C++ kernel: frozen snapshot -> risk rules R1-R19 -> position size
        |
HOLD, or BUY / SELL-to-close with a stop
        |
journal row first, then the order (Alpaca paper)
```

1. Prose never touches money. Research writes typed facts; thesis text goes
   to a human-only digest.
2. HOLD is the default. Stale data, a breached rule, unsettled cash, an
   unapproved strategy or conflicting evidence all produce HOLD.
3. Everything replays. The same logged snapshot and candidate give the same
   decision, bit for bit.

Not HFT, not crypto, not leveraged, no short selling. The fast C++ core buys
determinism and reliable exits, not latency edge.

## Where things stand

- **Kernel and paper transport:** built. The full C++ gate, including the
  sanitizer build, passes. Fault drills pass against a mock venue. The drill
  against the real paper venue still needs an open US session.
- **Strategies:** five were backtested on SIP/SEC data and none beat the
  passive benchmark after costs (`plan/reviews/2026-09-29-alpha-results.md`).
  The paper loop can run the passive core strategy to validate the plumbing.
- **JEV:** built as a filter on a strategy's candidates. It is admitted only
  on a strategy that passes its gate, after 200 decisions + 100 closed
  simulated trades with calibration at or above base rate (doc 03, doc 11).
- **Research plane:** built and tested, not connected to the trading path. It
  is connected once paper results show which strategies are worth feeding.
- **Order:** live drill, 24 h soak, paper run, choose strategies from the
  paper results, then connect the research plane.
- **Capital:** paper only. Nothing live is authorized.

`TODO.md` is the itemized checklist. Status words in the docs:
FROZEN-DESIGN (spec locked, not built), IMPLEMENTED (code exists),
VERIFIED (acceptance green).

## Run it

Paper run (WSL, Ubuntu 24.04): [`ops/deploy/README.md`](./ops/deploy/README.md).

Checks:

```bash
bash scripts/freeze-check.sh            # must print FREEZE-CHECK: PASS
cd kernel && WITH_CURL=1 bash build.sh  # full C++ gate, as a non-root user
python3 -m pip install -r research/requirements.txt   # Python 3.11+
python3 research/tests/test_plane.py    # each research/tests/test_*.py and collector/tests/test_*.py runs standalone
```

Copy `.env.example` to `.env` and fill it locally. Keys never go in git, a log
or a chat.

## Layout

```
plan/       the spec: 00-INDEX first; appendix/ = frozen records; reviews/ = history
kernel/     C++ core: validator, decision table, risk veto, sizing, router, runner, broker transport
research/   strategy/ (backtest harness, strategies), sources/ (data adapters),
            plane/ (LLM research pipeline), sandbox/ (isolation evidence), tests/
collector/  Python: signal collection and the JEV sidecar
ops/        paper-run files: candidate emitter, alert relay, deploy guide
scripts/    freeze-check.sh, pre-commit-secrets.sh, sign-stage.sh
data/       local only, gitignored
```

## Rules

- No code path promotes a capital stage. Demotion is automatic.
- Risk limits R1-R19 are code constants. A change needs a doc edit, a version
  bump and a fresh paper window.
- Live scope is a cash account, long only, 1x, allowlisted US stocks and ETFs.
- A journal row is written before every order.
- Research cannot touch the journal, HALT, the stage chain, candidates or
  broker keys.
- Every backtest goes through the trial ledger. LLM evidence counts only after
  the model's knowledge cutoff.
- Secrets never enter the repo, a log, a prompt or a chat.

Details: [`plan/05`](./plan/05-risk-and-determinism.md),
[`plan/10`](./plan/10-capital-gates-and-spend-control.md),
[`plan/11`](./plan/11-calibration-and-self-improvement.md).

## Spec

`plan/` is the source of truth; code implements it and never invents it.
Start at [`plan/00-INDEX.md`](./plan/00-INDEX.md). Docs 08-11 never weaken a
rule in docs 01-07. The `arena` branch holds an archived crypto bot from an
earlier hackathon.
