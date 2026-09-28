# Appendix 08 — Budget/spend ledger integrity and trust-model record (frozen)

Moved VERBATIM from doc 08 §8.4 in the freeze-v3 rebaseline (2026-09-28).
Doc 08 keeps the R15 contract table; this file keeps the ledger
durability, digest, migration, trust-boundary, and trusted-config rules.
Nothing here was edited.

Budget-ledger durability (frozen): the per-(cycle,symbol) counters live in
SQLite with a cycle registry alongside. A missing counters row for a cycle
seen within the 7-day retention window is a deleted authority → the next
reservation aborts, never fresh counters over live state. Only prune-aged
cycles (registry memory past 30 days) may start over. The same rule covers
every reader: snapshot/check/settle/invalidate abort on a deleted recent
row instead of minting zeros. Old ledgers backfill the registry from
surviving counters rows inside the migration itself, so upgraded
deployments are protected immediately. The migration is crash-safe
(CREATE + backfill in one transaction; a present-but-empty registry
over live counters is registry-only deletion, never healed — it
aborts, because healing would resurrect cover for deleted
authority).
Historical row integrity (beyond table presence): every money
table carries a same-transaction content digest (XOR of canonical
row hashes plus exact counts/cents, maintained explicitly in each
mutation's own SQLite transaction — SQLite atomicity means a crash
leaves rows and digest both old or both new, never split, which
closes the commit/bump crash seam by construction). Out-of-band SQL
skips digest maintenance and denies as digest-mismatch at the next
open — this covers UPDATE-usd/content edits that preserve every
aggregate, which pure max/count roots cannot see. The digest table
itself is mandatory at schema v3 on both ledgers: a missing digest
is NEVER rebuilt, because rebuilding would silently re-baseline
authority over possibly modified rows. The one-time v2→v3 migration
(CREATE + recompute + version stamp in a single transaction) runs
only for provably pre-digest ledgers — BOTH a pre-digest version
AND a pre-digest marker shape — so a version reset alone cannot
reach it; only a full marker forgery plus version reset could,
which is the documented coherent-forgery residual (keyless roots
detect corruption and non-coherent tamper; filesystem trust roots
bound the rest). The marker mirrors the digest (re-baselined from
in-DB truth post-commit; verify adopts the mirror when rows and
digest agree, so crash lag self-heals and marker tamper is erased
rather than honored). Malformed marker slots (missing keys,
NaN/inf, non-int numerics) deny. The R15 side keeps an out-of-band
cycle registry (sidecar file, 30-day window) whose marker adoption
flag publishes BEFORE the sidecar file, so every crash direction is
conservative (witness-without-sidecar safely re-adopts; the reverse
order would leave a reusable sidecar-without-witness). Sole sidecar
loss re-adopts from the verified registry.

Trust model & boundary (Round-9, verified by throwaway PoC against
`bb4733a`): the ledger proves MUTUAL CONSISTENCY (rows ↔ in-DB
digest), deletion of any single object (table, digest, marker,
sidecar, version), crash atomicity, and version/shape-gated
migration — against crashes, partial writes, operator error, and
non-coherent tamper. It does NOT prove history against a
format-aware adversary with arbitrary SQLite write access who
coherently rewrites rows AND digest together: that pair is
self-consistent by construction (verified: a 15-line PoC using only
the public hash algorithm re-baselined $149 to $0 with no marker
touch and no version reset), and the marker mirror adopts FROM db
truth — lag-tolerant by requirement, so it cannot cross-check. No
deterministic check on (DB, marker) can distinguish legitimate crash
lag (auto-recovery required: 116 hardening tests pin it) from
coherent forgery; they are observationally identical. Closing that
would need a non-readable secret or external anchor (HSM, TPM,
remote transparency log, OS-mediated key) — none exists in Phase-D
scope, and a same-disk key file or SQLite triggers would be theater
against a disk-write actor (readable secrets don't bind; triggers
don't authenticate the writer). That actor is host-compromise class
(it can equally patch the plane source itself), so coherent
multi-object forgery bottoms out at host/filesystem integrity — the
same root frozen-code integrity rests on. Marker digest/count/cents
fields are therefore a lag-tolerant recovery mirror and shape
tripwire (telemetry + baseline), NOT an authority root; the
authority is rows+digest mutual consistency under the gates above.
Thread identity cannot resurrect a budget: run_cycle refuses a thread_id
whose checkpoint is older than the 7-day R15 window (same cycle_id never
mints a second budget). A checkpoint whose age cannot be established —
lookup failure, unreadable timestamp, or a checkpoint id with no
timestamp — is refused, not treated as absent. A checkpoint dated
beyond the 300 s skew allowance, or with a timezone-less timestamp
(host-local interpretation), is likewise refused. A fail-closed reader error during cadence
accounting is blocked evidence (r15-budget-unreadable), never a silent
under-count. Established database files never regrow tables: a missing
table on a verified schema (spans, holds, counters, leases, meta —
and cycles at schema version 2) denies instead of recreating empty,
so deleted spend history can never reset to $0 under a surviving
marker; creation runs only on provable first init, pristine files,
or the explicit v1→v2 cycles migration (all inside one transaction).
Every counters/lease row is semantically validated on read
(non-negative counters, 0/1 dead/settled flags, finite walls) and by
CHECK constraints on write — corruption aborts, never normalizes.

Trusted-config boundary (explicit, not mechanically enforced): the
graph takes `extract_workers`, `tool_factory`, and
`executor_factory` as deployment-provided callables. The
"only provider path is run_gated()" property holds by frozen
deployment discipline (test doubles stay in tests); the code does
not and cannot prove a substituted worker is provider-free. Do not
present it as a runtime guarantee.
