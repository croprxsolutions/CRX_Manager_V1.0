## 2026-11-25 - Taha lane gate: #2605 Sol round-2 follow-ups

- Mason's `taha override` lets a release or hotfix migration be applied live only within 30 minutes of his sending it (Mason's decision); merges into `staging` keep 24 hours. An older override gets him a fresh code (`migration-landing-gate-lib.mjs`).
- Taha's Approve no longer carries over a hand restamp that changes the order the PR's own migrations run in (`restampMap`).
- Adding or dropping a UTF-8 byte-order mark is now a real change in the carry-over compare.
- `migration-landing-gate-lib.mjs` joins the Taha block's own wiring (`BLOCK_FILES_RE`), since it reads Mason's override.
- The Taha ready bot shows `taha-approved` only when the merge gate would accept his Approve (a base retarget voids it).
- `ship.md` release-day applies name Mason's override beside Taha's `Ready to merge`.
- Not changed, with reasons in the PR: a git mode-only change (only the executable bit can keep a file's content id) and override records written before #2605 (all expire by 2026-11-27 04:29 UTC).
