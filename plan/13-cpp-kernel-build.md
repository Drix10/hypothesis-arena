# 13 — C++ deterministic kernel build (Phase 3)

Phase 2 is frozen (`50ea369` accepted). The JEV sidecar is not modified
further unless Phase-3 integration exposes an actual contract defect.
This document is the Phase-3 build sequence. Order is load-bearing:
**boundary validator first, risk/sizing last.**

```
Raw AnswerSet JSON
     |
     v
Parse (JSON only, no semantics)
     |
     v
Schema validation (exact fields, versions, pins, types, ranges)
     |
     v
Cryptographic validation (response_hash recompute + Ed25519 verify + key trust)
     |
     v
State/freshness validation (state_hash + decision_key + expiry; LIVE vs REPLAY)
     |
     v
JEVAnswerSetV3 (typed object)
     |
     v
Deterministic decision engine (vetoes, table, sizing, exits, kills)
```

Once the object crosses the boundary, the rest of the kernel **never parses
arbitrary JEV JSON again**. Everything downstream consumes the typed object.

## 13.0 The three inequalities (locked)

```text
cryptographic validity =/= semantic validity =/= decision authorization
```

- A valid signature on a semantically invalid artifact -> HOLD.
- A semantically valid artifact that fails state binding or freshness -> HOLD.
- A fully valid artifact still only *nominates*; the deterministic engine
  authorizes (row-0 veto, R-gates, max-gate for 2xR). JEV never authorizes.

## 13.1 P3.1 — Boundary validator (first executable C++ component)

Independent enforcement, in this order (fail-closed, first failure wins, HOLD
with a named reason):

1. JSON/object structure (parseable, top-level object). Resource bounds are
   part of this check and frozen: raw JSON <= 64 KiB (rejected before any
   allocation), strings <= 1024 chars, objects/arrays <= 64 members/elements,
   numeric tokens <= 64 bytes, nesting <= 64 deep. Duplicate object member
   names rejected at parse (cryptographic boundary: no find()-first-wins).
2. Exact top-level schema (no missing, no extra fields).
3. `schema_version` pin.
4. `question_set_version == v3`.
5. `model` pin (`typesafe/jev-1.13`).
6. `revision` pin (`typesafe/jev-1.13-20260917`).
7. `provider` pin (`TypeSafe`).
8. `symbol` present and in the exec universe (<= 5, doc 04).
9. `snapshot_epoch` integer, non-negative, strictly monotonic per symbol:
   `epoch > previous accepted epoch` for that symbol (first artifact: any
   non-negative). Enforced in LIVE and REPLAY alike against the kernel-owned
   predecessor (replay callers supply the recorded predecessor).
10. `state_hash` well-formed (64 hex).
11. `decision_key` well-formed (64 hex).
12. `created_at` well-formed timestamp.
13. `expires_at` well-formed, `expires_at == created_at + 60 s`.
14. `response_hash` well-formed (64 hex).
15. Exactly four answers (`enter`, `edge_family`, `conviction`, `latent_risk`).
16. Answer types/enums/ranges: `noul` finite real in [0,1] (bool rejected —
    C++ `bool`/`int` must not implicitly satisfy a double field), family enum,
    conviction enum, `probabilities` bounded to the four family keys (<= 4
    entries, each in [0,1], never authorization). `confidence`, if present,
    must be a JSON number (structural integrity only); P3.1 applies §13.4(b)
    quarantine: it is never stored in and never readable from the
    decision-facing object (no accessor exists). If absent, unknown, never
    defaulted.
17. `response_hash` recomputation over canonical bytes (see 13.2) — mismatch
    -> HOLD.
18. Ed25519 signature verification (see 13.2) — failure -> HOLD.
19. Signature-key trust: pubkey must equal the pinned sidecar key (no
    self-attested keys; the artifact's `pubkey` field, if carried, is
    informational only and never trusted).
20. Live expiry: `now <= expires_at`, else HOLD (LIVE mode only). Frozen
    clock-skew allowance: `created_at <= now + 300 s`, else HOLD
    (`not-yet-valid`); boundary tested at created-299 (accept) / created-301
    (HOLD). Timestamps strictly validated (real calendar incl. leap years,
    seconds 00-59, years 1970-2100).
21. State binding: `state_hash` and `decision_key` recomputed from the kernel's
    own canonical snapshot must equal the artifact's values, else HOLD.
    `decision_key` is recomputed field-for-field from the parsed snapshot
    (frozen sidecar recipe, cross-checked on 300 randomized states); no
    trusted-string comparison exists on this path.

