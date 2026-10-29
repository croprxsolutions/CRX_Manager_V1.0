## 2026-10-28 - Repair draft invoice-cap CI documentation checks

PR #1174's CI identified the missing migration index entry and stale manual
verification stamps. Registered the unapplied candidate as migration-history
entry 1000 and refreshed CURRENT_STATE / KNOWN_ISSUES with scoped, read-only
live evidence: 1075 ledger rows, latest version 20261028121259, with the new
order-cap helpers absent. These records do not claim the change is live.

Added an exact-branch `git.deploymentEnabled` rule in `vercel.json` for
`codex/invoice-delivered-caps-20261028` so CI fix pushes do not create Vercel
deployments. Unspecified branches keep Vercel's default behavior. No CI checks,
review gates or production project settings were changed.

Superseded by the 2026-10-29 restamp entry: the migration-history entry is now
1002, CURRENT_STATE was not changed, and the `vercel.json` rule was dropped.

The PR remains a draft. No merge, migration application or deployment is
authorized by this follow-up. The previous independent Sol draft review binds
to the earlier commit and must not be represented as reviewing these additions.
