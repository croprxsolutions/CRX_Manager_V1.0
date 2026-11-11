## 2026-11-11 - Release bot: comment markers and table cells cleaned properly

CodeQL flagged 5 high alerts in `.github/scripts/release-flow.mjs` when the bootstrap PR to main (#1787)
ran it. All are in text the bot writes into the release PR body and CHANGELOG:
- `renderReleaseBody` removed `<!--` and `-->` in one pass, so `<<!--!--` left a new `<!--` behind and
  PR text could fake a bot block. Markers, `--!>` included, are now removed until none are left.
- `firstParagraph` removed only closed comments, so an unclosed `<!--` in a PR description reached the
  changelog and hid what followed. An unclosed comment now goes to its end, and leftover markers too.
- The release status table escaped `|` but not `\` in PR titles and orphan commit lines, so a title
  ending in `\` broke its row. The new `cell()` escapes backslashes first.

Tests: `.github/scripts/release-flow.test.mjs`.
