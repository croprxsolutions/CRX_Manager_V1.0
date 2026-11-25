# Behavior contract: field owner change refreshes the billing copy (FP-1 follow-up)

Read at FP-1 head `451afc8a3` (#2487, `20270305190000_field_split_versions.sql`). Follow-up to Sol round 6 on #2487
(Mason, 2026-11-25: "Land now, follow-up").

## Outcome and authority

- **Business result:** when a field's owner changes by any path, the copy that billing reads (`field_billing_defaults`)
  is recomputed in the same transaction by FP-1's rule (Mason, 2026-11-24, "Yes, automatic"): the new owner is
  primary when they pay product share; otherwise the largest positive product share, lowest customer id on a tie; a
  field with no split in force has no copy rows (Create Invoice then needs saved job shares, as today). Today the copy
  follows only a Field Setup save (`save_field` refreshes it) or the next nightly refresh, so Create Invoice on a job
  without saved job shares can anchor the job to the old owner's invoice in between (Sol r6 MED).
- **Smallest change:** one `AFTER UPDATE OF customer_id ON public.fields` row trigger, only when the owner actually
  changes (`WHEN OLD.customer_id IS DISTINCT FROM NEW.customer_id`; `save_field` names the column on every save),
  through a SECURITY DEFINER wrapper (the refresh helper is granted to no API role) that calls FP-1's
  `_refresh_field_billing_defaults_copy_20270303(NEW.id)`. At install, one call of FP-1's
  `_refresh_all_field_billing_copies_20270303()` repairs any copy already stale. No new table, lock, timer or job.
- **Who may change an owner:** unchanged: `fields` UPDATE policies plus FP-1's BEFORE trigger
  `fields_owner_change_page_access`. The new trigger runs only on updates those allow.
- **Writers of `fields.customer_id`** (all migrations and `src/` searched, 2026-11-25): `save_field` and a direct
  UPDATE through the fields policies or SQL. No other trigger assigns `NEW.customer_id`; no RPC, merge or bulk path
  rewrites it. Nothing references `field_billing_defaults` rows by id (no foreign key), so the refresh's
  delete-and-insert is safe.
- Files: new migration `20270306180000_field_owner_change_refreshes_copy.sql`, its record and ledger note, the FP-1
  record's rollback text, `scripts/smoke/prove-field-split-versions-real-schema.mjs`.

## State and failure

- **Automatic record change:** the copy rows are rewritten to the expected set; shares, payers and split versions do
  not change. Posted, paid and overdue invoices are untouched (share rows frozen; Taha's #2487 review). Invoices
  already created keep their customer links; the refresh never revisits them.
- **Rule that always holds:** after a committed owner change, the copy equals `_field_billing_copy_expected_20270303`
  for that field. Same transaction (a later failure in the same save rolls the refresh back with it); no outside
  effects.
- **Existing rows:** the install-time catch-up repairs a copy left stale by an earlier direct owner change. A field
  someone holds is skipped (same as the nightly run) and repaired at the next nightly run.
- **Lock order:** the UPDATE holds the field row, then the refresh rewrites that field's copy rows: the same order as
  the split writer and `save_field`. Known limit: a single UPDATE that changes owners on several fields at once can
  deadlock with an order invoice locking two of them; PostgreSQL aborts one and it can be retried (no partial
  write). No screen does multi-field owner changes.
- **Timing:** two owner changes on one field queue on the row; each ends with the copy for its own owner. An owner
  change in a transaction that started before Central midnight computes "today" from its start time; the nightly
  refresh (05:10 and 06:10 UTC) corrects it.
- **Undo:** this follow-up's rollback drops the trigger and its wrapper; the nightly refresh still repairs copies. A
  full FP-1 rollback must drop this trigger and wrapper first.
- **Out of scope (unchanged existing behavior):** a multi-field job anchors to the first primary in customer-id order;
  a stale Field Setup tab can resend an older owner (last save wins); saved job shares win over the copy.

## FP-1 rollback recipe (Sol r6 MED, no behavior change)

FP-1's header recipe drops `field_payer_notes`, losing every payer note. Corrected recipe (FP-1 record and this
migration's record): keep `field_payer_notes` and its office-only RLS (do not copy notes into
`field_billing_defaults.notes`: assigned applicators read the copy, Mason 2026-11-24). A full FP-1 rollback is a
destructive change (it drops split history) and needs Mason's explicit yes at that time.

## Proof cases (local Docker, `prove-field-split-versions-real-schema.mjs`)

1. When a signed-in admin changes F5's owner from paying B to paying C by a direct UPDATE, then in the same
   transaction the copy marks C primary; shares unchanged; the nightly refresh then finds nothing to do.
2. When Create Invoice then runs on a $100.00 job on F5 (10 Gal at $10.00, 10 acres, no application fee), then there
   is one invoice per payer, each within 50 cents of its exact share (Mason, 2026-11-22, "Allow up to 50c"), and the
   job anchors to C's invoice.
3. When a rep with Fields & Maps turned off changes an owner, it is refused (FP-1 case, kept).
4. When Create Invoice runs on a $100.00 job on the 50.01/50.00 field, then it splits the 10 Gal by acre share to
   4 decimals and prices each payer's quantity on its own: 5.0005 Gal = 5001 cents and 4.9995 Gal = 5000 cents
   (existing job-invoice rule, unchanged by FP-1, which stores the same shares), and the job anchors to the owner.
   Corrected 2026-11-25 after the first real run: the draft expected 5000/5000 from a model of job billing, not the
   real function.
5. The proof passes on any calendar date (no fixed future date).

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-25): 24 findings, settled

- Corrected: install-time stale copy (1: catch-up refresh), "follows the owner" wording (2), invoice proof not tied
  to the owner change (3: case 2), WHEN clause (15), SECURITY DEFINER wrapper (9), lock timeout and rollback order
  (19), notes rollback must not expose notes to applicators (21, 22).
- Disproved: copy row ids referenced elsewhere (6: no foreign key); another trigger assigning the owner (14: none);
  rollback after a refresh (18: one transaction).
- Out of scope, existing behavior unchanged: 4, 5, 10, 11, 12, 13; 16 and 17 documented above as known limits.
- 20 and 23: FP-1 and this follow-up ship in one release, so no live window exists; a full FP-1 rollback stays a
  destructive change needing Mason's yes at the time. 24 (keep notes recovery separate): declined; it is a text-only
  recipe change, no code.

## Open business decisions

None.
