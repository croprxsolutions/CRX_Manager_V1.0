## 2026-11-08 — Pre-push catches stale live-state doc stamps when a migration is pushed

- `.husky/pre-push` now runs `node scripts/check-doc-drift.mjs --freshness-only` on each pushed commit's files
  when the push adds or changes `supabase/migrations/*.sql`. It blocks a migration dated today (America/Chicago)
  whose `CURRENT_STATE.md` or `KNOWN_ISSUES.md` "Last verified" stamp is older, which until now only CI's
  `Documentation consistency` step caught (PR #1652). Pushes without migration SQL skip it.
- `--freshness-only` reuses the existing stamp checks; the full `npm run check:docs` run is unchanged.
- Proof: the hook blocked a throwaway commit with a migration dated 2026-11-08 and 2026-11-07 stamps, and let it
  through once the stamps read 2026-11-08. Tests: `scripts/check-doc-drift.test.mjs`,
  `scripts/prepush-needs-build.test.mjs` (both in `npm run test:agent-workflows`).
