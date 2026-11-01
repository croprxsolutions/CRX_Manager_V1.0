# `docs/reference/migrations.d/`: one file per migration

Each migration's record is a **new file in this folder**, not a row in
`docs/reference/migration-history.md`, which froze on 2026-11-01.

## Why

`migration-history.md` was one 2,245-line file that every migration PR edited, with rows
sitting next to each other. Any two PRs collided there, GitHub reported a conflict, and on
2026-10-31 and 2026-11-01 that repeatedly blocked finished PRs. The fix follows
`docs/changelog.d/`: each migration owns a file, so two PRs have nothing to collide on.

## How

Name the file exactly after the migration, with `.md` in place of `.sql`:

```text
supabase/migrations/20261102090000_example_change.sql
docs/reference/migrations.d/20261102090000_example_change.md
```

The **first paragraph** is the record, written the way a table row's description was: status
first, then the backticked migration file name, then what it does. It must start with one of
`**LOCAL CANDIDATE — NOT APPLIED`, `**APPLIED LIVE`, `**RETIRED CODE-ONLY ARTIFACT`, `**SUPERSEDED`
or `**STATUS UNKNOWN`, and it must name the record's own `.sql` file.

```markdown
**LOCAL CANDIDATE — NOT APPLIED.** PR #1234: `20261102090000_example_change.sql` (SQL sha256: `<64 hex>`). One or two plain sentences on what it does.
```

When the migration goes live, edit the same file. Replace the status and keep the rest:

```markdown
**APPLIED LIVE 2026-11-02 14:36:42 UTC (9:36 AM Central)**, ledger version `20261102143642` carrying name `20261102090000_example_change`. PR #1234: `20261102090000_example_change.sql`. One or two plain sentences on what it does.
```

Anything after the first blank line is free notes for people, such as live captures: read-only
ledger evidence with its UTC time. The gates read only the first paragraph, so a note may
name other migrations. A capture with no single migration goes in the PR's
`docs/changelog.d/` note.

A candidate record keeps the same rules as before: the words `LOCAL CANDIDATE` then `NOT APPLIED`,
exactly one backticked `<version>_<name>.sql` in the first paragraph, and at most one
`` SQL sha256: `<hex>` `` pin. If a live apply renames the migration file, rename the record too.

## What enforces this

`npm run check:docs` fails when a migration from 2026-09-15 on has no record or more than one,
when a record and a `.sql` file do not match by name in either direction, and when a new row or
live capture lands in the frozen file. A misnamed or empty record, or one that lacks its status or
file name, stops the check, and parked-migration reports show UNKNOWN rather than a false clean
count.

`.claude/hooks/migration-records-lib.mjs` turns each record into one row and joins it to the
frozen text, so every migration gate reads both.
