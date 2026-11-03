## 2026-11-02 - Commit refuses a migration stamp another worktree already uses

The pre-commit SQL check (`scripts/validate-sql.sh`) now refuses a newly added migration whose version stamp is already taken by a different file in another local worktree, naming that worktree and file. Two parallel sessions picked the same stamp twice on 2026-11-02 and it was only caught by hand hours later. The identical file checked out in several worktrees still passes. Test: `scripts/check-migration-stamp-collision.test.mjs`.
