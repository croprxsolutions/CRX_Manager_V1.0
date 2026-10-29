## 2026-10-29 — Guard friction, part 2: the home `.claude` folder is not the repository's

`review-proof-guard.mjs` treated the user's own `C:\Users\<u>\.claude` (personal hooks,
settings and agent memory) as this repository's protected `.claude`: `cd
/c/Users/mason/.claude && ls` was refused as entering the review state, and backing up
`/c/Users/mason/.claude/hooks/*.mjs` was refused as a write to the repository's guard
hooks. Both checks now recognise every home spelling (`~`, `$HOME`, `%USERPROFILE%`,
`C:/Users/<u>`, Git Bash's `/c/Users/<u>`, `/home/<u>`). The repository's own `.claude`
(relative or absolute) stays protected; the tests pin both directions.

The push guard (`codex-push-lib.mjs` `pushUsesConfigRootEnv`) likewise refused any push
whose command also contained the word "home" (a commit message in the same line). POSIX
spellings of `HOME`, `GIT_DIR` and the rest now match upper-case only, as shells name
them; PowerShell's `$env:` names stay matched in any case.
