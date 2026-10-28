# 2026-10-28 - Document-number review follow-up (To-Do 12.1)

The direct Claude review requested stronger migration contract checks and clear
handling of a quote number that is still loading. The follow-up adds preflight
and postflight checks for function settings, ownership, grants, default arguments
and replacement bodies. New-quote Save Draft waits for allocation to finish;
pending and failed allocations are distinguished. A stale comment was corrected.

The local database proof now exercises refusal and rollback for changed security
mode, owner, search path and grants, plus an incorrectly emitted replacement.
It passed along with the existing Chicago boundary, concurrency and retry cases.
The browser proved loading, success and failure behavior with a fake backend.
The final application suite passed all 480 files: 6,638 passed and 123 skipped;
the focused quote suite passed 111 tests. Typecheck, lint and the complete
agent-workflow suite passed.

Luna's concern about selecting an unverified reusable container is addressed by
removing reuse. The submitted proof always creates its own isolated container
and cleans up only the container ID returned by its successful creation call.

The first Claude alias resolved to Sonnet 5. The requested explicit Sonnet 5.5
high-effort review and normal push hooks are still required before draft-only
GitHub delivery. No merge, live migration apply or deployment is authorized.
See [the detailed proof record](../operations/2026-10-28-document-number-year-proof.md).
