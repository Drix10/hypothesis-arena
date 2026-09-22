# Phase-D deployment evidence log

Canonical state at start: `36c2862` (Round 9 closed, Phase D OPEN pending
deployment evidence, Slice D NOT AUTHORIZED, tree clean).

Each box records: what ran, where, when, exact pass/fail, and the artifact
hash. Runtime proof only — static inspection never closes a box. Statuses:
PROVEN (runtime proof on record), BLOCKED (external infra/credential genuinely
unavailable, with reason), OPEN (not yet attempted).

Deployment host for Linux boxes: WSL2 Ubuntu 24.04.1 LTS, kernel
5.15.167.4-microsoft-standard-WSL2 (this build host; the production Linux host
replicates the same mechanism). Docker daemon 29.7.2 (Docker Desktop) started
2026-09-22 for the daemon-dependent boxes.

## Box 7 — source/feed config + probes (§9.4) — PARTIAL 2026-09-22

- Live Tier-A probe (`sources/tier_a.py`, artifact
  `research-plane/sandbox/tier-a-deploy-evidence.json`): EDGAR 8K
  3/3×200 zero-403 (p50 94ms, p99 360ms), Fed monetary 3/3×200
  zero-403 (p50/p99 ~406ms). Calendar LOADED (seed nyse-2026,
  paper-only until G1).
- FRED macro + ALFRED vintage replay: BLOCKED (no FRED_API_KEY;
  the probe records BLOCKED, never silently downgrades — key
  presence alone would not promote without a live 200).
- `lessons.jsonl`: 12/12 entries carry pattern + failure_mode +
  accept/hype grade (≥10 required) ✓.
- Calendar fail-closed: `test_sources.py` pins CalendarMissing →
  zero entries (now also running in the hosted evidence job) ✓.
- Classification table: Phase-0 doc item (frozen). Tier B/C as
  CONTEXT/NULL unused-by-nothing: code posture, unchanged.

## Box 6 — Langfuse server + attribution — PARTIAL 2026-09-22

- Server SELF-HOSTED and healthy: `research-plane/sandbox/langfuse/`
  `docker-compose.yml` (postgres:16-alpine + redis:7-alpine +
  clickhouse:24-alpine + langfuse:2, health-gated startup) boots to
  `/api/public/health → 200` (bring-up needed two honest fixes:
  health-gated depends_on after a postgres race, and the native
  `clickhouse://:9000` migration URL; all-zero ENCRYPTION_KEY is
  rejected — evidence-only random key in the file, production
  replaces ALL placeholder secrets). Stack parked stopped after
  proof; reproduce with `docker compose up -d` in that dir.
