# Field Application Workflow: From Job to Sprayed to Billed (2026-11-22)

Read-only review of the custom-application (spraying) side of CRX Manager. It follows one job from the start to payment and says at each step **what happens to stock** and **what happens to money**.

- **Code read:** `origin/staging` at `3f1ca8933` (2026-11-22). The newest database code is in `supabase/migrations/`. Several of the newest migrations are still "local candidates" that are not applied live yet. Where that matters, it is noted.
- **Nothing was changed:** no app code, no data, no live database.
- **Lanes:** field application billing is Mason's work. Quotes, bookings, holds and chemical billing are Taha's until 12-15, so this document only describes those parts.
- **Diagram:** [field-application-workflow-2026-11-22.html](field-application-workflow-2026-11-22.html)

## Words used here

| Word | Meaning |
|---|---|
| **Job** | One spraying assignment: a customer, one or more fields, the chemicals and rates, a date, and an applicator. Table `jobs`. |
| **Applicator** | The person who sprays. In the app, "applicator" is also a user role with its own phone screen (Field View). |
| **On hand** | Product physically in the Main Warehouse (`inventory.quantity_available`). |
| **Hold / reservation** | A note saying "this stock is spoken for". It lowers "Today's Free" but does not lower on-hand (`inventory_holds`). |
| **Stock ledger** | The history of every stock movement (`inventory_transactions`). Spraying writes rows of type `job_applied`. |
| **Application record** | The legal spray log: who sprayed what, where, when, the EPA numbers and the weather (`application_records`). |
| **RPC** | A database function the screen calls to do a job safely in one step (for example `complete_job`). |
| **Trigger** | Database code that runs by itself when a row changes. |
| **Draft / unposted / posted** | An invoice's stages. Draft and unposted can still be edited. **Posted** means it is a real bill the customer owes (accounts receivable). |
| **Split billing** | One field owned by more than one grower, with each grower billed their share. Set per field in `field_billing_defaults`. |

## The flow at a glance

| # | Stage | Job status after | Stock effect | Money effect |
|---|---|---|---|---|
| 0 | One-time setup: fields, owners/splits, application service rates | — | none | Sets the per-acre fee that billing will use |
| 1 | Create the job (from a booking, or standalone) | `scheduled` | **Reserves** planned product (a hold). On hand unchanged | Job's chemical total is calculated and stored. Nothing billed |
| 2 | Assign applicator / dispatch fields | `scheduled` | none (screen shows shortages) | none |
| 3 | Start | `in_progress` | none | none |
| 4 | Log spray passes (optional) | `in_progress` | none | none |
| 5 | **Complete** | `completed` | **On hand goes DOWN** by the planned quantity. Hold released | none (unless the auto-draft setting is on; it is off by default) |
| 6 | **Bill** (Transfer, Split Billing, or auto-draft) | `invoiced` | none | **Unposted invoice created.** Commissions recorded as pending |
| 7 | Review / edit invoice | `invoiced` | none | Totals can change while unposted |
| 8 | **Post** | `invoiced` | none | **Customer now owes it** (accounts receivable) |
| 9 | Payment | `invoiced` | none | Balance goes down, then the invoice is `paid` |
| — | Direct "Field App Invoice" (no job) | no job | **none** (see GAP N1) | Unposted invoice → post → paid |

Job statuses come from `.claude/schema-registry.json`: `scheduled`, `in_progress`, `completed`, `invoiced`, `cancelled`. The database allows only these moves: scheduled → in_progress → completed → invoiced, and scheduled or in_progress → cancelled. An admin override can do anything (`supabase/migrations/20260620150000_job_cancel_gate.sql:21-45`).

Invoice statuses: `draft`, `unposted`, `posted`, `paid`, `overdue`, `voided`, `cancelled`.

---

## Stage by stage

### 0. One-time setup

- **Fields** (Fields and Field Setup pages): each field has acres, an owner, and optionally billing splits that say which growers pay what percent (`field_billing_defaults`; the percents must total 100).
- **Application services** (Application Services page, admin only): each service, such as "Aerial" or "Ground", has a default price per acre and a cost per acre (`application_services`). A customer can have a special rate (`customer_application_rates`).
- **Per-acre "grower share" pricing is being retired.** Mason's rule from 2026-11-22: "we always bill line by line". The constraint migration `20270224110000_retire_per_acre_field_pricing.sql` is written but **not applied yet**. Live had no rows using that pricing.

**Stock:** none. **Money:** none yet. These settings decide what billing will charge later.

### 1. Create the job

There are two ways in:

