## 2026-10-26 — Looser merge gate: filename patterns in arguments

Sol's gate review of PR #1128 found an allowed `"$GH"` program with a filename pattern argument
(`"$GH" pr me?ge 951 --admin`) could become `gh pr merge` when a matching file exists. For an allowed
variable-run program, an argument with an unquoted `*`, `?`, `[` or `{` now refuses the command; quoted
patterns (`"*.md"`, `'?x'`) still pass. `.claude/hooks/codex-push-lib.mjs`; cases in
`.claude/hooks/guards.test.mjs`. Mason, 2026-10-26: this is the final Sol attempt — if Sol blocks again, the
PR closes without merging.
