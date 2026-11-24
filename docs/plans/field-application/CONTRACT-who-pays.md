# Behavior contract: who pays for a field (packages FP-1 to FP-4)

**Master copy (2026-11-24).** Replaces the 2026-11-08 build sheet and backlog (git history keeps them; they were reviewed by Sol four times, Opus and Astra). Only rules still true after Mason's newest answers are kept. Business rules: `SPEC.md`. Build order and gates: `BUILD-PLAN.md`. Billing: `CONTRACT-field-billing.md`.

**Words.** *Split*: who pays for a field and what share, as two share sets, **product shares** and **application shares**, each exactly 100%. *Version*: one saved split with the date it starts. *Resolver*: one function answering "who pays for this field on this date". *Micro-percent*: 100,000,000 = 100%, so thirds are 33,333,334 / 33,333,333 / 33,333,333.

## Rules for every package

1. One package is one database PR through `ship.md`: Sol once before the PR, the 4-hour Taha hold, the live apply only with Mason's yes.
2. Rules live in the database; screens only explain them. Every new write RPC, and every existing one a package changes (`save_field`, `save_job`, `transfer_job_to_invoice`, the quote-to-job writer), takes `p_idempotency_key` bound to a hash of the request (same key, different payload: refused); the stored result is checked before any state check, so a retry always returns the first result. SECURITY DEFINER functions set `search_path = public, pg_temp`, check the caller's role inside, revoke `PUBLIC` execute, and never grant helpers to `authenticated`. Adding a parameter makes a new signature: drop the old one in the same migration. Every RPC that takes ids checks they belong to the named record.
3. Close each direct table write in the package that replaces its last screen writer. Any grant or policy change on an existing table needs Mason's `I approve` before apply.
4. Proof in the schema-matched Docker harness with the **fixture set**, built in FP-1 and extended by each package: fields at 100% one payer; 50/50; thirds; 50/25/25; 2/3–1/3; 60/40 where the landlord pays 0% application; a single payer who is not the owner; a field with no stored acres but a job acreage. Every path also gets a 1-cent line split three ways and its −1-cent credit, and a line where the main customer is at 0%.
5. **Cutover inventory:** right before each live apply, count the live unposted invoices, jobs and field-linked records it affects; any real (not test) record stops the apply until reviewed with Mason.
6. **Old screens are for testing only** (Mason, 2026-11-08): until a path moves to the new engine, the old field-invoice, job-transfer and blend-ticket screens stay on, but no real field billing is entered through them; each cutover inventory lists anything made there.
7. Stay out of Taha's areas until 2026-12-15 (the list is in `BUILD-PLAN.md` › How the work stays safe, item 6). Comment on his PRs only.

## FP-1 · One split per field, with history (DB + Field Setup)

