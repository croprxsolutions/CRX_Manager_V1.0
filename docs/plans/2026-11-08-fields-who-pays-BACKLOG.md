# Fields and who pays: backlog (foundation 18.1)

**Status: BACKLOG, 2026-11-08. Planning only; nothing here authorizes building.** Mason asked for foundation 18.1 to be planned the Product Master way: a numbered list of everything wrong or missing, then a build sheet (`2026-11-08-fields-who-pays-BUILD-SHEET.md`), then an advisory Sol review. Building starts only when Mason says so, one package at a time.

**Evidence:** `main` at `5a921026e` (0 behind on 2026-11-08); migrations and source read in that checkout; read-only queries against the live database the same day (row counts, policies, grants, function list, column list). Line numbers drift; re-check each item at build time. Migration paths are under `supabase/migrations/`.

**Target ("Done when" from the roadmap, `docs/plans/2026-11-08-foundation-roadmap.md` §1):** each field has one billing split group (payers and percentages that sum to exactly 100%, with history); every split path (job, field app, order, delivery) reads it; fields are archived through an RPC, never hard-deleted from a screen; job access ends when the job ends; billing uses one acres value.

**Marks:** 💲 money; 🔒 permissions or security; DB needs a migration; ❓ not confirmed; 🧑 needs a Mason decision (build sheet §5).

**Live data size (2026-11-08, read-only count):** 5 fields, 6 `field_billing_defaults` rows, 5 `job_field_shares`, 2 `field_app_location_shares`, 3 `invoice_shares`, 0 `invoice_line_shares`, 0 `order_shares`, 0 `order_item_field_allocations`. Any data move is tiny; the risk is in the rules, not the volume.

---

## A. Where "who pays" lives today (corrects the roadmap)

1. **The roadmap's "8 places" list mixes in two payment tables.** `order_line_allocations` and `invoice_line_allocations` hold how a *payment* is spread over lines, not who pays for a field (`20260213100000:107-145`; direct writes revoked in `20261022040000`). Corrected list of places that say who pays for a field:
   - `fields.customer_id`: the field's owner (`20260213000000:12-33`), used as the 100% fallback when a field has no split.
   - `field_billing_defaults`: the field's standing split (`20260213000000:42-53`).
   - `job_field_shares`: a per-job copy (`20260624120000:71-80`).
   - `field_app_location_shares`: per-location shares on a field-application invoice (`20260406100000:43-51`).
   - `invoice_shares`: one row per payer on a split invoice (`20260219200000:85-96`).
   - `invoice_line_shares` and `invoice_line_share_snapshots`: the per-line split engine, PR #164 (`20260720213000:83-150`).
   - `order_item_field_allocations`: acres per order line per field (`20260617143755:24-32`); payers then come from the field's split.
   - `order_shares`: the order's "Bill Split card" (`20260309100000:17-27`). Taha's PR #1524 adds `order_item_shares` beside it.
