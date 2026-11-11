## 2026-11-12 - Release flow posts to Slack

The release bot now keeps the team's release channel up to date. Everything is optional: without the
`SLACK_RELEASE_TOKEN` and `SLACK_RELEASE_CHANNEL` secrets in the `release-bot` environment, nothing is posted,
and a Slack failure only shows as a warning. It never fails a release, a gate or a back-merge.

- **One card per release PR**, posted when the Thursday release PR opens and edited in place on every refresh:
  version, date, PR count, how many are verified on staging, need proof or are held off, the release gate,
  migrations for live, and the PRs still needing proof. Buttons open the release PR and the comparison.
- **A thread under the card** for what changed: a PR verified (with its proof link) or held off (with the
  reason), a PR that lost its proof, PRs added to the release, the gate turning green or red.
- **On merge into main:** the card turns "shipped" and a separate "vX.Y.Z is live" post lists what users see,
  with links to the GitHub Release, the changelog and the release PR. A release merged by squash or rebase
  turns the card red and broadcasts the fix. A hotfix gets its own post.
- **Back-merge follow-up:** the new back-merge PR is threaded under the release (or hotfix); a thread reply
  when it lands; one broadcast warning if it is still open after 12 hours (checked on every refresh,
  including a new nightly one).

How it works: `.github/scripts/release-slack.mjs` builds the messages (tested in `release-slack.test.mjs`).
The card's place is a hidden `<!-- crx-slack {...} -->` comment in the release PR body; the back-merge PR
keeps its own. Only the bot writes them, and they hold ids, PR numbers and states, never PR text. PR text in
Slack is escaped, so a title can't ping the channel or forge a link. The Slack app has one permission,
`chat:write`.
