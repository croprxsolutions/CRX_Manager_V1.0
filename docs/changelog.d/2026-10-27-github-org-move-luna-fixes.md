## 2026-10-27 — GitHub org move prep: Luna round 1 fixes

- `coderabbit-skip-lib.mjs` no longer exports the single printed repo address, so no caller can use it as the app-repo identity check in place of `isSkipRepository` (which accepts both owners).
- `docs/operations/github-org-move.md` step 2: keep the organization's OAuth app restrictions on and approve GitHub CLI only, instead of offering "No restrictions".
