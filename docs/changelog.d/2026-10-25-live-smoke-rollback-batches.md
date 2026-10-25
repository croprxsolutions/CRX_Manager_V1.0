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
and only a leading `BEGIN`, temp-object setup, or other DO blocks free of transaction control before
it; PostgreSQL runs one multi-statement query string as one implicit transaction). The outer-handler rule came from the
automated security review: a raise that sits only in the outer handler runs only when something else
failed. Such a batch may call RPCs, write fixtures and touch the audit log, since none of it persists.
TRUNCATE and direct `setval`/`nextval` stay refused. A sequence advanced INSIDE a called RPC is not
undone by the rollback: that leaves a numbering gap, the same as the smoke runs did before #1084, and is
accepted. Anything else a rollback does not undo disqualifies the batch: dblink, pg_background, http or
pg_net calls, session advisory locks and unlocks, signalling other backends, non-transactional logical
messages and replication slots, server-side file reads/writes and COPY to or from a program or file, and
CREATE EXTENSION / SERVER / FOREIGN DATA WRAPPER / USER MAPPING (on 2026-10-25 none of the remote-call
extensions were installed live). String literals, quoted identifiers, comments and nested function
bodies are walked in one pass, so they cannot fake or hide any of this.

**Holes closed on the way (reported by the #1093 session and Luna).** The older textual "rolled back"
test, which exempted DDL, accepted `BEGIN; <DDL>; END; … ROLLBACK;`, and END is COMMIT; that exemption
now uses the same verified check. RPC calls inside a DO body (`PERFORM save_x()`, `v := save_x()`) or a
`CALL proc()` were never scanned, because the scanner required the word SELECT; outside a verified
rollback batch they are now refused. TRUNCATE inside a DO body is refused (it was only caught at the
start of a statement), and COPY to or from a server program or file is refused everywhere. Real live
writes outside such a batch are otherwise unchanged.

**Proof.** All 69 live-runnable smoke chains classify as allowed (before: 65 refused), with or without a
marker; more than 30 attack shapes (conditional or swallowed raise, a raise only in the outer handler, a labeled
outer block left with EXIT, early RETURN, COMMIT/END mid-batch, CALL, dblink, a write before the DO
block, a raise only in a string or comment, quote and `$tag$` tricks, END or COMMIT AND CHAIN before
ROLLBACK, a variable or quoted identifier named raise/end, CREATE EXTENSION plus dynamic SQL, session
advisory locks) are refused, and RPC calls via PERFORM, assignment or CALL are refused outside such a
batch. Guard suite: 552 assertions.

**Residual risk, accepted.** A text check cannot follow dynamic SQL. A batch that assembles a built-in
non-transactional call from string pieces (for example `EXECUTE 'SELECT pg_advisory_' || 'lock(42)'`)
gets past it; the worst outcomes found are a lock held until the connection closes or a signalled
backend, never a persisted data write. Refusing all assembled EXECUTEs would block 20+ existing smoke
chains.
