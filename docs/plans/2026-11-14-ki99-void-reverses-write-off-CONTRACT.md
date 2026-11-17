# KI-99: voiding an invoice reverses its write-offs — behavior contract

Read at `origin/staging` `73e17efcd` and live (read-only, 2026-11-14). Mason, 2026-11-14: **auto-reverse** (not refuse).

## Facts

- Every void path ends in `_void_invoice_split_provenance_impl_20260719`: `void_invoice` → `_void_invoice_return_credit_guard_impl_20260826` → `_void_invoice_group_guard_impl_20260720` → impl; `void_invoice_group` → group guard → impl; `batch_void_invoices` → `void_invoice`. Live body md5 `604b914bae32ca1da76719658a561730` = the newest definition (`20261206110000`, lines 291–606).
- The impl sets `invoices.write_off_cents = 0` on void but leaves `write_offs.reversed_at` NULL.
- The customer statement (`_get_customer_statement_scoped_impl`) drops voided invoices but subtracts every write-off with `reversed_at IS NULL`, so a voided invoice's write-off shows as an unexplained credit. `get_customer_transaction_review` and `statement_customer_has_later_balance_activity` also key on `reversed_at`.
- `apply_write_off` only writes on `posted`/`overdue`; `unpost_invoice` refuses when `write_off_cents <> 0`. So a draft/unposted invoice never carries an active write-off; only the posted/overdue/paid branch needs the fix.
- `reverse_write_off` checks the month of the write-off's Chicago date (`created_at AT TIME ZONE 'America/Chicago'`), stamps `reversed_at/by/reason`, and writes a `write_off_reversed` row in `financial_audit_log` (impact `+amount`).
- The credit-month half of KI-99 is already fixed live (KI-18, `20261206110000`: Chicago date).
- Live: 0 active write-offs on voided or cancelled invoices (query below).

## Outcome and authority

Voiding a posted/overdue/paid invoice also reverses each of its active write-offs in the same transaction. One migration re-emits the impl with one added loop; no screen, signature, grant or table change. Authority unchanged: the impl already requires an active admin; callers' guards unchanged. No client-supplied value is new: the write-offs are found by the locked invoice id.

## State and failure

