## 2026-10-26 — Looser merge gate: Luna round 3 fixes and the stated residual

Follow-up to `2026-10-26-looser-merge-gate.md`. Fixed in `.claude/hooks/codex-push-lib.mjs`, with cases
in `.claude/hooks/guards.test.mjs`:

- Perl `qx` and Ruby `%x` with any delimiter (`%x!…!`) count as running a shell command, and
  `pr … merge` with options in between (`pr --repo o/r merge`) counts as the merge action.
- Single-quoted text is literal, so `'literal$USER'` no longer reads as glued pieces.
- `execution` no longer reads as `exec`.

**Residual, open for Mason's decision:** a merge whose every word arrives in environment variables set
before the command (`"$GH" "$SUB" "$ACTION" 951 "$FLAG"`) shows nothing for the gate to read, and is now
allowed; the old code refused any program run from a variable. Like `node file.mjs`, which was always
allowed, it is a deliberate spelling, not an accident, and GitHub still enforces required checks.
