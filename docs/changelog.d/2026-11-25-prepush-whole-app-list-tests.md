## 2026-11-25 — Pre-push runs the whole-app list tests; two Windows-only false failures fixed

- `.husky/pre-push` now runs 14 vitest files that scan all of `src/` (for example `src/lib/pagedReadCallSites.test.ts`)
  whenever a push touches app files, before the type check (about 30-40 seconds). A new file missing from such a list
  failed only in CI on PR #1459 and again on PR #2438. Mason approved this in the 2026-11-25 retro.
  If the working folder differs from a pushed commit on what the tests read, the step is skipped with a warning
  and CI runs them, so it never passes on code other than what is pushed.
- `src/__tests__/postgrestEmbedsNamed.test.ts` normalises CRLF before reading `src/types/supabase.ts`; on a Windows
  checkout it found no schema links, so it failed its sanity check and its offender check checked nothing.
- `src/lib/rpcFixtureLiveDiff.test.ts` uses the staging rule on a local run (no `GITHUB_ACTIONS`), matching what CI
  applies to every PR agents open. CI behaviour is unchanged; a manual CI run on main still uses the live rule.