**a) From a booking** (Taha's lane, described only). In Quote Builder, "Schedule Job" calls `create_job_from_quote_section` (`src/pages/QuoteBuilder.tsx:3717`). The database first checks that the prices are the ones the customer was sent (`_assert_quote_prices_as_sent`, `supabase/migrations/20261204100000_ki18_batch1_chicago_today.sql:3403`). It then creates the job with its field and chemical lines at those prices (`:3445`).

**b) Standalone.** Jobs → New Job (Job Detail screen) → Save calls `save_job` (`src/pages/JobDetail.tsx:2887`). The office (admin or sales rep) enters fields, acres to treat, chemicals, rate per acre, quantity and price.

**What the database does:**
- `save_job` throws away any total the screen sends and recalculates the job's cost and price itself as price × quantity per chemical line. Lines the customer supplied count as $0 (`_save_job_cost_step2_impl`, last full version in `supabase/migrations/20260904185900_refuse_null_job_field_acres.sql`, "DERIVED MONEY TOTALS" block). Unit checks refuse a line whose units don't match the product's stock unit.
- **Stock: reserved, not removed.** A trigger on the job's chemical lines (`trg_sync_job_holds_*`) runs `_sync_job_holds`. While the job is scheduled or in progress, it puts one hold of type `job` on each product, sized to the planned quantity converted to the stock unit. Customer-supplied product gets no hold (`supabase/migrations/20261206110000_ki18_leftovers_hold_expiry_reversal_month_stale_quotes.sql:88-130`). Holds lower "Today's Free" but **not** on-hand. If the job came from a booking, `_sync_quote_job_reservations` draws the job's product against the booking's balance instead, so the booking hold shrinks by the same amount (`20261107070000_job_reservation_whole_hundredths.sql:140+`).
- **Money:** none is billed. The job only stores its chemical total (`jobs.total_price_cents`).

### 2. Assign the applicator and dispatch

- Job Detail → assign applicator calls `assign_job_applicator` (`src/pages/JobDetail.tsx:2663`).
- Dispatch Board sends fields to an applicator or ground crew with `dispatch_job_locations` (`src/pages/DispatchBoard.tsx:1283`). It shows stock shortages from `get_dispatch_stock_status` (`:408`), but only as a warning.
- An applicator sees only jobs dispatched to them. Their access ends 7 days after the job is finished (`20261217100000_job_access_ends_with_the_job.sql`).

**Stock:** none. **Money:** none.

### 3. Start the job

Field View (applicator phone screen, `src/pages/FieldView.tsx:471`) or Job Detail (`src/pages/JobDetail.tsx:3185`) calls `start_job`. The status goes from scheduled to in progress, and the start time is recorded (`20261217100000_job_access_ends_with_the_job.sql:448`).

**Stock:** none (the hold stays). **Money:** none.

### 4. Log spray passes (optional)

The Applied Records panel on Job Detail saves each pass with `save_job_applied_record`: the fields, the crew and the details (`src/components/jobs/AppliedRecordsManager.tsx`). This is compliance information only.

**Stock:** none. **Money:** none. Billing does not read these records.

### 5. Complete the job: this is when stock leaves

Field View (`src/pages/FieldView.tsx:592`) or Job Detail → Complete (`src/pages/JobDetail.tsx:3238`) calls `complete_job`. The applicator, or the office, enters the end time, wind, temperature, humidity, gallons, and the acres actually sprayed per field. The work happens in `_complete_job_replay_impl_20261015`, newest version in `supabase/migrations/20261217100000_job_access_ends_with_the_job.sql`:

1. Status becomes `completed` (`:628`). The job must already be in progress; the Complete button starts it first if needed.
2. The weather and times are saved (`job_applied_info`).
3. **Application record created** (`:745`): products with their EPA numbers and restricted-use flags, the applicator's name and license, the weather, the vehicle, and acres per field. The "acres actually sprayed" that were entered go **only here** (`:782-806`).
4. **Stock deducted** (`:818-886`). For every chemical line with a quantity that the customer did not supply, the **planned quantity** (`job_chemicals.quantity`) is converted to the stock unit and subtracted from Main Warehouse on-hand. A `job_applied` row is written to the stock ledger.
   - If that takes on-hand below zero, it still happens. The row is marked "SHORT STOCK, review required" (`:854`). If the product has no inventory row at all, one is created with a negative quantity (`:866`).
   - If the units cannot be converted, the raw number is deducted and flagged for review.
