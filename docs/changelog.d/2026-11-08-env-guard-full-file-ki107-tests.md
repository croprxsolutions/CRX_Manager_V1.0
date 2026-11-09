## 2026-11-08 — env-guard judges the whole file; KI-107 refusal cases pinned

`.claude/hooks/env-guard.mjs` now scans the raw text of a `src/` frontend file (comments included),
judges an Edit as the whole file after the edit (`judgedContent()` in `edit-splice-lib.mjs`), and
recognises a repo-relative or upper-case `src/` path. `*.test.ts(x)` files may quote `'service_role'`
because several assert database grants; the key-name and JWT checks still apply to them. Salvaged from
closed PR #605; its `.env` path-alias change stays out (accepted in KI-78 on 2026-11-02).

`.claude/hooks/review-proof-guard.test.mjs` gains the 23 "still refused" worktree-delete cases from
closed PR #1536, with no guard logic change, so any future narrowing must keep refusing them. KI-107 stays open.

Proof: `node .claude/hooks/guards.test.mjs` and `node .claude/hooks/review-proof-guard.test.mjs`; the
old guard allowed five of the new env-guard refusal cases (checked side by side on 2026-11-08).
