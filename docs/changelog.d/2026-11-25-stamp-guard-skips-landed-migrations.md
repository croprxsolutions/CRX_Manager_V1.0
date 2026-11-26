## 2026-11-25 - Migration stamp guard no longer blocks migrations that already landed

- `scripts/check-migration-stamp-collision.mjs` (pre-commit, via `scripts/validate-sql.sh`) now skips an added migration whose staged content matches the same path on `origin/staging` or `origin/main`. Merging `origin/staging` into a feature branch stages every migration staging gained as an added file; an older draft of one of them in a stale worktree falsely blocked the commit ("Version stamp … is already used").
- Still enforced: a new migration reusing a stamp, or a changed copy of a landed one, is refused as before; if neither ref can be read the check runs as before; the apply-time migration ordering re-check is unchanged.
- Proof: `node scripts/check-migration-stamp-collision.test.mjs` (landed file passes despite a stale draft; changed copy and new same-stamp file still blocked).
