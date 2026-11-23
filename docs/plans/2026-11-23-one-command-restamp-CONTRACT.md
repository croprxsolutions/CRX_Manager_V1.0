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

## The change as first proposed (superseded: the shipped rule is under "Cold challenge" below)

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
  carry proof written; the SQL body keeps every byte (superseded by the settled rule below).

## Open business decisions

1. Extend Mason's 2026-11-04 "a restamp keeps its Sol review" (byte-identical SQL) to a restamp whose
   only SQL edit is the header's link to its own record, with that record's pin following. Yes: #2338-
   style restamps stop costing a Sol round. No: they keep needing a full Sol run. Recommended: yes.

## Cold challenge (Astra, gpt-6.2-astra high, 21 findings) and how each was settled

The design above was narrowed in response; the shipped rule is:

- SQL: byte-identical, or only a leading `--` header line's link to its own record
  (`migrations.d/<old stem>.md` → new stem) changes (#1, #6, #9, #21). The body is never touched.
  The `crx: no-transaction` first-line marker cannot change: it names no stem.
- The pin may change only in the migration's own record, and every `SQL sha256` pin there must equal
  the new SQL's LF hash (#2, #4). Hashes in any other file refuse.
- The writer refuses when another branch migration sits between the old and new stamps (#8); this was
  also a hole in the 2026-11-04 rule.
- The command refuses: a non-feature branch, a dirty tree, a migration already on staging or main
  (#7), a migration this branch does not add, a `--to` that is not a real time, not above both bases'
  newest, or already used on the branch (#11, #12), an existing destination (#14); it warns before
  changing anything when no Sol proof exists for HEAD and reports the committed sha if the carry
  fails (#13), and lists files that still name the old stem (#10).
- Declined, with reason: #5 bare-stamp swaps in other files are the existing 2026-11-04 rule,
  unchanged; #15 a stamp aging after the PR check is the merge captain's re-check, out of scope;
  #16 older branches run the command from an updated checkout by full path (it runs the writer next
  to itself); #17 the ordering-guard hint covers live-apply restamps on hotfix/release, which this
  command refuses; #20 portable fixtures live in `scripts/restamp-migration.test.mjs`.
- Evidence (#18, #19): the real #2338 restamp (`31436d84de`, non-ASCII SQL, real pins) carries under
  the rule; the command run on its pre-restamp head `94d9e864a3` produces the identical tree
  (`8df9d755`); #2331 and #2248 restamps carry; #2324 (`22509a8cf2`, SQL changed) refuses.
- #1 DECISION for Mason: extend "a restamp keeps its Sol review" (2026-11-04, byte-identical SQL) to
  the header self-link + pin case. Recommended yes.

## Luna

- r1 (5): fixed a same-name migration under another stamp on a base (HIGH), a missing record, a bare
  `--to`; a failed fetch now refuses (r2). No-pin record: a changed SQL now needs its record's one pin (r2).
- r2 (4, no HIGH): both stamp orders checked; the body-stamp case prints a note and keeps the body.
- r3 HIGH refuted: restamping above migrations that already landed on staging is the purpose. Staging
  ran those first, the PR stamp check (`stampProblems`) requires the new stamp above the base's newest,
  so after the restamp live applies in the order staging did; without it live would flip that order.