5. **Hold released.** The status change fires `trg_release_job_holds_on_lifecycle`, which rebuilds the holds; a completed job holds nothing. For a booking job, the draw stays as a permanent use of the booking (`20261107070000_job_reservation_whole_hundredths.sql:200`).
6. **Auto-draft invoice (off by default).** If the setting `auto_draft_invoice_on_job_completion` is `true`, it is `false` unless changed (`20260630073344_auto_draft_invoice_on_job_completion.sql:34-37`), **and** an office user completed the job, it calls Transfer to Invoice (`:930-949`). An applicator's completion never auto-drafts; it only writes "bill this job manually" to the activity feed (`:967`). If the auto-draft fails, the job still completes and the failure goes only to the activity feed.

**Stock:** on hand goes **down** by the planned quantity; the hold goes away. **Money:** none, unless auto-draft is on.

### 6. Bill the job: the invoice is created

There are three ways to bill a completed job:

**a) Transfer to Invoice.** Field Invoices → Unbilled Applications panel (`src/components/field-invoices/UnbilledApplicationsPanel.tsx:246`) or Job Detail → Transfer (`src/pages/JobDetail.tsx:3323`) calls `transfer_job_to_invoice`. The work is in `_transfer_job_to_invoice_intent_impl_20260908`, newest version in `supabase/migrations/20261120100000_field_invoice_due_date_follows_owner_terms.sql`:
- It refuses a job that is already invoiced or not completed (`:383-384`). It also refuses if a blend ticket for this job was already billed (`:403`).
- **Acres billed = planned acres** (`job_fields.acres_to_treat`, `:412`), not the acres the applicator recorded.
- **One line per chemical** = the job's saved price × the planned quantity (`:553`, `:788`). The line shows quantity 1 with the whole amount; the rate and the total applied are informational. Customer-supplied lines are billed at $0.
- **Application fee line** = the service's per-acre rate for that customer × planned acres, from `compute_application_service_fee` (`:613`, `:896`).
- **Shared fields:** when more than one grower owns the fields, it makes one invoice per grower in an invoice group. Each chemical's dollars are split by acre percentage, and each grower gets their own fee line (`:470-700`).
- The invoice is created as `unposted` (`:644`, `:957`) and is type `field_application`, with no order behind it. The job becomes `invoiced` (`:669`, `:948`). The application record is linked to the invoice.
- **Commissions** are recorded as pending at this moment, from chemical profit only, not from the fee (`_insert_commissions_for_job`, `:685`, `:976`).

**b) Per-line Split Billing editor** (`src/pages/FieldAppSplitInvoiceEditor.tsx:715`) calls `save_field_app_split_invoice`. This is the newer billing path for shared fields. Each grower is priced from their own sent quote or tier price, or by hand. It must include every field on the job, refuses a job that is not completed or is already invoiced, and sets the job to `invoiced` (`_save_field_app_split_invoice_impl`, `20270129171000_field_app_refuses_product_without_sold_unit.sql:1457-1462`, `:2242`).

**c) Auto-draft:** the same as (a), run automatically at completion (Stage 5).

**Stock:** none; it already left at completion. **Money:** an unposted invoice now exists. It is not owed yet.

### 7. Review and edit the invoice

The Field Application Invoice editor (`src/pages/FieldApplicationInvoice.tsx`) re-saves with `save_field_app_invoice` (`:1961`). Each save rebuilds the invoice from scratch, and only while every invoice in its group is draft or unposted. The editor also saves the applied info with `update_field_app_applied_info` (`:2057`). For a booking customer, chemical prices come from: a manual override, then the field's quote, then the tier price. The fee comes from the customer's rate override, else the service default (`docs/workflows/QUOTE_TO_DELIVERY.md`, "Pricing modes").

**Stock:** none. **Money:** totals may change; nothing is owed yet.

### 8. Post

The editor's Post button calls `post_invoice` (`src/pages/FieldApplicationInvoice.tsx:2298`). For a grouped invoice it calls `post_invoice_group` (`:2288`), which posts every grower's invoice together or none of them. Posting checks that the accounting month is open. After posting, the invoice is **owed**: it counts toward the customer's balance and statements, and its due date comes from the customer's terms.

**Stock:** none. **Money:** it becomes a receivable, money the customer owes.

### 9. Payment

Payment works the same as for any invoice: payments and prepay credit are applied through Accounts Receivable. This review did not trace payments separately, because they are shared with the chemical-sales side.

### Undo paths

