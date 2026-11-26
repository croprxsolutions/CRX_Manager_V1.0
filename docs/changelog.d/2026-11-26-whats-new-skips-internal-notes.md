## 2026-11-26 — What's New skips internal notes and shows links as plain text

- Release bot (`.github/scripts/release-flow.mjs` `usersSee()`): a PR's "What users see" lines that start "None",
  "Nothing", "N/A" or "-" (e.g. "Nothing. Agent tooling only.") and the "🤖 Generated with …" footer no longer reach
  `src/releaseNotes.ts` and the What's New dialog; Markdown links show as their plain text. Checked against 300 real PR
  descriptions: only those junk lines drop. Applies from the next release; `src/releaseNotes.ts` is not edited by hand.
- Source: free-screens audit (2026-11-25), finding 5.
