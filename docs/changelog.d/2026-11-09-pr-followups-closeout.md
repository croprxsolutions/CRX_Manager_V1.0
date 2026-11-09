## 2026-11-09 - Every PR names its follow-ups; /ship closes out after the merge

Mason ran `wrap-session` after merges because he could not tell whether work had been put off, and that
check never looked for follow-ups. Sol reviewed the first plan (an after-merge reminder hook plus scanning the
conversation) and found it fired before the deploy check and could not see deferrals made in other sessions.
So deferrals are now recorded when they are decided: each PR description carries a `## Follow-ups` section,
one line per deferred item naming its GitHub issue or `KI-` entry, or `- None`. Both merge gates
(`pr-merge-guard.mjs`, Codex `production-action-guard.mjs`) refuse a merge into `main` or `staging` without a
usable section, through the shared `.claude/hooks/followups-lib.mjs`; Taha's PRs are exempt. `/ship` Step 8
gains item 8, a read-only close-out after the deploy check that confirms each follow-up's issue exists and
ends in SAFE TO ARCHIVE or NOT YET.
