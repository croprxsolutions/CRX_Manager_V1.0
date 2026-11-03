## 2026-11-02 - `check:docs` catches a CRLF SQL sha256 pin before the push

- `npm run check:docs` now runs `validateParkedMigrationCrossReferences()` from `.claude/hooks/worktree-awareness-lib.mjs`, the check behind CI's guard-regression suite, against the files on disk with CRLF turned back into LF. A Windows builder that pins the CRLF hash of a candidate migration now fails locally instead of after a push (PR #1316 commit `0b90a1767` pinned `bcde8359…` instead of `6260401d…`).
- The mismatch reason now names the migration file.
- Proof: PR #1316's record and migration (CRLF on disk) restored from `0b90a1767` made `check:docs` exit 1; the same record with the LF hash made it exit 0.
