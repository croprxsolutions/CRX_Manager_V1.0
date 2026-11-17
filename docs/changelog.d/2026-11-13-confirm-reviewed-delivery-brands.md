## 2026-11-13 - Confirmation of reviewed typed delivery brands: database half only

Follow-up #1846. The database candidate `20270120100000_priority_integrity_followups.sql` keeps the office review and the original entry when a typed brand's identity is unchanged, even when only the quantity changes (Mason's 2026-11-13 choice).

The matching screen change is held back from this PR. It would have let "save with no changes" also confirm lines with a typed brand the office has already linked or dismissed. Sol (2026-11-17, round 5) found that on staging the web app deploys before the database job applies the migration. In that gap, the old database function would reset such a pick to pending review. The screen therefore keeps its current guard: it skips those lines and tells the admin to pick the listed brand instead. That guard is safe on both the old and the new database. The screen relaxation (`d21e1f798`) can follow in a small PR once this migration is live.
