**LOCAL CANDIDATE, not applied.** `20261105123000_quote_sent_requires_version.sql` (LF SQL sha256: `5607991e1df2cea4ab741974ded4fc31ba355f711da56dd047d7dbc85e13ccaf`). Quote price-lock follow-up 1 (2026-11-01 list): a sent or revised quote always has the version the customer was sent.

What it does:
- `_enforce_quote_status_transition` (re-emitted; every other line is its pinned live body): a quote moves to sent or revised (from draft, or reopened from cancelled, declined, expired or accepted) only when a `quote_versions` row exists for it, checked before the admin override. The send records its version before it sets the status, and a rewind or reopen of a quote that was sent finds its version, so they keep working. The postflight repeats the no-version data check under the trigger lock and compares the grant list in `COLLATE "C"` order, since live sorts text in `en_US.UTF-8`.
- New trigger `enforce_quote_insert_status` (BEFORE INSERT on `quotes`, same function): a quote inserted by a signed-in or anonymous session starts as a draft. Every quote-creating function already inserts draft.

Unchanged: every other status transition, the admin override for them, grants, RLS, the send, the rewind, `save_quote`, `_assert_quote_prices_as_sent`. No data is written. The preflight refuses if any sent or revised quote has no version (none live, 2026-11-03).

Rollback: `DROP TRIGGER enforce_quote_insert_status ON public.quotes;` and re-emit `_enforce_quote_status_transition` from its pinned live body (md5 `c2749a6c84fc32d95e12d9af885616e5`); drop the `quotes:sent-requires-version` row from `quote-price-lock-boundary.sql`.

Proof: `node scripts/smoke/prove-quote-sent-requires-version-real-schema.mjs` prints `QUOTE_SENT_REQUIRES_VERSION_PROOF_PASS`. Live smoke chains after apply: `smoke-quote-sent-requires-version.sql` and `smoke-quote-sent-price-lock.sql`.

Live ledger preflight, read 2026-11-03 with read-only `execute_sql` on `supabase_migrations.schema_migrations` (the 14-digit name stamp when the name has one, otherwise the version): 1,110 rows; effective high-water `20261105090000`; no row at or above `20261105123000`; no trigger named `enforce_quote_insert_status`. Read the ledger again at apply time.
