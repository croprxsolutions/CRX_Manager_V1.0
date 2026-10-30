---
name: update-docs
description: Audit project reference documentation for drift from the codebase without putting volatile counts in always-loaded agent guidance.
---

# Documentation Audit & Update

Audit the CRX_Manager_V1.0 documentation for drift against the actual codebase. Follow each step, compare actual counts to documented counts, and fix any mismatches.

## Step 1: Gather Actual Counts

Run these commands and record each result:

```bash
# Page count (lazy-loaded pages: the shared page list plus App.tsx's dev gallery)
cat src/appPages.tsx src/App.tsx | grep -c "lazy("

# Migration count (SQL files in migrations folder)
ls supabase/migrations/*.sql | wc -l

# Edge Function count (exclude the _shared helper directory)
find supabase/functions -mindepth 1 -maxdepth 1 -type d ! -name _shared | wc -l

# Unit test file count
find src -name "*.test.ts" -o -name "*.test.tsx" | wc -l

# E2E test file count (this repo uses tests/e2e, not e2e)
find tests/e2e -name "*.spec.ts" -o -name "*.test.ts" 2>/dev/null | wc -l
```

## Step 2: Check Reference-Doc Counts

Keep changing counts in the reference documents that own them:

- Page count: `docs/reference/pages-routes.md`
- Migration count and inventory: `docs/reference/migration-history.md`
- RPC/trigger counts: `docs/reference/rpc-functions.md`
- Table/schema counts: `docs/reference/database-schema.md`
- Test counts: `TESTING.md` when that file makes an explicit current claim

Do not add these counts to `AGENTS.md` or `CLAUDE.md`; both are always-loaded guidance and should remain stable. Run `npm run check:agent-guidance` to enforce that boundary.

## Step 3: Check migration-history.md

Read `docs/reference/migration-history.md`. Then list all actual migration files:

```bash
ls supabase/migrations/
```

Compare the lists. If any migration file exists on disk but is NOT in the migration history
table, add a new row. The filename gives the timestamp and a slug, and that is **all** it gives.

**Never infer applied/planned/rolled-back status from a filename.** A file on disk proves only
that the migration was written. To state whether it is live, check the live database read-only
(Supabase MCP `list_migrations` on project `rhyzpcqhnizqbxphqdkr`) and record what you actually
observed. If you did not check, write the row with the status left explicitly unknown rather
than guessing — a fabricated "applied" row is worse than a blank one.

Every migration needs exactly **one** table row whose second cell is its version: `check:docs`
fails a migration from 2026-09-15 on with no row or with two. Update a row's status in place;
never add a second row for the same migration. The file merges with git's union driver
(2026-10-29), so if a main merge leaves two versions of one row or line, reconcile them into one.
The title carries no count. Give a new row the next number, but refer to migrations by version or
file name, since two PRs can take the same number. A new live capture goes at the top with its UTC
time; captures may sit in any order, so the newest timestamp is the latest evidence.

**Manual docs' "Last verified" line** (`docs/manual/*.md`) is one short line, at most 200
characters: the date (America/Chicago) and the scope you re-checked, e.g. "for the migration ledger
only". `check:docs` fails a longer line or a second one. The evidence of what you read goes in your
PR's `docs/changelog.d/` note, never on the stamp line. Bump the date only after re-reading the doc
against live state. In `DECISION_LOG.md`, correct or reverse a decision with a NEW entry that names
the one it supersedes; do not rewrite an old entry's rule, and do not bump its stamp for a new entry.

## Step 4: Check pages-routes.md

Read `docs/reference/pages-routes.md`. Then extract all lazy-loaded pages from the shared page list (App.tsx keeps only the dev gallery's):

```bash
grep "lazy(" src/appPages.tsx src/App.tsx
```

Also check the route definitions to find paths. Signed-in routes are the `routes` of each page in
`src/appPages.tsx` (`App.tsx` builds the `createBrowserRouter` routes from them and keeps the
sign-in pages and the two `invoices/field-app/*` routes), so the paths are object properties
(`path:`), not JSX attributes (`path=`). Some sit inline after `routes: [`, so match anywhere on
the line:

```bash
grep -noE "path: '[^']+'" src/appPages.tsx src/App.tsx
```

If any page exists in src/appPages.tsx or App.tsx but is NOT in pages-routes.md, add it with its route path and a short description. Update the page count in the title if it changed.

## Step 5: Check database-schema.md

Read `docs/reference/database-schema.md` (the table listings).

The live database **is** reachable read-only through the Supabase MCP connector (project
`rhyzpcqhnizqbxphqdkr`) — prefer it, because it is the only thing that proves what actually
exists. Use `list_tables`, or `execute_sql` against `information_schema` / `pg_policies`, and
diff that against `database-schema.md`. Never mutate live state from this skill.

Fall back to scanning migrations only when the connector is unavailable, and say so in the
summary. Scan **all** table-creating migrations, not just the newest few — an older undocumented
table stays invisible forever if you only ever look at the tail:

```bash
grep -l "CREATE TABLE" supabase/migrations/*.sql
```

For each, verify that table appears in database-schema.md. If not, add it under the correct
domain section. Also check for new RLS policies in those migrations.

## Step 6: Check rpc-functions.md

Read `docs/reference/rpc-functions.md`.

Prefer the live catalog (Supabase MCP `execute_sql`, read-only, against `pg_proc` joined to
`pg_namespace` where `nspname = 'public'`) — it reflects what is really callable, including
overloads. Fall back to scanning migrations when the connector is unavailable, and scan all of
them rather than the tail:

```bash
grep -l "CREATE.*FUNCTION" supabase/migrations/*.sql
```

For each, verify it appears in rpc-functions.md. If not, add it under the correct category.

## Step 7: Cross-Check Other Docs

If any counts changed, also check:
- `README.md` — does it mention page/table/RPC counts? Update if so.
- `TESTING.md` — does it mention test counts? Update if so.
- `DEPLOYMENT.md` — does it list Edge Functions? Update if a new one was added.

## Step 8: Print Summary

After all checks, print a summary table:

```
=== Documentation Audit Results ===

| Item               | Documented | Actual | Status  |
|--------------------|-----------|--------|---------|
| Pages              | XX        | XX     | OK / UPDATED |
| Migrations         | XX        | XX     | OK / UPDATED |
| Edge Functions     | XX        | XX     | OK / UPDATED |
| Test files         | XX        | XX     | OK / UPDATED |
| E2E test files     | XX        | XX     | OK / UPDATED (vs TESTING.md) |
| migration-history  | —         | —      | OK / X entries added |
| pages-routes       | —         | —      | OK / X entries added |
| database-schema    | —         | —      | OK / X tables added |
| rpc-functions      | —         | —      | OK / X functions added |

Files modified: [list files that were changed, or "None — all docs are current"]
```

If you made any changes, remind the user to include the doc updates in their next commit.
