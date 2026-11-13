## 2026-11-13 - Release flow: fixes from the #1838 review

Mason's agents reviewed #1838 (with a blind Sol second opinion) and found gaps that matter on release day. Each is now enforced:

- **Hotfix migration order:** a hotfix migration stamped above a migration waiting for the release (on `staging` or in an open PR into it) is refused by the live-apply gate; `next-migration-stamp --hotfix --live <high-water>` picks a stamp that fits. A new staging migration must also be newer than main's newest.
- **The guard can't vote for itself:** the gate refuses a release or hotfix whose `.github/workflows` differs from main's, a guard run started before switch-on, a release head that no longer contains staging's tip, and a fork's branch. Agents never approve a PR (both guards).
- **Hotfixes carry no staging work:** cherry-picked commits, copied files and copied lines (added or deleted, 20 characters or more) are refused, unless Taha adds `hotfix-backport` after the latest push.
- **The database never runs ahead of the app for long:** an agent applies a release or hotfix migration live only within 30 minutes of Taha's `Ready to merge: <head sha>` comment from his own account. That comment also freezes agent merges into `staging` until the release merges.
- **Destructive migrations** are merged into `staging` by Taha or Mason, never an agent.
- Docs: branches cut from `origin/staging`; rollback through `hotfix/revert-<name>` (`git revert -m 1` for merge commits); the release's migration list from its own SHAs; held-off migrations need a revert PR.

**Known limits (Taha accepted):** a short copied line (under 20 characters) in a hotfix isn't detected, and the person merging the hotfix sees the whole diff. After a hotfix, staging runs it after the waiting migrations, the other way round from live, so the hotfix PR says whether they touch the same tables. A human merge into `staging` during a release only delays the remaining applies: the gate refuses them until the release is refreshed.

**Live-state docs:** `CURRENT_STATE.md` and `KNOWN_ISSUES.md` re-verified for the live ledger on 2026-11-13 (America/Chicago) by a read-only `list_migrations` (with Taha's OK): 1,207 rows, newest `20261113011216` = `20270109100000_delivery_receipt_brands`. Nothing either doc says about the ledger is contradicted by it; only their stamps moved.
