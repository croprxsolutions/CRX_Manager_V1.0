# Fields and who pays: build sheet (foundation 18.1)

**Status: GAME PLAN, reviewed by Sol four times, by an independent Opus reviewer (who checked it against the code) and by Astra (blind, max effort) on 2026-11-08. NOT STARTED.** Mason asked for foundation 18.1 to be planned the Product Master way (handoff, 2026-11-08), then asked for a second Sol pass "to look for gaps or improvements" after answering the five business questions, then a third and a fourth. This sheet turns the backlog (`docs/plans/2026-11-08-fields-who-pays-BACKLOG.md`, items numbered the same) into packages, one pull request each, with an approach, "Done when", size, database impact and risk. Both Sol rounds and what was done with each finding are in §6. Nothing here authorizes building. Building starts when Mason says so, one package at a time.

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

## 0. Decided on the evening of 2026-11-08: not yet folded into the packages

Mason answered these after comparing the plan with the industry research (`docs/research/2026-11-03-ag-retail-software/`). They change parts of §1a, FP-1, FP-5a and FP-5c; the packages below still read as before until they are folded in at the next session. Where a package below disagrees with this section, **this section wins**.

- **Q8. Two shares per payer on a field: an application share and a product share.** (Mason: "set the application split share on a field and then the product split share, we dont need to edit anything else, in one off cases i can edit the individual line item split before posting".) Each payer on a field's split has an **application %** and a **product %**, each set adding to exactly 100%. Application and fuel-surcharge lines start from the application shares; chemical and other product lines start from the product shares; any single line can still be changed by hand before posting. This **replaces the yes/no "pays application" flag** (a payer who does not pay application is simply 0% on the application side). It matches the industry norm (Agvance ties splits to product groups, e.g. "50/50, but custom application 100% tenant"), but keeps only the two groups Mason needs. Folds into: §1a application and other-line-kind rules, FP-1 tables and Field Setup, FP-4 job snapshot, and the conversion of the 5 existing rows (each becomes 100% on both sides). **Open for the fold-in:** which side flat fees start from (recommended: product shares).
- **Q9. Each payer's invoice shows who else shares the bill.** (Mason: "yes i agree show who shared the bill with you".) Each payer's PDF and invoice detail prints a "Shared with" area naming the other payers on that invoice and their shares, like Agvance's "This invoice is shared with". Each payer's amounts still show only their own part. Folds into FP-5c (PDF and invoice detail), with a test that a single-payer invoice shows no such area.
- **Q10. A posted field-application invoice can be edited while no money has touched it and its month is still open.** (Mason: "I want to be able to edit posted field application invoices as long as no money has been applied to the invoice or we havent closed the month out".) Editing means the existing unpost, change, re-post step, applied to the whole payer set (§1a "invoice sets move together"). It is refused when any invoice in the set has a payment, prepay, credit or write-off applied, or when the invoice's accounting month is closed (`accounting_periods`, the existing month close). After that, the only correction is a credit and a new bill. Each re-post keeps its own posted record (§1a post revisions). Folds into FP-5a, which must first check what today's `unpost_invoice` already refuses (it is wrapped by Taha's chemical-sale split work, `20261215110000`, and Taha's #1576 sets who may unpost) and add only what is missing.
- **Credit and rebill, after money has been applied** (industry gap: Levridge automates it). When a paid invoice had the wrong split, the office credits it and bills the same work again with the right split. FP-5c must prove this in the ledger journey, including that the work's "billed once" link (§1a "one bill per piece of work"; a job's `invoiced` status today) allows the new bill only after the full credit.
- **Prepay on split bills** (industry gap: Levridge applies each payer's prepay to their own share). CRX already applies prepay one invoice at a time, and each payer has their own invoice, so no new design is expected; FP-5c's ledger journey adds one step applying one payer's prepay to their own payer invoice only.
- **Mason's current software (Chem Man) documentation** will be uploaded for review at the next session; check the plan against it before folding these in.

---

## 1. Rules for every package

1. One package is one pull request, delivered through `.claude/commands/ship.md`. Every package below touches the database, money or permissions, so each needs a clean Sol review before merge, and every PR stays open 4 hours (Taha's rule, 2026-11-08), including before any live migration apply.
2. Rules live in the database: the RPC refuses a bad split; the screen only explains it. Every new write RPC, **and every existing one a package changes** (`save_field`, `save_job`, `transfer_job_to_invoice`, `save_field_app_split_invoice`, `create_invoice_from_blend_ticket`, the order and delivery invoice functions), takes and enforces `p_idempotency_key`, bound to a hash of the request (a reused key with a different payload is refused); each package lists the entry points it changes and proves a retry (Sol R3 15). SECURITY DEFINER functions set `search_path = public, pg_temp`, check the caller's role inside, and get deliberate grants. Each package's own plan opens with a short contract per RPC: inputs, rows written, locks, key scope, output (R3 improvement 1). **Signatures** (Astra 38): adding `p_idempotency_key` makes a new PostgreSQL signature, so each package lists the exact old signatures it replaces and drops them in the same migration; every new function and `_impl` helper has `PUBLIC` execute revoked, and helpers are never granted to `authenticated`. **Replays** (Astra 40): the stored result is checked before any state-dependent validation, so a retry after midnight or after the job is invoiced returns the first result instead of an error. **Record checks** (Astra 39): every RPC that takes line, field or allocation ids checks they belong to the named job, draft or order and that the caller may change that record, as the existing writers do.
3. **Close each direct write in the package that replaces its last screen writer**, not at the end (Sol R2 25). Any grant or policy change on an existing table needs Mason's `I approve` before that migration is applied; each package names its exact grant changes.
4. Proof: database behaviour in the schema-matched Docker harness with the fixture set (rule 5); screens in the local dev app. Live checks are read-only unless Mason approves a specific live test in that conversation.
5. **Fixture set** (backlog 32), built in FP-1 and extended by each package. Fields at: 100% one payer; 50/50; thirds; 50/25/25; 2/3–1/3; 60/40 with a landlord who does not pay the application charge; a single payer who is not the field's owner; a field with no stored acres but a valid job acreage. Expected results are written per line kind (chemical, service/application, fuel surcharge, flat fee), price, acres and billing date; paths are compared on equal inputs, and intended differences are asserted explicitly. Every path also gets: a 1-cent line split three ways and its −1-cent credit; a line whose primary payer is changed to 0%; a line covering two fields with different primaries; a mixed order (one field line, one non-field line).
6. **Cutover inventory** (Sol R2 14, improvement 9): immediately before each migration is applied, count the live unposted drafts, jobs, orders and blend tickets it affects, and pin or review each one as that package says. November's counts are not proof for January (on 2026-11-08: 1 unposted field-application invoice, 5 job-share rows, 0 order allocations).

   **Where each record's split comes from, before and after each package** (R3 improvement 2):

   | Record | Today | After FP-1 | After FP-4 | After FP-5a | After FP-5b | After FP-6 |
   |---|---|---|---|---|---|---|
   | Field | `field_billing_defaults` | versions (copy kept in `field_billing_defaults`) | same | same | same | same |
   | Job | browser copy of `field_billing_defaults` into `job_field_shares` | same | planned split (`job_field_shares`, with source) | same | same | same |
   | Field-app / job invoice draft | location engine re-reads `field_billing_defaults` on save | same; testing only until FP-5a (Mason) | job-transfer bugs fixed (landlord-only header, different payers per field); office-override jobs refused | per-line draft payers, frozen until refresh | same | same |
   | Blend-ticket invoice | `derive_customer_shares_from_fields` | same | same | same | per-line draft, frozen until refresh | same |
   | Order line on a field | `order_item_field_allocations` → `field_billing_defaults` at invoicing | same | same | same | same | planned split stored at allocation; first draft resolves the billing date |
7. Stay out of Taha's billing files until 2026-12-15: `order_shares`, `order_item_shares`, the Bill Split card, and his re-emitted functions. Comment on his PRs only; never push to them.
8. Re-check each backlog item, and the live body of every function a package changes, before building.

## 1a. Shared money and date contracts (settled before FP-1)

These rules come first because every acceptance test depends on them (Sol R1 14, 22, 23, 26, 35; R2 2, 10, 16, 17, 30).

- **One field per billing line** (Astra 4, improvement 1). Today `field_app_billing_lines` has no field and `invoice_line_shares` allows one row and one unit price per line and payer (`20260720213000:61-115`), so a payer cannot have two prices or two fields' worth of rules on one line. FP-5a adds `field_id` to `field_app_billing_lines`: a product applied over two fields becomes two lines, one per field, which the screen and the PDF group under one heading. Every rule below (eligibility, primary, prices, acres) then works on one field at a time, and the existing line-and-payer tables fit unchanged. A line with no single field (converted old lines, discounts) has `field_id` blank and is never re-split from a field.
- **Start from the per-line engine's math, which is already sound** (`20260720214000`; only the per-line engine calls it, 0 real rows): signed largest-remainder on the absolute value with the sign restored, so a credit mirrors its charge exactly; quantities and acres at 0.0001 (4 decimals), rounded once; money rounded once per figure; display rounds to 2 decimals only (Sol R2 16).
- **Leftover cents go to the primary payer (Q4).** Change only the leftover step: after each payer gets `floor(|cents| × share / 100,000,000)`, all leftover cents go to the line's primary payer, then the sign is restored. The **line primary** is the field's primary if it has a share above 0% on that line; otherwise the payer with the largest share on that line (ties: lowest customer id) (Sol R2 2). Tests: 1¢ over thirds = 1/0/0; −1¢ = −1/0/0; primary at 0% on a 1¢ 50/50 line gives the cent to a non-zero payer. This is a **new allocator function** with its own name (Astra 6); the existing `compute_line_split_allocation` is left as it is, and posted records keep their stored cents, so nothing already calculated changes. The same line primary takes leftover quantity and acres too (Astra 53). Amounts are capped to a validated range well inside bigint, and kept in `numeric` until the final signed result (Astra 52).
- **Acres** use the same rule at 0.0001 acre, leftover to the line primary; never negative.
- **A product over more than one field** (Sol R2 10, R3 7; Astra 4): its quantity is split across the fields by acres once (largest-remainder at 0.0001), giving one line per field. When every payer has the same price, the product's cents are worked out **once** on the whole quantity (the existing calculator rounds quantity × price once, `20260720214000:408`) and those cents are split across the field lines by the same acres (largest-remainder at the cent), so splitting never adds or loses a cent (Codex review on #1674: 1 gallon at $10.01 over two equal fields bills $5.01 + $5.00, never $5.01 + $5.01). Each field line's cents are then split among that field's payers with that field's primary taking its leftover. Payers with different prices follow the quantity rule below. The resolver returns **one payer list per field**, never one blended list, which replaces the blending in today's `resolve_line_split_vector`.
- **Per-payer prices** (Sol R4 10; Astra 15). Same price for everyone: one line total, split as above. Different prices, whether from the payer's own price tier (the engine already prices by tier per payer, `base_price_source = 'tier'`) or an office `override` with a reason: the line's *quantity* is split among its payers (0.0001, leftover to the line primary); each payer's cents are their price × their quantity, rounded once; the line total is the sum. The price source is stored per payer either way. The unused field-level `price_override_cents` (0 live rows) is **not** carried into the new split model (Sol R2 17, improvement 8); the existing `pricing_note` text is carried as a note only.
- **Application charge (Q2).** `pays_application = false` sets the *default* only: on service/application lines that payer starts at 0% and the others share their part in proportion. The office may still change a draft line by hand, within the eligible payers (Sol R2 4). A field split where every payer is excused from application is **allowed** (a chemical-only field whose growers apply it themselves, Astra 19); the refusal moves to the draft: an application line on that field, with no payer above 0%, is refused with a plain message.
- **Other line kinds** (Sol R2 21, R3 10; Astra 20): chemical lines default to the full split; fuel surcharge defaults like application lines (Q6, Mason); flat fees default to the full field split; each kind is editable before posting. **No new discount line kind** (Astra 17, 18 and improvement 4, checked): field invoices have no discount line today; their only discount is the per-payer-invoice "Discount Earned", which is display-only and never changes the invoice total (`src/pages/FieldApplicationInvoice.tsx:345-361`). It stays exactly as it is, one per payer invoice, so there is no discount to split. Sol R2 21 and Opus 10 asked for a discount kind; checking the code shows none is needed. Sales tax: none on these invoices today; if one is added later it follows its own line.
- **Acres to bill, per path** (first one present wins; the writer works this out per field *before* checking acres, since today's writer refuses a field with no applied acres before any fallback, `20261204100000:3772-3775`, Sol R3 6): field application = applied acres on the invoice location → job's `acres_to_treat` → field billable acres; job = `job_fields.acres_to_treat` → field billable acres; blend ticket = actual acres → planned acres → field billable acres; order line = allocated acres. "Present" means not blank (Astra 42): a stored actual of exactly 0 is not skipped in favour of planned acres; it is refused as "0 acres applied", so work that was not done is never billed from a plan. Values are rounded to 4 decimals before the check. A path refuses only when it has no positive acres after its own order.
- **Billing date, per path** (Central date; exact columns, Opus 6): job = the job's legal application date (`application_records.application_date`, which `complete_job` writes from `job_applied_info.actual_start_time` in Central time), else `jobs.job_date`, so the invoice and the legal record can never disagree; field application = the application date on the invoice; blend ticket = each field's own `blend_ticket_fields.applied_at` for that field's contribution, else the ticket's date; order line = delivery completion date, or the invoice date for an order invoiced without a delivery. No date → the RPC refuses with a plain message; never "today" by accident (Sol R2 30). A snapshot taken before the billing date exists (an order allocation before delivery) resolves on its own recorded split date, the day it is saved (FP-6). Existing season and closed-period guards still apply.
- **Planned split, then draft split** (Q3; Sol R3 5, 17). A job or an order allocation holds a *planned* split: it shows who is expected to pay, copied from the field when the field is added. The **first invoice draft** resolves the field split in force on the billing date, unless the job or allocation carries an office override, which wins. A `legacy` job share (FP-4) counts as an office override when it differs from the field version (Astra 7), so an old job's saved split is never quietly replaced. If the planned split and the billing-date split differ, the draft says so ("field split changed on <date>"). From the first draft on, the draft's split is frozen: field changes reach it only through `refresh_split`. This is how Q3's "work dated on or after the change uses it" and "drafts keep their split until refresh" both hold.
- **Draft edits that are not re-weights** (Astra 14). The draft keeps one frozen payer list per field (taken when that field first entered the draft). A new line, a line moved to another field, or a line whose kind changes (chemical to application) starts again from that field's frozen list under the defaults for its kind, and the screen says the line's hand edits were cleared. A field new to the draft resolves its list on the billing date, logged like a refresh. Deleting and re-adding a line therefore never fetches a newer field split.
- **Stale screens** (Astra 34). Every draft has a revision number; save, refresh and post take the revision the screen loaded and refuse if the draft has changed since ("someone else changed this draft; reload"). The retry key alone cannot catch a second user's older screen.
- **Draft storage and provenance** (Sol R2 5, 11; R3 8, 9; R4 1, 4, 5, 6). FP-5a adds these tables, each with RLS, policies and grants in the same migration (office read; no direct writes, RPC only; no applicator or `anon` access):
  - `field_app_billing_line_sources` (one per line, since a line now has one field): billing line, field, acres, billing date, **source type** (`field_version` with version id, `job_override`, `legacy`, `owner_fallback`, `legacy_fixed`) and the source payer list with share, primary and pays-application copied in full, so each record stands on its own whatever the source.
  - `field_app_billing_line_payers`: **billing line and customer**, micro-percent, price mode and price source, override price and reason, `hand_edited`. The screen may offer one edit across a product's field lines, but it is saved per line, each within that field's eligible set.
  - **Posted record** (Astra 22, 23): instead of a new snapshot table, the existing append-only `invoice_line_share_snapshots` gains a **post revision** number and, per line and payer: field, billing date, source type and version id, the full eligible set (0% payers included), primary and pays-application flags, price source, override reasons, quantity and cents (Opus improvement 3). It already has no foreign key to the billing line, so unposting and re-saving can never erase what a posted invoice was built from. Unposting stays the office's existing correction step (Taha's #1576 sets who may do it); each post is a new revision, so every version a customer was sent can be rebuilt, and credits point at the revision they reverse.
  - **Refresh log** (Astra 35): `field_split_refresh_log` stores, per refreshed line, the payers, shares, price modes and overrides before and after, the scope chosen, who, when and why, in the same transaction. A reset of a hand edit is therefore recoverable even when the version id did not change.

  **Stable line ids** (Opus 5): today every re-save deletes and re-inserts all billing lines (`DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id`, `20261204100000:3935`), and `invoice_line_shares` cascades from them. FP-5a changes the writer to keep each line's id across saves (update in place, insert only new lines, delete only lines the office removed). The two new tables reference the line and are removed only when the office removes that line. The payers table is the draft's source of truth; `invoice_items` and `invoice_line_shares` are regenerated from it on every save, so a re-save never loses an edit. Tested: a re-save keeps every line id and every hand edit.
- **Refresh split** (Q3; Sol R2 6, 7, 8; R3 12). Built in steps (Opus 9): FP-4 builds the RPC with the `job` mode and its retry-key contract, FP-5a adds `invoice_draft`, FP-6 adds `order_line`. One RPC, `refresh_split(p_source_type, p_source_id, p_line_ids, p_field_ids, p_reset_hand_edits, p_reset_overrides, p_reason, p_idempotency_key)` (Sol R4 7, 8). `p_source_type` is `job`, `invoice_draft` or `order_line`; `p_line_ids` and `p_field_ids` limit it to some lines and some fields (default all); `p_reset_hand_edits` (default false) also resets hand-edited lines; `p_reset_overrides` (default false) also clears an office override on a job or allocation. Only the lines and fields actually refreshed get the new version's payers and eligible set; skipped ones keep theirs. It re-reads the version in force on the billing date, records who, when, why, old and new versions, and returns a per-line before-and-after summary for the screen. Nothing else re-reads the field's split for a frozen draft: not a date change, not a notes edit, not a retry. **Unpost and repost** start from the last posted line splits, and both post snapshots are kept.
- **Payer eligibility (Q1; Sol R2 9, R3 11).** Each job, draft or order line has its own **eligible set**: the payers in its snapshot (planned, override or draft). Any of them may be re-weighted, including from 0% back up, even if later deactivated or dropped from the field's split. A draft can **not** add a payer outside its eligible set by hand (Sol R4 9): the payer is first added to the field's split (Q1), then a logged `refresh_split` brings them in. On a job or order allocation the office may instead set an office override of the shares, whose payers must be on the field's split, checked against the version in force **on the day the override is saved** (an order allocation has no billing date yet, Astra 13). The saved override then stands: it is the job's or allocation's eligible set, and the first draft keeps it even if a payer later leaves the field's split, with a note. Q1 is read this way: "an office change on one job" changes the shares, never adds a payer the field does not have (Astra 12; §5). A refresh replaces the eligible set only for the lines and fields it refreshed, and says on screen who was dropped.
- **Returns and credits** (Sol R2 22; Astra 26) reverse the original *posted* line allocations of a named post revision, never the field's current split. Each posted line and payer keeps a remaining refundable quantity and cents, reduced under a row lock by every credit, so two half-returns of a 1¢ line refund 1¢ in total, never 2¢.
- **One bill per piece of work** (Astra 27). Retry keys stop a repeated click; they do not stop two different screens billing the same work. Each source can be billed once, enforced by a unique link in the database: a job (exists today), a blend-ticket field (FP-5b), and an order line's delivered quantity (FP-6, by remaining quantity).

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
  - `field_billing_split_payers`: version, customer (`ON DELETE RESTRICT`), `share_micro_pct` integer between 0 and 100,000,000, `is_primary`, `pays_application`, `pricing_note`, `notes` (the per-payer note Field Setup already sends, Opus 12). Unique (version, customer) (Sol R2 29).
  - Both append-only: a trigger refuses UPDATE and DELETE, and refuses a payer INSERT into any version not created in the same transaction, so an old version can never gain a payer (Astra 36). Every share and flag is `NOT NULL`. A deferred check fires on the version row as well as on payers, so a version with no payers is refused too (Astra 37), and refuses a version that does not total exactly 100,000,000, has not exactly one primary, or has a primary at 0% (a version where nobody pays application is allowed; §1a, Astra 19). A 0% payer is allowed only as a non-primary (a named party who normally pays nothing). **Older tables refuse 0%** (Opus 4): `field_billing_defaults`, `job_field_shares`, `field_app_location_shares` and `invoice_shares` all check `> 0` (`20260213000000:46`, `20260406100000:47`, `20260219200000:90`). So the transition copy into `field_billing_defaults` leaves out 0% payers, and in this same package Field Setup reads the split, and checks its retry, from the version tables instead of `field_billing_defaults` (`src/pages/FieldSetup.tsx:393`, :651-663), so a 0% payer is never lost on the next save. FP-4 relaxes `job_field_shares` to `>= 0` in its own migration.
  - **Read access:** admins and sales reps read all versions. Applicators get no direct read of these tables; they keep reading the current split through `field_billing_defaults` and its existing `_can_see_field` policy (Sol R1 8).
- **Owner protection moves here** (Sol R2 27): `fields.customer_id` changes from `ON DELETE CASCADE` to `ON DELETE RESTRICT`, so deleting a customer can never erase a field or its split history. Check first that no customer-delete flow relies on the cascade. 🔒 needs `I approve`.
- **Writer:** `set_field_billing_split(p_field_id, p_effective_from, p_payers, p_reason, p_idempotency_key)`; `save_field` and bulk import call the same internal function. It locks the field row (`FOR UPDATE`), so two saves of one field run one after the other. Resolver order: latest `effective_from` on or before the date, then highest version number. **The office picks any start date, past or future, from FP-1 on** (Mason, 2026-11-08, Q7: "no i want split fields now"; this replaces the earlier today-only limit). The old screens are not made date-aware; they are used for testing only until replaced (see "No changeover guards" below), which answers Sol R1 3, R3 3, Opus 8 and Sol R4 14. Posted invoices never change whatever date is picked. **Same-as-before check on the chosen date** (Sol R3 22; Astra 10, moved here from FP-7): a save whose payers and attributes match the version in force *on the chosen date* writes no new version, so editing a field's name never looks like a split change; saving today's split A dated January 1 when B is scheduled for that day does write a version, which cancels B. A future version can be replaced the same way; nothing is deleted.
- **Three engines write field invoices today** (Opus 1, 2): the location engine (`_save_field_app_invoice_impl_20260714`), the job-transfer engine (`_transfer_job_to_invoice_intent_impl_20260908`, `20261120100000`, its own code with two paths) and the per-line engine (`save_field_app_split_invoice`, switched on live: `per_line_split_billing_enabled = true`, read-only check 2026-11-08). The guards below cover all three.
- **One lock order** (Astra 33): the split writer takes the field row `FOR UPDATE`; every new invoice writer takes `FOR SHARE` on each field it bills **before** reading the split, and re-checks after the lock. So a split change and a new draft on the same field always run one after the other, never both on stale reads.
- **No changeover guards on the old screens** (Mason, in chat, 2026-11-08: "im not using them so just keep them on so we can test etc no real orders will be entered"). Five reviews in a row (Sol R4, Opus, Astra twice, Codex on #1674) kept finding new ways the old field-invoice, job-transfer, blend-ticket and order screens could bill a changed split, because they read only the undated copy. Mason's answer removes the need: until each path moves (FP-5a, FP-5b, FP-6), those old screens stay on **for testing only**, and no real field-application, job, blend-ticket or field-linked order billing is entered through them. Chemical-sale orders without field links bill as today. Accepted, by that decision: an old screen bills a field's current split whatever the work's date, and does not honour a payer excused from application. **Safety net instead of guards:** each later package's cutover inventory (rule 6) lists every field-application, job and blend-ticket invoice and every field-linked order line created through an old path since FP-1 went live; test records are voided or deleted by the office first, and any real one stops the cutover until it is reviewed with Mason. Live on 2026-11-08: 3 field-application invoices ever (1 unposted), 0 blend tickets ever, 0 field-linked order lines ever.
- **Transition copy:** the same transaction rewrites `field_billing_defaults` to the version **in force today** (resolver order), not simply the newest saved, and records which version it was built from. When a future-dated version starts, a `pg_cron` job (installed live, checked 2026-11-08) rewrites the copy just after midnight Central; the new writers read the dated resolver, never the copy, so the nightly job only keeps the old screens and applicators' view current. Direct INSERT, UPDATE and DELETE on `field_billing_defaults` are revoked from `authenticated` in this package (Sol R1 5). 🔒 needs `I approve`.
- **Unused field price, checked at apply** (Opus 11): the migration stops if any `field_billing_defaults.price_override_cents` is set at apply time, instead of silently dropping a live price; `save_field` stops accepting it in this package. Readers of that column and of `field_billing_defaults` that this plan must move or retire: `src/pages/FieldApplicationInvoice.tsx:1544` (grower-share banner), `src/pages/OrderDetail.tsx:335` (order split preview), `src/pages/FieldSetup.tsx:393,657`, `src/pages/JobDetail.tsx:1945,1981,3595`, `src/components/field-app/SelectLocationsModal.tsx:53`, and the grower-share checks at `20261204100000:3793-3799` and `20261120100000:443-449,837-866`. FP-1 moves Field Setup; FP-4 the Job Detail and job-transfer ones; FP-5a the field-app ones; FP-6 the order preview; FP-7 confirms none remain.
- **Resolver:** `field_split_as_of(p_field_ids, p_on_date)`, SECURITY DEFINER, office-only; refuses unknown and duplicate field ids and a null date; returns per field the payers with all attributes, version id and `history_known`. No version → owner at 100% (flagged). Granted to `authenticated`, not `anon`.
- **Backfill** (6 live rows; Sol R2 13): each field's current split becomes version 1, `history_known = false`, effective from the **earliest possible date** (not the migration date; Astra focused review 7), so a later backdated correction applies from its own date onward and the imported split never comes back after the migration day. Conversion: percent × 1,000,000, rounded to whole micro-percent, then the difference to exactly 100,000,000 goes to the primary; if that difference is more than 10,000 micro-percent (0.01%), or a field has no primary or two, the migration stops and lists the field for review instead of guessing. Live check 2026-11-08: every one of the 5 split fields has exactly one `is_primary` row and totals exactly 100, so none would stop today (Sol R3 2 refuted); the cutover inventory re-checks. Fields with no split get owner 100%. Every payer starts with `pays_application = true` (today's behaviour).
- **Pre-migration work** (Sol R1 4; R2 12, 14): dates before version 1 resolve to version 1 flagged `history_known = false`; screens say "split history before <date> not recorded". Existing job shares and invoice shares are left as they are (their own snapshots).
- **Payer rule (Q1)** enforced in the RPC.
- Field Setup shows the split history (date, who, payers, "imported" for version 1).
- **Test harness first** (Astra 50; backlog 31): the KI-84 smoke chain is fixed and the fixture set runs in CI in this package, so every later money package is checked by a working, green test run instead of one that is known to fail.
**Done when:**
- Saving thirds stores 33,333,334 / 33,333,333 / 33,333,333; the screen shows 33.33% each and "100%".
- The database refuses, also when called straight: 50/40; two primaries; a primary at 0%; the same customer twice; a share above 100% offset by a negative one; a blank share; a version with no payers; a payer added to yesterday's version. A field where nobody pays application saves.
- A split change and a new field-app draft on the same field, started at the same moment, end one after the other (harness, two sessions).
- **Synthetic history test** (harness, versions inserted directly, not the live backfill; Sol R2 12): with versions dated yesterday (50/50) and today (60/40), the resolver returns each on its date; a 70/30 correction dated yesterday with a higher version number leaves the copy rule choosing 60/40 for today. Through the RPC: a split dated last month bills work after that date at the new split on the new screen, while the old writers refuse work in that range unless today's copy is the same version; a split dated next week leaves today's work on the old split, and the old writers refuse work dated next week until the copy changes; the nightly job switches the copy on the start date; saving the current split dated on a scheduled change's day cancels it.
- Saving a field with only its name changed writes no new version.
- A named 0% payer survives two saves on Field Setup and is left out of the `field_billing_defaults` copy; Field Setup's retry check passes.
- The migration stops if a live `price_override_cents` is set at apply time.
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
- `CHECK` constraints that stored acres are positive when present: `total_acres`, `measured_acres`, `override_acres`, `job_fields.acres_to_treat`. Blank stays allowed. **Audit and fix first, then add the check** (Astra 54): `NOT VALID` still applies to any later update of an old row, so an old zero-acre job could not be saved at all. The migration first sets existing zeros to blank (blank = unknown, so the path's next acre source applies), lists them, then adds the checks validated.
- Measured and override acres are already saved by their own RPCs (`set_field_boundary`, `set_field_override_acres`); `save_field` writes `total_acres` only, which is correct (Astra 41 checked: refuted). The quote-to-job writer (`_create_job_from_quote_section_replay_impl_20261015`, `20261204100000:3433-3435`) writes `COALESCE(MAX(qi.acres), 0)` today; it changes to write blank instead of 0 (Opus 7), so converting a quote section with no acres keeps working. **Job Detail too** (Codex review on #1674): its save sends a blank acreage as `0` (`src/pages/JobDetail.tsx:2851`, `parseFloat(...) || 0`) and `save_job` stores it in `job_fields.acres_to_treat`; FP-2 changes the screen to send blank as `null` and `save_job` to store blank (and refuse a typed 0 with a plain message), in the same PR as the check.
- Acres keep 4 decimals for billing and snapshots; screens show 2 (Sol R2 16).
- `SelectLocationsModal.tsx:118` shows `billable_acres`.
**Done when:** a blend ticket with no actual or planned acres bills the field's override acres, while one with actual acres bills those; a field with no stored acres but a job acreage bills the job acreage; acres per payer add up exactly for every fixture; a zero-acre write is refused; an existing job with unknown acreage saves a notes edit from Job Detail without anyone typing acres.
**Size / risk:** S–M. 💲 DB. Can run beside FP-1.

#### FP-3 · 🔒 Fields are archived, never deleted
**Items:** 13, 16 (`fields`), 22.
**Approach.**
- Add `archived_at`, `archived_by`, `archive_reason` to `fields`; `is_active` is no longer writable through `save_field` (Sol R1 16). Archive state changes only through `archive_field(p_field_ids, p_reason, p_idempotency_key)` and `restore_field(...)`, **enforced by a trigger** on `fields` that refuses any change to `archived_at`, `archived_by`, `archive_reason` or `is_active` made outside those two functions (Sol R4 15). Also inventory direct `INSERT` and `UPDATE` on `fields` from screens; if none remain, revoke them from `authenticated` too.
- **Who (Q5; Sol R2 31):** active admins and sales reps archive; only active admins restore; everyone else is refused. Bulk calls are all-or-nothing and idempotent.
- **Existing inactive fields** (Astra 46): `archived_at` becomes the one archive state and `is_active` follows it. The migration sets `archived_at` on any field already `is_active = false` (0 live on 2026-11-08) with reason "inactive before archiving existed".
- **What blocks an archive (Q5; Astra 43): any work still owed on the field**: a scheduled or in-progress job; a completed job not yet invoiced and not marked billed outside the app; an unposted invoice; an order line allocated to the field that is undelivered **or delivered but not invoiced**; a blend ticket open or closed but not invoiced. A job marked billed outside the app counts as settled. The RPC names each blocking record.
- **No new work on an archived field, enforced in the database** (Sol R2 26; Astra 44, 45): the job, quote, blend-ticket, field-app and order-allocation writers refuse to *add* an archived field, under the same field-row lock the archive takes, so an archive and a new job cannot slip past each other. **Re-opening counts as new work**: reopening a job, unposting an invoice or re-opening a blend ticket on an archived field is refused ("restore the field first"). Order allocations are still written straight from the screen until FP-6, so FP-3 adds a trigger on `order_item_field_allocations` that refuses an archived field on INSERT or UPDATE. Existing records keep showing and saving an archived field otherwise (Sol R1 34).
- `src/pages/Fields.tsx` bulk delete becomes bulk archive (`ConfirmModal`, toast). Pickers for new work hide archived fields.
- Revoke DELETE on `fields` from `authenticated` and drop the `fields_delete` policy. 🔒 needs `I approve`.
**Done when:** a sales rep archives a field from the Fields list and it disappears from new-job, quote, field-app, blend-ticket and order pickers, while old records still open and save; a rep's restore is refused and an admin's works, with split, boundary and history intact; archiving a field with an open job is refused and names the job; a new job sent straight to the RPC for an archived field is refused; an archive and a new job at the same moment cannot both succeed; a direct `DELETE` on `fields` is refused; saving the field cannot un-archive it.
**Size / risk:** M. 🔒 DB. Not needed for the first February invoice (improvement 3), but it is one of Mason's five rules, so it is **due by the end of January** (Astra 3), built beside FP-5c.

### Wave 2: every billing path uses the per-line engine and the split group

#### FP-4 · 💲 Jobs carry the field's split snapshot
**Items:** 6, 7, 18 (job side).
**Approach.**
- `job_field_shares` gains `share_micro_pct`, `is_primary`, `pays_application`, `source` (`field_version` with version id, `office_override`, or `legacy`), and an exact-100% check per job field (Sol R2 5). `split_pct` stays, filled from `share_micro_pct`, until every reader moves in this PR (Sol R1 20); its `> 0` check becomes `>= 0` in this migration so a named 0% payer fits (Opus 4).
- **Jobs made from quotes** (Opus 7): `_create_job_from_quote_section_replay_impl_20261015` writes `job_fields` but no shares today; it sets each field's planned split from the resolver, like `save_job`.
- **Readers moved in this PR:** `get_job_billed_customers` / `get_jobs_billed_customers`, `resolve_line_split_vector`, Job Detail (including its browser-built default shares at `src/pages/JobDetail.tsx:1945,1981,3595`), the Jobs list (its direct `job_field_shares` read for the customer filter at `src/pages/Jobs.tsx:535`, and the billed-customer call at :664), the applicator job sheet print (`src/lib/applicatorSheetPrintData.ts:147,169`, which reads `job_field_shares` and `field_billing_defaults` directly), the loader worksheet (`src/lib/loaderWorksheetFetch.ts:99`) and the chemical application report (`src/lib/chemicalApplicationReportFetch.ts:144`).
- **Existing 5 rows** are kept, marked `legacy` (Sol R1 18). Conversion (Sol R3 4): live on 2026-11-08 every row is a single payer at 100% marked primary, so each becomes 100,000,000 micro-percent, primary, pays application. Any row that does not match a clean conversion at cutover (sum not exactly 100, no primary or two) is not converted; it is listed, and the job is **quarantined** (Sol R4 17): `transfer_job_to_invoice` refuses it with a plain message until the office re-saves its split through `save_job`, which clears the flag. Tested at cutover with a deliberately bad row in the harness.
- `save_job` sets a field's **planned split** from the resolver only when the field is first added to the job. Changing the date, notes or anything else never re-reads it; the office can re-plan with `refresh_split` or set an office override (§1a; Sol R2 6). Office edits are checked by the server (exact 100%, eligibility).
- **At invoicing, until FP-5a** (Sol R4 3; Opus 2 and improvement 1): the job-transfer engine is its own code with two paths (`20261120100000`: one invoice per owner at :428-731, or one invoice with `invoice_shares` from `field_billing_defaults` at :733-905), so rather than rewrite its ten or so split reads twice, FP-4 fixes its two live bugs (below) and adds a refusal of a job with an office override that differs from the field's split (the old engine reads `field_billing_defaults` at `20261120100000:438-439,852-854` and never `job_field_shares`, so it would ignore the override) ("use the new invoice screen"). Every other job's fields are still on their imported split, so it bills as it does now. FP-5a then replaces the engine.
- **Live bug fixed here first** (Opus 3, backlog item 7 now confirmed): when a job's fields have one payer who is not the job's customer (land billed 100% to a landlord), the transfer creates the invoice under the job's customer (`20261120100000:764`) while `invoice_shares` names the landlord at 100% (:865). The balance and aging land on the grower, while statements and year-end summaries show the landlord. FP-4 sets the invoice's customer to that single payer. **Ships inside FP-4** (Mason, in chat, 2026-11-08: "Fix it in FP-4"). Live check the same day: no field is billed wholly to someone other than its owner and no field invoice is mismatched, so nothing has been mis-billed yet. Until FP-4 lands, the office should not set up a field billed 100% to a landlord; FP-4's cutover inventory re-checks both counts before apply.
- **Second live bug, same function** (Astra 1, confirmed in code; backlog 37): on the shared-invoice path the transfer works out each payer's percentage **only over the fields that payer is on** (`20261120100000:839-862`, grouped by customer). A job on field A billed 100% to the grower and field B billed 100% to a landlord gives each of them 100%, so a $100 job bills $100 to each and the header becomes $200 (:878). Any job where the payers differ from field to field is over-billed in the same way. Live check 2026-11-08: no job has fields with different payers and no field invoice has shares above 100%, so nobody has been over-billed. The shared engine for location invoices (`derive_customer_shares_from_fields`) uses one denominator for all fields and is not affected. **Fix in FP-4, the same way as the landlord bug:** the old transfer refuses a job unless every field on it has the same payers at the same shares ("this job's fields are billed to different people; use the new invoice screen"); FP-5a then bills such jobs one line per field. Until FP-4 lands, the office should not put fields with different payers on one job; FP-1's cutover inventory re-checks the count.
- **Every existing job field gets a planned split** (Astra 8): the cutover inventory counts job fields with no share rows (0 of 5 live on 2026-11-08); any found get the resolver's split on the job's date, marked `legacy` with "no split was saved", and are listed.
- **The invoice's application date** (Astra 9): the old transfer stamps `jobs.job_date` (:768); FP-4 stamps the same billing date the guards use (§1a: the legal application date, else the job date), so the printed date and the split always match.
- **Billed outside the app** (Sol R4 13; Opus 15; Astra 28): a `job_external_billings` table and RPC copied from the existing `delivery_external_billings` pattern (`20261007150000`): admin only, reason required, retry key, RLS in the same migration; an admin can un-mark with a reason. Marking and invoicing take the same job-row lock; marking is refused while the job has an unposted draft or a posted invoice ("delete the draft first"); `transfer_job_to_invoice`, the FP-5a writer and every post entry point refuse a marked job, so it can never be billed twice. Blend tickets and standalone field invoices have no job to mark: work billed by hand there is simply not entered in the app, and FP-5b's cutover inventory lists open tickets on refused fields for the office to settle first.
- **`refresh_split` is built here** with its `job` mode (§1a).
- Direct writes on `job_field_shares` are revoked from `authenticated` here, once `save_job` is its only writer (rule 3). 🔒 needs `I approve`.
**Done when:** Job Detail, the Jobs list, the applicator sheet and the billed-customer lookups all show the same payers for each fixture job; a 70/30 office override survives a notes edit, a date change and a retried save; `refresh_split` on that job is logged with old and new versions; a field split change after the job leaves the job's planned split unchanged; a job applied while its field was 50/50, whose field became 60/40 after the application date, is refused by the old transfer with "use the new invoice screen" (in FP-5a its first draft stays 50/50, the split in force on the application date); a job planned at 50/50 whose field became 60/40 *before* its application date transfers at 60/40 (in FP-5a its draft is 60/40 with a "field split changed" note); a job with a 70/30 office override on a 50/50 field is refused by the old transfer (in FP-5a it drafts at 70/30); a job on a field billed 100% to a landlord invoices the landlord's account, and the landlord's balance shows it; a job with one field billed to the grower and one to a landlord is refused by the old transfer (and in FP-5a bills each its own field, totalling the job price once); a rescheduled job's invoice shows its legal application date; a job with a draft cannot be marked billed outside the app; a job made from a quote shows its planned split; a job marked billed outside the app cannot be transferred; a retried `save_job` with the same key changes nothing; a direct write to `job_field_shares` is refused.
**Size / risk:** M–L. 💲🔒 DB + screens.

#### FP-5a · 💲 One field invoice engine, with line-by-line changes before posting (February-critical)
**Items:** 6, 8, 12, 27, 28, 29; Mason's question-2 answer.
**Approach.**
- **Field-application invoices and job invoices both use the per-line engine** (Sol R2 1, improvement 4). It already accepts a source job (`_save_field_app_split_invoice_impl(p_billing_set_id, p_source_job_id, ...)`, `20261204100000:3629`). `transfer_job_to_invoice` creates a per-line draft from the job's snapshot instead of a location-engine invoice.
- `resolve_line_split_vector` gains the billing date, returns one payer list per field (§1a), and reads, in order: job office override, or a `legacy` job share that differs from the field (Astra 7) → field split version on the billing date → owner (Sol R1 22; R3 7). The browser preview calls the same function with the same inputs.
- The writer works out each field's acres by the §1a order before checking them (Sol R3 6); the two draft tables and the refresh log (§1a draft storage) are added here.
- **Draft line splits (Mason's answer):** every line starts from the snapshot under the §1a defaults; before posting, the office can set any line's percentages and per-line price, within eligible payers. The server checks each line (exact 100%, a positive line primary, eligibility), keeps a "changed from the field split" mark, and never touches the field's saved split.
- **Posting** snapshots each line's split and provenance (§1a). Unpost and repost start from the last posted split.
- **Old location-engine records, in this same package** (Sol R2 15, improvement 2): posted invoices stay as they are, PDFs unchanged. Before the cutover, the unposted location-engine drafts (cutover inventory, rule 6; 1 live on 2026-11-08) are converted to per-line drafts **cent for cent** (Sol R3 13): each existing payer invoice's own lines become per-line lines billed 100% to that payer at their existing cents, marked `legacy_fixed` (Sol R4 11). A line keeps a field only when the old record names exactly one field for it; otherwise its field is left blank, never guessed (Astra 29), and a blank-field line can be re-weighted or deleted but not refreshed from a field. A save never re-prices or re-splits a `legacy_fixed` line: its cents, payer and field stay as converted through every save, unpost and post, until the office deliberately refreshes it (which then follows the normal rules). Proven by saving, posting, unposting and reposting a converted draft and comparing every payer's cents. Any draft whose stored lines do not add up to its stored payer totals, or a job-transfer draft with **one invoice carrying several `invoice_shares`** (the shared-header path, `20261120100000:733-905`, which has no per-payer invoices to convert; Astra focused review 11), is **not converted**: the cutover stops until the office deletes it and re-creates it on the new screen (Astra focused review 12), so no draft is left that neither screen can fix. Live on 2026-11-08: the 1 unposted field invoice has one share. **Job-transfer drafts too** (Opus 2): unposted drafts created by the job-transfer engine are in the same inventory and convert the same way (each payer invoice's lines at their own cents). After that, neither the location engine nor the job-transfer engine can create or edit invoices.
  - **Proof is more than payer totals** (Astra 31): for every converted draft, compare before and after: invoice numbers, payer, each line's quantity, unit, price, cents and cost, due date, season, application date, and the links (`jobs.invoice_id`, the billing set, source job). Any difference holds the draft back.
  - **Two more record kinds** (Astra 30): per-line drafts that already exist (0 live today; the inventory re-counts) get their source and payer rows filled from their current `invoice_line_shares`, marked hand-edited, so nothing changes. An old **posted** location invoice that is unposted after cutover is converted the same way at the moment of unposting, inside the unpost, so it can still be corrected.
  - **One-step cutover** (Astra 32): the migration that converts drafts also replaces the old engines' functions with ones that refuse, inside one transaction holding the invoice-number and field locks, so no old-style draft can appear after the count. The new save RPC requires the stable line ids and draft revision, so an old browser tab's save is refused with "reload the page". Order: apply the migration, deploy the screens, re-run the inventory read-only and confirm 0 unconverted drafts.
- **`refresh_split`** gains its `invoice_draft` mode here (§1a).
- **The posting switch** (Opus 14): `split_field_invoice_posting_enabled` is checked inside every posting entry point (single post, `post_invoice_group`, and the batch posting in `src/lib/invoiceBatchPosting.ts` through those RPCs). It is separate from the existing `per_line_split_billing_enabled`, which says the per-line engine may be used at all; the new one says invoices with more than one payer may be posted. "More than one payer" is counted on the **whole billing set**, never on the one payer invoice being posted (Astra 25), because each payer's invoice holds only that payer.
- **Invoice sets move together** (Astra 24): save, refresh, unpost and delete lock the whole billing set and are refused if any payer invoice in it is paid, credited or voided ("this set has a paid invoice; issue a credit instead"). Posting is all-or-nothing per set.
- **Direct writes** on `field_app_location_shares` and `invoice_shares` are revoked from `authenticated` here (rule 3). 🔒 needs `I approve`.
- **Proof with Mason, no duplicate bills** (Sol R1 25; R3 14): once the preview is built and passes the fixtures, and before the first real split invoice, Mason compares the engine's *preview* (read-only) for one real landlord field with his own sheet; then he creates the one real invoice. This is the last step of FP-5a, not a prerequisite.
**Done when:**
- For every fixture, preview and saved draft give the expected payers and cents per line kind; the 60/40-no-application field bills the landlord 40% of chemicals and 0% of application.
- On a draft, changing one chemical line to 80/20 and another to 100/0 posts exactly those shares while the field stays 60/40; a line totalling 90%, or adding a payer not on the field, is refused.
- A job invoice is created as a per-line draft with the job's override split.
- With dates pinned (Astra 11): an invoice for work on Nov 1, posted at 60/40, then the field changed to 70/30 starting Nov 10. Unposting and reposting gives 60/40; `refresh_split` also gives 60/40, because 70/30 starts after the work, and the log records "no change". A draft for work on Nov 12 refreshes to 70/30. A correction dated Nov 1 or earlier (backdating is allowed from FP-1, Q7) makes `refresh_split` give the corrected split; a hand edit on the line also works.
- **Job transfer parity** (Astra 16): fixtures prove a job moves into the per-line engine with the same products, units, quantities, quoted prices and costs as the old transfer; a customer-supplied chemical stays at $0 price and $0 cost, pinned so it is never re-priced.
- **Single-payer money journey before the old engine retires** (Astra 5): a single-payer field-app invoice and a single-payer job invoice made by the new engine pass the FP-5c ledger journey (PDF, balance, aging, a payment, statement, a credit) in the harness, because single-payer invoices post through the new writer from day one. FP-5c then covers sets with more than one payer.
- A paid payer invoice in a two-payer set blocks refresh, unpost and delete of the set; posting one payer invoice of a two-payer set directly, with the posting switch off, is refused.
- Two users on one draft: the second save, made from an older screen, is refused.
- An application line on a field where nobody pays application is refused; changing a chemical line to an application line resets it to the application defaults and says so.
- An old location-engine draft opens as a per-line draft with the same payers and cents, cent for cent per payer.
- 1 gallon at $10.01 over two equal fields bills $10.01 in total ($5.01 + $5.00), not $10.02.
- A product applied over two fields with different primaries becomes two lines, one per field, each giving its leftover cent to its own field's primary; each line's source is stored with field, version and acres.
- A location with no applied acres bills the job's acres; each payer invoice's Discount Earned still shows as today and does not change its total.
- Re-saving a draft keeps every line id.
- Re-saving a draft with a hand-edited line keeps the edit; a retried save or `transfer_job_to_invoice` with the same key creates nothing new.
- `refresh_split` on one line of a two-line draft changes only that line and returns its before-and-after; a skipped hand-edited line keeps its payers and can still be re-weighted.
- On a product over field A (payers A/B) and field B (payers A/C), an edit giving C 50% changes only field B's line; C gets nothing on field A's line.
- Two fields billed wholly to different payers at different prices bill each payer their own price × their own quantity; two payers on different price tiers on one field each pay their own tier price.
- With `split_field_invoice_posting_enabled` off, a two-payer invoice drafts and previews but cannot post; a single-payer invoice posts.
- Unposting and re-saving a posted two-field invoice leaves its posted contribution snapshot intact.
- Mason's preview matches his sheet before he saves.
**Size / risk:** L. 💲🔒 DB + screens. The largest package; may split into an engine PR and a screen PR if review needs it.

#### FP-5c · 💲 Split invoices all the way through: PDFs, balances, payments, statements, credits
**Items:** new from Sol R2 22–24.
**Approach.** No new engine; prove and fix the paths after posting, using one **ledger journey** fixture (improvement 5): a split field-application invoice → posted payer invoices → each payer's PDF and invoice detail → customer balance and aging → a payment applied to one payer → that payer's statement → a return credit and a void. Fix what does not hold. Inventory every reader first: `InvoiceDetail.tsx`, `Invoices.tsx`, `FieldInvoicesPostedPanel.tsx`, `FieldInvoicesUnpostedPanel.tsx`, `src/lib/fieldInvoiceList.ts`, `src/lib/invoiceBatchPosting.ts`, `src/lib/splitGroupPostChecks.ts`, `supabase/functions/_shared/pdf/invoicePdf.ts`, statements, AR aging, and commission records (the field-app path stamps a commission record per invoice). Commission on split invoices (Astra 21): commission is worked out **by the existing formula** (on chemical profit, with the existing rep split), never on the invoice amount. Each payer invoice credits the job's rep, or the invoice's salesperson when there is no job (Sol R3 21), for that payer invoice's own profit; per-payer sales reports are foundation 18.2.
**Done when:** for the journey fixture, each payer's PDF shows only their lines and amounts (the landlord's PDF shows no application charge); each payer's balance and statement shows only their share; a payment to one payer touches only that payer; a return credit reverses the original posted allocation even after the field's split changed; two half-returns of a 1¢ line refund 1¢ in total; the commission across all payer invoices equals the commission the same work earns as one unsplit invoice, for both a job-sourced and a standalone invoice, and unposting and reposting does not add a second commission record; a set with one paid and one unpaid payer invoice behaves as FP-5a says. **February go/no-go** (R3 improvement 5): Mason's first real split field-application invoice is posted through the app, both payer PDFs are checked against his sheet, and both balances show the right amounts; the first real payment is checked when it arrives.
**Size / risk:** M. 💲 Mostly screens and reads; DB only if a reader is wrong. February-critical.

#### FP-5b · 💲 Blend-ticket invoices on the same engine
**Items:** 9, 12.
**Approach.** `blend_ticket_fields.customer_id` exists per field but billing ignores it today (Opus 16); it stays ignored for billing, and the ticket screen warns when it differs from the field's split, since the field split is the one source of who pays. `create_invoice_from_blend_ticket` creates a per-line draft (billing date and acres per §1a) instead of reading `derive_customer_shares_from_fields`, so blend tickets get the same line changes before posting. `derive_customer_shares_from_fields` then has no billing callers; keep it for display only with a date input, or remove it with its browser preview call. Each blend-ticket field can be billed once, enforced by a unique link (Astra 27).
**Done when:** a blend ticket on each fixture field drafts the expected payers and cents; invoicing the same ticket twice from two screens creates one draft; a line can be changed before posting; blend-ticket billing no longer reads `field_billing_defaults` (the order path still does until FP-6; the all-paths check is in FP-7, Sol R3 16).
**Size / risk:** M. 💲 DB. After FP-5a; not on the February path unless blend tickets are billed before then.

#### FP-6 · 💲 Orders and deliveries read the split group (after 2026-12-15)
**Items:** 10, 15.
**Approach.**
- **Existing orders** (Astra focused review 14): field-linked order lines made on the old screens are test records (Mason); the cutover inventory requires 0 real ones (0 ever on 2026-11-08) and stops otherwise, so remaining quantities start from a clean slate.
- Re-read Taha's live code first. Reconcile **per order line** (Sol R1 28): a line with field allocations bills by the field split; a line without follows his card or `order_item_shares`.
- New RPC `set_order_line_field_allocations(p_order_item_id, p_allocations, p_idempotency_key)` replaces the direct writes at `OrderDetail.tsx:1005` and :1022. It checks the line belongs to an editable order, no field twice, acres positive, no archived field added, and refuses changes once the line is delivered or invoiced (Sol R1 31). Direct writes on `order_item_field_allocations` are revoked here (rule 3). 🔒 needs `I approve`.
- **Quantity and cents per field** (Sol R2 19; R3 18; Astra 47): allocated acres are **weights**: a field-allocated line is assigned whole to its fields in proportion to their acres, so "fully covered" means every allocation has positive acres and the line has at least one, and a line can never be half field-split and half on Taha's card. The line's quantity and cents are split across its fields by those weights (§1a math).
- **Partial deliveries** (Astra 48): each delivery of a field-allocated line is billed as its own piece, dated by that delivery, with its own quantity, and the line keeps a remaining quantity so it is never billed past 100%. If Taha's live delivery code cannot give per-delivery quantities, partial delivery of a field-allocated line is refused until it can.
- **Mixed orders** (Astra 49): the field lines and the card lines are billed by their own writers into separate invoices; each writer takes only its own lines, under the order lock, and records which order lines it billed, so neither can bill the whole order. The exact hand-off is designed against Taha's final code (step 1 above) and written into FP-6's own contract before building.
- **Planned split when the allocation is saved** (Sol R2 20; R3 17): delivery and invoice dates do not exist yet, so the allocation stores the field split **as of the day it is saved** (Central), with that date, for display and audit. Storage (Sol R4 16): a new table `order_item_field_allocation_payers` (allocation, customer, micro-percent, primary, pays-application, source `field_version` with version id or `office_override`, split date), exact 100% per allocation with one primary, RLS, policies and grants in the same migration, written only by `set_order_line_field_allocations`. The **first invoice draft** resolves the split in force on the billing date (delivery or invoice date), unless the allocation carries an office override, and notes any difference from the planned split; after that the draft is frozen until `refresh_split` (§1a planned-then-draft rule).
- **Leftover cent on the main customer at 0%** (Sol R3 19): re-read Taha's live allocator and test a 1¢ line where the main payer is at 0% on both paths; if his rule differs from §1a in that case, raise it with Mason and Taha before building rather than leaving two rules.
- Both the **delivery** invoice and the **direct order invoice** produce draft field-split invoices with line changes before posting (Sol R1 29; R2 18, R2 1), dated per §1a; retries return the first result.
**Done when:** an order with one line on a 50/50 field and one on Taha's card produces the right invoices per payer, cents exact, both through delivery and through a direct order invoice; a line spread over two differently split fields bills each field's payers its part; a retried delivery creates nothing new; changing allocations after delivery is refused; an allocation saved Monday at 50/50, a field change to 60/40 on Tuesday and delivery Wednesday give a first draft at 60/40 with a "field split changed" note; a later field change does not touch that draft until `refresh_split`; a partly allocated line is refused.
**Size / risk:** M–L. 💲🔒 DB + screen. Shared files with Taha (`OrderDetail.tsx`, delivery functions).

### Wave 3: final check

#### FP-7 · 🔒 Final boundary check
**Items:** 1, 17, 31, 33.
**Approach.**
- Verify, table by table, that every payer-bearing table has no direct write left (the closures happened in FP-1, FP-3, FP-4, FP-5a and FP-6; rule 3). Taha's `order_shares` and `order_item_shares` are his decision, raised as a comment.
- `anon` SELECT revoked only where a table-by-table check shows nothing legitimate reads it (Sol R1 33).
- Replace `field_billing_defaults` with a read-only, narrow current-split function for applicators that applies `_can_see_field` itself (SECURITY DEFINER, one field at a time), then drop the table copy once nothing else reads it (Sol R2 28).
- Future-split cancellation is in FP-1 (Astra 10).
- Check that no billing function on any path reads `field_billing_defaults` directly.
- Run the fixture and ledger-journey tests in CI (the KI-84 smoke chain is fixed in FP-1, below).
- Update the roadmap, DECISION_LOG, KNOWN_ISSUES (KI-16, KI-76) and the field part of `docs/workflows/QUOTE_TO_DELIVERY.md`.
**Done when:** the table-by-table check finds no direct write; an applicator still sees exactly their assigned fields' current splits and nothing else; a future-dated split bills correctly on both sides of its date on every path; no old writer remains; CI runs the fixtures.
**Size / risk:** S–M. 🔒 DB.

---

## 3. How this relates to Taha's work

- **One line:** Taha's open PRs #1524 and #1534 add a per-payer Bill Split for chemical sales (an order card plus per-line payers in `order_item_shares`, stored as percent); this plan does not touch them, and they already let a field allocation win over the card. #1587 shares `OrderDetail.tsx` only; #1576 changes who may unpost field invoices and needs no change from us.
- The two models meet on an order line with a field allocation. FP-6 reconciles them per line against his final, live code, after 2026-12-15.
- Shared choices that match his: inactive customers cannot be added as payers; leftover cents go to the main payer (Q4); his allocator floors the other payers and gives the main customer the rest. One case may differ: when the main payer is at 0% on a line, §1a gives the cent to the largest payer; FP-6 checks his live rule for that case before claiming they match (Sol R3 19).

## 4. Order and timeline

| Order | Package | Needs first | Target | February path |
|---|---|---|---|---|
| 1 | FP-1 split group with history | `I approve` (grant, foreign key) | November | yes |
| 1 (parallel) | FP-2 billable acres | nothing | November | yes |
| 2 | FP-4 jobs carry the snapshot | FP-1, FP-2; PR #1650 landed; `I approve` (grant) | early December | yes |
| 3 | FP-5a one engine + line changes + old drafts | FP-4; `I approve` (grants). Ends with Mason's 20-minute preview check | December–early January | yes |
| 4 | FP-5c PDFs, balances, payments, statements, credits | FP-5a | January | yes |
| any time | FP-3 archive fields | `I approve` (grant) | by end of January (Astra 3) | not for the first invoice, but due before spring work |
| 5 | FP-5b blend tickets | FP-5a | January–February | only if blend tickets bill before February |
| 6 | FP-6 orders and deliveries | Taha's #1524 and #1534 live (after 2026-12-15) | January–February | no |
| 7 | FP-7 final check | all above | February | no |

**9 PRs in 3 waves** (the roadmap guessed 5–6; history, line editing on every path, and the end-to-end money proof add the rest). **February path: FP-1, FP-2, FP-4, FP-5a, FP-5c** (5 PRs, all database and money work under Sol). Risk: FP-5a is large and lands near the holidays. **Fallbacks** (Sol R3 20; R4 12, 13):
- *If FP-5a slips past February:* the old screens may be used for real billing only on fields whose split has not changed since FP-1 and where every payer pays every charge (the office checks the field's split history first; the old screens do not check it). Other fields are billed by hand and their jobs marked "billed outside the app" (FP-4), so they cannot be billed twice later.
- *If FP-5a lands but FP-5c slips:* the location engine is gone by then, so it is not the fallback. FP-5a ships a database setting, `split_field_invoice_posting_enabled`, off by default: single-payer field invoices post normally, while invoices with more than one payer can be drafted and previewed but not posted until FP-5c passes and the setting is turned on. Hand billing plus the "billed outside the app" mark covers anything urgent.

## 5. Mason's decisions (2026-11-08)

All five answered in chat: question 2 in his own words, and "I agree with all rest" for 1, 3, 4 and 5. Recorded in `docs/manual/DECISION_LOG.md` (2026-11-08 entries).

1. **Which customers may a field split bill? (KI-76)** **DECIDED:** only payers saved on that field's split (or an office change of their shares on one job); to bill someone else, the office adds them to the field's split first (any active customer). A line changed before posting may re-weight these payers (including down to 0%) but not add someone outside them.
2. **Can a payer share a field but not pay the application charge?** **DECIDED** (Mason: "field level splits always auto populate based on field but we need to be able to adjust the split before posting invoice and change line items at different percentages and shares"): each payer has "pays application" yes/no on the field; every invoice line starts from the field's split; before posting, the office can set any line to its own percentages, on every field-billing path (FP-5a, FP-5b, FP-6).
3. **When a field's split changes, which work uses the new split?** **DECIDED:** the office picks the start date, any day, from FP-1 on (Q7); work with a billing date on or after it uses it; posted invoices never change; an unposted draft keeps its split until someone presses "refresh split", which is logged.
4. **Who gets the extra penny?** **DECIDED:** the primary payer, the same as Taha's chemical-sale split. If the primary is at 0% on a line, the largest payer on that line (§1a).
5. **Who may archive a field?** **DECIDED:** admins and sales reps archive; blocked while the field has open or unbilled work; only admins restore.

No new business questions came out of the second review; the edge cases it raised are settled in §1a as technical rules that follow from these answers.

**Two more, from the Astra review, answered by Mason in chat on 2026-11-08:**

6. **Fuel surcharge and flat fees: who pays them by default?** (Astra 20) **DECIDED** (Mason: "fuel surcharge follows who pays application"): a payer excused from application also starts at 0% on fuel surcharge lines. Flat fees were not covered by his answer; the plan uses the recommended default, the full field split, until he says otherwise. The office can change any line before posting.
7. **May the office pick a split's start date from the start, or only today until February?** (Astra 3) **DECIDED** (Mason: "no i want split fields now"): any start date, past or future, from FP-1. The old invoice screens are not made date-aware; Mason keeps them on for testing only until the new screens replace them (no real orders or field invoices entered there), and each cutover inventory checks that. Mason also confirmed field application invoices start in February and the feature is used from about March (2026-11-08), so that refusal costs nothing in practice.

**Three more, after the industry comparison, answered by Mason in chat on 2026-11-08 (evening):** Q8 two shares per payer (application and product), Q9 "shared with" on each payer's invoice, Q10 posted field-application invoices editable until money is applied or the month is closed. Details and what they change: §0.

## 6. Sol review record

Both rounds: `gpt-6-sol`, high, advisory only (not a ship gate), given the plan docs and code excerpts inline. Full outputs kept in the session scratchpad.

### Round 1 (2026-11-08): 35 findings (5 BLOCKER, 25 HIGH, 5 MED)

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | HIGH | Cited migration bodies (`20261120100000`, `20261204100000`) may not be on `main` or live | **Refuted:** both files are on `main` at `5a921026e` (`20261204100000` landed in #1579), and the live migration ledger lists `20261204100000` as applied (read-only query). The project stamps migration files ahead of the calendar. |
| 2 | MED | Backlog mixes payer sources, snapshots and acre allocations | Backlog items 1 and 3 separate them; FP-7 checks per table |
| 3 | BLOCKER | A future-dated version copied into `field_billing_defaults` bills early | FP-1: no future dates until FP-7 (superseded by Q7: any date from FP-1, made safe by the FP-1 changeover rule (later replaced by Mason's testing-only decision)) |
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

### Round 3 (2026-11-08): 22 findings (5 BLOCKER, 14 HIGH, 3 MED) and 5 improvements

Focus: does the plan agree with itself, can it be built as written, is the February path complete. 21 accepted, 1 refuted. Checked against code and live data first: today's writer refuses a field with no applied acres before any fallback (`20261204100000:3772-3775`); the per-line engine has no discount kind; every live field split has exactly one primary.

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | BLOCKER | "Somebody pays application" passes with a 0% payer | §1a and FP-1: application payers must hold more than 0% |
| 2 | BLOCKER | Legacy splits have no primary, so backfill would stop | **Refuted:** `field_billing_defaults.is_primary` exists and live every split field has exactly one primary totalling exactly 100 (read-only query); the stop rule stays for safety |
| 3 | BLOCKER | Backdated versions change old writers' splits before they move | FP-1: `effective_from` is today only until FP-6 (superseded by Q7) |
| 4 | HIGH | Legacy job shares have no conversion rule | FP-4: live rows are all 100% single primary; others listed, not converted |
| 5 | HIGH | Job planned under 50/50, done after 60/40 contradicts Q3 | §1a planned-then-draft rule; FP-4 test |
| 6 | HIGH | Writer refuses before the job-acres fallback | §1a acres; FP-5a |
| 7 | BLOCKER | Resolver blends fields, so per-field primaries can't get their cent | §1a: one payer list per field; FP-5a |
| 8 | HIGH | No schema for field contributions | §1a draft storage: `field_app_billing_line_contributions` |
| 9 | HIGH | No durable home for draft edits | §1a: `field_app_billing_line_payers` with `hand_edited` |
| 10 | HIGH | No discount line kind | §1a; FP-5a adds `discount` |
| 11 | HIGH | Re-weighting a saved payer could be refused | §1a: each record's eligible set is its own snapshot |
| 12 | HIGH | `refresh_split` inputs undefined | §1a: typed source, line list, reset option, summary |
| 13 | HIGH | Old-draft conversion could move cents | FP-5a: cent-for-cent per payer |
| 14 | HIGH | Mason's preview listed as a prerequisite of the package that builds it | FP-5a last step; §4 |
| 15 | HIGH | Changed existing RPCs' retry keys not stated | Rule 2 |
| 16 | HIGH | FP-5b test can't pass before FP-6 | FP-5b scoped; global check in FP-7 |
| 17 | HIGH | Order allocation snapshot contradicts Q3 | §1a planned-then-draft; FP-6 |
| 18 | HIGH | Partly allocated line remainder bypasses Taha's card | FP-6: full coverage required |
| 19 | MED | "Same rule as Taha" not true at 0% main payer | §3 and FP-6 check his live rule |
| 20 | BLOCKER | Fallback used an engine that can't do the application rule | §4 fallback replaced |
| 21 | MED | Commission without a job | FP-5c |
| 22 | MED | Field name edit would add a split version | FP-1: unchanged payers write nothing |

Improvements taken: 1 (per-RPC contract, rule 2), 2 (cutover table, rule 6), 3 (tests added in FP-1, FP-4, FP-6), 4 (canonical line cents, §1a), 5 (February go/no-go, FP-5c).

### Round 4 (2026-11-08): 18 new findings (3 BLOCKER, 14 HIGH, 1 LOW)

A convergence check: only new problems, or round-3 fixes that were wrong or incomplete. All 18 accepted.

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | BLOCKER | Draft payers stored per line, but lines split per field | §1a: draft payers stored per line *and field* |
| 2 | BLOCKER | Old drafts still re-read the field split until FP-5a | FP-1 transition guard (a): split change refused while the field is on an open old-engine draft |
| 3 | HIGH | FP-4 promised dated job invoices while the old engine still used the copy | FP-4: `transfer_job_to_invoice` resolves the billing date from FP-4 on |
| 4 | HIGH | Contributions only cite a field version, not overrides | §1a: source type and full payer copy |
| 5 | HIGH | Posted field-level evidence lost on unpost | §1a: append-only `field_app_billing_contribution_snapshots` |
| 6 | HIGH | New FP-5a tables lacked RLS | §1a: same-migration RLS, RPC-only writes |
| 7 | HIGH | Refresh replaced eligibility for skipped lines | §1a: only refreshed lines and fields change |
| 8 | HIGH | Refresh had no field target or override rule | §1a: `p_field_ids`, `p_reset_overrides` |
| 9 | HIGH | A draft could add a payer without refresh | §1a: adding needs field split + logged refresh (or a job/allocation override) |
| 10 | HIGH | Multi-field rule contradicted per-payer prices | §1a: split quantity, not cents, when prices differ |
| 11 | HIGH | Converted legacy lines could be re-priced on save | FP-5a: `legacy_fixed` lines never re-priced until refreshed |
| 12 | BLOCKER | Fallback after FP-5a pointed to a retired engine | §4: posting setting off until FP-5c |
| 13 | HIGH | Fallback restriction not enforced; hand-billed work could bill twice | FP-1 guard (b); FP-4 "billed outside the app" mark |
| 14 | HIGH | Future dates before the copy is gone | FP-7: only after the copy is replaced |
| 15 | HIGH | Archive columns writable directly | FP-3 trigger; revoke direct writes if none remain |
| 16 | HIGH | No storage for an order allocation's planned split | FP-6: `order_item_field_allocation_payers` |
| 17 | HIGH | Unconvertible job shares still invoiceable | FP-4 quarantine |
| 18 | LOW | Cutover table missing FP-5b | Rule 6 table |

### Independent Opus review (2026-11-08): 16 findings (5 HIGH, 6 MED, 5 LOW) and 5 improvements

Mason asked for a review by an independent Claude Opus agent. Unlike the Sol rounds, it read the code itself (read-only) and spot-checked the plan's citations. All 16 accepted. Checked before folding in: `per_line_split_billing_enabled` is `true` live; the job transfer creates the invoice under the job's customer (`20261120100000:764`) while naming the landlord in `invoice_shares` (:865); re-saves delete every billing line (`20261204100000:3935`); four older share tables check `> 0`.

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | HIGH | The live per-line engine was outside the transition guards | FP-1: guards (a) and (b) cover all three engines |
| 2 | HIGH | Job invoices have their own engine, not the location engine | Named everywhere; FP-4 refuses changed-split jobs instead of rewriting it; FP-5a converts its drafts |
| 3 | HIGH | Landlord-only field bills the grower's account (live bug) | Backlog 7 confirmed; FP-4 fixes the invoice customer first |
| 4 | HIGH | 0% payers clash with `> 0` checks | FP-1 copy leaves 0% out, Field Setup reads versions; FP-4 relaxes `job_field_shares` |
| 5 | HIGH | Billing line ids change on every save | §1a: stable line ids; snapshot without a line key |
| 6 | MED | Billing-date columns did not exist | §1a: exact columns (legal application date; per-field `applied_at`) |
| 7 | MED | Quote-to-job writer missed; conflicts with acre check | FP-2 writes blank, not 0; FP-4 sets its planned split |
| 8 | MED | "Until FP-6" vs "until FP-7" for dates | One date everywhere: FP-7; DECISION_LOG line added (superseded by Q7) |
| 9 | MED | No package built `refresh_split` | FP-4 job, FP-5a draft, FP-6 order line |
| 10 | MED | Discount could push a payer below zero | §1a: discount in proportion to charges; refuse below zero |
| 11 | MED | Readers of `field_billing_defaults` and field price not listed | FP-1 list and owner per package; migration stops on a live price |
| 12 | LOW | Per-payer `notes` dropped | FP-1 carries it |
| 13 | LOW | Three backlog citations drifted | Backlog 10, 19, 34 corrected |
| 14 | LOW | Posting switch entry points not named | FP-5a |
| 15 | LOW | "Billed outside the app" had no storage | FP-4: `job_external_billings`, copied from deliveries |
| 16 | LOW | Blend-ticket field customer ignored | FP-5b: stays ignored, screen warns |

Improvements taken: 1 (FP-4 refuses instead of rewriting the old transfer), 3 (extend `invoice_line_share_snapshots`), 4 (`order_line` refresh with FP-6), 5 (job billing date = legal application date). Not taken: 2 (switch the per-line engine off until FP-5a), because changing a live setting is a live data change and the guards in FP-1 cover the same risk.

### Astra review (2026-11-08, `gpt-6-astra`, max effort, blind): 54 findings (5 BLOCKER, 39 HIGH, 8 MED, 2 LOW)

Astra saw §1–5, the backlog and code excerpts, but not this review history. Each finding was checked against the code and live data (read-only) before it was taken. Verdict: the design is right ("dated field versions, explicit overrides, frozen drafts, database allocation and immutable posting evidence"), with one simplification taken: **one field per billing line**.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | BLOCKER | Job with fields billed to different payers is billed twice over | **Confirmed in code** (`20261120100000:839-878`); 0 live jobs affected. FP-4 refuses it; backlog 37 |
| 2 | BLOCKER | A split saved today re-bills older unbilled work at the new split | Taken: FP-1 changeover rule (later replaced by Mason's testing-only decision), old writers refuse any changed field; orders: split change refused while a field has uninvoiced allocations |
| 3 | BLOCKER | February path leaves out chosen start dates and archiving | Taken: FP-3 due end of January; Mason chose any start date from FP-1 (Q7), made safe by the FP-1 changeover rule (later replaced by Mason's testing-only decision) |
| 4 | BLOCKER | One price per line and payer cannot hold two fields' prices | **Confirmed** (`20260720213000:83-115`, unique line+customer). §1a: one field per billing line |
| 5 | BLOCKER | Money journey proved only after single-payer invoices already post through the new engine | Taken: single-payer ledger journey in FP-5a's Done when |
| 6 | HIGH | Changing the shared allocator changes other callers | Taken: new allocator function; old one untouched |
| 7 | HIGH | Legacy job shares lose to the field version | Taken: legacy that differs counts as an override |
| 8 | HIGH | Job fields with no share rows | Taken: FP-4 inventory and backfill (0 of 5 live) |
| 9 | HIGH | Old transfer prints the scheduled date | **Confirmed** (:768). FP-4 stamps the billing date |
| 10 | HIGH | A scheduled split cannot be cancelled | Taken: FP-7 compares against the chosen date |
| 11 | HIGH | Refresh test contradicted the billing-date rule | **Confirmed.** FP-5a test rewritten with pinned dates |
| 12 | HIGH | Q1's job exception narrowed | Wording: "an office change of their shares on one job"; adding a payer still goes through the field (§5 Q1) |
| 13 | MED | Allocation override checked against a date that does not exist yet | Taken: checked on the day saved; then stands |
| 14 | HIGH | New line, changed field or kind not defined | Taken: §1a draft edits rule |
| 15 | HIGH | Tier prices per payer missing | **Confirmed** (`base_price_source = 'tier'`). §1a per-payer prices |
| 16 | HIGH | Transfer parity (customer-supplied at $0) | Taken: FP-5a fixtures |
| 17 | HIGH | Discount basis vs acre split | Taken more simply: no discount line kind at all; field invoices only have per-payer Discount Earned, display-only |
| 18 | MED | Full discount can be refused by rounding | Moot: no discount line to split |
| 19 | HIGH | Refusing a split where nobody pays application | Taken: allowed; the application line is refused instead |
| 20 | MED | Fuel and flat fees following "pays application" is a business choice | Mason: fuel surcharge follows application (Q6) |
| 21 | HIGH | Commission test used the invoice amount | Taken: existing profit formula; FP-5c test rewritten |
| 22 | HIGH | Posted snapshot not complete | Taken: full posted record with revision |
| 23 | HIGH | Unpost lets an issued invoice change | Partly: unpost is the existing correction step; each post is a kept revision |
| 24 | HIGH | Invoice-set lifecycle unproven | Taken: set lock; paid/credited/voided child blocks |
| 25 | HIGH | Posting switch counted per child invoice | Taken: counted on the billing set |
| 26 | HIGH | Partial returns can over-refund | Taken: remaining refundable per posted line and payer |
| 27 | HIGH | No once-only billing per source across screens | Taken: §1a rule; FP-5b, FP-6 |
| 28 | HIGH | External mark with a draft open | Taken: refused; same lock; every post refuses |
| 29 | HIGH | Old lines' field guessed | Taken: blank field unless the record names one |
| 30 | HIGH | Existing per-line drafts and later-unposted old invoices | Taken: both converted |
| 31 | HIGH | Conversion checked only payer totals | Taken: full comparison |
| 32 | HIGH | No one-step cutover | Taken: same-transaction cutover; old tabs refused |
| 33 | HIGH | Split change and new draft can race | Taken: one lock order |
| 34 | HIGH | Second user's older screen overwrites | Taken: draft revision |
| 35 | HIGH | Refresh log cannot rebuild a reset hand edit | Taken: before/after log table |
| 36 | MED | Old version can gain a payer by insert | Taken: inserts only in the creating transaction |
| 37 | MED | Empty versions and blank shares | Taken: NOT NULL; check on the version row |
| 38 | HIGH | Old signatures and helpers stay callable | Taken: rule 2 |
| 39 | HIGH | Ids not checked against the record | Taken: rule 2 |
| 40 | MED | Replay after state changes | Taken: rule 2 |
| 41 | MED | `save_field` does not save measured/override acres | **Refuted**: they have their own RPCs (`set_field_boundary`, `set_field_override_acres`) |
| 42 | MED | Zero acres falls through to planned | Taken: §1a |
| 43 | HIGH | Archive allowed with delivered-but-unbilled work | Taken: FP-3 |
| 44 | HIGH | Reopening work on an archived field | Taken: FP-3 |
| 45 | HIGH | Direct allocation writes bypass the archive | Taken: FP-3 trigger |
| 46 | MED | Existing inactive fields | Taken: FP-3 (0 live) |
| 47 | HIGH | "Fully covered" had no measure | Taken: acres are weights over the whole line |
| 48 | HIGH | Partial deliveries straddle a split change | Taken: per-delivery pieces, or refused |
| 49 | HIGH | Mixed-order hand-off undefined | Taken: each writer bills only its lines; detail in FP-6's contract |
| 50 | HIGH | Test chain fixed too late | Taken: KI-84 moved to FP-1 |
| 51 | LOW | Wrong precision claim for `numeric(9,6)` | **Confirmed**; backlog 4 corrected |
| 52 | LOW | Allocator overflow at the bigint edge | Taken: validated range, numeric until the end |
| 53 | MED | Field primary vs line primary for leftovers | Taken: one line primary for cents, quantity and acres |
| 54 | MED | `NOT VALID` still blocks updates to old rows | Taken: FP-2 fixes zeros first |

Simplifications taken: one field per billing line (removes the separate per-field contribution grain). Also taken: no new discount line kind (the code has none to keep). Not taken: dropping `legacy_fixed` in favour of reviewed hand conversion (it is what makes the conversion reviewable, and live drafts number 1).

### Changeover simplified (2026-11-08, after Mason's answer)

Five reviews in a row (Sol R4, Opus, Astra, and two Codex comments on #1674) widened the changeover guards for the old field-invoice screens. Following the project rule for a repeating finding, the mechanism was named and put to Mason, who answered: "we wont be billing field application invoices untill february so no issue we wont use feature till probably march". The separate guards (a), (b) and (c) are replaced by one rule in FP-1: the old field-invoice writers refuse any field whose split has changed. Orders keep their own two guards until FP-6, because chemical sales are billed now. Rows above that name guards (a), (b) or (c) are history.

### Astra focused review of the changeover (2026-11-08, `gpt-6-astra`, high): 17 findings (2 BLOCKER, 12 HIGH, 3 MED)

Findings 1-6, 8-10, 13, 15-17 were about the old screens and the guards meant to keep them safe. Live check: 0 blend tickets ever, 0 field-linked order lines ever, 3 field-application invoices ever. Mason chose to keep the old screens on for testing only, with no real field or field-linked order billing until the new screens replace them, so those guards were removed instead of patched further, and each cutover inventory checks that no real record went through an old path. Taken as plan changes: 7 (imported split effective from the earliest date), 11 and 12 (shared-header and mismatched drafts stop the cutover until re-created), 14 (existing order lines must be test records).
