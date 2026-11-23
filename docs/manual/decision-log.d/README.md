# `docs/manual/decision-log.d/` — one file per decision

Write each NEW decision-log entry as a new file in this folder instead of adding it to
`docs/manual/DECISION_LOG.md` (Mason, 2026-11-22). `DECISION_LOG.md` stays as the history;
it is not rolled up or moved, and readers read it and this folder together.

## Why

Every PR that added an entry to `DECISION_LOG.md` went DIRTY on GitHub as soon as a sibling
PR that also added one merged (GitHub ignores the local `merge=union` driver). Each merge of
staging to fix it moved the head off its Sol proof and forced a full Sol rerun. Two PRs never
write the same new file, so they cannot conflict here.

## How

Create `docs/manual/decision-log.d/<YYYY-MM-DD>-<pr-or-slug>.md`, for example
`2026-11-22-pr2270-sol-round-trade-off.md`. Put a distinctive word in the slug. Write the
entry exactly as you would have in `DECISION_LOG.md`:

```text
## YYYY-MM-DD — <decision title>

**Decision (Mason, …):** one sentence — what was decided.
**Why:** plain English.
**What this forbids/implies:** the operative rule an agent must follow.
```

One entry per file. Date it today (Central time) or earlier. Never rewrite or delete a past
entry; reverse a decision with a new file that names the old one.

## Who reads this folder

- **Sol round 5+ stop** (`scripts/write-codex-push-proof.mjs`, `decisionLogAt`): an entry
  dated today or later, with a `**Decision` line naming Mason and naming the PR as `#<n>`,
  unlocks the round, whether it is in `DECISION_LOG.md` or in a file here. Each file is read
  on its own, so text in one file never joins another file's entry.
- **Future-date pre-flight** (same script): a `## <date>` or `**Decision (Mason, <date>)` line
  added here dated after today refuses before Sol runs.
- **Ledger guards** (`scripts/check-ledger-update.mjs`, `.claude/hooks/stop-wrap.mjs`): a file
  here counts as the record for a migration or a session's commits.
- **People and agents** searching settled decisions: search this folder AND `DECISION_LOG.md`.

**Exception:** `node scripts/owner-accept-sol-finding.mjs --log` still writes Mason's
owner-accept entry into `DECISION_LOG.md`, because the owner-accepted carry and the release
check (`.github/scripts/release-flow.mjs`) expect exactly that file. Moving it needs a
separate `.github/` PR that Mason or Taha merges by hand.

`README.md` is never read as an entry.