| Action | Screen / RPC | Stock | Money / job |
|---|---|---|---|
| Cancel a scheduled or in-progress job | Job Detail / `edit_jobs` | Hold released | none |
| Delete an unposted job invoice | `delete_invoices` (admin) | none | Invoice gone, pending commissions removed, job **back to `completed`**, so it shows in Unbilled again (`20260711050000_credit_apply_reversal_and_lifecycle.sql:873`) |
| Unpost | `unpost_invoice` (`FieldApplicationInvoice.tsx:2366`) | none | Back to unposted while unpaid in an open month |
| Void a posted job invoice | `void_invoice` (`FieldApplicationInvoice.tsx:2431`) | **none**: the product was really sprayed | Invoice voided, job **back to `completed`** and can be billed again (`20270116100000_ki99_void_reverses_write_offs.sql:108`, `:315`) |
| Send invoice back to job | `transfer_invoice_to_job` (`FieldApplicationInvoice.tsx:2911`) | none | Job back to `completed` |
| Undo a blend-ticket spray record | `reverse_application_record` (admin) | Stock put back | — |
| Admin deletes a completed job | `edit_jobs` delete (`20270203110000_job_writes_through_rpcs.sql:197`) | **Not put back** | Job leaves Unbilled Jobs. See GAP 7 |

There is **no** undo for a job's completion. Once completed, stock stays deducted. That is correct if it was sprayed, but if a job was completed by mistake, only an admin stock adjustment fixes on-hand.

### Other routes that also deduct stock

- **Blend tickets** (Blend Tickets → approve → Create App Record): `create_application_record_from_blend_ticket` deducts each product as `job_applied` and writes an application record (`20260713060200_harden_blend_unit_indeterminate_guard.sql:194-198`). It can be billed with "Create Invoice" (`create_invoice_from_blend_ticket`). A ticket can be linked to a job (`src/pages/BlendTicketDetail.tsx:556`). See GAP 3.

---

## Gaps, risks and recommendations

Severity: HIGH = could bill wrong or lose money or stock accuracy in normal use. MED = a real but narrower risk. LOW = cleanup or a rare case. "Known" means it is already in `docs/manual/KNOWN_ISSUES.md`. "NEW" means this review found it.

