## 2026-10-25 — Live smoke runs work again: the live-data guard allows rollback-only batches

**What broke.** After #1084 (2026-10-25) the live-data guard refused 65 of the 69 live-runnable
`scripts/smoke/` chains, so the post-apply live smoke step could not run for any migration (reported by
the #1058 session through the coordinator). Before #1084 those chains also failed the rules on their
own; they ran only because any leftover `REAL-DATA-OK` marker switched every rule off, and #1084 made
the marker stop unlocking RPC calls.

**Fix.** `isVerifiedRollbackBatch()` in `.claude/hooks/live-testdata-lib.mjs` recognises a batch that
PostgreSQL must undo entirely: `BEGIN` first and `ROLLBACK` last with no other transaction control, or a
final `DO` block that always ends in `RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK…'` (no RETURN, COMMIT,
ROLLBACK or CALL that could skip or split it, no EXCEPTION section and no label on the outermost block,
and only a leading `BEGIN` or temp-object setup before it). The outer-handler rule came from the
automated security review: a raise that sits only in the outer handler runs only when something else
failed. Such a batch may call RPCs, write fixtures and touch the audit log, since
none of it persists; TRUNCATE and `setval`/`nextval` stay refused, and dblink, pg_background or http
calls disqualify it. String literals, comments and nested function bodies are walked in one pass, so
they cannot fake or hide any of this. `smoke-fuel-surcharge.sql` gained a leading `BEGIN;` so its two
DO blocks share one transaction. Real live writes outside such a batch are unchanged.

**Proof.** All 69 live-runnable smoke chains classify as allowed (before: 65 refused), with or without a
marker; 19 attack shapes (conditional or swallowed raise, a raise only in the outer handler, a labeled
outer block left with EXIT, early RETURN, COMMIT/END mid-batch, CALL, dblink, a write before the DO
block, a raise only in a string or comment, quote and `$tag$` tricks) are refused. Guard suite: 512
assertions.

**Known gap, unchanged.** `PERFORM fn()` inside a DO body is not detected as an RPC call (pre-existing).
