## 2026-11-08 — KI-96 part 2: delete the two unwired hooks

No user-visible change and no change to what any guard does.

- **Deleted `.claude/hooks/active-area-guard.mjs` and `.claude/hooks/rls-on-new-tables.mjs`.** Both were
  unwired from `.claude/settings.json` and `.codex/hooks.json` on 2026-10-27, so neither has run since.
  `active-area-guard` read a config file that never existed; CI's `scripts/check-migration-hard-rules.mjs` still
  refuses a new table without row security. Their test case in `guards.test.mjs` and their entry in
  `scripts/guard-claim-audit.baseline.json` went with them; comments that named them were updated.
- **Deleted `scripts/smoke/prove-assign-customers-sales-rep.mjs`**, an August one-off proof for a migration applied
  that month. Nothing runs it; its smoke chain `smoke-assign-customers-sales-rep.sql` stays.
- Kept: the October and November proofs (recent work still runs them by hand) and `scripts/smoke/undo-paths/`
  (imported by eight proofs).