Two validation modes, selected explicitly at the call site:

- `LIVE`: all 21 checks; expired -> HOLD.
- `REPLAY`: checks 1–19 + 21 against the recorded snapshot; expiry (20)
  waived so historical artifacts remain valid historical inputs.
  Replay never weakens crypto or semantic validation — it only waives
  wall-clock freshness.

Done when: adversarial suite green (each check has a dedicated failing
vector: wrong revision, wrong provider, extra top-level field, extra answer
key, bool noul, NaN-equivalent, out-of-range, tampered response_hash,
tampered signature, untrusted key, expired-live, mismatched state_hash,
mismatched decision_key), plus the §13.2 cross-language vector.

Frozen P3.1 Ed25519 policy: strict RFC 8032 decoding (canonical y,
recovered-x == 0 with sign bit rejected, post-adjustment square re-check),
`S < L`, cofactorless `[S]B == R + [h]A` verification. No ZIP-215 semantics.
Cross-checked against OpenSSL 3.2 signatures (accept) plus tamper/wrong-msg
rejection; decode distinction vectors (y=0/sign=1 valid, y=1/sign=1 invalid).

Explicitly NOT claimed by P3.1 (carried, not expanded):
- `allowed_symbols` / `previous_epoch` are kernel-supplied inputs; the
  persistent per-symbol epoch state machine and immutable universe live in
  the kernel (P3.3/P3.5), not in this caller-constructible request.
- `ComputeDecisionKey` maps unrepresentable feature_id types to `"?"`
  (Python would raise: such states are unsignable, comparison fails closed).
  P3.3 hardens this to an explicit `state-shape` failure.
- Check order keeps crypto before freshness/binding (fine for the cold
  sidecar path); the hot path never revalidates JEV JSON.
- ASan/UBSan: MinGW ships no runtimes (hardened build substituted and
  green); Linux ASan/UBSan required before production freeze.
- Fuzz is mutation-robustness around committed artifacts (single-artifact
  seed + token soup + nesting + boundary sizes), not grammar coverage.

## 13.2 P3.2 — Canonical serialization + cross-language test vector

`state_hash`, `decision_key`, `response_hash`, and the Ed25519 signature are
cross-language interoperability boundaries. "Python JSON serialization" must
not remain an implicit cryptographic dependency. This section defines the
canonical byte representation explicitly:

- Canonical JSON: UTF-8, `sort_keys=True`, `separators=(",", ":")`
  (equivalently: keys lexicographically sorted by UTF-16 code unit, no
  whitespace, `:` and `,` separators, shortest float repr, no NaN/Infinity).
- `response_hash = sha256_hex(canonical_bytes(payload_without_signature))`.
- `signature = Ed25519(signing_key, canonical_bytes(full_payload))`
  where `full_payload` includes `response_hash` (sign-then... precisely:
  sign the canonical bytes of the payload object that carries all fields
  except `signature` itself; `response_hash` is a field of that payload).

Dedicated test vector (generated once from the frozen sidecar, committed):

```text
known AnswerSet payload
    -> canonical bytes (committed hex)
    -> SHA-256 (committed response_hash)
    -> Ed25519 signature (committed, sidecar key)
```

C++ verifies the vector independently: recompute canonical bytes (byte-equal
to committed), recompute hash (equal), verify signature (valid). Any
canonicalization drift between languages fails this vector loudly instead of
silently invalidating every artifact at runtime.

Done when: C++ reproduces the committed canonical bytes, hash, and signature
verification bit-for-bit; a deliberately altered byte fails.

## 13.3 P3.3 — Canonical C++ representation + deterministic decision table

- Typed `JEVAnswerSetV3` struct: no optional-in-practice fields, no raw JSON
  carried forward. Construction is only possible through the §13.1 validator
  (private constructor / factory returning `HOLD` reason on failure).
- Deterministic decision table per doc 03 §3.5a (row-0 veto authoritative,
  `latent_risk` HOLD-only, conviction nominates). Same snapshot + same
  AnswerSet -> bit-for-bit identical decision output (tested: 200 recorded
  AnswerSets replayed through the table, outputs hashed and compared).
- Distribution sanity on replay: no degenerate all-`enter`/all-HOLD collapse
  (deferred full check to paper window with live states, per §3.6 note).

Done when: table unit tests green vs doc 03 §3.7 cases; replay determinism
proven by hash comparison.