2. **Four different share formats.** `numeric(9,6)` percent in most tables; integer micro-percent (100,000,000 = 100%) in `invoice_line_shares`; acres in `order_item_field_allocations`; cents in `amount_cents` columns. Each path converts on its own.
3. **No field split history.** No split table has effective dates or versions; `save_field` deletes and re-inserts the whole split on each save (`20261107140000:124-131`). Once a split changes, nobody can tell which split applied to last spring's work. Only posted per-line invoices keep a snapshot (`invoice_line_share_snapshots`). DB
4. 💲 **"Sum to 100%" is checked in one table only, and not exactly.** `field_billing_defaults` has a deferred trigger allowing 99.99–100.01 (`20260713060600:13-59`). `order_shares` only blocks totals over 100.01 (`20260616121521`). `job_field_shares`, `field_app_location_shares` and `invoice_shares` check each row only. Thirds *can* add to exactly 100 in `numeric(9,6)` (33.333334 + 33.333333 + 33.333333), but nothing makes a writer do that, which is why the tolerance exists (corrected after the Astra review: the plan's micro-percent integers are for one exact representation shared with the per-line engine, not for extra precision). DB
5. 🧑 **Owners and landlords are not separate from customers.** There is no owner or landlord column; a landlord is any customer row listed in a split. Real split patterns in Mason's records: 100% one payer; 50/50; 50/25/25; thirds; 2/3–1/3; and a 60/40 landlord share where the landlord **does not pay the application charge**. The last one cannot be stored on a field today.

## B. Each billing path reads something different

6. 💲 **The job invoice ignores the job's own shares.** `_transfer_job_to_invoice_intent_impl_20260908` (newest body in `20261120100000`, split block about 110–190 lines into the function) reads the field's live `field_billing_defaults` and `job_fields.acres_to_treat`, never `job_field_shares`. A split edited on Job Detail (`src/pages/JobDetail.tsx:2840-2844`, saved by `save_job` at :2910) does not reach the invoice, while `get_job_billed_customers` (`20261026050000:283`) *does* read the job shares. The job screen and the invoice can disagree.
7. 💲 **CONFIRMED live bug: a field billed wholly to a landlord bills the grower's account.** The job invoice splits only when a field has more than one billing-default payer (same function: "Trigger ONLY on EXPLICIT multi-owner billing"). With one payer who is not the job's customer, the invoice is created under `v_job.customer_id` (`20261120100000:764`) while `invoice_shares` names the landlord at 100% (:865): the balance and aging go to the grower, statements and year-end summaries show the landlord (confirmed by the independent Opus review, 2026-11-08). Fixed first in build sheet FP-4.
8. 💲 **Two field-application invoice engines run side by side.** The location engine (`_save_field_app_invoice_impl_20260714`, `20260904180000:683-714`) takes its split from `derive_customer_shares_from_fields` and writes `field_app_location_shares` + `invoice_shares`. The per-line engine (`_save_field_app_split_invoice_impl`, `20261204100000:3629`) uses `resolve_line_split_vector` (job shares → field defaults → owner, `20261013220000:1947`) and writes `invoice_line_shares`. The per-line engine is switched on (`per_line_split_billing_enabled`) but has 0 live rows; the location engine holds the only real split rows. Field invoicing before February needs one of them.
9. 💲 **Blend-ticket invoices use the location-style split** via `derive_customer_shares_from_fields` (`create_invoice_from_blend_ticket`, `20261022020000:322-343`).
10. 💲 **Order field splits** go through `order_item_field_allocations` acres, then `field_billing_defaults` (`_create_split_invoices_from_order_provenance_impl_20260719`, `20261029160000:432-491`). The plain order invoice refuses an order with field allocations (`ORDER_HAS_FIELD_SPLIT`, `20261022021000:235`); the delivery invoice refuses split orders (`ORDER_NEEDS_SPLIT_BILLING`, `20260827041200:678-684`).
11. **`order_shares` reaches no invoice on `main`.** No database function reads it except its own sum guard (`20260616121521:30`). Taha's PR #1524 (open, not applied) makes it a live billing path for chemical sales; his `_order_has_bill_split` returns false when a line has a field allocation, so "the field split wins over the card". That is the right boundary; this plan keeps it.
12. **`derive_customer_shares_from_fields` writes nothing.** Confirmed in the live body: a read-only, office-only function (`20261023090000:447`) that returns payers from `field_billing_defaults`, or the owner at 100%. Callers: the location engine, blend tickets, and the browser preview (`src/pages/FieldApplicationInvoice.tsx:1634`). It is the closest thing to "one resolver" today, but it has no date (no history) and uses `total_acres` (item 19).

## C. Screens that write tables directly (no RPC, no retry key)

13. 🔒💲 **`src/pages/Fields.tsx:254` hard-deletes fields** with `.from('fields').delete()`. Live policy `fields_delete` allows any admin. `field_billing_defaults`, `field_polygons`, `field_crop_history` and `field_obstacles` cascade (`ON DELETE CASCADE`, live check), so deleting an unused field silently erases its split, boundary and crop history. Fields used by jobs or invoices are blocked by foreign keys, which the screen reports as an error. DB
14. 💲 **`src/pages/OrderDetail.tsx:960` inserts and :985 deletes `order_shares` directly** and works out the amount in the browser from a dollar total (`Math.round(order.total_price * 100 * (pct / 100))`, :959). Taha's PR #1534 rewrites this card. **This belongs to his billing work, not this plan** (build sheet §3).
15. 💲 **`src/pages/OrderDetail.tsx:1005` inserts and :1022 deletes `order_item_field_allocations` directly.** This is the field side of an order and belongs here, but `OrderDetail.tsx` is also edited by Taha's PRs #1534 and #1587.
16. 🔒 **Every split table still grants direct writes to signed-in users.** Live check: `authenticated` has INSERT and DELETE on `fields`, `field_billing_defaults`, `job_field_shares`, `field_app_location_shares`, `order_shares` and `invoice_shares`, and policies let any admin or sales rep write. Every legitimate writer except items 13–15 is a SECURITY DEFINER RPC, so the grants can go once those screens use RPCs. DB (grant change: needs Mason's `I approve`)
17. 🔒 **`anon` still holds SELECT on most of these tables** (live `has_table_privilege` check). Policies keep the rows hidden, so nothing leaks today, but the grant is not needed. `field_app_location_shares` policies are written for role `public` rather than `authenticated`. LOW. DB
18. 💲 **Split rows are built in the browser** on Field Setup (`src/pages/FieldSetup.tsx:631`), bulk field import (`src/components/fields/BulkFieldImport.tsx:562`) and Job Detail (`JobDetail.tsx:2840-2844`); the server checks the sum only for field defaults. The server should take "these payers, these percents" and enforce every rule itself.

## D. Acres

19. 💲 **No single billable-acres value in the database.** The two-acre model (`20260623120000_fields_two_acre_model.sql:33-41`) added `measured_acres`, `override_acres` and a generated *label* `acres_source`, but no generated acres number. Billable acres = override → measured → `total_acres`, computed only in the browser (`src/lib/fieldGeometry.ts:58`, `billableAcres`). Database paths that use plain `total_acres` instead: `derive_customer_shares_from_fields`, the blend-ticket fallback (`20261022020000:323,335`), and `save_field`, which writes only `total_acres`. `src/components/field-app/SelectLocationsModal.tsx:118` sums `total_acres` for display. The four `total_acres` uses in `_save_field_app_split_invoice_impl` are display and snapshot only (billing uses applied acres at :4519 and :4549; :4871 is the `field_app_locations` snapshot), checked by the independent Opus review. DB
20. **Live data:** of 5 fields, 3 have `acres_source = legacy`, and one has no `total_acres` at all. A field with no acres bills 0 acres on any acre-based split. Check before the packages that rely on acres.
21. 💲 **Split acres round to 2 decimals and can miss the field's acres** (KI-16, unverified). Fold into one rounding rule (items 4 and 29).

## E. Field lifecycle and access

22. ❓ **No archive function.** `fields.is_active` exists and Field Setup toggles it through `save_field` (`FieldSetup.tsx:1448`), but there is no `archived_at`, `archived_by` or reason, and pickers have not been checked for hiding inactive fields. DB
23. 🔒 **Deleting a customer cascades to its fields** (`fields.customer_id ... ON DELETE CASCADE`, `20260213000000`), and `field_billing_defaults.customer_id` cascades too, so deleting a landlord customer silently removes it from every split. This belongs to the customer master (roadmap area 3), but the split group must not depend on a cascade. DB
24. 🔒 **Job access ends when the job ends (KI-01 part C, KI-73).** Written on PR #1650 (`20261213100000_job_access_ends_with_the_job.sql`), not applied. It narrows read access only and writes no split table. **A dependency, not redone here.**
25. 🔒 **Applicators can read a field's billing split while assigned** (`fbd_select` allows `is_applicator() AND _can_see_field(field_id)`, live). That follows Mason's 2026-10-25 "they should be able to see the entire job" decision (`docs/manual/DECISION_LOG.md` around line 641). New split tables must copy this rule exactly.

## F. Who a split may bill, and other rules

26. 🧑🔒💲 **KI-76: a split can bill any customer** named in editable order allocations, field owners or billing defaults (`docs/manual/KNOWN_ISSUES.md` KI-76). Taha's PR #1524 lets the chemical-sale card bill any *active* customer (`BILL_SPLIT_CUSTOMER_INACTIVE`). Whether field splits may bill anyone, or only payers set on the field, is Mason's open decision. **Needed first.**
27. 🧑💲 **No way to say "this payer does not pay the application charge"** (item 5). The per-line engine can do it by hand per invoice line, but nothing stores it on the field.
28. 🧑💲 **No rule for which split applies to work done before a split changed.** Once history exists (item 3), each invoice must pick the split in force on the application date.
29. 🧑💲 **Who gets the leftover penny differs by path.** Per-line engine: largest remainder (`docs/plans/per-line-item-split-billing-spec-2026-07-17.md`). Taha's card: other payers round down and the main customer takes the rest. Location engine: ❓.
30. **Per-payer price override on the field** (`field_billing_defaults.price_override_cents`, `20260221200000:11`) is unused live (0 rows set). Keep it with the split group or drop it; decide in package FP-1.

## G. Tests and docs

31. **KI-84:** the split-billing backfill smoke chain fails on `main` (test gap). Fix it before relying on it as proof.
32. **No end-to-end proof that one field's split produces the same payers and cents through every path** (job, field app, blend ticket, order). A shared fixture set (100%, 50/50, thirds, 50/25/25, landlord-pays-no-application) run through every path is the acceptance test for this foundation.
33. **Docs out of date:** the DECISION_LOG 2026-06-17 and 2026-07-17 entries describe split surfaces that were later superseded; the roadmap's "8 places" list needs item 1's correction.
34. **Other screens read who-pays on their own** (found 2026-11-08, second pass): the applicator job sheet print reads `job_field_shares` and `field_billing_defaults` directly (`src/lib/applicatorSheetPrintData.ts:147,169`); the Jobs list (a direct `job_field_shares` read for its customer filter at `src/pages/Jobs.tsx:535`, and the billed-customer call at :664), loader worksheet (`src/lib/loaderWorksheetFetch.ts:99`) and chemical application report (`src/lib/chemicalApplicationReportFetch.ts:144`) go through `get_jobs_billed_customers`. They must move with the job split (build sheet FP-4).
35. 💲 **Nothing proves a split invoice works after posting** (Sol round 2): payer PDFs, balances, aging, payments, statements, return credits and commission records have no split-invoice test. Readers include `src/pages/InvoiceDetail.tsx`, `src/lib/invoiceBatchPosting.ts`, `src/lib/splitGroupPostChecks.ts` and `supabase/functions/_shared/pdf/invoicePdf.ts` (build sheet FP-5c).
36. 💲 **The per-line engine's money math is already sound and should be the base** (`20260720214000`): signed largest-remainder that mirrors credits, 4-decimal quantities and acres, per-payer override prices. Only its leftover-cent step changes, to Mason's "primary payer" rule.
37. 💲 **CONFIRMED in code: a job whose fields have different payers is over-billed** (Astra review, 2026-11-08). On the shared-invoice path the job transfer works out each payer's percentage only over the fields that payer is on (`20261120100000:839-862`, grouped by customer), so field A billed 100% to the grower and field B billed 100% to a landlord gives each 100%, and the header becomes the sum (:878). Live check 2026-11-08: no job has fields with different payers and no field invoice has shares above 100%, so nobody has been over-billed. `derive_customer_shares_from_fields` (location and blend-ticket invoices) uses one denominator over all fields and is not affected. Fixed in build sheet FP-4 (the old transfer refuses such a job).

## H. From the industry comparison (2026-11-08, evening)

38. 🧑💲 **One percentage split per field cannot give application and product different shares** (Agvance and co-ops split by product group). Decided: an application share and a product share per payer (build sheet §0, Q8).
39. 🧑 **A payer's invoice does not say who else shares it.** Decided: print "Shared with" (build sheet §0, Q9).
40. 🧑💲 **No stated rule for editing a posted field-application invoice.** Decided: allowed until money is applied or the month is closed (build sheet §0, Q10).
41. 💲 **No proven credit-and-rebill path for a paid invoice with the wrong split**, and the job's "already invoiced" check may block the rebill (build sheet §0).
42. 💲 **Prepay applied to one payer's split invoice is untested** (build sheet §0).
