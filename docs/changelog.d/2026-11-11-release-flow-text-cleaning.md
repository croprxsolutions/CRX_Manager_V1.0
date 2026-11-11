## 2026-11-11 - Release bot: comment markers and table cells cleaned properly

CodeQL flagged 5 high alerts in `.github/scripts/release-flow.mjs` when the bootstrap PR to main (#1787)
ran it. All are in text the bot writes into the release PR body and CHANGELOG:
- `renderReleaseBody` removed `<!--` and `-->` in one pass, so `<<!--!--` left a new `<!--` behind and
  PR text could fake a bot block. Markers (`--!>` included) are now turned into visible text
  (`&lt;!--`, `--&gt;`) in one pass: nothing is removed, so nothing can be rebuilt, and it stays linear
  on crafted input.
- `firstParagraph` removed only closed comments, so an unclosed `<!--` in a PR description reached the
  changelog and hid what followed. Closed comments still go whole; a stray marker is turned into text
  the same way, so an arrow (`A --> B`) or `<!--` in code stays readable.
- The release status table escaped `|` but not `\` in PR titles and orphan commit lines, so a title
  ending in `\` broke its row. The new `cell()` puts the text on one line, then escapes backslashes,
  then pipes, so no text can start a row of its own.

Tests: `.github/scripts/release-flow.test.mjs`.
