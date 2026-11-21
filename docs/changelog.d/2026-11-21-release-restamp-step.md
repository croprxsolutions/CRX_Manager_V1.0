## 2026-11-21 - Ship workflow: open the docs re-stamp PR right after a release's live applies

- `.claude/commands/ship.md` (Staging section) gains one step: after the release's last live apply, a read-only `list_migrations`, then a docs-only `hotfix/<name>` PR into `main` moving the `CURRENT_STATE.md` and `KNOWN_ISSUES.md` "Last verified" stamps to today's Chicago date and the newest live row.
- Why: after release #1990 the main → staging back-merge (#2099) failed the docs freshness check on stale stamps, and staging waited about 2.5 hours for hotfix #2101. The re-stamp PR is now ready before the release merges.
