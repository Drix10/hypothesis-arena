# Phase D deployment evidence log

Baseline: `36c2862`. Each box records what ran, where, when, the pass/fail result and artifact
hashes. Runtime proof only; static inspection never closes a box. Statuses: PROVEN (runtime
proof on record), PARTIAL, BLOCKED (external infrastructure or credential unavailable), OPEN.

Host for Linux boxes: WSL2 Ubuntu 24.04.1, kernel 5.15.167.4-microsoft-standard-WSL2, Docker
29.7.2 (Docker Desktop), 2026-09-22. Hosted CI on the deployment tree (run 35761650805, head
`c3b375f`): plane SUCCESS (249 tests), kernel SUCCESS, evidence SUCCESS, stdlib FAILURE (frozen
collector step, later fixed; see `research/PHASE_E_AUDIT.md` section 3).

Updates after 2026-09-22 are in `research/PHASE_E_AUDIT.md` section 4: BEA PROVEN, earnings
wiring PROVEN, Alpaca paper PROVEN read-only, OANDA BLOCKED (India ineligible).

## Box 8: remaining s8.6 evidence (PARTIAL, 2026-09-22)

- Kill -9 and resume with no duplicates: PROVEN. `research/sandbox/kill9-resume.sh` with
  worker, verify and reconcile scripts; real 6-node graph, fake models, SQLite checkpoints,
  40 epochs. SIGKILL mid-run, same-thread resume records the killed attempt as unknown spend
  and aborts (asserted), supervisor `reconcile_unknown` at attested $0, then a fresh cycle
  for the killed epoch (aborted checkpoints are terminal by design). All asserts pass: 40/40
  epochs exactly once, unique span ids, 40 committed bundles, reader resolves latest. A later
  run proved the no-ambiguity branch (kill outside an attempt resumes directly).
- Cadence gating observed in the same run: LLM attempts on 7 of 40 epochs (2 calls each),
  33 epochs cadence-skipped, all 40 emitted.
- Covered by the hosted battery, not re-proven here: R15 runaway (`test_looping_tool_caught`),
  R12 future drop (`test_r12_future_dropped_by_ctx`), bundle atomicity
  (`test_partial_never_visible`), TTL/TRIGGER/throttle (`test_trigger_immediate_and_ttl`,
  `test_throttle_doubles`), crash-resume ledger (`test_crash_resume_reconstructs`).
- BLOCKED on elapsed time: 7-day unattended run, full-day Langfuse attribution, wall-clock
  cadence-rate match.
- C++ `ctx/` consumption of `features.jsonl` is frozen kernel territory; the Python reader
  path resolves.

## Box 7: source and feed probes (s9.1 Tier-A, s9.4) (PARTIAL, 2026-09-22)

| Source | Status as recorded |
|---|---|
| Broker feed | OPEN at the time; Alpaca paper later PROVEN read-only |
| SEC EDGAR | PROVEN live: 3/3 x 200, zero 403, p50 ~94 ms, p99 ~360 ms |
| FRED / ALFRED | PROVEN 2026-09-23 (`sandbox/fred_vintage_probe.py`, `fred-vintage-evidence.json`): GDP $32,486.066 @ 2026-04-01, N=3, p50 ~500 ms, p99 ~844 ms; realtime replay as known 2020-01-01 byte-identical across two fetches; bad key denied; no key in the artifact. `/alfred/*` paths 404 for this key, so replay uses the FRED realtime parameters |
| Treasury / BLS / BEA | Treasury auctions 3/3 x 200 (p50 ~1.6 s); BLS empsit RSS 3/3 x 200 (p50 ~125 ms), both ad hoc 2026-09-22; BEA needed a key at the time (later PROVEN) |
| Session calendars | PROVEN: `CalendarMissing` yields zero entries, test-pinned |
| Earnings calendar | gate and live probe PROVEN (`sources/earnings.py`, 6 tests; AAPL/MSFT 200, p50 ~1.0 s; True on event, False on quiet day, True on unknown); TTL/heartbeat wiring was OPEN and later closed |
| Fed / ECB RSS | PROVEN live: Fed p50 ~400 ms, ECB p50 ~766 ms |

- `research/sandbox/tier-a-deploy-evidence.json` holds the EDGAR, Fed and calendar run;
  Treasury, BLS and ECB were measured ad hoc with the same urllib semantics as
  `sources/tier_a.py`.
- `lessons.jsonl`: 12/12 entries carry pattern, failure mode and accept/hype grade (10 required).
- Profit and calibration feeds are future-stage prerequisites, not Phase D exit blockers.
  Registry publication is optional; the frozen requirement is pin, digest, SBOM and scan.

## Box 6: Langfuse server and attribution (PARTIAL, 2026-09-22)

- Self-hosted stack `research/sandbox/langfuse/docker-compose.yml` (postgres 16, redis 7,
  clickhouse 24, langfuse 2, health-gated startup) reaches `/api/public/health` 200. Two
  fixes were needed: health-gated `depends_on`, and the native `clickhouse://:9000`
  migration URL. Reproduce with `docker compose up -d` in that directory.
- Attribution mechanics proven without the server: 3 spans aggregate per node from the ledger
  (critique 1 call / 120 tok / $0.40; hypothesize 2 calls / 300 tok / $1.00); `spans.jsonl`
  is the tail (3 lines, fsynced).
