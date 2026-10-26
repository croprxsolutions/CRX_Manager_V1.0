## 2026-10-26 — Looser merge gate: Sol's second review

Sol's second gate review of PR #1128 returned BLOCKERS on two shapes; both fixed in
`.claude/hooks/codex-push-lib.mjs` with cases in `.claude/hooks/guards.test.mjs`:

- A program run from a variable is now refused when ANY of its arguments is a variable, not only the
  next three (options could push the hidden action to the fourth word). `"$NODE" x.mjs` and
  `"$CODEX" --version` still pass; `"$CODEX" exec … -C "$WORK"` is refused again.
- Inline code that assembles words from pieces (`'child_'+'process'`, char codes, decoding) counts as
  able to act, so it is refused whenever it also shows a gated word.
