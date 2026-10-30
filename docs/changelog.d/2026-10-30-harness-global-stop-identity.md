## 2026-10-30 - Agent health identifies the global Stop script

Luna's follow-up review found that health treated any user Stop command mentioning the global verification hook's name as that hook being active. Health now recognizes a direct Node invocation of the script under `.codex/hooks/`, including quoted Windows and unquoted POSIX paths. A mention, a similarly named backup file, or a compound command does not count. Required project-hook checks are unchanged.

Verification: the focused health helper suite passed with regressions for those false matches and both supported path forms. ESLint and the whitespace check passed. Live activation of the new project reminder remains pending installation and native trust approval, as recorded in the main harness-parity entry.
