## 2026-11-18 - Release Slack posts say what is in the release

Taha asked for release posts that read like release notes. The bot's messages now:

- **Release card:** a "What's in this release" section. New features, bug fixes and other changes each list their top 3 (with the PR's "What users see" line when it has one, otherwise its title without the `type(scope):` prefix) and a count. Engineering (CI, agents, guards, the release flow) and docs/records show as counts only, so features and fixes are what the app gained. Back-merges are left out. The context line says how many PRs ship, how many database changes go live and how many are held back.
- **Live post:** "CRX Manager vX.Y.Z is live" with feature, fix and database-change counts (kept in the card's hidden marker as `grp`, validated on read like the other fields).
- **Hotfix post:** what changed, what users see (from the PR's own line), whether it touches the app or only tooling, and how many database changes it carries. If the PR's file list can't be read, those two facts are left out; the post still goes.
- Emoji headers and section labels throughout.

Grouping is by conventional-commit type and scope (`changeGroup` in `release-slack.mjs`). Still only `chat:write`; the new bot icon is set in the Slack app's settings, not in code.

Tests: `.github/scripts/release-slack.test.mjs`.
