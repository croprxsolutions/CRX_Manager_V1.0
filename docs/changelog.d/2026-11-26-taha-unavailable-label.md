## 2026-11-26 — Taha's `taha-unavailable` label for live applies

Taha's idea, agreed by Mason on Slack (2026-11-26): the signal that Taha is unavailable should come from Taha.

- **Live applies** (`migration-landing-gate-lib.mjs` `tahaUnavailableLabelled`): a `taha-unavailable` label on a
  hotfix or release PR counts as Taha's go-ahead and lifts the 4-hour hold, but only when Taha's own account added
  it after the PR's latest push, within the last 30 minutes, and it is still on the PR. Like `hotfix-backport`,
  the label's actor is read from the PR's timeline; an unreadable timeline does not count. Every other apply check
  still runs, and no override comment is posted (the signal came from him).
- Mason's `taha override #<PR> <code> unavailable: <reason>` stays as the backup, unchanged.