- **Always true after a void:** no `write_offs` row with `reversed_at IS NULL` points at a voided invoice.
- **Month check:** each write-off's Chicago booking month must be open (`check_period_open`), as `reverse_write_off` requires. A closed month refuses the whole void (same as an applied credit in a closed month today). Whole function is one transaction: any refusal leaves the invoice and every write-off unchanged.
- **Recorded:** `reversed_at = now()`, `reversed_by = auth.uid()`, `reversed_reason = 'Auto-reversed: invoice <number> voided — <void reason>'`; one `financial_audit_log` `write_off_reversed` row per write-off, same shape as `reverse_write_off`. Amount and original reason are kept.
- **Existing rows:** none stranded live. Read-only check: `SELECT count(*) FROM write_offs w JOIN invoices i ON i.id = w.invoice_id WHERE w.reversed_at IS NULL AND i.status IN ('voided','cancelled')` → `0` (2026-11-14). The migration does not backfill.
- **Timing:** double click / retry with the same key replays the saved result (impl's existing `check_idempotency`); a second void without key raises `Invoice already voided`. Two admins voiding at once serialize on the invoice row lock; a concurrent `reverse_write_off` locks the write-off then the invoice, the void locks the invoice then the write-offs: a deadlock aborts one cleanly (as with credit applications) — money stays atomic.
- **Undo:** void is not undoable; the reversed write-off shows "Reversed <date>" on the invoice screen (existing card) and drops off the statement, together with the voided invoice.

## Delivery

One database PR to `staging`; the deployed app needs no change (same RPCs). Rollback: a forward migration re-emitting the pre-image (md5 pinned in the preflight).

## Proof cases (disposable PostgreSQL: `scripts/smoke/prove-ki99-void-reverses-write-offs-real-schema.mjs`)

1. When a posted invoice with two active write-offs and one already reversed is voided, then both active ones get `reversed_at/by/reason`, the old reversal is untouched, one `write_off_reversed` audit row is added per active write-off (actor filled), and the invoice is `voided` with `write_off_cents = 0`.
2. When a `paid` invoice settled only by a write-off is voided, then the write-off is reversed and the void succeeds.
3. When one of an invoice's write-offs is in a closed Chicago month (October; booked Oct 31 7:30 pm CDT = Nov 1 UTC), then the void is refused and the invoice and both write-offs are unchanged, including one in an open month; with only November (its UTC month) closed, it passes.
4. When batch void covers an invoice with a write-off, then that write-off is reversed. Group void reaches the same changed function for each member and catches no error, so one refused member rolls back the whole group (checked from the function definitions: a governed split group cannot be seeded without a real split sale).
5. When the customer statement is read after case 1, then neither the invoice nor its write-off appears (the pair contributes $0; no leftover credit).
6. When the void is retried with the same idempotency key, then nothing new is written.
7. When an invoice with no write-off is voided, then no `write_off_reversed` row is added (the existing `invoice_voided` row still is).
8. When an invoice with a write-off also has direct cash applied, then the existing refusal stands and the write-off stays active.

## Challenge (Astra `gpt-6-astra` high, 50 findings) — settled

- **Corrected:** case 5 (no leftover credit, not "balance unchanged"), case 7 (no write-off row; the void row stays), multiple active write-offs and a later closed row rolling back an earlier reversal (cases 1, 3), direct cash with a write-off (case 8), a post-apply read-back (Delivery).
- **Disproved by evidence:** group and batch atomicity — neither `void_invoice_group` nor `_batch_void_invoices_replay_impl_20261015` catches exceptions, so one refusal rolls back all members; period-close race — `check_period_open` takes the month lock (`20261103220000`); stale "active" state — the loop's `FOR UPDATE` re-reads each row after any wait, so a write-off reversed meanwhile is skipped, and a concurrent `apply_write_off` locks the invoice first, then refuses the voided status; audit actor — `financial_audit_log.actor_user_id` defaults to `auth.uid()` with trigger `trg_fill_audit_actor`; direct calls to the impl — EXECUTE is `postgres` only; `reverse_write_off`'s weak inner admin test — its wrapper checks `is_admin()`; screen — Void reloads the invoice (`fetchInvoice`), so the card shows "Reversed"; legacy rows — live has **0 write-offs at all**, 0 orphans, 0 customer mismatches, 0 aggregate mismatches (read as `postgres`, no RLS, 2026-11-14 19:35 UTC); migration order — stamp `20270116100000` is the highest (`npm run next-migration-stamp`); drift — the preflight refuses unless the live body md5 is the pre-image or this file's.
- **Unchanged, out of scope:** idempotency binding and concurrent double-submit of `void_invoice` (KI-10 owns it), batch void selecting only `posted` rows, statements recomputing history after any void, deadlock between a manual reverse and a void (aborts one cleanly, as with credit applications today), void not being undoable.
- **Declined:** reusing `reverse_write_off` inside void (it flips a paid invoice back to posted/overdue mid-void and writes its own receipt; the inline loop keeps one status transition), extra activity/notification lines (the per-row audit and the "Reversed" card cover it), screen copy changes.

## Delivery checks

After the live apply: the impl's body md5 reads back as the postflight value and `SELECT count(*) FROM write_offs w JOIN invoices i ON i.id = w.invoice_id WHERE w.reversed_at IS NULL AND i.status IN ('voided','cancelled')` is `0`. Any row found would be reversed through the normal Reverse button (an admin action), not by a data change. Rollback is a forward migration to the pre-image; voids done under the fix stay done.

## Open business decisions

None (Mason chose auto-reverse 2026-11-14).
