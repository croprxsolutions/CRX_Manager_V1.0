## 2026-11-25 — Mason's override covers a live apply for 30 minutes only

**Decision (Mason, in chat on the #2605 follow-ups, choosing the recommended option):** Mason's `taha override #<PR> <code>` lets a release or hotfix migration be applied to the live database only within 30 minutes of his sending it, the same window as Taha's `Ready to merge:` go-ahead. Merges into `staging` keep the 24-hour override.
**Why:** the override proved permission for 24 hours but not that Mason was about to merge, so an agent could apply a migration live hours before the matching code shipped. Sol round 2 on #2605 raised it.
**What this forbids/implies:** an agent never applies a release or hotfix migration on an override older than 30 minutes; the landing gate refuses and hands Mason a fresh code to send right before he merges (`migration-landing-gate-lib.mjs`).
