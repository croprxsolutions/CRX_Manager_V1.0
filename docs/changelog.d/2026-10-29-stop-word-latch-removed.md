## 2026-10-29 — The stop-word hold latch is removed (PR #1195)

Mason: "make sure stop here in a session doesnt stop all other sessions andis it really
necessary? if i want to stopp i just hit the stop button etc, lets not overcomplicate this",
then "Yes, remove it". (His message itself latched the old hold.)

- `prompt-router.mjs` no longer runs `hold-latch-prompt.mjs`; `hold-latch-guard.mjs` is
  removed from `.claude/settings.json` and `.codex/hooks.json`. The files stay unwired
  until deleted by hand (the review proof guard reserves deleting hook files for Mason).
  The command-only narrowing made earlier in this PR is therefore inert.
- Agents still obey a typed stop (AGENTS.md); the app's Stop button is the brake.
- Luna (PR #1195) fixes in the same push: the push guard's `HOME`/`GIT_DIR`/… check matches
  only variable syntax (`NAME=…`, `$NAME`, `$env:NAME`, `Env:NAME`, cmd's `set NAME=…`), so
  "HOME" in a commit message no longer refuses a push while cmd's lower-case
  `set git_dir=` now does; `docs/reference/agent-guardrails.md` and the decision log no
  longer claim every typed stop latches, and the decision entry restates the 30-minute owner
  approval. Accepted: `PATH=` written inside a commit message still refuses a push.
