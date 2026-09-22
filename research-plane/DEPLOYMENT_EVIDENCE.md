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
