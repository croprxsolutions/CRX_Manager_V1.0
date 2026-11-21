## 2026-11-21 - The release guard lets Mason's owner-accept log through

Mason asked (20 Nov, #1990) for the "Release flow guard (main)" to accept his owner-accept commit. `scripts/owner-accept-sol-finding.mjs` writes `docs/manual/DECISION_LOG.md`, and that commit sits on top of the bot's release/next head, so it is never on staging. The guard compared release/next with staging + main and refused it every time.

`check-release-files` (`.github/scripts/release-flow.mjs`) now also allows `docs/manual/DECISION_LOG.md`, and nothing else. It is a log, so it can't change what ships; every other file still has to match staging + main, and the bot's files are still checked by `check-release-content`.

Tests: `.github/scripts/release-flow.test.mjs`.
