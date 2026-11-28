## 2026-11-24 — Taha's Approve lets his-area PRs merge; the lane block has no end date

- Mason, 2026-11-24: Taha's GitHub **Approve** on the exact commit being merged is his green light. Both merge gates
  (`pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`) now read his reviews from GitHub
  (`tahaApprovedOnGitHub` in `.claude/hooks/taha-lane-lib.mjs`): his latest approve / changes-requested / dismissed review
  on that commit decides; comments, pending reviews and approvals of older commits do not count. A failed read refuses.
- Not covered by his Approve: a PR that edits the block's own wiring (merge gates, hook settings, prompt router, Sol
  classifier) and a file list GitHub can't read. Those still need Mason's `taha override #<PR> <code>`.
- Mason kept the block past Dec 15: `TAHA_LANE_UNTIL_MS` is gone, and Luna still flags Taha-lane files after that date.
