## 2026-11-03 — ship.md: carry cost-exposure re-keys before a migration's apply

`.claude/commands/ship.md` Step 5 now has a pre-apply step: when a migration replaces a function, compute the post-apply `cost-exposure-review` keys of every allowlisted chain that reaches it and carry them in the same PR (the `20261102200000` precedent). Missing this cost an extra commit and CI round after the apply three times (11-02, 11-03 #1318/#1300, 11-03 #1398).

Also proven read-only on live: the two #1398 re-keys (`close_quote_as_applied`, `close_quote_as_short`). With only `_enforce_quote_status_transition` swapped back to its pre-`20261105160000` ledger body (md5 matches the migration's preflight pin), the predicate rebuilds the old keys `#713b54fec909` and `#598ae3dba2b6` exactly, and no other allowlisted chain reaches that function.
