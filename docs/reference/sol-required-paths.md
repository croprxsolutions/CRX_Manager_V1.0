# Sol-required paths

**Rule (Mason, 2026-10-30):** a pull request needs one clean Sol review only when it
changes, deletes, renames or moves a file below. Every other change merges on green
checks, with the head pinned by `--match-head-commit`. This replaces the 2026-10-07
documentation exemption and the 2026-10-29 "every code change" rule, which cost more
review time than they repaid.

The merge guards enforce this: `.claude/hooks/pr-merge-guard.mjs` and
`.codex/hooks/production-action-guard.mjs` both call `.claude/hooks/sol-risk-lib.mjs`.
That module is the source of truth, and `.claude/hooks/sol-risk-lib.test.mjs` fails if a
listed entry is missing here.

The guard reads GitHub's compare of the pull request's base and head, which lists the pull
request's own changes even when main has moved on. A failed GitHub call, a comparison that
does not end at the head, a list of 250 files or more, or an unknown change status all
answer "Sol required".

## Always

- **Money and inventory code:** any file under `src/` whose name carries a money word
  (`MONEY_PATH_WORDS` in `.claude/hooks/codex-bot-review-lib.mjs`, deliberately broad).
- **Dependencies, in any folder:** `package.json`, `package-lock.json`,
  `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `deno.lock`, `.npmrc`.

## Paths

Folders end in `/`. The match ignores case, from the repository root.

**Database and Edge Functions:** `supabase/`

**Logins and permissions:** `src/components/auth/`, `src/contexts/AuthContext.tsx`,
`src/lib/db.ts`, `src/lib/pagePermissions.ts`, `src/App.tsx`, `src/appPages.tsx`,
`src/routeBaseline.json`

**Money and inventory screens:** `src/pages/`, `src/lib/offlineSync.ts`, `src/lib/offlineQueue.ts`,
`src/lib/jobChemicalPayload.ts`, `src/lib/recipeHelpers.ts`, `src/hooks/useGuardrails.ts`,
`src/components/products/BulkProductImport.tsx`, `src/components/products/bulkProductImportSafety.ts`,
`src/components/receiving/`, `src/components/integrity/`, `src/components/field-app/`

**Deployment and CI:** `.github/`, `.husky/`, `vercel.json`, `vite.config.ts`, `index.html`,
`public/sw-doctor.js`, `.gitmodules`, `scripts/vercel-ignore-build.sh`, `scripts/classify-ci-scope.mjs`

**Hook wiring:** `.claude/settings.json`, `.claude/settings.local.json`, `.codex/hooks.json`,
`.claude/hooks/hook-router-runtime.mjs`, `.claude/hooks/posttool-router.mjs`, `.claude/hooks/prompt-router.mjs`,
`.codex/hooks/codex-hook-adapter.mjs`

**Merge, push and review gates:** `.codex/hooks/production-action-guard.mjs`,
`.claude/hooks/bash-safety.mjs`, `.claude/hooks/bash-safety-lib.mjs`,
`.claude/hooks/codex-bot-review-lib.mjs`, `.claude/hooks/codex-push-guard.mjs`,
`.claude/hooks/codex-push-lib.mjs`, `.claude/hooks/merge-guard-launcher.mjs`,
`.claude/hooks/pr-merge-guard.mjs`, `.claude/hooks/review-proof-guard.mjs`,
`.claude/hooks/sol-risk-lib.mjs`, `scripts/write-codex-push-proof.mjs`, `.claude/hooks/app-repo-identity.mjs`,
`.claude/hooks/coderabbit-skip-lib.mjs`, `.claude/hooks/read-only-search-lib.mjs`,
`.claude/hooks/session-context-reminder.mjs`, `.claude/hooks/autopilot-lib.mjs`,
`.claude/hooks/changelog-entry-lib.mjs`, `scripts/run-claude-review.mjs`, `scripts/overnight-codex-gate.mjs`

**Secrets:** `.claude/hooks/env-guard.mjs`

**Migration proofs and database rules:** `.claude/hooks/mcp-tool-guard.mjs`,
`.claude/hooks/migration-apply-guard.mjs`, `.claude/hooks/migration-apply-lib.mjs`,
`.claude/hooks/migration-landing-gate-lib.mjs`, `.claude/hooks/migration-pending-lib.mjs`,
`.claude/hooks/money-safety.mjs`, `.claude/hooks/owner-approval-lib.mjs`,
`.claude/hooks/owner-approval-prompt.mjs`, `.claude/hooks/rls-on-new-tables.mjs`,
`.claude/hooks/sql-safety.mjs`, `scripts/apply-migration-file.mjs`,
`scripts/check-migration-hard-rules.mjs`, `scripts/owner-approve-migration.mjs`,
`scripts/validate-sql-migrations.sh`, `scripts/write-apply-proofs.mjs`,
`scripts/write-apply-proofs-lib.mjs`, `.claude/agents/migration-drift-reviewer.md`,
`.claude/agents/rls-security-reviewer.md`, `.claude/hooks/live-testdata-guard.mjs`,
`.claude/hooks/live-testdata-lib.mjs`, `.claude/hooks/migration-access-lib.mjs`,
`.claude/hooks/migration-ordering-lib.mjs`, `.claude/hooks/migration-wrappability-lib.mjs`,
`.claude/hooks/grant-change-guard.mjs`, `.claude/hooks/idempotency-body-check.mjs`,
`.claude/hooks/actor-binding-check.mjs`, `.claude/hooks/status-enum-check.mjs`,
`.claude/hooks/generated-column-check.mjs`, `.claude/hooks/edit-splice-lib.mjs`,
`.claude/hooks/registry-freshness-lib.mjs`, `.claude/hooks/ledger-lock-lib.mjs`,
`.claude/hooks/applied-snapshot-invalidate.mjs`, `scripts/refresh-applied-migrations.mjs`,
`scripts/remove-applied-ledger-entry.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`

## What stays separate

A migration still needs an exact-head Sol proof before it applies; the apply gate
checks that on its own. To change this list, change the module and this page in one pull
request. That pull request touches `.claude/hooks/sol-risk-lib.mjs`, so it needs Sol.
