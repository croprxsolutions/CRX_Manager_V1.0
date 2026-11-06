# Sol-required paths

**Rule (Mason, 2026-10-30; cut to three areas 2026-11-01; gate files added back 2026-11-06):**
a pull request needs one clean Sol review only when it changes, deletes, renames or moves a
file below: the database, logins and permissions, money and inventory, or the files that
enforce the Sol, migration-apply and owner-approval gates. Every other change merges on
green checks, with the head pinned by `--match-head-commit`. That includes dependencies,
deployment files, and the other hooks, guards and scripts. This replaces the
2026-10-07 documentation exemption and the 2026-10-29 "every code change" rule, which cost
more review time than they repaid.

The merge guards enforce this: `.claude/hooks/pr-merge-guard.mjs` and
`.codex/hooks/production-action-guard.mjs` both call `.claude/hooks/sol-risk-lib.mjs`.
That module is the source of truth, and `.claude/hooks/sol-risk-lib.test.mjs` fails if a
listed entry is missing here.

The guard reads GitHub's compare of the pull request's base and head, which lists the pull
request's own changes even when main has moved on. A failed GitHub call, a comparison that
does not end at the head, a list of 250 files or more, or an unknown change status all
answer "Sol required".

## Always

**Money and inventory code:** any file under `src/` whose name carries a money word
(`MONEY_PATH_WORDS` in `.claude/hooks/codex-bot-review-lib.mjs`, deliberately broad).

## Paths

Folders end in `/`. The match ignores case, from the repository root.

**Database and Edge Functions:** `supabase/`

**Logins and permissions:** `src/components/auth/`, `src/contexts/AuthContext.tsx`,
`src/lib/db.ts`, `src/lib/pagePermissions.ts`, `src/App.tsx`, `src/appPages.tsx`,
`src/routeBaseline.json`, `src/pages/SettingsPage.tsx`

**Money and inventory files with no money word in their name:** `src/pages/MonthEndClose.tsx`,
`src/pages/Rebates.tsx`, `src/pages/Receiving.tsx`, `src/pages/Integrity.tsx`, `src/pages/LotTrace.tsx`,
`src/pages/CustomerTransactionReview.tsx`, `src/pages/OfflineWorkReview.tsx`, `src/pages/JobDetail.tsx`,
`src/pages/ProductDetail.tsx`, `src/pages/Products.tsx`, `src/pages/OfficeCockpit.tsx`, `src/pages/Reports.tsx`,
`src/pages/ApplicationServiceDetail.tsx`, `src/pages/CustomerDetail.tsx`, `src/lib/offlineSync.ts`, `src/lib/offlineQueue.ts`,
`src/lib/jobChemicalPayload.ts`, `src/lib/recipeHelpers.ts`, `src/hooks/useGuardrails.ts`,
`src/components/products/BulkProductImport.tsx`, `src/components/products/bulkProductImportSafety.ts`,
`src/components/receiving/`, `src/components/integrity/`, `src/components/field-app/`

**The gates themselves (Mason, 2026-11-06):** a change that could weaken a gate must not
land on green checks alone. `.claude/hooks/sol-risk-lib.mjs`, `.claude/hooks/codex-bot-review-lib.mjs`
(the money word list), `.claude/hooks/codex-push-lib.mjs`, `.claude/hooks/pr-merge-guard.mjs`,
`.claude/hooks/migration-apply-guard.mjs`, `.claude/hooks/migration-apply-lib.mjs`,
`.claude/hooks/migration-landing-gate-lib.mjs`, `.claude/hooks/migration-access-lib.mjs`,
`.claude/hooks/owner-approval-lib.mjs`, `.codex/hooks/production-action-guard.mjs`,
`scripts/write-codex-push-proof.mjs`, `scripts/write-apply-proofs.mjs`,
`scripts/apply-migration-file.mjs`, `scripts/owner-approve-migration.mjs`, and
`scripts/check-agent-workflows.mjs`, which fails CI if a gate hook is unwired from
`.claude/settings.json` or `.codex/hooks.json`. Those two wiring files change too often for
routine reasons to put behind Sol, so that CI check guards them instead. The gate files' tests and every
other hook stay off the list.

## What stays separate

A migration still needs a Sol proof bound to its exact head before it applies (a full
review, or a carry-forward of one after a clean merge of main, since 2026-11-03); the apply gate
checks that on its own. To change this list, change the module and this page in one pull
request. Since 2026-11-06 the module is on the list itself, so that pull request needs Sol;
widening or narrowing the list stays Mason's decision.
