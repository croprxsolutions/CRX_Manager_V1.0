## 2026-10-28 - Codex can run the generated database sweep queries

Codex's read-only SQL check refused 19 of the 29 queries that `npm run db-sweeps` generates, because those queries read the database catalog with built-in functions its short list does not include. This meant Codex could not run the post-apply invariant sweeps.

`.codex/hooks/production-action-guard.mjs` now also accepts a query when `isKnownSweepQuery` (the recognizer the Claude SQL guard already uses, in `.claude/hooks/live-testdata-lib.mjs`) matches it exactly: the generated wrapper, a predicate whose fingerprint is pinned in that file under its own name, and plain function-contract keys. The built-in function list is unchanged, and so are the fingerprints and the wrapper check. A query that is not an exact match gets the old read-only check alone.

The gate also now judges every SQL field in a call (`query` and `sql`) and accepts SQL only as plain text (from Luna's review).

No application, database or business-data changes. Validation: the guard tests now build all 29 current sweep queries and confirm each one passes under all three Supabase tool prefixes, in both line-ending forms and in both input fields. The same tests confirm that an appended or spliced statement, an edited predicate, a wrong or unknown name, a hostile contract key, an application call, `set_config` or a write inside the wrapper are all refused. Running the guard as a separate process gave 19 refusals out of 29 before the change and 0 after; tampered queries, writes and application calls were refused both times.
