## 2026-11-09 - Doc freshness check ignores migrations dated in the future

`npm run check:docs` (CI "Documentation consistency") and the pre-push `--freshness-only` check now
require the `CURRENT_STATE.md` / `KNOWN_ISSUES.md` "Last verified" stamps to reach the newest migration
that is already due: dated on or before today in America/Chicago. Before, the bar was "newest migration,
capped at today", so a future-dated migration on main (20261217...) made the bar simply "today", and
every open PR went red after midnight Central until main was re-stamped and each PR refreshed (which
reset checks and could void Sol carry-forwards). It caught nothing real on 2026-11-09.

This narrows a CI check under Mason's 2026-11-09 approval of this exact change. A PR adding a migration
dated today or earlier still fails until both stamps reach that date; a future-dated migration counts
once its date arrives. Tests in `scripts/check-doc-drift.test.mjs` cover all three cases.
