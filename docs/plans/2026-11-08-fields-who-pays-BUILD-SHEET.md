# Fields and who pays: build sheet (foundation 18.1)

**Status: GAME PLAN, reviewed by Sol twice on 2026-11-08. NOT STARTED.** Mason asked for foundation 18.1 to be planned the Product Master way (handoff, 2026-11-08), then asked for a second Sol pass "to look for gaps or improvements" after answering the five business questions. This sheet turns the backlog (`docs/plans/2026-11-08-fields-who-pays-BACKLOG.md`, items numbered the same) into packages, one pull request each, with an approach, "Done when", size, database impact and risk. Both Sol rounds and what was done with each finding are in §6. Nothing here authorizes building. Building starts when Mason says so, one package at a time.

**Why now:** field-application invoicing must be ready before February 2027 (CRX Notes decision 2026-11-04). It stands on this foundation. It is Mason's own work, outside Taha's chemical-sale billing (to 2026-12-15).

**Words used below.**
- *Split group*: the list of who pays for a field and what share each pays, adding to exactly 100%.
- *Version*: one saved state of a field's split group, with the date it starts applying. Old versions are kept (history).
- *Resolver*: one database function that answers "who pays for this field on this date".
- *Per-line engine*: the line-by-line field invoice system built in PR #164 (`field_app_billing_sets`, `field_app_billing_lines`, `invoice_line_shares`, `compute_line_split_allocation`). Live and switched on, never used on a real invoice yet. This plan makes it the one engine for field billing.
- *Draft line split*: the payer list and percentages on one unposted invoice line, filled in from the field and editable before posting (Mason's question-2 answer).
- *Billing date*: the one date each billing path uses to pick the split version (§1a).
- *Micro-percent*: a share stored as a whole number where 100,000,000 means 100%, so thirds add to exactly 100% (33,333,334 + 33,333,333 + 33,333,333).
- *Package (FP-n)*: one pull request.
- 💲 money; 🔒 permissions; DB needs a migration.

---

## 1. Rules for every package

1. One package is one pull request, delivered through `.claude/commands/ship.md`. Every package below touches the database, money or permissions, so each needs a clean Sol review before merge, and every PR stays open 4 hours (Taha's rule, 2026-11-08), including before any live migration apply.
2. Rules live in the database: the RPC refuses a bad split; the screen only explains it. Every new write RPC takes and enforces `p_idempotency_key`, bound to the request (a reused key with a different payload is refused). SECURITY DEFINER functions set `search_path = public, pg_temp`, check the caller's role inside, and get deliberate grants.
3. **Close each direct write in the package that replaces its last screen writer**, not at the end (Sol R2 25). Any grant or policy change on an existing table needs Mason's `I approve` before that migration is applied; each package names its exact grant changes.
4. Proof: database behaviour in the schema-matched Docker harness with the fixture set (rule 5); screens in the local dev app. Live checks are read-only unless Mason approves a specific live test in that conversation.
5. **Fixture set** (backlog 32), built in FP-1 and extended by each package. Fields at: 100% one payer; 50/50; thirds; 50/25/25; 2/3–1/3; 60/40 with a landlord who does not pay the application charge; a single payer who is not the field's owner; a field with no stored acres but a valid job acreage. Expected results are written per line kind (chemical, service/application, fuel surcharge, flat fee, discount), price, acres and billing date; paths are compared on equal inputs, and intended differences are asserted explicitly. Every path also gets: a 1-cent line split three ways and its −1-cent credit; a line whose primary payer is changed to 0%; a line covering two fields with different primaries; a mixed order (one field line, one non-field line).
6. **Cutover inventory** (Sol R2 14, improvement 9): immediately before each migration is applied, count the live unposted drafts, jobs, orders and blend tickets it affects, and pin or review each one as that package says. November's counts are not proof for January.
7. Stay out of Taha's billing files until 2026-12-15: `order_shares`, `order_item_shares`, the Bill Split card, and his re-emitted functions. Comment on his PRs only; never push to them.
8. Re-check each backlog item, and the live body of every function a package changes, before building.

## 1a. Shared money and date contracts (settled before FP-1)

These rules come first because every acceptance test depends on them (Sol R1 14, 22, 23, 26, 35; R2 2, 10, 16, 17, 30).

- **Start from the per-line engine's math, which is already sound** (`20260720214000`): signed largest-remainder on the absolute value with the sign restored, so a credit mirrors its charge exactly; quantities and acres at 0.0001 (4 decimals), rounded once; money rounded once per figure; display rounds to 2 decimals only (Sol R2 16).
- **Leftover cents go to the primary payer (Q4).** Change only the leftover step: after each payer gets `floor(|cents| × share / 100,000,000)`, all leftover cents go to the line's primary payer, then the sign is restored. The **line primary** is the field's primary if it has a share above 0% on that line; otherwise the payer with the largest share on that line (ties: lowest customer id) (Sol R2 2). Tests: 1¢ over thirds = 1/0/0; −1¢ = −1/0/0; primary at 0% on a 1¢ 50/50 line gives the cent to a non-zero payer.
- **Acres** use the same rule at 0.0001 acre, leftover to the line primary; never negative.
- **Lines covering more than one field** are split field by field first (each field's acres, payers and primary), then the payer amounts are added up per payer (Sol R2 10). Each contribution is recorded (provenance rule below).
- **Per-payer prices.** Same price for everyone: one line total, split as above. Different prices (the engine's existing per-line `override` price with a reason): each payer's amount is their price × their quantity, and the line total is the sum (the engine's existing rule). The unused field-level `price_override_cents` (0 live rows) is **not** carried into the new split model (Sol R2 17, improvement 8); the existing `pricing_note` text is carried as a note only.
- **Application charge (Q2).** `pays_application = false` sets the *default* only: on service/application lines that payer starts at 0% and the others share their part in proportion. The office may still change a draft line by hand, within the eligible payers (Sol R2 4). A split where nobody pays application is refused when saved (Sol R2 3).
- **Other line kinds** (Sol R2 21): fuel surcharge and flat fees default like application lines; chemical lines and discounts default to the full split; each kind is editable before posting. Sales tax: none on these invoices today; if one is added later it follows its own line.
- **Acres to bill, per path** (first one present wins): field application = applied acres on the invoice location → job's `acres_to_treat` → field billable acres; job = `job_fields.acres_to_treat` → field billable acres; blend ticket = actual acres → planned acres → field billable acres; order line = allocated acres. A path refuses only when it has no positive acres after its own order.
- **Billing date, per path** (Central date): job = completed date, else scheduled date; field application = application date on the invoice; blend ticket = applied date, else ticket date; order line = delivery completion date, or the invoice date for an order invoiced without a delivery. No date → the RPC refuses with a plain message; never "today" by accident (Sol R2 30). Existing season and closed-period guards still apply.
- **Snapshot and provenance** (Sol R2 5, 11). When a job, draft or order line first takes a split, it stores per field: version id, acres, the default payer list with every billing attribute (share, primary, pays-application), and per line the final payer list and billing date. Field split changes never change a snapshot silently.
- **Refresh split** (Q3; Sol R2 6, 7, 8). One RPC, `refresh_split(p_source, p_reason, p_idempotency_key)`, for jobs, drafts and order lines: re-reads the version in force on the billing date, records who, when, why, old and new versions, and leaves hand-edited lines alone unless the office chooses to reset them. Nothing else re-reads the field's split for an existing snapshot: not a date change, not a notes edit, not a retry. **Unpost and repost** start from the last posted line splits, and both post snapshots are kept.
- **Payer eligibility (Q1; Sol R2 9).** A payer may be *added* to a draft line or job only if they are in the field's split version in force on the billing date (or the job's saved split) and the customer is active. A payer already in a saved snapshot stays valid for that record even if later deactivated or dropped from the field's split; posting and reposting honor it. A refresh drops a payer only if the new version drops them, and says so on screen.
- **Returns and credits** (Sol R2 22) reverse the original *posted* line allocations, never the field's current split.

---

## 2. Packages, in build order

### Wave 0: before building (no PR from us)

- **Mason answered Q1–Q5 on 2026-11-08 (§5).** Nothing is waiting on him except the go-ahead to build.
- **PR #1650 lands** (job access ends with the job, KI-01 part C, KI-73; backlog 24). Not redone here. Its policies are the baseline for applicator access.
- **Taha's PRs #1524 and #1534 land** before FP-6 only.

### Wave 1: the foundation

#### FP-1 · 💲🔒 One split group per field, with history (DB + Field Setup)
**Items:** 2, 3, 4, 5, 16 (`field_billing_defaults`), 18, 23, 26, 27, 30; fixtures (32); §1a functions.
**Approach.**
- New tables, RLS and policies in the same migration:
  - `field_billing_split_versions`: field (`ON DELETE RESTRICT`), version number (unique per field), `effective_from` date, `history_known` flag, reason, who, when.
  - `field_billing_split_payers`: version, customer (`ON DELETE RESTRICT`), `share_micro_pct` integer between 0 and 100,000,000, `is_primary`, `pays_application`, `pricing_note`. Unique (version, customer) (Sol R2 29).
  - Both append-only: a trigger refuses UPDATE and DELETE. A deferred check refuses a version that does not total exactly 100,000,000, has not exactly one primary, has a primary at 0%, or has nobody paying application. A 0% payer is allowed only as a non-primary (a named party who normally pays nothing).
  - **Read access:** admins and sales reps read all versions. Applicators get no direct read of these tables; they keep reading the current split through `field_billing_defaults` and its existing `_can_see_field` policy (Sol R1 8).
- **Owner protection moves here** (Sol R2 27): `fields.customer_id` changes from `ON DELETE CASCADE` to `ON DELETE RESTRICT`, so deleting a customer can never erase a field or its split history. Check first that no customer-delete flow relies on the cascade. 🔒 needs `I approve`.
- **Writer:** `set_field_billing_split(p_field_id, p_effective_from, p_payers, p_reason, p_idempotency_key)`; `save_field` and bulk import call the same internal function. It locks the field row (`FOR UPDATE`), so two saves of one field run one after the other. Resolver order: latest `effective_from` on or before the date, then highest version number. **Until the end of Wave 2, `p_effective_from` must be today or earlier** (Sol R1 3).
- **Transition copy:** the same transaction rewrites `field_billing_defaults` to the version **in force today** (resolver order), not simply the newest saved, so a backdated correction cannot change today's copy. Direct INSERT, UPDATE and DELETE on `field_billing_defaults` are revoked from `authenticated` in this package (Sol R1 5). 🔒 needs `I approve`.
- **Resolver:** `field_split_as_of(p_field_ids, p_on_date)`, SECURITY DEFINER, office-only; refuses unknown and duplicate field ids and a null date; returns per field the payers with all attributes, version id and `history_known`. No version → owner at 100% (flagged). Granted to `authenticated`, not `anon`.
- **Backfill** (6 live rows; Sol R2 13): each field's current split becomes version 1, `history_known = false`, effective on the migration date. Conversion: percent × 1,000,000, rounded to whole micro-percent, then the difference to exactly 100,000,000 goes to the primary; if that difference is more than 10,000 micro-percent (0.01%), or a field has no primary or two, the migration stops and lists the field for review instead of guessing. Fields with no split get owner 100%.
- **Pre-migration work** (Sol R1 4; R2 12, 14): dates before version 1 resolve to version 1 flagged `history_known = false`; screens say "split history before <date> not recorded". Existing job shares and invoice shares are left as they are (their own snapshots).
- **Payer rule (Q1)** enforced in the RPC.
- Field Setup shows the split history (date, who, payers, "imported" for version 1).
**Done when:**
- Saving thirds stores 33,333,334 / 33,333,333 / 33,333,333; the screen shows 33.33% each and "100%".
- The database refuses, also when called straight: 50/40; two primaries; a primary at 0%; the same customer twice; a share above 100% offset by a negative one; nobody paying application.
- **Synthetic history test** (harness, not the live backfill; Sol R2 12): with versions dated yesterday (50/50) and today (60/40), the resolver returns each on its date; a future date is refused; saving 60/40 today and then a 70/30 correction for yesterday leaves `field_billing_defaults` at 60/40.
- The same key resent returns the first result and writes nothing; the same key with different payers is refused; two saves of one field at once end as two ordered versions.
- A direct write to `field_billing_defaults` as a signed-in admin is refused. An applicator on a job still sees that field's current split and cannot read the version tables.
- Deleting a customer who owns a field, or who is a payer, is refused.
- The §1a allocator functions pass the 1¢, −1¢, 0%-primary and two-field fixtures.
- **Live backfill check** (read-only, after apply): all 5 fields have version 1 flagged imported, and `field_billing_defaults` matches it.
**Size / risk:** L. 💲🔒 DB. New tables plus two changes on existing tables (one grant, one foreign key).

#### FP-2 · 💲 Field billable acres and acre rules
**Items:** 19, 20, 21.
**Approach.**
- Add a generated column `fields.billable_acres = COALESCE(override_acres, measured_acres, total_acres)`, matching `src/lib/fieldGeometry.ts` `billableAcres`. It is only the last default in each path's acre order (§1a).
- Where database functions fall back to `total_acres` (`derive_customer_shares_from_fields`, the blend-ticket fallback, and the per-line engine if its uses feed billing; confirm first), the fallback becomes `billable_acres`. Applied, job and allocated acres keep priority.
- `CHECK` constraints (`NOT VALID`, validated after a live audit) that stored acres are positive when present: `total_acres`, `measured_acres`, `override_acres`, `job_fields.acres_to_treat`. Blank stays allowed.
- Acres keep 4 decimals for billing and snapshots; screens show 2 (Sol R2 16).
- `SelectLocationsModal.tsx:118` shows `billable_acres`.
**Done when:** a blend ticket with no actual or planned acres bills the field's override acres, while one with actual acres bills those; a field with no stored acres but a job acreage bills the job acreage; acres per payer add up exactly for every fixture; a zero-acre write is refused.
**Size / risk:** S–M. 💲 DB. Can run beside FP-1.

#### FP-3 · 🔒 Fields are archived, never deleted
**Items:** 13, 16 (`fields`), 22.
**Approach.**
- Add `archived_at`, `archived_by`, `archive_reason` to `fields`; `is_active` is no longer writable through `save_field` (Sol R1 16). Archive state changes only through `archive_field(p_field_ids, p_reason, p_idempotency_key)` and `restore_field(...)`.
- **Who (Q5; Sol R2 31):** active admins and sales reps archive; only active admins restore; everyone else is refused. Bulk calls are all-or-nothing and idempotent.
- **What blocks an archive (Q5):** a scheduled or in-progress job; a completed job not yet invoiced; an unposted invoice; an undelivered order line allocated to the field; an open blend ticket. The RPC names each blocking record.
- **No new work on an archived field, enforced in the database** (Sol R2 26): the job, quote, blend-ticket, field-app and order-allocation writers refuse to *add* an archived field, under the same field-row lock the archive takes, so an archive and a new job cannot slip past each other. Existing records keep showing and saving an archived field (Sol R1 34).
- `src/pages/Fields.tsx` bulk delete becomes bulk archive (`ConfirmModal`, toast). Pickers for new work hide archived fields.
- Revoke DELETE on `fields` from `authenticated` and drop the `fields_delete` policy. 🔒 needs `I approve`.
**Done when:** a sales rep archives a field from the Fields list and it disappears from new-job, quote, field-app, blend-ticket and order pickers, while old records still open and save; a rep's restore is refused and an admin's works, with split, boundary and history intact; archiving a field with an open job is refused and names the job; a new job sent straight to the RPC for an archived field is refused; an archive and a new job at the same moment cannot both succeed; a direct `DELETE` on `fields` is refused; saving the field cannot un-archive it.
**Size / risk:** M. 🔒 DB. **Not on the February path** (improvement 3); build when convenient.

### Wave 2: every billing path uses the per-line engine and the split group

#### FP-4 · 💲 Jobs carry the field's split snapshot
**Items:** 6, 7, 18 (job side).
**Approach.**
- `job_field_shares` gains `share_micro_pct`, `is_primary`, `pays_application`, `source` (`field_version` with version id, `office_override`, or `legacy`), and an exact-100% check per job field (Sol R2 5). `split_pct` stays, filled from `share_micro_pct`, until every reader moves in this PR (Sol R1 20).
- **Readers moved in this PR:** `get_job_billed_customers` / `get_jobs_billed_customers`, `resolve_line_split_vector`, `_transfer_job_to_invoice_intent_impl_20260908`, Job Detail, the Jobs list (`src/pages/Jobs.tsx:535`), the applicator job sheet print (`src/lib/applicatorSheetPrintData.ts:147,169`, which reads `job_field_shares` and `field_billing_defaults` directly), the loader worksheet (`src/lib/loaderWorksheetFetch.ts:99`) and the chemical application report (`src/lib/chemicalApplicationReportFetch.ts:144`).
- **Existing 5 rows** are kept, marked `legacy`, their sums audited; nothing is re-copied over them (Sol R1 18).
- `save_job` takes a field's split from the resolver **only when the field is first added to the job**. Changing the date, notes or anything else never re-reads it; adopting a newer split is the explicit `refresh_split` (§1a; Sol R2 6). Office edits are checked by the server (exact 100%, eligibility).
- Direct writes on `job_field_shares` are revoked from `authenticated` here, once `save_job` is its only writer (rule 3). 🔒 needs `I approve`.
**Done when:** Job Detail, the Jobs list, the applicator sheet and the billed-customer lookups all show the same payers for each fixture job; a 70/30 office override survives a notes edit, a date change and a retried save; `refresh_split` on that job is logged with old and new versions; a field split change after the job leaves the job unchanged; a direct write to `job_field_shares` is refused.
**Size / risk:** M. 💲🔒 DB + screens.

#### FP-5a · 💲 One field invoice engine, with line-by-line changes before posting (February-critical)
**Items:** 6, 8, 12, 27, 28, 29; Mason's question-2 answer.
**Approach.**
- **Field-application invoices and job invoices both use the per-line engine** (Sol R2 1, improvement 4). It already accepts a source job (`_save_field_app_split_invoice_impl(p_billing_set_id, p_source_job_id, ...)`, `20261204100000:3629`). `transfer_job_to_invoice` creates a per-line draft from the job's snapshot instead of a location-engine invoice.
- `resolve_line_split_vector` gains the billing date and reads, in order: job snapshot → field split version on the billing date → owner (Sol R1 22). The browser preview calls the same function with the same inputs.
- **Draft line splits (Mason's answer):** every line starts from the snapshot under the §1a defaults; before posting, the office can set any line's percentages and per-line price, within eligible payers. The server checks each line (exact 100%, a positive line primary, eligibility), keeps a "changed from the field split" mark, and never touches the field's saved split.
- **Posting** snapshots each line's split and provenance (§1a). Unpost and repost start from the last posted split.
- **Old location-engine records, in this same package** (Sol R2 15, improvement 2): posted invoices stay as they are, PDFs unchanged. Before the cutover, the unposted location-engine drafts (cutover inventory, rule 6) are converted to per-line drafts that copy their stored `invoice_shares` exactly, with a log; any draft whose stored shares cannot be read cleanly is listed for the office instead. After that, the location engine cannot create or edit invoices.
- **Direct writes** on `field_app_location_shares` and `invoice_shares` are revoked from `authenticated` here (rule 3). 🔒 needs `I approve`.
- **Proof with Mason, no duplicate bills** (Sol R1 25): for one real landlord field, compare the engine's *preview* (read-only) with Mason's own sheet; then he creates the one real invoice.
**Done when:**
- For every fixture, preview and saved draft give the expected payers and cents per line kind; the 60/40-no-application field bills the landlord 40% of chemicals and 0% of application.
- On a draft, changing one chemical line to 80/20 and another to 100/0 posts exactly those shares while the field stays 60/40; a line totalling 90%, or adding a payer not on the field, is refused.
- A job invoice is created as a per-line draft with the job's override split.
- Unposting a posted 60/40 invoice after the field became 70/30 and reposting without refresh gives 60/40 again; with `refresh_split` it gives 70/30 and logs it.
- An old location-engine draft opens as a per-line draft with the same payers and cents.
- Mason's preview matches his sheet before he saves.
**Size / risk:** L. 💲🔒 DB + screens. The largest package; may split into an engine PR and a screen PR if review needs it.

#### FP-5c · 💲 Split invoices all the way through: PDFs, balances, payments, statements, credits
**Items:** new from Sol R2 22–24.
**Approach.** No new engine; prove and fix the paths after posting, using one **ledger journey** fixture (improvement 5): a split field-application invoice → posted payer invoices → each payer's PDF and invoice detail → customer balance and aging → a payment applied to one payer → that payer's statement → a return credit and a void. Fix what does not hold. Inventory every reader first: `InvoiceDetail.tsx`, `Invoices.tsx`, `FieldInvoicesPostedPanel.tsx`, `FieldInvoicesUnpostedPanel.tsx`, `src/lib/fieldInvoiceList.ts`, `src/lib/invoiceBatchPosting.ts`, `src/lib/splitGroupPostChecks.ts`, `supabase/functions/_shared/pdf/invoicePdf.ts`, statements, AR aging, and commission records (the field-app path stamps a commission record per invoice). Commission on split invoices: each payer invoice credits the job's rep for that invoice's amount, never the group total twice; per-payer sales reports are foundation 18.2.
**Done when:** for the journey fixture, each payer's PDF shows only their lines and amounts (the landlord's PDF shows no application charge); each payer's balance and statement shows only their share; a payment to one payer touches only that payer; a return credit reverses the original posted allocation even after the field's split changed; commission totals equal the group total once.
**Size / risk:** M. 💲 Mostly screens and reads; DB only if a reader is wrong. February-critical.

#### FP-5b · 💲 Blend-ticket invoices on the same engine
**Items:** 9, 12.
**Approach.** `create_invoice_from_blend_ticket` creates a per-line draft (billing date and acres per §1a) instead of reading `derive_customer_shares_from_fields`, so blend tickets get the same line changes before posting. `derive_customer_shares_from_fields` then has no billing callers; keep it for display only with a date input, or remove it with its browser preview call.
**Done when:** a blend ticket on each fixture field drafts the expected payers and cents; a line can be changed before posting; no billing function reads `field_billing_defaults` directly.
**Size / risk:** M. 💲 DB. After FP-5a; not on the February path unless blend tickets are billed before then.

#### FP-6 · 💲 Orders and deliveries read the split group (after 2026-12-15)
**Items:** 10, 15.
**Approach.**
- Re-read Taha's live code first. Reconcile **per order line** (Sol R1 28): a line with field allocations bills by the field split; a line without follows his card or `order_item_shares`.
- New RPC `set_order_line_field_allocations(p_order_item_id, p_allocations, p_idempotency_key)` replaces the direct writes at `OrderDetail.tsx:1005` and :1022. It checks the line belongs to an editable order, no field twice, acres positive, no archived field added, and refuses changes once the line is delivered or invoiced (Sol R1 31). Direct writes on `order_item_field_allocations` are revoked here (rule 3). 🔒 needs `I approve`.
- **Quantity and cents per field** (Sol R2 19): the line's quantity and cents are split across its fields by allocated acres (§1a math); allocations must cover the whole line, or the remainder is named as unallocated and billed to the order's customer.
- **Snapshot when the allocation is saved** (Sol R2 20), not at delivery; `refresh_split` before invoicing adopts a newer field split.
- Both the **delivery** invoice and the **direct order invoice** produce draft field-split invoices with line changes before posting (Sol R1 29; R2 18, R2 1), dated per §1a; retries return the first result.
**Done when:** an order with one line on a 50/50 field and one on Taha's card produces the right invoices per payer, cents exact, both through delivery and through a direct order invoice; a line spread over two differently split fields bills each field's payers its part; a retried delivery creates nothing new; changing allocations after delivery is refused.
**Size / risk:** M–L. 💲🔒 DB + screen. Shared files with Taha (`OrderDetail.tsx`, delivery functions).

### Wave 3: final check

#### FP-7 · 🔒 Final boundary check and future-dated splits
**Items:** 1, 17, 31, 33.
**Approach.**
- Verify, table by table, that every payer-bearing table has no direct write left (the closures happened in FP-1, FP-3, FP-4, FP-5a and FP-6; rule 3). Taha's `order_shares` and `order_item_shares` are his decision, raised as a comment.
- `anon` SELECT revoked only where a table-by-table check shows nothing legitimate reads it (Sol R1 33).
- Replace `field_billing_defaults` with a read-only, narrow current-split function for applicators that applies `_can_see_field` itself (SECURITY DEFINER, one field at a time), then drop the table copy once nothing else reads it (Sol R2 28).
- Allow future-dated splits.
- Fix the KI-84 smoke chain; run the fixture and ledger-journey tests in CI.
- Update the roadmap, DECISION_LOG, KNOWN_ISSUES (KI-16, KI-76) and the field part of `docs/workflows/QUOTE_TO_DELIVERY.md`.
**Done when:** the table-by-table check finds no direct write; an applicator still sees exactly their assigned fields' current splits and nothing else; a future-dated split bills correctly on both sides of its date; CI runs the fixtures.
**Size / risk:** S–M. 🔒 DB.

---

## 3. How this relates to Taha's work

- **One line:** Taha's open PRs #1524 and #1534 add a per-payer Bill Split for chemical sales (an order card plus per-line payers in `order_item_shares`, stored as percent); this plan does not touch them, and they already let a field allocation win over the card. #1587 shares `OrderDetail.tsx` only; #1576 changes who may unpost field invoices and needs no change from us.
- The two models meet on an order line with a field allocation. FP-6 reconciles them per line against his final, live code, after 2026-12-15.
- Shared choices that match his: inactive customers cannot be added as payers; leftover cents go to the main payer (Q4). His allocator floors the other payers and gives the main customer the rest, which is the same rule.

## 4. Order and timeline

| Order | Package | Needs first | Target | February path |
|---|---|---|---|---|
| 1 | FP-1 split group with history | `I approve` (grant, foreign key) | November | yes |
| 1 (parallel) | FP-2 billable acres | nothing | November | yes |
| 2 | FP-4 jobs carry the snapshot | FP-1, FP-2; PR #1650 landed; `I approve` (grant) | early December | yes |
| 3 | FP-5a one engine + line changes + old drafts | FP-4; `I approve` (grants); Mason's 20-minute preview check | December–early January | yes |
| 4 | FP-5c PDFs, balances, payments, statements, credits | FP-5a | January | yes |
| any time | FP-3 archive fields | `I approve` (grant) | when convenient | no |
| 5 | FP-5b blend tickets | FP-5a | January–February | only if blend tickets bill before February |
| 6 | FP-6 orders and deliveries | Taha's #1524 and #1534 live (after 2026-12-15) | January–February | no |
| 7 | FP-7 final check, future dates on | all above | February | no |

**9 PRs in 3 waves** (the roadmap guessed 5–6; history, line editing on every path, and the end-to-end money proof add the rest). **February path: FP-1, FP-2, FP-4, FP-5a, FP-5c** (5 PRs, all database and money work under Sol). Risk: FP-5a is large and lands near the holidays; if it slips, the fallback is to keep the location engine for one more month for single-payer fields only and use the per-line engine for split fields.

## 5. Mason's decisions (2026-11-08)

All five answered in chat: question 2 in his own words, and "I agree with all rest" for 1, 3, 4 and 5. Recorded in `docs/manual/DECISION_LOG.md` (2026-11-08 entries).

1. **Which customers may a field split bill? (KI-76)** **DECIDED:** only payers saved on that field's split (or an office change on one job); to bill someone else, the office adds them to the field's split first (any active customer). A line changed before posting may re-weight these payers (including down to 0%) but not add someone outside them.
2. **Can a payer share a field but not pay the application charge?** **DECIDED** (Mason: "field level splits always auto populate based on field but we need to be able to adjust the split before posting invoice and change line items at different percentages and shares"): each payer has "pays application" yes/no on the field; every invoice line starts from the field's split; before posting, the office can set any line to its own percentages, on every field-billing path (FP-5a, FP-5b, FP-6).
3. **When a field's split changes, which work uses the new split?** **DECIDED:** the office picks the start date (today or earlier at first; future dates after FP-7); work with a billing date on or after it uses it; posted invoices never change; an unposted draft keeps its split until someone presses "refresh split", which is logged.
4. **Who gets the extra penny?** **DECIDED:** the primary payer, the same as Taha's chemical-sale split. If the primary is at 0% on a line, the largest payer on that line (§1a).
5. **Who may archive a field?** **DECIDED:** admins and sales reps archive; blocked while the field has open or unbilled work; only admins restore.

No new business questions came out of the second review; the edge cases it raised are settled in §1a as technical rules that follow from these answers.

## 6. Sol review record

Both rounds: `gpt-6-sol`, high, advisory only (not a ship gate), given the plan docs and code excerpts inline. Full outputs kept in the session scratchpad.

### Round 1 (2026-11-08): 35 findings (5 BLOCKER, 25 HIGH, 5 MED)

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | HIGH | Cited migration bodies (`20261120100000`, `20261204100000`) may not be on `main` or live | **Refuted:** both files are on `main` at `5a921026e` (`20261204100000` landed in #1579), and the live migration ledger lists `20261204100000` as applied (read-only query). The project stamps migration files ahead of the calendar. |
| 2 | MED | Backlog mixes payer sources, snapshots and acre allocations | Backlog items 1 and 3 separate them; FP-7 checks per table |
| 3 | BLOCKER | A future-dated version copied into `field_billing_defaults` bills early | FP-1: no future dates until FP-7 |
| 4 | HIGH | Backfill invents history | FP-1: version 1 flagged `history_known = false` |
| 5 | BLOCKER | Direct writes to `field_billing_defaults` open during dual storage | FP-1 revokes them |
| 6 | HIGH | Concurrency, replay, append-only only noted | FP-1 specifies and tests each |
| 7 | HIGH | Resolver access and bad input undefined | FP-1 |
| 8 | HIGH | Version history widens applicator access | FP-1: no applicator read of versions |
| 9 | HIGH | `price_override_cents` and `pricing_note` could be lost | Revised in round 2: note kept; unused field-level price dropped (R2 17) |
| 10 | HIGH | Owner customer delete cascades fields | FP-1 (moved from FP-3 in round 2) |
| 11 | HIGH | Payer eligibility not dated | §1a |
| 12 | HIGH | Field acres could replace applied acres | §1a acres order |
| 13 | MED | "No acres" rule too blunt | §1a |
| 14 | HIGH | Acre remainder could go negative | §1a (now the engine's signed math) |
| 15 | MED | No database check on acre values | FP-2 |
| 16 | HIGH | `is_active` could un-archive | FP-3 |
| 17 | HIGH | Archive blocks incomplete | FP-3 |
| 18 | HIGH | Re-copying overwrites the 5 job-share rows | FP-4: kept as `legacy` |
| 19 | HIGH | Override needs a durable marker | FP-4 `source` |
| 20 | HIGH | Job-share format change without reader plan | FP-4 moves every reader |
| 21 | BLOCKER | Location engine cannot bill product and application differently | FP-5a: per-line engine |
| 22 | HIGH | Resolver functions lack date/job inputs | FP-5a |
| 23 | HIGH | "Application date" incomplete | §1a billing dates |
| 24 | HIGH | Old location drafts undefined | FP-5a converts them |
| 25 | HIGH | Side-by-side could create two bills | FP-5a read-only preview |
| 26 | BLOCKER | Cents rule undefined and differs by engine | §1a |
| 27 | MED | "Same cents everywhere" is the wrong test | Rule 5 |
| 28 | BLOCKER | Taha's line payers missing from order design | FP-6 per line |
| 29 | HIGH | Delivery still refuses split orders | FP-6 |
| 30 | HIGH | Order split not snapshotted | FP-6 (now at allocation, R2 20) |
| 31 | HIGH | Allocation RPC lacks rules | FP-6 |
| 32 | HIGH | Lockdown list incomplete | Rule 3 and FP-7 |
| 33 | MED | Blanket `anon` revoke | FP-7 |
| 34 | HIGH | Archive and draft refresh interact | FP-3; §1a refresh |
| 35 | MED | Tests before the rules they need | §1a first |

Also folded in after round 1: two Codex GitHub-review comments on PR #1674 (credits reverse charges; the transition copy follows the split in force today).

### Round 2 (2026-11-08, after Mason's answers): 32 findings (3 BLOCKER, 25 HIGH, 3 MED, 1 LOW) and 10 improvements

All 32 accepted; none refuted. Checked against code before folding in: the per-line allocator already mirrors credits and keeps 4-decimal acres (`20260720214000`), and job invoices are field-application invoices that the per-line engine can take with a source job (`20261204100000:3629`).

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | BLOCKER | Line changes before posting only on one path | Every field-billing path uses the per-line draft: FP-5a (field app and job), FP-5b (blend), FP-6 (orders) |
| 2 | BLOCKER | Primary at 0% could still get the cent | §1a line primary |
| 3 | BLOCKER | Nobody paying application leaves the charge unbillable | FP-1 check; §1a |
| 4 | HIGH | Is "pays application" a default or a hard rule? | §1a: default; hand edits allowed within eligible payers |
| 5 | HIGH | Job snapshot misses billing attributes | FP-4 columns; §1a snapshot |
| 6 | HIGH | Date change silently re-copies the split | FP-4: copied only when a field is added; `refresh_split` otherwise |
| 7 | HIGH | "Refresh split" undefined | §1a `refresh_split` RPC |
| 8 | HIGH | Unpost/repost start point undefined | §1a, FP-5a test |
| 9 | HIGH | Deactivated payer on saved work | §1a eligibility |
| 10 | HIGH | Lines over several fields with different primaries | §1a field-by-field |
| 11 | HIGH | One version id not enough provenance | §1a provenance |
| 12 | HIGH | Backfill can't prove yesterday's split | FP-1 separates synthetic and live tests |
| 13 | HIGH | Legacy 99.999999 totals vs "refuse if off" | FP-1 conversion rule with a review stop |
| 14 | HIGH | Old unposted work without snapshots | Rule 6 cutover inventory; FP-1, FP-5a |
| 15 | HIGH | Old location drafts could recalculate | FP-5a converts them from stored shares |
| 16 | HIGH | 0.01-acre rule conflicts with the engine's 0.0001 | §1a: keep 4 decimals |
| 17 | HIGH | Per-payer price vs one line total | §1a; unused field-level price dropped |
| 18 | HIGH | Direct order invoice not covered | FP-6 |
| 19 | HIGH | Order line cents across fields undefined | FP-6 |
| 20 | HIGH | Order snapshot taken too late | FP-6: at allocation |
| 21 | HIGH | Other line kinds and discounts | §1a |
| 22 | HIGH | Credits after a split change | §1a; FP-5c |
| 23 | HIGH | Balances, payments, statements unproven | FP-5c ledger journey |
| 24 | HIGH | PDFs, reports, commissions unproven | FP-5c |
| 25 | HIGH | Direct writes open until FP-7 | Rule 3: closed in each package |
| 26 | HIGH | Archive races new work | FP-3 database admission under lock |
| 27 | HIGH | Version foreign keys; owner cascade waits | FP-1 RESTRICT keys; owner fix moved to FP-1 |
| 28 | HIGH | Applicator view over version tables | FP-7 narrow function |
| 29 | MED | Missing range and uniqueness rules | FP-1 |
| 30 | MED | No billing date fallback | §1a: refuse |
| 31 | MED | Archive roles not in tests | FP-3 |
| 32 | LOW | "No history anywhere" overstated | Backlog item 3 reworded |

Improvements taken: 1 (rule 3), 2 (old drafts in FP-5a), 3 (FP-3 off the February path), 4 (one draft-line engine), 5 (ledger journey, FP-5c), 6 (per-contribution provenance), 7 (4-decimal acres), 8 (drop unused field price), 9 (rule 6), 10 (re-estimate, §4).

**Found by Claude alongside round 2:** the applicator job sheet print, loader worksheet, chemical application report and Jobs list read who-pays on their own; they are now named in FP-4.
