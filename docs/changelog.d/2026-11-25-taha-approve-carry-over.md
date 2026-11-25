## 2026-11-25 — Taha's Approve survives harmless pushes; Mason's override covers releases

Mason: Taha's approval kept getting wiped by small pushes, so nobody could tell whether he had approved.

- **Carry-over** (`taha-lane-lib.mjs` `tahaApprovedOnGitHub`): Taha's Approve of an older commit still lets a
  lane PR through when the PR's own change is the same now. Pushes that only catch up with staging, change files
  under `docs/`, or restamp a migration keep it, unless staging changed one of the PR's own files meanwhile; any other change needs him again. GitHub's rulesets dismiss
  stale reviews on push, so an Approve the timeline shows dismissed by a push (no message) still counts; one a
  person dismissed does not. Proven on PR #2557's real history: docs note and restamp carried, the code fix did not.
  Known gap, accepted by Mason: a staging catch-up can change how the PR's unchanged code behaves.
- **Override covers later pushes**: Mason's `taha override #<PR> <code>` now covers that PR for 24 hours,
  later pushes included.
- **Releases** (`migration-landing-gate-lib.mjs`): the override also stands in for Taha's 30-minute
  `Ready to merge:` go-ahead and the 4-hour hold on a live apply, and the refusal hands Mason the code.
  `release/next` skips the 4-hour hold (each change was held on its way into staging).
- **Bot labels** (`.github/scripts/taha-ready.mjs`): `taha-approved` shows a carried-over Approve,
  `ready-for-taha` comes off once Taha approves, and the bot no longer re-labels or pings while his
  Approve carries over.
