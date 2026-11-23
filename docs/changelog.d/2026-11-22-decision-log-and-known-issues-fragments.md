## 2026-11-22 — Decision-log and known-issues entries go one file each (no more sibling-PR conflicts)

New decision-log entries now go in `docs/manual/decision-log.d/<YYYY-MM-DD>-<slug>.md` and new
known issues in `docs/manual/known-issues.d/<YYYY-MM-DD>-<slug>.md`, one file per entry, like
`docs/changelog.d/`. `DECISION_LOG.md` and `KNOWN_ISSUES.md` stay as the history and are read
together with the folders; nothing is rolled up. Why: every PR that added an entry to either big
file went DIRTY on GitHub when a sibling that also added one merged (GitHub ignores the local
`merge=union` driver), and each fix moved the head off its Sol proof (2026-11-22: #2244, #2239,
#2242, #2260 twice, #2256). Mason approved this in the 2026-11-22 retro.

Readers changed so a fragment-only entry is found:

- Sol round-5+ stop and its status line (`scripts/write-codex-push-proof.mjs`, new `decisionLogAt()`):
  reads `DECISION_LOG.md` plus every `decision-log.d/*.md` (README excepted) at the reviewed head,
  in one `git cat-file --batch` call; each file is split into entries on its own, so text in one
  file can never borrow another file's date.
- Future-dated entry pre-flight: the diff now covers `decision-log.d/` too.
- Post-apply carry: `known-issues.d/*.md` may be added or edited, like `KNOWN_ISSUES.md`.
- Ledger guards (`scripts/check-ledger-update.mjs`, `.claude/hooks/stop-wrap.mjs`): a dated file in
  either folder counts as the record.
- Guidance: `AGENTS.md` routing row (pinned by `check:agent-guidance`), coding guidelines, safe
  development rules, `ship.md`, `plan-contract`, `agent-guardrails.md`, the `codex-review` and
  `update-docs` skills, the migration-apply guard's messages, and the two big files' own update rules.

Not changed: `node scripts/owner-accept-sol-finding.mjs --log` still writes Mason's owner-accept
entry into `DECISION_LOG.md`, because the owner-accepted carry and the release check
(`.github/scripts/release-flow.mjs`, hand-merge only) expect that exact file. Owner-accept commits
can therefore still conflict with each other; moving them needs a separate `.github/` PR.

Proof: new tests in `scripts/write-codex-push-proof.test.mjs` (a throwaway repository: an entry
only in `decision-log.d/` unlocks round 5; README, headless fragments and a missing head do not; a
future-dated fragment refuses), `scripts/check-ledger-update.test.mjs` and
`.claude/hooks/stop-wrap-ledger.test.mjs`. The round-5 test fails against the old reader (the old
`git show HEAD:DECISION_LOG.md`) and the stop-hook test fails with the new ledger pattern removed;
both pass now.
