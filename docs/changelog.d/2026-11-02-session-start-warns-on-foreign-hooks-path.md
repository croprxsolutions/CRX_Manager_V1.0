## 2026-11-02 - Session start warns when a worktree runs another checkout's guards

- `.claude/hooks/session-staleness.mjs` now warns at session start when `core.hooksPath` points anywhere but this checkout's `.husky`, and prints the fix. It reuses agent-health's `checkGitHooksInstalled`, so the rule is the same in both places.
- Why: on 2026-11-01 four worktrees pointed at `C:\CRX_Manager\.husky`, the main checkout, 30 commits behind. Every commit there ran old guards with no error, and only `npm run agent-health` noticed. Memory notes about this trap had not stopped it recurring.
- Proof: `node .claude/hooks/session-staleness.test.mjs` fails on main's hook ("foreign hooksPath is warned about") and passes with the change, on a real Git repository. Run on a real affected worktree, the hook printed the warning; on a correctly set one it printed nothing, in under a second.
- Warning only: it blocks nothing, and a folder outside Git is skipped.
