## 2026-10-26 — Looser merge gate: inline-code loosening dropped

Sol's third gate review of PR #1128 blocked on yet another process-launching API (`Deno.run`) after
earlier rounds found `readpipe`, `posix_spawn`, `qx`, Octokit and others. A list of launch APIs cannot be
complete, so the inline-code loosening is dropped (Mason, 2026-10-26): `inlineCodeReachesGatedAction` in
`.claude/hooks/codex-push-lib.mjs` is back to its main-branch rule (inline code that shows a gated word is
refused). The variable-program loosening (`runtimeProgramRefused`) stays. This supersedes the inline-code
parts of the earlier `2026-10-26-looser-merge-gate*.md` entries.
