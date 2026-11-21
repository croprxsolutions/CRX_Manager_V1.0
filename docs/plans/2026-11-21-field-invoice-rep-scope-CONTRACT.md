# Behavior contract: a rep edits only their own field-application invoices

**DROPPED (Mason, 2026-11-21: "Drop the fix").** Any rep may edit any draft or unposted field invoice, as the app works today. Nothing below is built. Recorded in `docs/manual/DECISION_LOG.md` (2026-11-21) and under KI-01 and KI-03.

Status: REVISED after one cold challenge (Astra `gpt-6.2-astra` high, 2026-11-21, 48 findings; disposition at the end).
Code read at `origin/staging` `68045a72c` (2026-11-21). Closes the KI-01 related low ("any sales rep can edit
another rep's draft field-invoice billing") and the field-invoice part of KI-03.

## Facts (with sources)

- Rep writes to a field invoice go through owner-rights (`SECURITY DEFINER`) functions that check only the role and the
  status, never the owner:
  - `update_field_app_invoice_billing`: newest body `20261120100000_field_invoice_due_date_follows_owner_terms.sql`
    (role :1067/:1195; rows locked `FOR UPDATE` by id at :1122; `UPDATE ... WHERE id = ANY(p_invoice_ids) AND
    status IN ('draft','unposted')` :1124-1142; affected-count check after). Takes a list of ids.
  - `save_field_app_invoice` (existing invoice): lock wrapper `20260714224000_field_app_save_post_lock.sql` takes a
    group advisory lock and then locks every live group member (or the single invoice) `FOR UPDATE` (:75-112) before
    calling the impl. Newest impl `20270129171000_field_app_refuses_product_without_sold_unit.sql:43`: role :113; a rep
    cannot name another salesperson :117-124; on an existing invoice :300 keeps the old `salesman_id`; clears and
    rebuilds children across the whole group and can cancel a removed customer's member (:154-307).
  - `update_field_app_applied_info`: wrapper `20261123110000_bind_ops_replay_receipts_batch4e.sql:929-1010` (keyless old-tab
    branch returns early into the implementation), body `20260630190000_field_app_invoice_diluent_per_acre.sql:61-196`. Role-only.
- Already enforced, same rule, to copy exactly:
  - `post_invoice` (`20261022022000_post_binds_reviewed_invoice_version.sql:458-467`): row locked, then a sales rep is
    refused with `INVOICE_SCOPE_DENIED` unless `salesman_id IS NOT DISTINCT FROM actor OR (salesman_id IS NULL AND
    created_by IS NOT DISTINCT FROM actor)`. `post_invoice_group` also enforces it (:610).
  - Split save `_save_field_app_split_invoice_impl` (`20270129171000`:1054, check ~:1341-1347): every live child must
    pass the same predicate or `SPLIT_SET_NOT_OWNED`.
  - `delete_invoices` is admin-only (`20261215110000_chem_sale_bill_split_invoices.sql`, `require_admin()`).
- Direct table writes:
  - `invoices`: INSERT/UPDATE/DELETE revoked from signed-in users (`20260719044912`:155, `20260719093000`:59).
  - `invoice_shares`: INSERT `is_admin() OR is_sales_rep()` with no owner or invoice-type test
    (`20260219200000_invoice_statement_enrichment.sql`:119); UPDATE/DELETE admin-only (:123, :127).
  - `field_app_locations`, `field_app_location_shares`: INSERT/UPDATE/DELETE `is_admin() OR is_sales_rep()`
    (`20260430230000_field_app_workflow_phase11.sql`:36-44, :59-67). A grouped location has `invoice_id` NULL and an
    `invoice_group_id`; a location share points at a location, not an invoice.
  - No screen or Edge Function writes these three tables directly (`git grep` of `src/`, `supabase/functions/`: reads only).
  - The posted-invoice freeze trigger is on `invoice_items`, `invoice_shares`, `field_app_locations`,
    `invoice_line_shares` (`20261022022000`:380-391), **not** on `field_app_location_shares`.
- Read rule: a rep reads invoices they created or are the salesperson on (`20260213100000`:256-261). The screen's
  `canEdit` (`FieldApplicationInvoice.tsx` ~:2469) checks status and the siblings it can see; it drives the
  posted-lock banner, Post and Delete feedback.
- Live, read-only (2026-11-21): 3 field invoices, all admin-created; the only open one (unposted) has no salesperson.

## Decisions

- Recorded 2026-10-13 (`DECISION_LOG.md`, `INVOICE_SCOPE_DENIED`): a rep changes or posts only an existing invoice
  under their own name (salesperson, or none and they created it). Admins unrestricted.
- Mason, 2026-11-21 ("Whatever you recommend"): (1) an invoice a rep created but another rep is the salesperson on is
  the salesperson's only; the creator keeps read access. (2) An admin-created draft with no salesperson is admin-only
  to edit; an admin hands it over by assigning a salesperson.
- Technical, following the recorded rule: **the group is the unit.** Every write here can touch every member of a
  split group, so a rep may change a field invoice only when they own every live member of its group (as the split
  save and `post_invoice_group` already require). A mixed-owner group (only possible after an admin reassigns one
  member) is admin-only to edit.

## 1. Outcome and authority

- **Result:** a sales rep can save, change billing on, or change applied details of a draft/unposted field invoice
  only when they own it and every live member of its group. Admins: unchanged. New invoices: unchanged.
- **Ownership predicate:** copied verbatim from `post_invoice`, null-safe (`IS NOT DISTINCT FROM`); anything but a
  definite true is a denial. The actor is `auth.uid()` (already checked equal to `p_performed_by`); the role comes from
  the active profile, so an inactive or non-rep account is refused by the existing role checks first.
- **Where it runs (fresh writes only):**
  - Save: in the lock wrapper, right after it has locked the group (or single invoice): the anchor must exist and be
    live; every locked live member must pass. This runs before the impl's "cannot attribute to another user" check,
    so the rep sees the scope denial, not the attribution error.
  - Billing and applied details: in the implementation body both the keyed and keyless paths reach, before the
    `UPDATE`: take the group advisory locks (ascending group id) and lock every live member of every affected group
    `FOR UPDATE` by id (the save/post order); require every supplied id to be found live, editable and field-type;
    require every locked member to pass. All or nothing; the existing affected-count failure stays.
  - Refusal: `RAISE EXCEPTION 'INVOICE_SCOPE_DENIED' USING ERRCODE = '42501'`. Unknown or unreadable ids get the
    existing not-found/not-editable errors, so a denial reveals nothing about invoices the rep cannot read.
- **Direct table writes (smaller design, finding 48):** reps lose direct INSERT/UPDATE/DELETE on
  `field_app_locations` and `field_app_location_shares` (admin-only, like `invoice_shares` update/delete), and lose
  direct `invoice_shares` INSERT **only when the parent invoice is a field invoice** (non-field behavior unchanged).
  The owner-rights save keeps writing them. No ownership logic lives in policies.
- **Screen:** one new read-only owner-rights function, `field_invoice_edit_state(p_invoice_id)`, returns for the caller
  `{editable, reason}` with reason one of `ok`, `locked_status`, `not_owner`, `unavailable`; it reveals nothing about
  hidden siblings beyond that yes/no. The screen shows Edit, Save, Post and Delete only when `editable`, keeps them off
  while it is unknown, and shows the reason (a not-owner banner instead of the "posted/voided" text).
- **Files expected:** `supabase/migrations/<new>_field_invoice_rep_scope.sql` (+ ledger `docs/changelog.d/`), a
  real-schema prover in `scripts/smoke/`, `docs/manual/KNOWN_ISSUES.md`; later `src/pages/FieldApplicationInvoice.tsx`
  and its test. Database files are on the Sol list.

## 2. State and failure

- **Existing rows:** no rep-owned field invoice exists live, so no rep loses access to their own work. The one
  admin-created unassigned unposted draft becomes admin-only, matching decision (2). This removes a capability; it
  does not claim reps never used it.
- **Timing:** the check runs on rows locked in the same transaction as the write, in the lock order save and post use,
  so a concurrent reassignment or post either finishes first (rep refused, or posted-state refusal) or waits. Stale
  content between two authorized editors is not addressed here (out of scope; existing behavior).
- **Retries:** an exact retry of an earlier successful, actor-bound request returns its stored receipt without a new
  write (existing receipt behavior). A fresh request, or a retry after a denial, is checked against current ownership.
- **Old tabs / partial screen save:** the screen saves the invoice, then sends applied details and billing as separate
  calls. If an admin reassigns between them, the save stands and the later call is refused. The screen then reloads
  and says the invoice was saved but its applicator/weather/billing changes were not, because it is no longer theirs;
  it never retries as a new invoice. Old tabs get the generic error toast until the screen PR deploys; no partial write
  inside any one call.
- **Undo/recovery:** nothing to undo (refusals roll back). If the migration wrongly blocks a valid owner, roll forward
  with a fix migration; an admin can finish any blocked invoice meanwhile. A faulty screen PR is reverted on its own;
  the database rule stays.

## 3. Delivery

1. Database PR into `staging` (the checks, the policy changes, `field_invoice_edit_state`), compatible with the
   deployed screen; Sol before the PR; staging DB job applies it.
2. Screen PR after (1) is applied on staging.
3. KI-01's low and KI-03's field part close only when both are live in production (release) and a read-only production
   check confirms the function bodies and policies.

## 4. Pre-build checks (must pass before building on them)

- P1. List every callable owner-rights function that writes `invoice_shares`, `invoice_items`, `field_app_locations`,
  `field_app_location_shares` or field-invoice headers for an **existing** invoice id, from the newest definition of
  each (e.g. `20270120150000`, `20270129190000`, the split save, the `save_field_app_invoice` public wrappers). Each is
  covered, already owner-checked, admin-only, or listed out of scope.
- P2. Confirm both applied-info branches (keyed, keyless) reach the one body that gets the check, and the billing
  public wrapper reaches its impl the same way.
- P3. Read live `pg_policies` and table grants for the three child tables, and execute grants for the touched
  functions, so the migration replaces exactly what is live and keeps private grants.
- P4. Confirm receipts are bound to actor and request (a different actor or payload cannot replay another's result).
- P5. Confirm the newest definition of each touched function (no later re-emit) at build time.

## 5. Proof cases (real-schema prover with test data, as the real caller; observer is an admin/owner session)

1. Owner rep (salesperson) saves, changes billing, changes applied details on their own draft and unposted invoice → succeeds.
2. Creator rep whose invoice now has another salesperson → all three refused `INVOICE_SCOPE_DENIED`; the salesperson
   who did not create it → succeeds.
3. No salesperson: the creator rep succeeds; another rep refused; the admin-created unassigned draft → every rep refused.
4. Unrelated rep on another rep's draft → refused; observer confirms headers, totals, items, both share tables,
   locations, group membership and statuses unchanged.
5. Mixed-owner group: rep owns member A, not B → save of A, billing on [A], applied details on [A] all refused; B is
   not cancelled; nothing changes.
6. Billing/applied lists with a duplicate id, an unknown id, a soft-deleted id, a posted id, a non-field id → refused,
   no partial change.
7. Admin does all of the above → succeeds, as today. Inactive rep, driver, applicator, no session, mismatched
   `p_performed_by` → refused as today.
8. Rep creates a new field invoice (single and multi-customer) → succeeds; every new member has that rep as
   salesperson and creator.
9. Direct writes as a rep: INSERT/UPDATE/DELETE on `field_app_locations` and `field_app_location_shares` and INSERT on
   `invoice_shares` for a field invoice → refused/zero rows, state unchanged; `invoice_shares` INSERT on a non-field
   invoice behaves as before; admin direct writes unchanged.
10. Two sessions: an admin reassigns while a rep saves (both orders); a post during a rep save → committed state matches
    the order; no deadlock.
11. Exact retry of an earlier successful rep request after reassignment → stored result, no new write; a fresh request → refused.
12. `field_invoice_edit_state` returns `ok`, `not_owner`, `locked_status`, `unavailable` for the matching cases and
    nothing more.
13. Browser on staging (screen PR): the assigned rep saves; the assigned-away creator sees it read-only with the
    reason; an unrelated rep gets the existing "unavailable" page; an old tab's refused save leaves the expected state.

## Not in scope

`unpost_invoice`, `unpost_invoice_group`, `transfer_invoice_to_job`, `consolidate_draft_invoices` (Taha's billing area
until 2026-12-15); reps reading every invoice (KI-03 later step); `field_billing_defaults`; commission splits; quote
rollover; stale-content protection between two authorized editors. Follow-up to log: the posted-invoice freeze trigger
does not cover `field_app_location_shares` (admins can still change a posted invoice's location shares directly).

## Challenge disposition (Astra, 48 findings)

- Contract corrected: 1, 3, 4, 5, 6, 7, 9 (group is the unit), 10, 14, 15, 16, 17, 19, 22, 24, 26 (exact replay keeps
  its receipt), 28, 29, 31, 33, 34, 35, 36, 39, 40, 41, 42, 43, 45, 46, 47, 48 (adopted).
- Disproved with code: 2 (the save lock wrapper takes the group advisory lock and locks every member,
  `20260714224000`:75-112); 37 (`post_invoice`/`post_invoice_group` already enforce the rule, `20261022022000`:458-467,
  :610); 38 (`delete_invoices` is admin-only).
- Confirmed and moved out of scope as a follow-up: 20 (no freeze trigger on `field_app_location_shares`; reps lose
  direct writes, so only admins are affected).
- Pre-build checks: 8, 13 (P1); 28 (P2); 23, 25 (P3); 27, 30 (P4); 44 (P5).
- Out of scope, stated: 11, 12 (existing save-rebuild behavior for owners; unchanged by this change), 18, 21 (direct
  child writes removed for reps, so policy-time resolution is not needed), 32 (stale content).

## Targeted re-check (Astra high, 2026-11-21, 20 findings) — ON HOLD

Build is on hold: Mason gave a conflicting answer in another session ("Anyone" / "Any rep"), and the parent session
is confirming A (drop the fix) or B (lock down as planned). If A, this contract is dropped and the decision recorded
under KI-01/KI-03. If B, settle these before building (no further challenge round, per `plan-contract` Step 3):
- Business (ask Mason only if B): an A-only billing/applied change when sibling B has another owner (re-check 2);
  a rep-owned group with one posted member (7).
- Simplify the screen: drop `field_invoice_edit_state` if possible (findings 9-12 all come from it); otherwise give it
  its own caller contract, existing-invoices only, one disclosure-safe reason, and leave Post/Delete on their own checks.
- Server: field-type check on the save anchor (4); copy the save wrapper's anchor-then-fresh-set lock and group
  re-check into billing/applied (5); identical outward error for hidden and unknown ids (3); parent-type check for the
  `invoice_shares` policy that does not depend on the rep's read access (8); membership writers honor the group lock (6).
- Proof additions: billing/applied two-session and opposite-order cases (17); keyed retry after a denial (14); admin
  expected result per invalid-input case (16); partial-save message per committed call (15); new-invoice creation
  through the screen (12); per-endpoint receipt binding (13); `post_invoice_group` :610 and `delete_invoices` bodies
  quoted (19).
- Refuted: 20 (an admin can set the salesperson on save: `20270129171000`:300 `CASE WHEN is_admin() THEN
  COALESCE(v_salesman_id, salesman_id)`). 1 is a packet limitation (original findings are in the session record).
