## 2026-11-25 — Mason's Taha override narrowed (live applies, the gate's own files)

Mason (Slack reply to Taha, 2026-11-25): live applies keep Taha's go-ahead unless Taha is unavailable, and an
override on the gate's own files goes back to one head, as agreed on #2303.

- **Live applies** (`migration-landing-gate-lib.mjs`): a plain `taha override #<PR> <code>` no longer stands in for
  Taha's `Ready to merge:` go-ahead or the 4-hour hold. Only `taha override #<PR> <code> unavailable: <reason>`
  does, with the code a live-apply refusal gave (a staging-merge code cannot be used), only at the head it was issued
  for; the reason stays in chat, never on GitHub. Mason decides when Taha is unavailable. When it lets a live apply through,
  the landing gate now posts the PR comment tagging Taha, once per migration (it never did; only the merge gate did), or refuses. Staging merges are unchanged: any override covers the PR for 24 hours.
- **The gate's own files** (`taha-lane-lib.mjs` `BLOCK_FILES_RE`, now including the live-apply gate and its callers):
  an override on a PR that changes them covers only the head it was issued for; a later push needs a new code.
