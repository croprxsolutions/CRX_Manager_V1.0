# Behavior contract: a standalone field-application draft follows its fields' payers (#2058)

Read at `origin/staging` dab22364c (2026-11-21). Live checked read-only the same day.

## Facts

- `_save_field_app_invoice_impl_20260714` (newest body: `supabase/migrations/20270129171000_field_app_refuses_product_without_sold_unit.sql`, live md5 `1a4a2655e43392d867b195289df9b9a1`, matches the file).
- The payers come from the selected fields (`derive_customer_shares_from_fields`), never from the screen.
- Editing a **grouped** draft (several payers) already handles payer changes: a member whose payer left the fields is set `cancelled` with totals 0, unlinked from the group, with an `invoice_orphan_cancelled` activity row (`:194-222`); a new payer gets a new draft.
- Editing a **standalone** draft (one payer, no group):
  1. fields now owned by a different farm: the draft is reused for the new payer (`:262`) but its header UPDATE (`:298`) never sets `customer_id`, so the old farm is billed for the new farm's work.
  2. fields now split across several payers: `:262` only reuses the draft when there is one payer, so every payer gets a new draft and the original stays a live draft with its old total and no lines (its lines were deleted at `:162-167`).
- Live 2026-11-21: 3 field-application invoices; 0 standalone invoices whose fields belong to another customer; 0 empty standalone drafts. Neither problem has happened.

## Outcome

A standalone draft is treated exactly as a grouped draft's member already is:
- reused (same id and number) only for the payer it already bills; when the fields are split, it joins the new group as that payer's draft;
- if its payer is no longer among the fields' payers and it is a plain **draft** with no job or blend ticket, it is cancelled the same way a grouped orphan is (status `cancelled`, totals 0, `invoice_orphan_cancelled` activity), and the new payer(s) get new drafts;
- an `unposted` invoice or one made from a job or blend ticket is refused `FIELD_APP_PAYER_CHANGED` instead, whether moved or split (Sol r1: a split would put it in a group, whose later orphan cancel has no such check) (migration reviewers 2026-11-21: a cancel would skip the void, or leave the job `invoiced` on a cancelled invoice; live has one job-made unposted field invoice). Nothing is cancelled; the office voids it or changes the job.

No new table, column, status, permission or argument. Who may save is unchanged (admin or sales rep; actor = caller; posted/voided refused). One new migration re-emits only this function: preflight pins live md5 `1a4a2655…`, and the change is the reuse condition plus the standalone orphan cancel. Files: that migration, its ledger record and changelog entry, a real-schema prover and SQL chain, `src/lib/rpcContracts` fixtures if the md5 list needs it.

## Rules that hold after a successful save

- Every live draft the save leaves is billed to a payer of the fields as derived **by that save** (a later change to a field's billing defaults is not followed until the next save, as today).
- An edit never leaves the original draft live with its lines removed.
- Posted/voided invoices are refused (unchanged). The public save's lock wrapper (20260714224000) already locks the edited row (or its group) and refuses a deleted invoice; the impl now repeats both, which only matters for a direct call.
- All inside the one save transaction (any later refusal rolls the cancel back too); the retry key replays the stored result (unchanged).

## Timing and retries

Same key → stored result (unchanged). Two saves of one draft already take turns on the wrapper's lock. A lost-reply retry whose earlier save cancelled the draft repeats onto the new draft, not the cancelled one (`src/pages/FieldApplicationInvoice.tsx`).

## Screen

After an edit whose result no longer contains the edited id (its payer left), the page opens the first returned invoice instead of reloading the cancelled one (`src/pages/FieldApplicationInvoice.tsx`). This also fixes the same pre-existing case for a grouped member. Works with the old database too (the edited id is then always returned).

## Existing rows

No backfill. Live 2026-11-21 (read-only, by saved payer shares, both location paths): 0 live field-application invoices whose customer is not among their saved location payers; 0 live ones without lines; 0 `invoice_orphan_cancelled` rows ever. Statuses present: cancelled, unposted, voided.

## Same as the grouped path today (Astra challenge, not changed here)

A new payer's draft takes the saver as salesman (rep) and the sent date/notes; a zero-acre share still counts as a payer; the cancelled draft keeps its number and history; stale-tab saves are last-save-wins; overlapping same-key retries rely on the wrapper's key lock. Each matches what a grouped edit already does; changing them is out of scope for #2058.

## Proof cases (real migrated database, prover)

1. When a standalone draft for farm A is re-saved with only farm B's field, then the original is `cancelled` with totals 0 and an `invoice_orphan_cancelled` row, and one new live draft bills B with the lines. Before the fix: the draft keeps A with B's lines.
2. When a standalone draft for A is re-saved with A's field plus B's field, then the original id is reused for A, joins a group with B's new draft, both have lines; no live empty draft remains. Before: the original stays live with no lines.
3. When a standalone draft for A is re-saved with A's fields only (normal edit), then the same id, number and customer are kept (regression).
4. A grouped edit and a new save end exactly as before (existing smoke chains pass before and after).
5. A second apply is refused by the preflight.
6. Moving or splitting an unposted invoice, or a job-made draft, over another farm's fields is refused `FIELD_APP_PAYER_CHANGED`; before, it kept the old farm.
7. A deleted draft is refused `Invoice not found` before and after.

## Open business decisions

None. Cancelling a draft whose payer left follows the existing grouped-draft rule above.
