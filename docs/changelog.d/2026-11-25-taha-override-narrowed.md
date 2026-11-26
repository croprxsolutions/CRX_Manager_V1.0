## 2026-11-25 — Mason's Taha override narrowed (live applies, the gate's own files)

Mason (Slack reply to Taha, 2026-11-25): live applies keep Taha's go-ahead unless Taha is unavailable, and an
override on the gate's own files goes back to one head, as agreed on #2303.

- **Live applies** (`migration-landing-gate-lib.mjs`): a plain `taha override #<PR> <code>` no longer stands in for
  Taha's `Ready to merge:` go-ahead or the 4-hour hold. Only `taha override #<PR> <code> unavailable: <reason>`
  does; Mason decides when Taha is unavailable. Staging merges are unchanged: any override covers the PR for 24 hours.
- **The gate's own files** (`taha-lane-lib.mjs` `BLOCK_FILES_RE`, now including `migration-landing-gate-lib.mjs`):
  an override on a PR that changes them covers only the head it was issued for; a later push needs a new code.
