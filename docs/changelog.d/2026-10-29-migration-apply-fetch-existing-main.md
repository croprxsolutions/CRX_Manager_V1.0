## 2026-10-29 - Migration apply script no longer creates origin/main

- **Migration apply (PR #1196).** `scripts/apply-migration-file.mjs` now refreshes `origin/main` only when the checkout already has it. In a CI checkout without it, creating the ref changed what later tests in the same job saw and failed the Windows guard suite.