## 13.4 P3.4 — Confidence contract (if consumed, else quarantine)

`confidence` is currently non-authoritative metadata passed through by the
adapter. Rule: **C++ may not read `confidence` for any decision until this
box is closed.** Either:

- (a) freeze its schema (type double, range, absent-means-unknown, and which
  decisions may use it), with tests; or
- (b) keep it quarantined (parsed, logged, never branched on).

Default is (b). Switching to (a) is a doc edit, not a silent code change.

## 13.5 P3.5 — Risk engine, sizing, exits, kills (docs 04–06 order)

Only after P3.1–P3.3 are green:

- `core` + `risk/veto.cpp` (R1–R17, stage multiplier, row-0 veto).
- `ingest/features.cpp` + rejection tests (schema f2, R12 timestamps, TTL).
- `kill/switch.cpp` + SOFT/MEDIUM/HARD drills, exits proven alive in each.
- `STAGE` chain verification, corrupted-file -> G0_PAPER test.
- `feed` + 24 h soak + kill/reconnect drill.
- `ctx` + hash-stability test (10k identical -> 1 hash).
- `exec` + `journal` + kill-switch + reconcile drills.

Exit: §4.5, §6.5 drill boxes checked.

## 13.6 Non-goals for Phase 3

- No JEV sidecar changes (frozen at `50ea369`).
- No research-plane work (Phase 2.5 runs in parallel, feeds `features.jsonl`
  only through the frozen f2 schema).
- No live capital, no stage above G0_PAPER, no venue beyond OANDA practice +
  Alpaca paper.
- No confidence-driven decisions without closing §13.4(a).

## Exit criteria (Phase 3 -> Phase 4)

- [x] P3.1 DONE (`kernel/jev_validate.hpp` + `kernel/test_p31.cpp`, 39 checks
      green): boundary validator first; typed `ValidatedJEVAnswerSetV3`
      constructible only via `validate_jev()`; per-check failing vectors from
      the frozen sidecar (fixed key); crypto primitives independently proven
      (SHA-256/512 vectors, first-principles K table, field ops vs Python,
      oracle Ed25519 vectors); LIVE vs REPLAY expiry; artifact key ignored
      for trust; build.sh grep-gate enforces no raw-JSON downstream.
      Sidecar untouched. P3.2 NOT started (separate boundary).
- [x] P3.1 CORRECTION PASS (deep review, 17 findings -> all closed):
      epoch strictly monotonic vs kernel-owned predecessor (LIVE+REPLAY);
      decision_key recomputed field-for-field in-kernel (0 mismatches on
      300 randomized sidecar states); exec-universe membership enforced;
      confidence quarantined per §13.4(b) (no accessor exists, grep-gated);
      RFC 8032 decode (canonical-y, x=0/sign reject, post-sqrtm1 re-check);
      resource bounds (64 KiB raw, member/string/array/number caps);
      duplicate keys rejected at parse; strict calendar timestamps, frozen
      300 s skew rule; checked numeric parsing (no atoll); thread-safe
      crypto init; Python-repr float formatting (all float_edges byte-equal,
      incl. subnormals); Ed25519 adversarial unit vectors (zero/S=L/
      noncanonical/x0-sign/malformed-key); 96 checks + 20k-iter deterministic
      fuzz clean in normal AND hardened (libstdc++-debug) builds; sanitizer
      runtimes unavailable on this MinGW toolchain (documented in build.sh).
      Sidecar still byte-identical. P3.2 still NOT started. P3.1 ACCEPTED/FROZEN at dcd44d4 (human sign-off; no further P3.1 changes).
- [x] P3.1 FINAL (unambiguous gate record; history above retained):
      ACCEPTED/FROZEN at `dcd44d4` — 102/102 checks, 20,000 fuzz iterations,
      normal + hardened builds, Python suite + freeze green, sidecar
      byte-identical. (Earlier "39 checks" / "96 checks" lines describe
      superseded intermediate states, not the final gate.)
- [ ] P3.2 cross-language vector green (byte-equal canonical, hash, verify).
- [ ] P3.3 table tests + replay determinism green.
- [ ] §13.4 resolved to (a) with contract or (b) quarantined.
- [ ] P3.5 drill boxes (§4.5, §6.5) checked.
- [ ] Freeze-check extended to cover the kernel pins (model/revision/provider/
      qversion/schema) and passing.
- [ ] Human sign-off recorded in doc 07.
