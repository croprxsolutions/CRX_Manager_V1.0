## 2026-10-29 — Guard friction, part 1: Luna round 2 and accepted holes (PR #1193)

Mason, mid-review: "i am fine with holes i our harness i want it more relaxed than too
rigid". Luna round 2 reported five items; the cheap real ones are fixed, the exotic ones
are accepted and named in the code.

- Fixed: `find` no longer counts as a plain read in `review-proof-guard.mjs` (a quoted
  `"-delete"` slipped its action check); the migration reminder keys on the file's full
  path; the part-1 changelog now records that Mason deleted `ship-intent-reminder.mjs`.
- Accepted: a git pager or alias already configured to write a guard file still runs
  under a plain `git log` read; a `git -c alias.x=!…` that runs a database client named
  by a variable is not seen by the destructive-SQL check. Both need a booby-trapped
  setup to exist first.
