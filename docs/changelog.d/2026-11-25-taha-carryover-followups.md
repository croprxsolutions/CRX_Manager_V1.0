## 2026-11-25 - Taha lane gate: #2605 Sol round-2 follow-ups

- Taha's Approve no longer carries over a hand restamp that changes the order the PR's own migrations run in (`restampMap`).
- Adding or dropping a UTF-8 byte-order mark is now a real change in the carry-over compare.
- `migration-landing-gate-lib.mjs` joins the Taha block's own wiring (`BLOCK_FILES_RE`), since it reads Mason's override.
- The Taha ready bot shows `taha-approved` only when the merge gate would accept his Approve (a base retarget voids it).
- Mason's override for live applies is left to #2631 (the "Taha unavailable" form Mason and Taha agreed).
- Not changed, with reasons in the PR: a git mode-only change that keeps a file's content id (the executable bit, or a file turned into a symlink whose target equals its old text) and override records written before #2605 (all expire by 2026-11-27 04:29 UTC).
