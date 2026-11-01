# Sol-required paths

**Rule (Mason, 2026-10-30; cut to three areas 2026-11-01):** a pull request needs one
clean Sol review only when it changes, deletes, renames or moves a file below: the
database, logins and permissions, or money and inventory. Every other change merges on
green checks, with the head pinned by `--match-head-commit`. That includes dependencies,
deployment files, and the hooks, guards and scripts themselves. This replaces the
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

## What stays separate

A migration still needs an exact-head Sol proof before it applies; the apply gate
checks that on its own. To change this list, change the module and this page in one pull
request. Since 2026-11-01 that pull request is off the list itself, so it lands on green
checks; widening or narrowing the list stays Mason's decision.
