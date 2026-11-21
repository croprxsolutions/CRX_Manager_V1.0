# Behavior contract: a rep edits only their own field-application invoices

Status: DRAFT (Step 2 of `plan-contract`). Not yet challenged. Code read at `origin/staging` `68045a72c` (2026-11-21).
Closes: the KI-01 related low ("any sales rep can edit another rep's draft field-invoice billing") and the
field-invoice part of KI-03.

## Facts (with sources)

- Every rep write to a field-application invoice goes through owner-rights (`SECURITY DEFINER`) functions that check
  only the role (`is_admin() OR is_sales_rep()`) and the status (`draft`/`unposted`), never who owns the invoice:
  - `update_field_app_invoice_billing`: newest body is `20261120100000_field_invoice_due_date_follows_owner_terms.sql`
    (role check at :1067 and :1195; `UPDATE invoices ... WHERE i.id = ANY(p_invoice_ids) AND status IN ('draft','unposted')` at :1124-1142).
    It takes a list of invoice ids (a split group).
  - `save_field_app_invoice` (existing invoice): newest impl `20270129171000_field_app_refuses_product_without_sold_unit.sql`
    (role check :113; a rep cannot name another salesperson :117-124, but on an existing invoice :300 keeps the old
    `salesman_id` and the edit goes through; it deletes and re-inserts `invoice_shares` and
    `field_app_location_shares`). The same file has a second save body (:1063, :1179) to cover the same way.
  - `update_field_app_applied_info` (applicator, weather, diluent): wrapper `20261123110000_bind_ops_replay_receipts_batch4e.sql`,
    body `20260630190000_field_app_invoice_diluent_per_acre.sql`; role-only.
- Direct table writes:
  - `invoices`: INSERT/UPDATE/DELETE revoked from signed-in users (`20260719044912`:155, `20260719093000`:59).
  - `invoice_shares_insert` policy: `WITH CHECK (is_admin() OR is_sales_rep())`, no owner test
    (`20260219200000_invoice_statement_enrichment.sql`:119). UPDATE/DELETE are admin-only.
  - `field_app_locations` / `field_app_location_shares`: INSERT/UPDATE/DELETE are `is_admin() OR is_sales_rep()`
    (`20260430230000_field_app_workflow_phase11.sql`:36-43, :59-67).
  - A trigger refuses child writes once the invoice is posted (`20261022022000`:383-388), so the gap is drafts/unposted only.
  - No screen writes these three tables directly (`git grep` on `src/` and `supabase/functions/`: reads only).
- Read rule today: a rep reads an invoice they created or are the salesperson on
  (`invoices_select`, `20260213100000_phase2_billing_architecture.sql`:256-261). The screen (`FieldApplicationInvoice.tsx`
  `canEdit`, ~:2469) checks status only, no owner.
- Live, read-only (2026-11-21): 3 field-application invoices, all created by an admin; the only open one (unposted)
  has no salesperson. No rep-owned field invoice exists yet, so no existing row changes meaning.

## Established decision (cited)

`DECISION_LOG.md` 2026-10-13 ("Reps see all invoices"): `INVOICE_SCOPE_DENIED` — a rep changes or posts only an
existing invoice under their own name: **they are its salesperson, or it has none and they created it.** Admins are
unrestricted. (Reps reading every invoice is the later step and is NOT in this change.)

## 1. Outcome and authority

- **Result:** a sales rep can change a draft or unposted field-application invoice only when it is theirs (rule
  above). Admins: unchanged. Posted invoices: unchanged (already locked).
- **Smallest change:** one migration adding one helper, `_rep_owns_invoice(invoice_id)` (true for an admin; for a rep:
  `salesman_id = me`, or `salesman_id IS NULL AND created_by = me`), called inside the three functions after the
  existing role check, per invoice id, under the row lock they already take; plus the three write policies get
  `is_admin() OR _rep_owns_invoice(invoice_id)` in place of `is_admin() OR is_sales_rep()`. Refusal raises
  `INVOICE_SCOPE_DENIED`. Then a screen PR: hide/disable Edit and Save on an invoice the rep does not own, with a
  one-line reason.
- **Bulk:** `update_field_app_invoice_billing` takes a list; every id must pass, or the whole call is refused (no
  partial write).
- **Locators:** the invoice ids the screen sends are only locators; ownership is read from the locked row, the actor
  from `auth.uid()`.
- **Files expected:** `supabase/migrations/<new>_field_invoice_rep_scope.sql`, a real-schema prover under
  `scripts/smoke/`, ledger `docs/changelog.d/`, `KNOWN_ISSUES.md` (KI-01, KI-03); later `src/pages/FieldApplicationInvoice.tsx`.
  All on the Sol list (database), so Sol before the PR.

## 2. State and failure

- **Existing rows:** no rep-owned field invoices live (query above), so nothing a rep does today changes. The one
  unposted admin-created, no-salesperson draft becomes admin-only to edit (it already is in practice).
- **Deployed app during rollout:** the old screen still shows Edit to a non-owner rep; the save then fails with
  `INVOICE_SCOPE_DENIED`, shown as an error toast. Safe (no partial write), just unfriendly until the screen PR lands.
- **Timing:** the check runs under the existing row lock in the same transaction as the write, so an admin
  reassigning the salesperson at the same moment either lands first (rep refused) or after (rep's save stands). A
  retry with the same idempotency key replays the stored result; a refused call stores nothing.
- **Undo/history:** none added; refusals write nothing.

## 3. Delivery

Database PR first (into `staging`), compatible with the deployed app. Screen PR after it is applied on staging.

## 4. Proof cases (real-schema prover, test data; as the real caller)

1. When rep A saves, updates billing on, or updates applied info on rep A's own draft, then it succeeds (unchanged).
2. When rep B does any of the three on rep A's draft, then `INVOICE_SCOPE_DENIED` and no row changes.
3. When rep B inserts an `invoice_shares`, `field_app_locations` or `field_app_location_shares` row directly onto
   rep A's draft, then RLS refuses it.
4. When a rep updates billing on a split group with one sibling not theirs, then the whole call is refused and no
   sibling changes.
5. When a draft has no salesperson, then its creator rep may edit it and another rep may not.
6. When an admin does any of the above on any draft, then it succeeds.
7. When rep A creates a NEW field invoice, then it still succeeds (new invoices are not gated).
8. Browser (after the screen PR, staging): a non-owner rep sees the invoice read-only with the reason.

## Open business decisions

1. **Invoice a rep created but another rep is the salesperson on.** The recorded rule makes it the salesperson's
   only; the creator can still read it but not edit. Options: (a) keep the rule (recommended; matches the 2026-10-13
   decision and the planned wider read); (b) also let the creator edit (looser; reverses that decision).
2. **Admin-created draft with no salesperson** (the live one today): admin-only to edit under the rule.
   Options: (a) keep (recommended; an admin can assign a salesperson to hand it over); (b) let any rep edit unassigned
   drafts (reopens the hole for unassigned work).

## Not in scope

`unpost_invoice`, `unpost_invoice_group`, `transfer_invoice_to_job`, `consolidate_draft_invoices` (general invoice
actions; Taha owns invoices/billing until 2026-12-15); reps reading every invoice (KI-03's later step);
`field_billing_defaults` (field-level splits, not per invoice); commission splits; quote rollover.
UNVERIFIED, to check before build: whether any other owner-rights function writes `invoice_shares` for an existing
field invoice by id (several recent migrations insert into it, e.g. `20270120150000`, `20270129190000`).