- **Tables** (RLS, policies and grants in the same migration):
  - `field_billing_split_versions`: field (`ON DELETE RESTRICT`), version number (unique per field), `effective_from` date, `history_known`, reason, who, when.
  - `field_billing_split_payers`: version, customer (`ON DELETE RESTRICT`), `product_share_micro_pct` and `application_share_micro_pct` (integers 0–100,000,000, `NOT NULL`), `pricing_note`, `notes`. Unique (version, customer).
  - Append-only: a trigger refuses UPDATE and DELETE, and refuses a payer added to a version not created in the same transaction. A deferred check refuses a version with no payers, or whose product or application shares do not each total exactly 100,000,000. A payer may be 0% on one side (a landlord who pays no application) or both (a named party who normally pays nothing).
  - No primary flag: who takes the leftover cent is decided at billing (the job's customer, `CONTRACT-field-billing.md` B3).
- **Read access:** admins and sales reps read all versions. Applicators keep reading the current split through `field_billing_defaults` and its `_can_see_field` policy, never the version tables.
- **`fields.customer_id`** changes from `ON DELETE CASCADE` to `ON DELETE RESTRICT` (check no customer-delete flow relies on the cascade). `I approve`.
- **Writer:** `set_field_billing_split(p_field_id, p_effective_from, p_payers, p_reason, p_idempotency_key)`; `save_field` and the Chem Man field import call the same internal function. It locks the field row `FOR UPDATE`. **The office picks any start date, past or future** (Mason Q3). A save whose payers and shares match the version in force on the chosen date writes nothing (renaming a field never looks like a split change). Payers can be any active customer added to the field (Q1).
- **Resolver:** `field_split_as_of(p_field_ids, p_on_date)`, SECURITY DEFINER, office only, refuses unknown or duplicate ids and a null date; latest `effective_from` on or before the date, then highest version number; returns both share sets, version id and `history_known`. No version: returns "no split"; the job then bills 100% to the grower the field was added under (FP-4, GR5).
- **Lock order:** the split writer takes the field row `FOR UPDATE`; every invoice writer takes `FOR SHARE` on each field it bills before reading the split.
- **Transition copy:** the same transaction rewrites `field_billing_defaults` to the version in force today (product shares, 0% payers left out because that table refuses 0%), recording which version it came from; a `pg_cron` job rewrites it just after midnight Central when a dated version starts. Direct writes to `field_billing_defaults` are revoked from `authenticated`. `I approve`. Field Setup reads and saves through the version tables in this same package, so a 0% payer is never lost.
- **Unused field price:** the migration stops if any `field_billing_defaults.price_override_cents` is set; `save_field` stops accepting it.
- **Backfill:** each field's current split becomes version 1, both share sets equal to today's percent, `history_known = false`, effective from the earliest possible date. Percent × 1,000,000; any difference to exactly 100,000,000 goes to the owner's row; a difference over 10,000 micro-percent stops the migration and lists the field. Fields with no split get no version, so GR5 applies to them.
- Field Setup shows split history (date, who, payers, "imported" for version 1), with two share columns.
- **Test harness first:** the KI-84 smoke chain is fixed and the fixtures run in CI in this package.

**Done when:** thirds save as 33,333,334 / 33,333,333 / 33,333,333 and show 33.33% each; the database refuses (also called directly) a set totalling 90%, the same customer twice, a negative or blank share, a version with no payers, a payer added to yesterday's version; a 0% application payer saves; a split save and a new invoice draft on the same field at the same moment run one after the other; a name-only save writes no version; a named 0% payer survives two Field Setup saves; same key resent writes nothing, same key with different payers is refused; a direct write to `field_billing_defaults` is refused; an applicator on a job still sees that field's current split and cannot read the version tables; deleting a customer who owns or pays on a field is refused; after the live apply (read-only check) every field has version 1 and `field_billing_defaults` matches it. **Size:** L.

## FP-2 · Billable acres (DB)

- Generated column `fields.billable_acres = COALESCE(override_acres, measured_acres, total_acres)`, matching `src/lib/fieldGeometry.ts` `billableAcres`; database fallbacks to `total_acres` use it instead.
- **Blank is not zero.** `CHECK` that stored acres are positive when present (`total_acres`, `measured_acres`, `override_acres`, `job_fields.acres_to_treat`). The migration first sets existing zeros to blank and lists them, then adds the checks validated. The quote-to-job writer writes blank instead of 0; Job Detail sends blank as `null` and `save_job` refuses a typed 0 with a plain message.
- Acres keep 4 decimals for billing; screens show 2. `SelectLocationsModal` shows `billable_acres`.

**Done when:** a field with no stored acres but a job acreage bills the job acreage; a zero-acre write is refused; an old job with unknown acreage saves a notes edit without anyone typing acres. **Size:** S–M. After FP-1. Lands after 2026-12-15, because it changes the quote-to-job writer (Taha's quotes area), with Taha's review of that change.

## FP-3 · Fields are archived, never deleted (DB + Fields list)

- `fields` gains `archived_at`, `archived_by`, `archive_reason`; archive state changes only through `archive_field(p_field_ids, p_reason, p_idempotency_key)` and `restore_field(...)`, enforced by a trigger. `is_active` follows `archived_at`; existing inactive fields are archived with reason "inactive before archiving existed".
- **Who** (Q5): admins and sales reps archive; only admins restore. Bulk calls are all-or-nothing.
- **Blocked while work is owed:** a scheduled or in-progress job; a closed job not yet invoiced and not marked billed in Chem Man; an unposted invoice; an undelivered or uninvoiced order line on the field; an uninvoiced blend ticket. The RPC names each blocking record.
- **No new work on an archived field**, enforced in the database under the same field-row lock (job, quote, blend-ticket, field-app and order-allocation writers; a trigger on `order_item_field_allocations`). Re-opening counts as new work ("restore the field first"). Old records still open and save.
- Fields-list bulk delete becomes bulk archive; pickers hide archived fields. DELETE on `fields` revoked and the `fields_delete` policy dropped. `I approve`.

**Done when:** a rep archives a field and it leaves every new-work picker while old records still open; a rep's restore is refused, an admin's works with history intact; archiving a field with an open job is refused and names the job; an archive and a new job at the same moment cannot both succeed; a direct `DELETE` is refused. **Size:** M. Due before billing switches on.

## FP-4 · Jobs carry the field's split (DB + Job Detail)

- `job_field_shares` gains `product_share_micro_pct`, `application_share_micro_pct`, `source` (`field_version` with version id, `office_override` with reason, or `legacy`) and an exact-100% check per side per job field; its `> 0` check becomes `>= 0`. `split_pct` stays, filled from the product share, until every reader moves in this PR.
- **Planned split:** `save_job` and the quote-to-job writer copy each field's split from the resolver **when the field is first added** to the job. A field with no split gets **100% to the grower it was added under** (stored on the job-field link at add time; GR5), never a guess from the owner. Nothing else re-reads it; the office re-plans with `refresh_split` or sets an office split.
- **Office split on one job** (Q1): changes the shares only among payers on the field's split in force the day it is saved; saved with a reason; wins over the field split at billing.
- **Readers moved in this PR:** `get_job_billed_customers` / `get_jobs_billed_customers`, `resolve_line_split_vector`, Job Detail (including its browser-built shares), the Jobs list customer filter, the applicator sheet, the loader worksheet and the chemical application report.
- **Existing rows** stay, marked `legacy`; a row that does not convert cleanly is listed and its job refused by the transfer until the office re-saves its split. Job fields with no share rows get the resolver's split, marked `legacy`.
- **Old transfer until the new engine lands:** `transfer_job_to_invoice` refuses (a) a job with an office split, (b) a job whose fields have different payers, and (c) a job billed wholly to someone other than its customer, each with "use the new invoice screen". These are the two live bugs found on 2026-11-08 (wrong invoice customer for a landlord-billed field; percentages over 100% when payers differ by field); nothing has been mis-billed live.
- **Billed in Chem Man** (`job_external_billings`, copied from `delivery_external_billings`, `20261007150000`): admin only, reason required, retry key, RLS; un-marking needs a reason. Marking and invoicing take the same job-row lock; marking is refused while the job has an unposted or posted invoice; every invoice writer and post entry point refuses a marked job. Used for work sprayed before the billing switch-on date (`CONTRACT-field-billing.md` B14).
- **`refresh_split`** is built here with its `job` mode: `refresh_split(p_source_type, p_source_id, p_line_ids, p_field_ids, p_reset_hand_edits, p_reset_overrides, p_reason, p_idempotency_key)`; it re-reads the version in force, logs who, when, why, old and new versions, and returns a before-and-after per line. The billing contract adds the `invoice_draft` mode.
- Direct writes on `job_field_shares` revoked once `save_job` is its only writer. `I approve`.

**Done when:** Job Detail, the Jobs list, the applicator sheet and the billed-customer lookups show the same payers for each fixture job; an office split survives a notes edit, a date change and a retried save; a field split change after the field was added leaves the job's planned split unchanged; `refresh_split` is logged with old and new versions; the old transfer refuses the three cases above; a job marked billed in Chem Man cannot be transferred, and one with an invoice cannot be marked; a direct write to `job_field_shares` is refused. **Size:** M–L.

## Later (spring and after)

Orders and deliveries reading field shares (old FP-6: per-line reconciliation with Taha's live Bill Split code after 2026-12-15, allocation stored at save, partial deliveries billed per delivery); blend-ticket invoices on the field engine (old FP-5b); a final boundary check (old FP-7: no direct writes left on any payer table, `field_billing_defaults` replaced by a narrow applicator read function, no billing path reads it). Each gets its own contract when scheduled.