- BLOCKED: full-day per-node attribution needs live LLM traffic.
- The compose file holds evidence-only dev secrets (random key, placeholder passwords);
  production replaces all of them. Tracked-tree secret grep is clean.

## Box 5: supervisor WALL_S kill and reap (PROVEN, 2026-09-22)

- Mechanism: `plane/timeout.py::run_in_process`, driven by the supervisor with
  `timeout_s=WALL_S=480`; `r15.WALL_S` is the same constant. Deadline-parameterized, so
  proven at short deadlines with the identical ladder.
- `research/sandbox/kill-probe.py` on Linux: 4/4 PASS. SIGTERM-trapping runaway escalates to
  SIGKILL (`CallTimeout` at 13.6 s on a 3 s deadline); cooperative sleeper dies on TERM
  (3.3 s); fast child returns unharmed; no live workers remain on any path.

## Box 4: model credential and pricing config (PARTIAL, 2026-09-22; live call 2026-09-23)

- Fail-closed proven (`research/sandbox/config-probe.py`, 5/5, shipped constructors, no
  mocks): empty pricing, provider without egress proxy, and missing model id each raise
  `ConfigBlocked`; a bogus-key provider constructs offline and fails at call time.
- Secrets: `git grep` for key patterns over tracked files finds nothing. Single source: root
  `.env` (git-ignored) plus tracked `.env.example`; sole loader
  `collector/config.py::_load_dotenv()` (exported variables win, allowlisted keys only).
- Live provider and accounting proof (`sandbox/live-provider-probe.py`,
  `live-provider-evidence.json`): `RESEARCH_MODEL_ID=meta/muse-spark-1.3-contributor` ($0.10/M
  in, $0.20/M out). Reserve ($0.000038 worst case), `mark_invoked`, `UsageTape` through Squid
  127.0.0.1:3128, 15 prompt + 16 completion tokens in 2.8 s, `append_span` ($0.000005),
  `settle_usd` (hold released). Key validity pre-checked at zero spend via `/auth/key`.
- Scope: exercises the shipped `make_raw_provider`, `UsageTape` and `SpendGovernor`. The
  pricing entry was built by the probe, so production pricing config is not proven, and this
  is not a full `graph.run_cycle()` run.

## Box 3: image pin, digest, SBOM, scan (PROVEN, 2026-09-22)

- Base `python:3.11-slim-bookworm@sha256:a36c24f9...` in `research/sandbox/Dockerfile`.
- Image `mirohedge/worker:sandbox-20260922`, digest `sha256:4da3c201...5834` (local build, no
  registry push).
- SBOM `research/sandbox/image-sbom.cyclonedx.json` (CycloneDX 1.5, 194 components, sha256
  `27e24676...`).
- Scan `research/sandbox/image-scan.txt` (`docker scout cves`): 3C 14H 13M 40L, all inherited
  from the pinned base. No silent upgrade; re-pin, rebuild and re-scan per Dockerfile rule D3.

## Box 2: egress enforcement (PROVEN, 2026-09-22)

- Image digest `sha256:4da3c2016be32467812b1fce4da00e67636605b100b0750caf6b35b4f68a5834`.
- Topology: worker on the `--internal` network `egress-inner` plus a squid proxy
  (`research/sandbox/egress-proxy/squid.conf`, exact `dstdomain` allowlist `www.sec.gov`,
  deny by default) on both networks. Worker flags: non-root 65532, read-only rootfs,
  cap-drop ALL, pids/memory/cpu limits.
- `research/sandbox/egress-probe.sh`: 5/5 PASS. Allowlisted host transits; `example.com` and
  `data.sec.gov` get 403 at the proxy (the allowlist is exact, not suffix-wide); direct egress
  has no route. Proxy log: TCP_DENIED/403=6, TCP_TUNNEL/200=4.
- tinyproxy was rejected: its `Filter` does not apply to CONNECT, so HTTPS bypassed it
  (example.com:443 returned 200). Squid `http_access` enforces on CONNECT.
- The probe brings the proxy up idempotently and honors `PROXY_HOST`.

## Box 1: OS-user isolation (PROVEN, 2026-09-22)

- `research/sandbox/setup-identities.sh` on the deployment host: tree ready, 8/8 probes
  PASS, idempotent re-run.
- Users `mirotrade`, `miroresearch`, `mirojev`, `mirohuman`, private groups only, nologin
  shells. `/srv/mirohedge`: `journal/`, `stage/`, `creds/broker` (trade), `creds/jev` (jev),
  all 700; `features/`, `signals/`, `creds/sources` owned by miroresearch.
- Repo isolation check as miroresearch via setpriv: 4/4 protected paths denied. Extra probes:
  miroresearch and mirojev cannot read the broker key fixture (600) or list `creds/broker`;
  mirotrade reads its own key; miroresearch writes its own `features/`.
- `mirohuman` is a nologin identity in the script while plan s8.2 describes the human
  operator. Ruling 2026-09-22: not a blocker, script unchanged; the invariant is that
  services never run as the human, and a real human login performs sign-off.
- Re-runs never overwrite a deployed `broker.key` (fixture guard).
