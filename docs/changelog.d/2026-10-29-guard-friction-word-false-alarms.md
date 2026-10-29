## 2026-10-29 — Guard friction, part 1: word false alarms and noisy reminders

Mason asked to remove guard friction ("stop blocking on certain words like ... truncate").
A Sol plan review split the work into five PRs; this is the first, and it changes no
merge, push, migration-apply or secret gate.

- **`review-proof-guard.mjs`:** a plain search whose double-quoted pattern contains a `|`
  (`grep -n "truncate\|TRUNCATE" .claude/hooks/sql-safety.mjs`) was refused, because the
  text after the `|` was read as a `truncate` command. Such a command is now split outside
  its quotes, but only when it uses double quotes alone (no single quotes, backticks,
  escaped quotes or substitutions), redefines no command, and every piece is a program the
  existing read-only allowlist vouches for. Anything else keeps the old reading. Real
  writes stay refused; the tests pin both directions.
- **`bash-safety-lib.mjs`:** `DROP TABLE`/`DROP SCHEMA`/`TRUNCATE` now counts as a live
  wipe only beside a database client (`psql`, `pgcli`, `supabase sql`). A bare `-c`
  used to count, so `grep -c TRUNCATE file` was refused.
- **`ship-intent-reminder.mjs`:** unwired from `prompt-router.mjs`. Its word list matched
  nearly every message and added the `/ship` text and landing policy each time; `AGENTS.md`
  states both every session. The file stays (unwired) because the review proof guard
  reserves deleting hook files for Mason.
- **`posttooluse-migration.mjs`:** the eight-step migration checklist is shown in full once
  per migration file per session; later edits of the same file get a one-line pointer.

Remaining enforcement: branch protection and CI for guard files, the unchanged
`live-testdata-guard` for live SQL, and `AGENTS.md` for the delivery flow.

Known leftover: a search that names both `psql` and `DROP TABLE` (or `TRUNCATE`) is still
refused by `bash-safety`; it cannot tell a search from a real client call.
