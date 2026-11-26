## 2026-11-26 — Taha's `taha-unavailable` label for live applies

Taha's idea, agreed by Mason on Slack (2026-11-26): the signal that Taha is unavailable should come from Taha.

- **Live applies** (`migration-landing-gate-lib.mjs` `tahaUnavailableLabelled`): a `taha-unavailable` label on a
  hotfix or release PR counts as Taha's go-ahead and lifts the 4-hour hold, but only when Taha's own account added
  it after the head's latest push (by push time from GitHub's branch activity, since the timeline orders commits by commit date; Taha's review of #2668), within the last 30 minutes, and it is still on the PR. Like `hotfix-backport`,
  the label's actor is read from the PR's timeline; an unreadable timeline does not count. Every other apply check
  still runs, and no override comment is posted (the signal came from him).
- Mason's `taha override #<PR> <code> unavailable: <reason>` stays as the backup for when he cannot reach Taha at all
  (Taha's review asked for it to count only with his label; Mason chose to keep it, and it tags Taha on the PR once
  for each migration it lets through). It now counts for 30 minutes from Mason's message, not 24 hours (`TAHA_APPLY_OVERRIDE_MAX_AGE_MS`,
  matching `READY_WINDOW_MS`); staging-merge overrides keep 24 hours.
- Wording: "Mason decides Taha is unavailable" now reads "only for when Mason cannot reach Taha at all".