| # | Severity | Status | Gap | Evidence |
|---|---|---|---|---|
| **N1** | **HIGH (needs Mason's rule)** | **NEW** | **A direct "Field App Invoice" bills chemicals but never takes them out of stock and writes no spray record.** The New menu → Field App Invoice (`src/components/layout/TopBar.tsx:20`, route `src/App.tsx:127`) calls `save_field_app_invoice`. That function, and posting, never touch `inventory` or `inventory_transactions`. Spray records can only come from a job or a blend ticket (`application_records.source_type` ∈ {job, blend_ticket}, schema registry). If it is used to bill a spray of our own product, on-hand stays too high and there is no EPA spray log. | `_save_field_app_invoice_impl_20260714` (`20270205100000_field_app_refuses_payer_change.sql:39+`): its only inserts are invoices, invoice_items, invoice_shares, field_app_locations/_shares, the audit log and the activity feed |
| 1 | HIGH | Known KI-185 | **Planned acres, not sprayed acres, drive both stock and billing.** Sprayed acres entered at completion go only to the spray record. Stock deducts the planned quantity and the invoice bills planned acres and planned quantity. A job planned at 100 acres and sprayed at 80 bills and deducts for 100. | `20261217100000…:782-806` vs `:818-886`; `20261120100000…:412`, `:553` |
| 2 | HIGH | Known KI-198 | **The same shared-field job can bill different totals** depending on the billing route. Transfer and auto-draft use the job's price split by acres; Split Billing uses each grower's own quote or tier. Decision 31 is made; the build is still needed. | `20261120100000…:547-566`; `20270129171000…:1686-1755` |
| 3 | HIGH (latent) | Known KI-187 (#2178) | **A blend ticket and its linked job can both deduct stock** for one spray. Live has no blend tickets yet. | `20260713060200…:194-198`; `20261217100000…:818-886`, with no blend-ticket check |
| 4 | HIGH | Known #2063, **source supports it** | **Double billing: blend-ticket invoice, then Split Billing.** Transfer refuses if a blend ticket on the job is billed (`20261120100000…:403`), and the blend invoice refuses if the job is billed. The per-line Split Billing save has **no** blend-ticket check at all (0 mentions in `_save_field_app_split_invoice_impl`). | `20270129171000…:1054+` |
| 5 | HIGH (unsure) | Known #2061 | A job could be billed a second time. Not traced further here. | KNOWN_ISSUES W1-05 |
| 6 | MED | Known (LOW in KI list) | **A completed job is still editable in the database.** `save_job` does not refuse a completed job; only the screen hides the editing (`src/pages/JobDetail.tsx:3870`). The billed-job lock covers only invoiced or cancelled jobs (`20270210110000_completed_job_delete_admin_only.sql:52`). An edit after completion changes what Transfer bills, but the stock deducted at completion stays at the old quantity, so the two disagree. | `KNOWN_ISSUES.md:390-393` |
| 7 | MED | Known #2196 (rep side) + NEW note | **Deleting a completed job removes it from Unbilled Jobs, so it is never billed.** For reps, #2196 says a direct table path may allow it. For admins it is allowed on purpose (`20270203110000…:197`). In both cases the stock stays deducted and the spray record stays, with no warning that billable work is disappearing. | as cited |
| 8 | MED | NEW | **An applicator's completion never auto-drafts the invoice, and an auto-draft failure only writes to the activity feed.** Billing then depends on someone checking the Unbilled Applications panel. It is low-risk while the panel is used, but nothing alerts the office. | `20261217100000…:930-985` |
| 9 | MED | NEW (design note) | **Spraying can push on-hand below zero.** It is flagged "review required" in the stock ledger but never refused. A product with no inventory row gets a negative row. Dispatch shows shortages only as a warning. | `20261217100000…:854`, `:866` |
| 10 | MED | NEW | **Commissions are recorded when the unposted invoice is created, and they can be paid out before the bill is sent or collected.** The Commission Payments screen lists every pending commission, job ones included, with no invoice check (`src/pages/CommissionPayments.tsx` `fetchUnpaid`), and the payout functions do not require a posted or paid invoice (`create_commission_payment`, `20260811130000…`). Delete and void reverse unpaid rows only. This is the same payout gap as chemical sales; decisions 1 and 13 (pay only on cash or prepay received) cover field invoices too. | `20261120100000…:685`, `:976`; `20260711050000…` delete path |
| 11 | LOW | Known #2141 | A job-made group draft could be cancelled, leaving the job pointing at a cancelled invoice. | KNOWN_ISSUES W3-33 |
| 12 | LOW–MED | Known #1933, #1926, #2105 | Unit conversion edge cases: a line can refuse or misprice, a tiny application can bill $0, and posting does not re-check the sold unit. Completion falls back to deducting the raw quantity and flags it. | `20261217100000…:826-831` |
| 13 | INFO | Known KI-81 | The field-application and blend invoice editors read the current quote price, not the sent version (Taha's pricing lane). | `docs/workflows/QUOTE_TO_DELIVERY.md:77` |
| 14 | INFO | NEW (housekeeping) | `docs/workflows/QUOTE_TO_DELIVERY.md` "Field Application Workflow" still describes Mode A per-acre pricing, which is being retired by `20270224110000`. It should be updated when that migration lands. | `QUOTE_TO_DELIVERY.md:321-333` |

### Recommendations (in order)

1. **Decide the rule for the direct Field App Invoice (N1).** Mason's call: what is that screen for? If it bills sprays of our own product, it needs to deduct stock and write a spray record, the same as a job. If it is only for product that already left another way (a delivery or a blend ticket) or customer-supplied product, the screen should say so and refuse our own stock lines.
2. **Bill and deduct from what actually went in the tank (KI-185; Mason decision 4).** The mixer edits the job's product totals to what was actually mixed, and those totals drive both the stock deduction and the chemical charge (planned 160 acres, mixed 162 acres: deduct and bill 162). Sprayed acres entered at completion drive only the per-acre application fee and the spray record. This also keeps stock and the bill in step.
3. **Lock a completed job's chemicals and acres in the database (gap 6).** Then the bill cannot drift away from what was deducted.
4. **Add one shared "already billed?" check (gaps 4, 5)** that every billing route calls: Transfer, Split Billing, blend invoice and the direct editor.
5. **Fix KI-187** before blend tickets are used live, so one spray deducts stock once.
6. **Make unbilled completed jobs visible.** Add an alert or dashboard count for completed jobs older than N days with no invoice, and warn before deleting a completed job (gaps 7, 8).

## What this review did not cover

- **Payments, statements, finance charges and the posting code itself:** these are shared with chemical sales and covered by the main session.
- **The blend ticket billing internals (`create_invoice_from_blend_ticket`, 1,134 lines):** only its double-bill guard was checked.
- **Live data:** nothing was queried. Which of the newest migrations are applied live was not checked one by one. Several 2027-stamped files are local candidates (see `docs/reference/migrations.d/`).
- **Running the app:** this is a code reading. Nothing was clicked through on staging.
