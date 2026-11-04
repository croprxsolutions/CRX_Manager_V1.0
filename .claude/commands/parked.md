Show Mason every PARKED migration across all worktrees — database changes that are written and waiting, but have NOT been applied to the live database — and, if he wants one applied, walk it through the existing safety gates.

Use this when Mason asks anything like: "what's parked", "anything waiting on me", "what migrations are pending", "apply the parked ones".

## Steps

1. Run the fleet report and focus on the parked section:
   ```
   node scripts/fleet-status.mjs
   ```
   The "Parked migrations awaiting apply" section lists each draft with the worktree it lives in, when it was last touched, and its first comment line (what it says it does). Parked drafts live in `scripts/.staging-migrations/`, as `*draft*.sql` files in `docs/audits/`, and as branch-owned `supabase/migrations/*.sql` only when either (a) a standalone leading SQL status line explicitly marks them `PARKED`, `NOT APPLIED`, or `DO NOT APPLY`, or (b) an exact `LOCAL CANDIDATE / NOT APPLIED` migration record pins the file's full SQL sha256. Ordinary forward migrations are deliberately excluded. Files marked SUPERSEDED are already replaced and are correctly ignored.

   **Fail-closed scan states:** `PARKED STATE UNKNOWN` means the report could not establish the authoritative parked set (for example, the `origin/main` migration-history-to-SQL cross-reference is unreadable, inconsistent, or has a stale sha256 pin). `PARKED-SCAN DEGRADED` means it had to use conservative disk discovery because `origin/main` or its draft tree was unavailable; inherited historical files may be included. In either state, never report a numeric count or a clean zero as authoritative. First run `node scripts/fleet-status.mjs --fetch`; if the state remains, repair the migration record ↔ SQL marker cross-reference before declaring the parked queue clear.

2. Present the parked list in plain English: for each one, what it changes, why it was parked (check the loop ledger / `docs/loops/` mission doc it came from if unclear), and how risky it looks. Lead with a recommendation for which one (if any) to handle first.

3. **If Mason asks to APPLY one — never apply it directly from here.** Route into the existing gated flow, in order:
   1. `/explain-migration <file>` — plain-English explanation of exactly what the SQL will do to the live database, what could go wrong, and what rollback looks like.
   2. `/migration-review <file>` — the deep parallel review (RLS + drift + types with adversarial verification); only a clean verdict stamps the proof file the `migration-apply-guard` hook requires.
   3. **Apply** — follows `AGENTS.md` autonomous landing and `.claude/commands/ship.md` Step 5: a NON-destructive migration with no permission change applies without a per-migration ask, but only through `scripts/apply-migration-file.mjs` and the full migration-apply-guard proof gate (both reviewer proofs plus a content-bound Sol proof, each under 24 hours, on the open PR's green, Sol-cleared head). A destructive, data-overwriting or permission-changing migration needs Mason's `I approve` for that exact file. The Supabase MCP `apply_migration` cannot pass the guard. Then run the post-apply steps in `ship.md` Step 5 (smoke chains, ledger check, registry refresh, sweeps).

   The gates stay. If any step fails or the review comes back blocked, stop and tell Mason what was found and what you recommend instead.

4. If a parked draft lives in ANOTHER worktree, don't edit or move that worktree's files — coordinate: tell Mason which window/session owns it, or copy the SQL content read-only for review here. (See the staging-migrations DRAFT/APPLY protocol — check for parallel-session writes first.)

Without an apply request, this command reads and reports only.
