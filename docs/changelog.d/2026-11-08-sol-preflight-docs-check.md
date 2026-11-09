## 2026-11-08 — Sol checks the docs before it runs

`scripts/write-codex-push-proof.mjs` now runs `scripts/check-doc-drift.mjs` (CI's "Documentation
consistency" check, about a second) against the reviewed base after the pre-flight and code health, and
refuses with no Sol call when it fails.

Why: PR #1650 (2026-11-08) passed Sol, then failed CI because the manual "Last verified" stamps were a
day old. The docs-only re-stamp made a new head, so Sol had to run again. This is the sixth time this
trap cost a commit after review; the written rule ("run check:docs first") did not stop it.

Proof: unit tests in `scripts/write-codex-push-proof.test.mjs` (a failing check refuses, a passing
one runs, a check that cannot run refuses). The real check at PR #1650's two heads: FAIL at `e9b8a6540`
(stale stamps), PASS at `7a31c6be8`. No gate is loosened; this only moves a CI failure to before Sol.
