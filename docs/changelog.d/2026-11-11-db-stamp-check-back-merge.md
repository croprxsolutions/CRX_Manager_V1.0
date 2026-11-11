## 2026-11-11 - Migration stamp check: back-merges of main into staging

The "Migration stamps" PR check refuses a new migration whose stamp is not newer than the base branch's
newest. A back-merge of `main` into `staging` broke that rule by design: main's files reach staging
after staging-only migrations (M4b `20261231110000`, M4a `20261231120000`), so they are older. The
first catch-up after the release flow (`20261229160000_convert_to_gl_lb_dry_oz`) would have shown red.

`.github/scripts/db-apply.mjs stamp-check` now skips the "newer" rule, on PRs into `staging` only, for
an added file whose content is byte for byte the one on `origin/main` (same git blob). Main's own check
already passed it, and the staging job applies such files out of order on purpose
(`ALLOW_OUT_OF_ORDER`). The name, real-time and unique-stamp rules still apply to them, and a file that
differs from main's copy in any byte gets no exemption. PRs into `main` are unchanged.
The "Migration stamps" job now runs that base-branch check before the PR's own tests, so a PR's test
file can't move `origin/*` refs or the environment ahead of it. Locally, `stamp-check mason/staging`
compares with `mason/main`. Tests: `.github/scripts/db-apply.test.mjs`.
