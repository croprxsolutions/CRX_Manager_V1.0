## 2026-10-26 — Looser merge gate: unquoted variable programs, PowerShell backticks

Two Codex GitHub App findings (P2), both fixed in `.claude/hooks/codex-push-lib.mjs` with cases in
`.claude/hooks/guards.test.mjs`:

- `$A 951 --admin` with `A='gh pr merge'` passed: an unquoted variable is word-split, so the program word
  itself can carry the merge. A bare unquoted `$A` / `${A}` program is now refused; the quoted
  `"$NODE" x.mjs` / `"$P" -I x.py` still passes (`$P -I x.py` is refused again).
- `Write-Output "Hello`n$env:USERNAME"` was refused: a lone backtick is a PowerShell escape (and an unclosed
  one is a POSIX syntax error that runs nothing), so the backtick scanner now skips it.
