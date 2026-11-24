# Proposed change: cut guard friction (for Sol's opinion)

**This is our proposed change, not yet built.** Owner's position: we are far too handicapped on shipping code. We need structure and a harness, but the current harness is over-engineered. We want your honest opinion, including "cut more" or "this is the wrong approach", and how YOU would go about it. Prefer the smallest change that removes the friction. Do not propose new machinery unless it deletes more than it adds.

Repo: this checkout (branch from origin/staging). Hooks: `.claude/hooks/`. Claude and Codex both run them (`.codex/hooks.json` via an adapter).

## Evidence (last 7 days, all saved sessions)
1,056 blocks across 58,862 tool steps (1.79 per 100). Top:

| blocks | guard |
|---|---|
| 165 | CODEX GATE: directory-changing or GIT_DIR/GIT_WORK_TREE-prefixed push (`pushContextIsAmbiguous`, codex-push-lib.mjs ~466) |
| 99 | REVIEW PROOF GUARD: shell WRITE to .husky/.github/workflows/.claude/hooks/.codex/hooks/.coderabbit.yaml (review-proof-guard.mjs ~1122) |
| 96 | REVIEW PROOF GUARD: direct shell access to review proof JSON (~209), including pure reads like `cat .claude/session-state/codex-review-*.json` |
| 52+42 | LANDING CLAIM: another session is landing branch X (pr-claim-lib.mjs, CLAIM_TTL_MS = 2h) |
| 51 | REVIEW PROOF GUARD: delete/move after cd into .claude (~631); mostly `cd <worktree> && git mv supabase/migrations/${O}_x.sql supabase/migrations/${N}_x.sql` (the `$` makes it "unreadable target") |
| 51 | REVIEW PROOF GUARD: destructive/overwriting near state dir (~592); fires on any `.claude` mention plus a redirect, e.g. a scratch script whose text contains `".claude"` written via heredoc to %TEMP% |
| 49 | PR MERGE GATE: not merge-ready (checks pending etc.) |
| 42 | PR MERGE GATE: Follow-ups lines name no issue |
| 37 | PR MERGE GATE: PR description has no `## Follow-ups` section |
| 27 | PR MERGE GATE: teammate comments unresolved |
| 27 | PR MERGE GATE: needs clean Sol proof (Sol-required path) |
| 22 | PR MERGE GATE: could not resolve base/SHAs (gh ETIMEDOUT) |

Example CODEX GATE false positive: `cd /c/CRX_wt/lane-f-tools && git log --oneline -2 && git -C /c/CRX_wt/lane-f-tools push -u origin fix/x`, which is refused even though the push names its repo with -C.

Separately, the SessionStart hook `worktree-awareness.mjs` takes 52s with 219 worktrees against a 10s timeout. It has timed out 129 times in 48h and has never emitted anything.

## Proposal
1. **worktree-awareness**: only scan worktrees touched in the last 3 days (fold the rest into a count) and add an internal ~7s deadline that emits what it has. Separately, clean up landed worktrees.
2. **CODEX GATE cd rule**: allow when every push segment uses `git -C <path>`; for a plain leading `cd <literal path> && … git push`, bind inspection to that path instead of refusing. Keep GIT_DIR/--git-dir refusals and every main/staging/proof check.
3. **Review proof guard**:
   - allow read-only access to proof JSON (block only writes, deletes, and redirects into it);
   - the cd-then-move rule fires only when the move target can resolve into `.claude`, not when a `$VAR` sits inside a `supabase/migrations/...` path;
   - the destructive rule fires only when the write/delete/redirect target is the state dir, not when `.claude` merely appears elsewhere in the command;
   - keep the hook-file write block (change only the message: "use Edit/Write").
4. **Merge/landing gates** (owner must approve each):
   - check `## Follow-ups` at `gh pr create`/`edit` time, not only at merge;
   - auto-release a landing claim when its PR merged or its session has been quiet for 30 min (today 2h);
   - retry gh once on ETIMEDOUT before failing closed;
   - add a "wait until merge-ready, then merge" helper so agents stop retrying the merge;
   - no change to the Taha-comment, Sol-proof, or release-freeze gates.
5. **Later**: Sol only on money/inventory/DB/login (already the written rule), Terra 6.2 for everything else.

## Questions for you
1. For each item: keep, change, or drop? Is any of it over-engineered, and what is the simpler version?
2. What would you cut or simplify that we did NOT list? Name specific guards/rules that cost more than they protect. Think about deletion, not patches.
3. Which protections must stay no matter what (the real safety floor)?
4. How would you sequence this so we get the most friction removed for the least code and review churn?
5. Any risk where a proposed loosening opens a real hole (fake review proof, push to main, unreviewed migration apply)?

Give every finding, ranked. Be blunt. Plain English is fine.
