## 2026-11-12 - Release flow posts to Slack

The release bot now keeps the team's release channel up to date. Everything is optional: without the
`SLACK_RELEASE_TOKEN` and `SLACK_RELEASE_CHANNEL` secrets in the `release-bot` environment, nothing is posted,
and a Slack failure only shows as a warning. It never fails a release, a gate or a back-merge.

- **One card per release PR**, posted when the Thursday release PR opens and edited in place on every refresh:
  version, date, PR count, how many are verified on staging, need proof or are held off, the release gate,
  migrations for live, the PRs still needing proof and the held-off PRs with their reasons. Buttons open the release PR and the comparison.
- **A thread under the card** for what changed: a PR verified (with its proof link) or held off (with the
  reason), a PR that lost its proof, PRs added to the release, the gate turning green or red.
- **On merge into main:** the card turns "shipped" and a separate "vX.Y.Z is live" post lists what users see,
  with links to the GitHub Release, the changelog and the release PR. A release merged by squash or rebase
  turns the card red and broadcasts the fix. A hotfix gets its own post.
- **Back-merge follow-up:** the new back-merge PR is threaded under the release (or hotfix); a thread reply
  when it lands (a broadcast warning instead if it was squash-merged); one broadcast warning if it is still open after 12 hours (checked on every release PR refresh and
  by a nightly Slack-only job, which touches no branch, PR content or status).

How it works: `.github/scripts/release-slack.mjs` builds the messages (tested in `release-slack.test.mjs`).
The card's place is a hidden `<!-- crx-slack {...} -->` comment in the release PR body; the back-merge PR
keeps its own. Only the bot writes them; they hold ids, PR numbers and states, never PR text, and on read only fields
of the expected shape are kept. A marker is saved before its thread replies are posted, so a failed save
can't repeat a post. The release PR job runs main's copy of the scripts, never release/next's. PR text in
Slack is escaped, so a title can't ping the channel or forge a link. The Slack app has one permission,
`chat:write`.

**Known limits (accepted):**
- Thread replies and back-merge posts are at most once: the marker is saved first, so a Slack failure loses
  that one post instead of repeating it on every run. A failed save after a new card is posted means the
  next refresh posts a fresh card.
- Re-running the "Back-merge main into staging" job by hand posts its "is live" (or hotfix) message again.
- Someone who can edit a release or back-merge PR body can edit its marker, for example pointing it at
  another of the bot's messages. Only the expected field shapes are read, so it can't inject text.
- If a second release lands while a back-merge is still open, the back-merge follows the newest release's
  thread; the earlier thread doesn't get the "merged" reply.
- A changed proof link on an already-verified PR isn't announced again.
