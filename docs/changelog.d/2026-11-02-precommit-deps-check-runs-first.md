## 2026-11-02 - Pre-commit checks dependencies first when package files are staged

- `.husky/pre-commit` now runs `scripts/verify-deps.mjs` before every other step, still only when `package.json`, `package-lock.json` or `.nvmrc` is staged. A worktree with no `node_modules` now stops at the first step with "run npm ci" instead of after the ledger, containment, SQL and frontend checks. `verify-deps.mjs` is unchanged; other commits skip it as before.
- Why: in the PR #1306 session a commit staging `package.json` in a fresh worktree failed only at the hook's last step. Memory notes about this trap had not stopped it recurring.
- Proof: `node scripts/precommit-deps-first.test.mjs` runs the real hook and the real `verify-deps.mjs` in a throwaway repo; it fails on main's hook and passes with the change. It is part of `npm run test:agent-workflows`.
