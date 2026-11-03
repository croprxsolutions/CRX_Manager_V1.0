## 2026-11-02 - Stamp check also covers renamed migrations

- `scripts/validate-sql.sh` now lists staged migrations with `--no-renames`, so a committed migration renamed onto another worktree's stamp counts as added and is refused instead of skipped (Codex App review on PR #1304).
- `scripts/check-migration-stamp-collision.test.mjs` adds the renamed-migration case; it failed before the change and passes after.
