## 2026-10-26 — Looser merge gate: allow-list matches whole words only

The Codex GitHub App (P2) found `/"$A" "$B" "$C" 951 --admin` passed: the per-occurrence check replaced the
quoted `"$A"` inside the larger executable word `/"$A"`, hiding it from the stricter program-name test. The
replacement now matches only a whole word, so a path or letters glued to the allowed shape keep the program
visible and refused. `.claude/hooks/codex-push-lib.mjs`; cases in `.claude/hooks/guards.test.mjs`.
