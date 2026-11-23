---
name: deploy-check
description: Pre-PR checklist (changes no tracked file) for CRX Manager — is this branch safe to open a PR for and land? Knows the staging-first flow (feature PRs merge into staging; only the weekly release and hotfixes reach main and production). Use before opening or merging a PR. It lands nothing; landing is /ship Step 8.
---

# Deploy check

A checklist. It changes no tracked file and lands nothing (`git fetch` and `npm run build` only update local refs and `dist/`). Where anything here differs from `.claude/commands/ship.md`, ship.md wins.

**How code reaches production.** A feature branch merges into `staging` (its own Vercel site and test database). Only `release/next` (weekly) and `hotfix/<name>` merge into `main`, by Taha or Mason; that merge deploys croprxsolutions.app. Direct pushes to `main` and `staging` are impossible.

## Checklist

1. **Branch:** `git status --short --branch`, then `git fetch origin && git rev-list --left-right --count origin/staging...HEAD` (`hotfix/` and `release/` branches: `origin/main`). On `main` or `staging` → branch first. Uncommitted changes → WARN.
2. **Code:** `npm run lint && npm run typecheck && npm run check:code-health && npm run build && npm run test` (plus `npm run test:agent-workflows` for agent-surface changes, and `node scripts/verify-deps.mjs` when `package.json` or `package-lock.json` changed). Any failure → BLOCKED.
3. **Secrets:** `git ls-files | grep -iE '(^|/)\.env($|\.)' | grep -v '\.example$'` and `grep -rlE "service_role|sk_live|sk_test|SUPABASE_SERVICE" src/ supabase/functions/ scripts/`. Never print a hit's value: list matching lines with `grep -rnoE "service_role|sk_live|sk_test|SUPABASE_SERVICE" src/ supabase/functions/ scripts/` (file, line and the matched word only), and judge from the variable name and file whether it is a real credential (→ BLOCKED, tell Mason the file, not the value) or a name or placeholder (fine). This scan is narrow: report its result as "no hits in scanned paths", never as proof the branch has no secrets.
4. **Bundle:** `ls -lhS dist/assets/*.js | head -5` (largest first); WARN on any chunk over 500 KB.
5. **Migrations:** list the branch's new `supabase/migrations/*.sql`. A feature PR's migration is applied to the staging database by the `Database` workflow after merge, never by hand. A hotfix or release migration is applied live before the merge through `scripts/apply-migration-file.mjs` (ship.md Step 5, Step 8 item 5). A destructive one may merge into `staging`, but its live apply needs Mason's approval of that exact file. Never `supabase db push`.
6. **Sol:** `npm run sol-needed -- <n>` (or the Step 0.5 check in ship.md before a PR exists). On the list → a clean Sol proof on the head is required.
7. **Taha:** a PR touching his hold list waits 4 hours (ship.md Step 8 item 4a); never push to his branches.

## Report

```
DEPLOY CHECK — <branch>
Behind base: X   Clean tree: YES/NO   Last commit: <hash> <msg>
Lint/Typecheck/Build: PASS   Tests: X/Y   Secrets: no hits in scanned paths   Largest chunk: XXX KB
Migrations: <none | N, staging job | N, live apply before merge>
Sol: <needed / not needed>   Taha hold: <yes until HH:MM / no>
Verdict: READY FOR PR / BLOCKED (<each issue>)
```

Then hand to `/ship` Step 8. Edge Function deploys, direct `vercel --prod` deploys and data deletion always need Mason's explicit yes.
