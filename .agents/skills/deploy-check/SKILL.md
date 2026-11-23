---
name: deploy-check
description: Read-only pre-PR checklist for CRX Manager — is this branch safe to open a PR for and land? Knows the staging-first flow (feature PRs merge into staging; only the weekly release and hotfixes reach main and production). Use before opening or merging a PR. It lands nothing; landing is /ship Step 8.
---

# Deploy check

A read-only checklist. It lands nothing. Where anything here differs from `.claude/commands/ship.md`, ship.md wins.

**How code reaches production.** A feature branch merges into `staging` (its own Vercel site and test database). Only `release/next` (weekly) and `hotfix/<name>` merge into `main`, by Taha or Mason; that merge deploys croprxsolutions.app. Direct pushes to `main` and `staging` are impossible.

## Checklist

1. **Branch:** `git status --short --branch`, then `git fetch origin && git rev-list --left-right --count origin/staging...HEAD` (a hotfix: `origin/main`). On `main` or `staging` → branch first. Uncommitted changes → WARN.
2. **Code:** `npm run lint && npm run typecheck && npm run check:code-health && npm run build && npm run test` (plus `npm run test:agent-workflows` for agent-surface changes). Any failure → BLOCKED.
3. **Secrets:** `git ls-files | grep -i "\.env"` and `grep -rlE "service_role|sk_live|sk_test|SUPABASE_SERVICE" src/ --include="*.ts" --include="*.tsx"`. Any hit → BLOCKED.
4. **Bundle:** `ls -lh dist/assets/*.js | head -5`; WARN on any chunk over 500 KB.
5. **Migrations:** list the branch's new `supabase/migrations/*.sql`. A feature PR's migration is applied to the staging database by the `Database` workflow after merge, never by hand. A hotfix or release migration is applied live before the merge through `scripts/apply-migration-file.mjs` (ship.md Step 5, Step 8 item 5). Destructive ones need Mason's approval of that exact file. Never `supabase db push`.
6. **Sol:** `npm run sol-needed -- <n>` (or the Step 0.5 check in ship.md before a PR exists). On the list → a clean Sol proof on the head is required.
7. **Taha:** a PR touching his hold list waits 4 hours (ship.md Step 8 item 4a); never push to his branches.

## Report

```
DEPLOY CHECK — <branch>
Behind base: X   Clean tree: YES/NO   Last commit: <hash> <msg>
Lint/Typecheck/Build: PASS   Tests: X/Y   Secrets: NONE   Largest chunk: XXX KB
Migrations: <none | N, staging job | N, live apply before merge>
Sol: <needed / not needed>   Taha hold: <yes until HH:MM / no>
Verdict: READY FOR PR / BLOCKED (<each issue>)
```

Then hand to `/ship` Step 8. Edge Function deploys, direct `vercel --prod` deploys and data deletion always need Mason's explicit yes.
