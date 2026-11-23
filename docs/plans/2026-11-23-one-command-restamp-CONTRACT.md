# Behavior contract: one-command migration restamp (2026-11-23)

Read at `origin/staging` `f91774df2`.

## Outcome

A PR whose migration stamp went stale in the merge queue is re-dated with one command, and its clean Sol
proof carries to the restamped head without a model run, whenever only the stamp changed. Anything more
than a stamp change still needs a full Sol review.

## Facts

- The PR check refuses a new migration whose stamp is not above the base branch's newest
  (`stampProblems`, `.github/scripts/db-apply.mjs:156`). That keeps live (main) applying in stamp order
  the same order staging ran them. Unchanged.
- `--carry-restamp` (`scripts/write-codex-push-proof.mjs` `restampProblem`) requires byte-identical SQL
  and every other file equal to the old one with the stamp swapped.
- 2026-11-23 restamps: #2338 (`31436d84de`) changed only the SQL's header comment
  (`-- docs/reference/migrations.d/<stamp>_....md`) and so the record's `SQL sha256` pin; the carry
  refused on both. #2331 (`b2b579c97d`) was a clean restamp. #2248 and #2324 were done by hand;
  #2324 also changed SQL, which correctly needs Sol.
- Gates trust the proof's `carry.mode`; the judgment lives only in `restampProblem`
  (`carriedSolProof`, `.claude/hooks/codex-push-lib.mjs:1757`).

## The change (files)

1. `scripts/write-codex-push-proof.mjs` `restampProblem` also accepts:
   - SQL whose LF text equals the old LF text with the stamp swapped, where every changed line sits in the
     leading comment header (lines before the first line that is neither blank nor a `--` comment). A
     header comment is outside every statement and function body, so nothing the database stores or runs
     changes.
   - any other changed file equal to the old one with the stamp swapped AND the old SQL's LF sha256
     swapped for the new SQL's LF sha256 (the record's pin), nothing else.
2. New `scripts/restamp-migration.mjs <old-stamp> [--to <stamp>]`: needs a clean worktree; finds the one
   `.sql` and its record; new stamp from `next-migration-stamp` unless given; refuses when the old stamp
   appears in the SQL outside the header; `git mv` both files; swaps the stamp (and the pin) only in files
   this branch already changes against `origin/staging` (never another `supabase/` file); commits; then
   runs `--carry-restamp`. Push stays manual.
3. Docs: `docs/reference/sol-proof-mechanics.md` row, `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`
   line, changelog note.

No new table, lock, timer, flag or job. `.github/` untouched. Apply proofs (`--restamp-from`) unchanged:
they stay bound to one SQL hash; live apply proofs are minted at release time anyway.

## Rules that always hold

- Live in-order rule, PR stamp check, migration-apply proof gate: untouched.
- A carried proof still needs the reviewed head's clean, <24h Sol proof, one commit on top, same base.
- Any SQL change below the header, any other database file, a mode change, or more than one migration →
  refused, full Sol.

## Proof cases

- When the SQL header and the record pin change by the stamp only → carry accepted (unit test on
  `restampProblem`, plus a replay of #2338's real restamp commit `31436d84de`).
- When the stamp is swapped inside a function body or statement → refused.
- When the record's pin is set to any hash other than the new SQL's LF hash → refused.
- When a non-header SQL line changes as well → refused.
- When `restamp-migration.mjs` runs in a scratch repo with a Sol proof on HEAD → one commit, files renamed,
  carry proof written; when the stamp sits in the SQL body → refuses and commits nothing.

## Open business decisions

None. Mason already decided a stamp-only restamp keeps its Sol review (2026-11-04, DECISION_LOG); this
extends "stamp-only" to the stamp in a comment and the pin that is its hash.
