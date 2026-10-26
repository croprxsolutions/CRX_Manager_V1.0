## 2026-10-26 — Looser merge gate: Sol blockers closed narrowly

Sol's gate review of PR #1128 returned BLOCKERS on two shapes; both are fixed in
`.claude/hooks/codex-push-lib.mjs` with cases in `.claude/hooks/guards.test.mjs`:

- A merge hidden entirely in variables set earlier (`"$A" "$B" "$C" 951 --admin`). Mason, 2026-10-26:
  "Close it narrowly." A program run from a variable is now refused when any of its next three words is
  also a variable. `"$NODE" x.mjs`, `"$CODEX" --version` and `"$CODEX" exec … -C "$WORK"` still pass.
  This supersedes the acceptance in `2026-10-26-looser-merge-gate-residual-accepted.md`.
- An Octokit merge written with a comment inside the brackets (`pulls[ /* note */ 'merge' ]`): `pulls`
  followed by `merge` within 80 characters now counts as the merge action.
