# `docs/manual/known-issues.d/` — one file per new known issue

Record each NEW known issue as a new file in this folder instead of adding it to
`docs/manual/KNOWN_ISSUES.md` (Mason, 2026-11-22). `KNOWN_ISSUES.md` stays as the curated
list; it is not rolled up or moved, and readers read it and this folder together.

## Why

Every PR that added an entry to `KNOWN_ISSUES.md` went DIRTY on GitHub as soon as a sibling
PR that also touched it merged, and each fix moved the head off its Sol proof. A new file per
issue cannot conflict. It also leaves the file's "Last verified" stamp alone, so adding an
issue no longer forces a live-ledger re-check.

## How

Create `docs/manual/known-issues.d/<YYYY-MM-DD>-<pr-or-slug>.md`, for example
`2026-11-22-receipt-retry-gap.md`, with a distinctive word in the slug:

```text
## YYYY-MM-DD — <plain-English title>

**Severity:** HIGH / MED / LOW. **Area:** <area>. **Status:** OPEN / PARTIAL / ACCEPTED / UNVERIFIED.
**Owner:** <named person or "unassigned">. **Tracked:** #<issue or PR>, if any.

What is wrong, in plain English, and what it affects. Say what changes, never how to exploit
a hole that is not fixed yet.
```

Do not pick a new `KI-<n>` number; the slug and date identify the entry, so two PRs never
take the same number. When the issue is fixed, delete its file in the fixing PR and say so in
that PR's `docs/changelog.d/` note. Editing or closing an item that already lives in
`KNOWN_ISSUES.md` still edits that file.

## Who reads this folder

- **People and agents** checking whether a problem is new: search this folder AND
  `KNOWN_ISSUES.md`.
- **Ledger guards** (`scripts/check-ledger-update.mjs`, `.claude/hooks/stop-wrap.mjs`): a file
  here counts as the record for a migration or a session's commits.
- **Post-apply carry** (`scripts/write-codex-push-proof.mjs --carry-post-apply`): adding or
  editing a file here counts as post-apply paperwork, like editing `KNOWN_ISSUES.md`.

`README.md` is never read as an entry.
