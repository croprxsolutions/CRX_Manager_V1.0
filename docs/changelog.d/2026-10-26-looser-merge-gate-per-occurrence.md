## 2026-10-26 — Looser merge gate: the allow-list is checked per program

The Codex GitHub App (P2) found that one allowed `"$NODE"` earlier in a line made the allow-list accept an
unrecognised run-time program later in it (`"$NODE" --version; ''"$A" ''"$B" ''"$C" 951 --admin`). Two
fixes in `.claude/hooks/codex-push-lib.mjs`, cases in `.claude/hooks/guards.test.mjs`:

- Each allowed `"$NAME"` is replaced by a plain word and the stricter program-name test runs again; any
  run-time program still found refuses the command.
- The allow-list scan reads a word with its single-quoted spans dropped, so `''"$A"` is checked as `"$A"`.
