## 2026-11-01 - Quote sweep pins refreshed after a fresh live review

The booking migrations from PRs #1201 and #1203 changed two reviewed quote functions without updating their sweep pins, so 2 of 29 live sweeps failed on 2026-10-31.

- **Review:** both live function bodies were re-read and matched their migration files exactly. The changes add a chosen quote expiry, and let a sent quote's price change straight away with a recorded trail (the deliberate #1203 relaxation of the sent-price lock). The actor binding, strict actor-mismatch refusal, role gates and EXECUTE restrictions are unchanged, so these were stale pins and not a hole.
- **Pins:** the `save_quote` entry in `allowlist.json`, the `_create_quote_version_owner_impl` body pin in the `quote-versions-rpc-owned` predicate and `quoteVersionWriteBoundary.test.ts`, and the matching predicate fingerprint in `live-testdata-lib.mjs`.
- **Proof:** a full live sweep on 2026-11-01 adjudicated all 29 predicates `ok: true`, `complete: true`, with no new flags. KI-85 and To-Do 11.12 are closed.