- Attribution mechanics PROVEN without the server (venv python):
  3 spans across hypothesize/critique aggregate per-node from the
  authoritative ledger (critique 1 call/120 tok/$0.40, hypothesize
  2 calls/300 tok/$1.00); `spans.jsonl` itself is the tail (3 lines,
  one row per insert, fsync'd).
- BLOCKED (genuinely unavailable): full-day live per-node Langfuse
  attribution needs the Box-4 model key (no live LLM traffic exists
  to attribute). Server is ready to receive it.

## Box 5 — supervisor WALL_S kill/reap — PROVEN 2026-09-22

- Mechanism: `plane/timeout.py::run_in_process` (the primitive the
  production supervisor drives with `timeout_s=WALL_S=480s`;
  `r15.WALL_S` is the same constant the cycle bound and prune
  already enforce). Deadline-parameterized, so proven at short
  deadlines — identical ladder at any value.
- Script `research-plane/sandbox/kill-probe.py` on Linux (POSIX-only;
  Windows signals vacuous): 4/4 PASS, exit 0. SIGTERM-trapping runaway
  → SIGKILL escalation, CallTimeout in 13.6s on a 3s deadline
  (bounded); cooperative sleeper → TERM death, CallTimeout in 3.3s;
  fast child returns its result unharmed; zero live worker children
  remain on every path (reaped).

## Box 4 — model credential + pricing config — PARTIAL 2026-09-22

- Fail-closed PROVEN at runtime (`research-plane/sandbox/config-probe.py`,
  venv python, 5/5 PASS exit 0, shipped constructors, no mocks): empty/None
  pricing → ConfigBlocked; provider without egress proxy → ConfigBlocked
  (never direct); without model_id → ConfigBlocked; bogus-key provider
  constructs fully offline (no silent validation call — fail-closed
  defers to call time with a real provider error).
- Secrets: `git grep` for key patterns over tracked files = zero matches
  (exit 1). Placement: `research-plane/sandbox/provider.env.example`
  (placeholders only) + `provider.env` git-ignored; real file lives in
  the miroresearch home mode 600, sourced by the supervisor only.
- BLOCKED (genuinely unavailable, not unattempted): no live model key
  exists → no live provider call, no live per-node spend, no full-day
  Langfuse attribution. Requires human-placed key + funded provider
  account. Fail-closed behavior with the key absent is the proven part.

## Box 3 — image pin/digest/SBOM/scan — PROVEN 2026-09-22

- Base pinned in `research-plane/sandbox/Dockerfile`:
  `python:3.11-slim-bookworm@sha256:a36c24f9…` (pre-existing pin).
- Built `mirohedge/worker:sandbox-20260922`, digest
  `sha256:4da3c201…5834` (local build; no registry push — no
  registry credential exists on this host; RepoDigest records on push).
- SBOM: `research-plane/sandbox/image-sbom.cyclonedx.json`
  (CycloneDX 1.5, 194 components, sha256 `27e24676…`).
- Scan: `research-plane/sandbox/image-scan.txt` (`docker scout cves`):
  3C 14H 13M 40L, all inherited from the pinned bookworm base
  (worker layer adds only the ==-pinned pip set). Disposition: no
  silent upgrade — re-pin + rebuild + re-scan per the Dockerfile D3
  rule; recorded here as the baseline for the next rebuild.

## Box 2 — egress enforcement (§8.6 "Egress proven") — PROVEN 2026-09-22

- Worker image built from `research-plane/sandbox/Dockerfile`:
  `mirohedge/worker:sandbox-20260922`, image digest
  `sha256:4da3c2016be32467812b1fce4da00e67636605b100b0750caf6b35b4f68a5834`
  (local build; registry push + SBOM/scan are Box 3).
- Topology: worker on `--internal` docker network `egress-inner` (no
  external route possible) + squid forward proxy (`egress-proxy`,
  config `research-plane/sandbox/egress-proxy/squid.conf`: exact
  `dstdomain` allowlist = `www.sec.gov`, deny-all default) on both
  nets. Worker runs with the doc-08 flags (non-root 65532, read-only
  rootfs, cap-drop ALL, pids/memory/cpu limits).
- Script `research-plane/sandbox/egress-probe.sh`: 5/5 PASS, exit 0.
  allowlisted host transits (origin verdict, never proxy-403);
  `example.com` AND `data.sec.gov` die AT THE PROXY with 403
  (subdomain precision: allowlist is exact, not suffix-wide); direct
  egress fails (ConnectionError, no route). Proxy access log counts
  TCP_DENIED/403=6, TCP_TUNNEL/200=4.
- Honest negative: tinyproxy `Filter` was evaluated first and REJECTED —
  it does not apply to CONNECT so HTTPS tunneling bypasses the filter
  (observed: example.com:443 returned 200 through it). Squid
  `http_access` enforces on CONNECT and is the recorded mechanism.

## Box 1 — OS-user isolation (§8.6 "Isolation proven") — PROVEN 2026-09-22

- Script: `research-plane/sandbox/setup-identities.sh` (original deployment
  script restored + evidence probes appended; idempotent re-run), run as
  root on the deployment host: tree ready + 8/8 probes PASS, exit 0.
- Users `mirotrade`, `miroresearch`, `mirojev`, `mirohuman` with private
  groups only (no shared/supplementary groups); service shells nologin.
- Deployment tree `/srv/mirohedge`: `journal/`, `stage/`, `creds/broker`,
  `creds/jev` owned 700 by trade/trade, jev/jev; `features/`, `signals/`,
  `creds/sources` owned by miroresearch.
- Repo isolation check as miroresearch via setpriv: 4/4 protected paths
  denied (`journal`, `stage`, `creds/broker`, `creds/jev`).
- Extra probes: miroresearch/mirojev cannot read the broker.key fixture
  (600) or list `creds/broker`; mirotrade reads own key; miroresearch
  writes own `features/`.
- Note: `mirohuman` is the deploying human's account; service identities
  never run as the human, and the process never runs as root after setup.
