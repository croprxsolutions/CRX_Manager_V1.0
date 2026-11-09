# Fields and who pays: build sheet (foundation 18.1)

**Status: GAME PLAN, reviewed by Sol 2026-11-08. NOT STARTED.** Mason asked for foundation 18.1 to be planned the Product Master way (handoff, 2026-11-08). This sheet turns the backlog (`docs/plans/2026-11-08-fields-who-pays-BACKLOG.md`, items numbered the same) into packages, one pull request each, with an approach, "Done when", size, database impact and risk. Sol (`gpt-6-sol`, high, advisory, read-only, given both docs and code excerpts inline) returned 35 findings, five of them BLOCKERs; 34 are folded in below and one was refuted with evidence (§6). Nothing here authorizes building. Building starts when Mason says so, one package at a time.

**Why now:** field-application invoicing must be ready before February 2027 (CRX Notes decision 2026-11-04). It stands on this foundation. It is Mason's own work, outside Taha's chemical-sale billing (to 2026-12-15).

**Words used below.**
- *Split group*: the list of who pays for a field and what share each pays, adding to exactly 100%.
- *Version*: one saved state of a field's split group, with the date it starts applying. Old versions are kept (history).
- *Resolver*: one database function that answers "who pays for this field on this date".
- *Cent allocator*: one database function that turns a line's cents and a split into exact cents per payer.
- *Billing date*: the one date each billing path uses to pick the split version (§1a).
- *Micro-percent*: a share stored as a whole number where 100,000,000 means 100%, so thirds add to exactly 100% (33,333,334 + 33,333,333 + 33,333,333).
- *Package (FP-n)*: one pull request.
- 💲 money; 🔒 permissions; DB needs a migration; 🧑 needs a Mason answer (§5).

---

## 1. Rules for every package

1. One package is one pull request, delivered through `.claude/commands/ship.md`. Every package below touches the database, money or permissions, so each needs a clean Sol review before merge, and every PR stays open 4 hours (Taha's rule, 2026-11-08), including before any live migration apply.
2. Rules live in the database: the RPC refuses a bad split; the screen only explains it. Every new write RPC takes and enforces `p_idempotency_key`, bound to the request (a reused key with a different payload is refused). SECURITY DEFINER functions set `search_path = public, pg_temp`, check the caller's role inside, and get deliberate grants.
3. Any grant or policy change on an existing table needs Mason's `I approve` before the migration is applied. Each package names its exact grant changes.
4. Proof: database behaviour in the schema-matched Docker harness with the fixture set (rule 5); screens in the local dev app. Live checks are read-only unless Mason approves a specific live test in that conversation.
5. **Fixture set** (backlog 32), built in FP-1 and extended by each package. Fields at: 100% one payer; 50/50; thirds; 50/25/25; 2/3–1/3; 60/40 with a landlord who does not pay the application charge (if Q2 = yes); a single payer who is not the field's owner; a field with no stored acres but a valid job acreage. Expected results are written per line type (product, application, other), price, acres and billing date, not "the same through every path": paths that use different prices or acres are compared on equal inputs, and intended differences (Q2) are asserted explicitly. Every path also gets a 1-cent line split three ways and a mixed order (one field line, one non-field line).
6. Money stays in whole cents; shares in micro-percent; every path uses the one cent allocator (§1a).
7. Stay out of Taha's billing files until 2026-12-15: `order_shares`, `order_item_shares`, the Bill Split card, and his re-emitted functions. Comment on his PRs only; never push to them.
8. Re-check each backlog item, and the live body of every function a package changes, before building.

## 1a. Shared contracts (settled before FP-1, used by every package)

Sol's findings 14, 22, 23, 26 and 35: these rules must be fixed before any acceptance test is written.

- **Cent allocator.** Input: one line's cents and a payer list with micro-percents and one primary. Each payer gets `floor(cents × share / 100,000,000)`; every leftover cent goes to the primary payer (Q4). Result: never negative, always sums exactly, same answer every time. Discounts and credits are allocated as their own lines through the same function, on the absolute amount with the sign restored afterwards, so a credit exactly reverses the matching charge (−1 cent split three ways is −1/0/0, never 1/−1/−1). The per-line engine's current largest-remainder rule (0 live rows) is changed to match. Proven on the 1-cent-three-ways fixture and its −1-cent credit.
- **Acre allocator.** Same shape at 0.01-acre precision (whole hundredths), leftover hundredths to the primary payer; never negative.
- **Acres to bill, per path** (first one present wins): field application = applied acres recorded on the invoice location → job's `acres_to_treat` → field billable acres; job = `job_fields.acres_to_treat` → field billable acres; blend ticket = actual acres → planned acres → field billable acres; order line = allocated acres. Field billable acres (FP-2) is only the last default. A path refuses only when it has no positive acres after its own order.
- **Billing date, per path** (Central date, stored on the invoice or snapshot with the version used): job = the date the job was completed (applied), else its scheduled date; field application = the application date on the invoice; blend ticket = applied date, else ticket date; order line = the delivery completion date. Existing season and closed-period guards still apply to backdating.
- **Snapshot rule.** When a job, invoice draft or order line first takes a split, it stores the version id and the payer list. Later field split changes never change it silently; picking up a newer split on a draft is an explicit, logged "refresh split" action (Q3).
- **Payer eligibility (Q1).** A payer must be in the field's split version in force on the billing date, or in the job's own saved split (an office override). Snapshots already taken stay valid even if the field's split later changes.

---

## 2. Packages, in build order

### Wave 0: before building (no PR from us)

- **Mason answers Q1–Q5 (§5).** Q1 (KI-76) and Q4 block FP-1.
- **PR #1650 lands** (job access ends with the job, KI-01 part C, KI-73; backlog 24). Not redone here. Its policies are the baseline for applicator access in FP-1 and FP-4.
- **Taha's PRs #1524 and #1534 land** before FP-6 only.

### Wave 1: the foundation

#### FP-1 · 💲🔒 One split group per field, with history (DB + Field Setup)
**Items:** 2, 3, 4, 5, 16 (`field_billing_defaults` only), 18, 26, 27, 30; the fixtures (32); the allocators (§1a).
**Approach.**
- New tables, RLS and policies in the same migration:
  - `field_billing_split_versions`: field, version number (unique per field), `effective_from` date, `history_known` flag, reason, who, when.
  - `field_billing_split_payers`: version, customer (`ON DELETE RESTRICT`), `share_micro_pct` integer, `is_primary`, `pays_application` (decided, Q2), `price_override_cents`, `pricing_note`.
  - Both append-only: a trigger refuses UPDATE and DELETE. A deferred check refuses a version whose shares are not exactly 100,000,000 or that has not exactly one primary.
  - **Read access:** admins and sales reps read all versions. Applicators get **no direct read** of these tables; they keep reading the current split exactly as today (through `field_billing_defaults` and its existing `_can_see_field` policy), so their access is neither widened to history nor narrowed (Sol 8).
- **Writer:** `set_field_billing_split(p_field_id, p_effective_from, p_payers, p_reason, p_idempotency_key)`; `save_field` and bulk import call the same internal function. It locks the field row (`FOR UPDATE`), so two saves of one field run one after the other. If two versions share an `effective_from`, the higher version number wins in the resolver. **Until every reader has moved (end of Wave 2), `p_effective_from` must be today or earlier** (Sol 3): no future-dated splits, so the copy kept in `field_billing_defaults` is always the split in force.
- **Transition copy:** the same transaction rewrites `field_billing_defaults` to match the version **in force today**, as the resolver picks it (latest `effective_from` on or before today, then highest version number), not simply the newest version saved. So a backdated correction (70/30 from yesterday, saved after 60/40 from today) leaves the copy at 60/40, matching the resolver. Current readers keep working. In this same package, direct INSERT, UPDATE and DELETE on `field_billing_defaults` are revoked from `authenticated` (Sol 5), so the copy cannot drift. 🔒 needs `I approve`.
- **Resolver:** `field_split_as_of(p_field_ids, p_on_date)`, SECURITY DEFINER, office-only (admin or sales rep); refuses unknown and duplicate field ids; returns per field the payers, micro-percents, version id and `history_known`. No version → the field's owner at 100% (flagged). Granted to `authenticated`, not `anon`.
- **Cent and acre allocators** (§1a) built here as read-only functions with tests; later packages call them.
- **Backfill** (6 live rows): each field's current split becomes version 1 with `history_known = false` and `effective_from` = the migration date (Sol 4); fields with none get owner 100%. Percent becomes micro-percent with the leftover to the primary. The migration logs each field and refuses to finish if any total is off. Work dated before version 1 keeps reading its own existing snapshots (job shares, invoice shares); the resolver answers such dates with version 1 flagged `history_known = false`, and screens say "split history before <date> not recorded".
- **Payer rule (Q1)** enforced in the RPC; inactive customers refused, as in Taha's card.
- Field Setup shows the split history (date, who, payers, "imported" for version 1).
**Done when:**
- Saving thirds stores 33,333,334 / 33,333,333 / 33,333,333; the screen shows 33.33% each and "100%".
- 50/40 and a split with two primaries are refused by the database, also when sent straight to the RPC.
- A 50/50 field changed to 60/40 today keeps the old version; `field_split_as_of` returns 50/50 for yesterday and 60/40 for today. A future date is refused.
- The same key resent returns the first result and writes nothing; the same key with different payers is refused.
- Two saves of one field at the same moment end as two ordered versions, never a mix.
- A direct write to `field_billing_defaults` as a signed-in admin is refused. An applicator on a job still sees that field's current split and cannot read the version tables.
- The cent allocator splits 1 cent three ways as 1/0/0 to the primary and 100 cents as 34/33/33.
- Saving 60/40 effective today, then a 70/30 correction effective yesterday, leaves `field_billing_defaults` at 60/40 and the resolver at 70/30 for yesterday and 60/40 for today.
- A −1-cent credit split three ways comes out −1/0/0, the exact reverse of the 1-cent charge.
- After backfill (read-only live check), `field_billing_defaults` matches version 1 for all 5 fields.
**Size / risk:** L. 💲🔒 DB. New tables plus one grant change on an existing table.

#### FP-2 · 💲 Field billable acres and acre rules
**Items:** 19, 20, 21.
**Approach.**
- Add a generated column `fields.billable_acres = COALESCE(override_acres, measured_acres, total_acres)`, matching `src/lib/fieldGeometry.ts` `billableAcres`. It is only the last default in each path's acre order (§1a), never a replacement for applied, job or allocated acres (Sol 12).
- Where database functions fall back to `total_acres` (`derive_customer_shares_from_fields`, the blend-ticket fallback, and the per-line engine if its uses feed billing; confirm first), the fallback becomes `billable_acres`. Applied-acre maps and job acres keep priority.
- Add `CHECK` constraints (`NOT VALID`, then validated after the audit) that stored acres are positive when present: `total_acres`, `measured_acres`, `override_acres`, `job_fields.acres_to_treat`, `order_item_field_allocations.acres` (already > 0) (Sol 15). Audit live rows first; one field has no acres today, which is allowed (blank, not zero).
- Split acres per payer use the acre allocator (§1a).
- `SelectLocationsModal.tsx:118` shows `billable_acres`.
**Done when:** a field with an override bills the override acres on a blend ticket that has no actual or planned acres, while a ticket with actual acres bills those; a field with no stored acres but a job acreage bills the job acreage; acres per payer add up exactly for every fixture; a zero-acre write is refused by the database.
**Size / risk:** S–M. 💲 DB. Independent of FP-1's tables; its acceptance uses the §1a rules, which are written down before either starts.

#### FP-3 · 🔒 Fields are archived, never deleted
**Items:** 13, 16 (`fields` only), 22, 23.
**Approach.**
- Add `archived_at`, `archived_by`, `archive_reason` to `fields`. `is_active` becomes a generated value from `archived_at`, or is no longer writable through `save_field` (Sol 16): archive state changes only through `archive_field(p_field_ids, p_reason, p_idempotency_key)` and `restore_field(...)`.
- **What blocks an archive (Q5, Sol 17):** a scheduled or in-progress job; a completed job not yet invoiced; an unposted invoice; an undelivered order line allocated to the field; an open blend ticket. The RPC lists the blocking records.
- **Archived fields** drop out of pickers for *new* work, but existing jobs, drafts, orders and invoices keep showing and saving them (Sol 34).
- `src/pages/Fields.tsx` bulk delete becomes bulk archive (`ConfirmModal`, toast).
- Revoke DELETE on `fields` from `authenticated` and drop the `fields_delete` policy. Change `fields.customer_id` from `ON DELETE CASCADE` to `ON DELETE RESTRICT`, so deleting the owner customer cannot erase a field or its split history (Sol 10). 🔒 needs `I approve`. Check first that no customer-delete flow relies on the cascade (customer master, roadmap area 3).
**Done when:** archiving from the Fields list hides the field from new-job, quote, field-app, blend-ticket and order pickers and keeps it on old records, which still open and save; archiving a field with an open job is refused and names the job; a direct `DELETE` on `fields` as an admin is refused; deleting a customer who owns a field is refused; restoring brings the field back with split, boundary and history intact; saving the field cannot un-archive it.
**Size / risk:** M. 🔒 DB. Grant and foreign-key changes on an existing table.

### Wave 2: every billing path reads the split group

Order: FP-4, then FP-5a (both needed for February), then FP-5b, then FP-6 after 2026-12-15. Future-dated splits are allowed only after FP-6 lands and nothing reads `field_billing_defaults` for billing.

#### FP-4 · 💲 Jobs carry the field's split and bill with it
**Items:** 6, 7, 18 (job side).
**Approach.**
- `job_field_shares` gains `share_micro_pct`, `source` (`field_version` with the version id, `office_override`, or `legacy`), and an exact-100% check per job field. `split_pct` stays, filled from `share_micro_pct`, until every reader moves in this same PR: `get_job_billed_customers`, `resolve_line_split_vector`, `_transfer_job_to_invoice_intent_impl_20260908` and the Job Detail screen (Sol 20).
- **Existing 5 rows** are kept as they are, marked `legacy`, and their sums audited; nothing is re-copied over them (Sol 18).
- `save_job` copies a field's split from the resolver on the job's billing date only when the field is new to the job, or the job date or field changed and the source is `field_version`. An `office_override` is never re-copied by an unrelated edit or a retry (Sol 19). Office edits are checked by the server (exact 100%, payer rule).
- The job invoice bills from `job_field_shares` through the cent allocator, so what Job Detail shows is what is billed, and it splits whenever the payers differ from the job's customer, including a field billed 100% to a landlord (item 7).
**Done when:** for every fixture, Job Detail's payers and the job invoice's payers and cents match the expected table; a 70/30 office override survives editing the job's notes and a retried save; a field whose split changes after the job keeps the job's snapshot; posted invoices never change.
**Size / risk:** M. 💲 DB + Job Detail.

#### FP-5a · 💲 One field-application engine: the per-line engine, reading the resolver
**Items:** 8, 12, 27, 28, 29.
**Approach (reordered after Sol 21: the engine that can bill one line differently must come first).**
- Make the per-line engine the field-application invoice engine. Its resolver gains explicit inputs: `resolve_line_split_vector(field, source job, billing date)`; order of sources: job shares → field split version in force on the billing date → owner (Sol 22). The browser preview calls the same function with the same inputs.
- Q2 (decided): every line starts filled in from the field's split. When a payer does not pay the application charge, the application line is split among the other payers in proportion (through the cent allocator); product lines use the full split.
- **Line-by-line changes before posting (Mason, 2026-11-08):** on an unposted draft the office can change any line's payers' percentages, so different lines bill at different shares. The server checks each line adds to exactly 100% and keeps a "changed from the field split" mark per line; the field's saved split is never changed by it. Posting snapshots each line's final split; unpost, edit and repost stays allowed. Whether a line may add a payer who is not on the field follows Q1. The per-line engine's existing `custom` split mode is the starting point.
- Each saved draft stores the billing date and version used (snapshot rule).
- The field-application screen sends new invoices through this engine.
- **Proof with Mason, no duplicate bills (Sol 25):** for one real landlord field, compare the engine's *preview* (read-only, nothing saved) against Mason's own sheet; then he creates the one real invoice.
**Done when:** for every fixture, preview and saved invoice give the expected payers and cents per line type; an application dated before a split change bills the old split; the 60/40-no-application fixture bills the landlord 40% of product and 0% of application; on a draft, changing one product line to 80/20 and another to 100/0 posts exactly those shares while the field's split stays 60/40, and a line totalling 90% is refused by the database; Mason's preview matches his sheet before he saves.
**Size / risk:** L. 💲 DB + screens. Feb-critical.

#### FP-5b · 💲 Old field-application drafts and blend tickets
**Items:** 8, 9, 12.
**Approach.**
- **Location-engine records (Sol 24):** posted invoices stay as they are, PDFs unchanged. For unposted location-engine drafts (count them live first; 2 location-share rows exist today), keep the old engine for edit and post of those drafts only, with a visible "old split method" label, and refuse it for new invoices. If none exist at build time, retire the path outright.
- `create_invoice_from_blend_ticket` and `derive_customer_shares_from_fields` take a billing date and call the resolver and cent allocator (§1a). `derive_customer_shares_from_fields` gains the date input and its callers are updated together.
**Done when:** an old draft opens, edits and posts with its original split; no new invoice can be made on the old engine; a blend ticket on each fixture field gives the expected payers and cents.
**Size / risk:** M. 💲 DB.

#### FP-6 · 💲 Orders and deliveries read the split group (after 2026-12-15)
**Items:** 10, 15.
**Approach.**
- Re-read Taha's live code first. Reconcile **per order line** (Sol 28): a line with field allocations bills by the field split; a line without follows his card or his line payers (`order_item_shares`). Mixed orders are a fixture.
- New RPC `set_order_line_field_allocations(p_order_item_id, p_allocations, p_idempotency_key)` replaces the direct writes at `OrderDetail.tsx:1005` and :1022. It checks the line belongs to an editable order, no field twice, acres positive, archived fields only if already on the line, and refuses changes once the line is delivered or invoiced (Sol 31).
- At delivery completion (the billing date) the split version and exact cents per payer are stored; a retry returns that result (Sol 30).
- Delivery of a field-split order goes to the split-invoice path instead of failing with `ORDER_NEEDS_SPLIT_BILLING` (Sol 29), unless Taha's live code already routes it; test delivery, retry and the invoices end to end.
**Done when:** an order with one line on a 50/50 field and one line on Taha's card produces the right invoices per payer after delivery, cents exact; a retried delivery creates nothing new; editing allocations after delivery is refused.
**Size / risk:** M–L. 💲 DB + screen. Shared files with Taha (`OrderDetail.tsx`, delivery functions).

### Wave 3: lock it down and tidy up

#### FP-7 · 🔒 Only RPCs write splits; old pieces retired
**Items:** 1, 16, 17, 31, 33.
**Approach.**
- Inventory every payer-bearing table (grants, policies, triggers, writers) and close each remaining direct write (Sol 32): `job_field_shares`, `field_app_location_shares`, `order_item_field_allocations` and `invoice_shares` lose INSERT, UPDATE and DELETE for `authenticated`. Already closed: `field_billing_defaults` (FP-1), `invoice_line_shares` and its snapshots (`20260720213000:263-285`). Taha's `order_shares` and `order_item_shares`: his decision, raised as a comment on his work, not changed here. 🔒 needs `I approve`.
- `anon` SELECT is revoked only where a table-by-table check shows nothing legitimate reads it as `anon` (Sol 33).
- Replace `field_billing_defaults` with a read-only view of the current version (keeping applicator access as today), or drop it once nothing reads it. Then allow future-dated splits.
- Fix the KI-84 smoke chain; run the fixture test in CI.
- Update the roadmap, DECISION_LOG, KNOWN_ISSUES (KI-16, KI-76) and the field part of `docs/workflows/QUOTE_TO_DELIVERY.md`.
**Done when:** a signed-in admin writing any table on the inventory directly is refused; Field Setup, Job Detail, the field-app invoice, blend tickets and order allocations all still work; a future-dated split bills correctly on both sides of its date; the fixture test passes in CI.
**Size / risk:** M. 🔒 DB. Grant changes on existing tables.

---

## 3. How this relates to Taha's work

- **One line:** Taha's open PRs #1524 and #1534 add a per-payer Bill Split for chemical sales (an order card plus per-line payers in `order_item_shares`, stored as percent); this plan does not touch them, and they already let a field allocation win over the card. #1587 shares `OrderDetail.tsx` only; #1576 changes who may unpost field invoices and needs no change from us.
- The two models meet on an order line with a field allocation. FP-6 reconciles them per line against his final, live code, after 2026-12-15.
- Shared choices that should match his: inactive customers cannot be payers; leftover cents go to the main payer (Q4), which is his rule. If Mason picks differently, tell both before FP-1.

## 4. Order and timeline

| Order | Package | Needs first | Target |
|---|---|---|---|
| 0 | §1a contracts written into the FP-1 plan | Q1, Q2, Q4 | November |
| 1 | FP-1 split group with history | §1a; Q3; `I approve` (one grant) | November |
| 1 (parallel) | FP-2 billable acres and acre rules | §1a | November |
| 2 | FP-3 archive fields | Q5; `I approve` (grant and foreign key) | December |
| 3 | FP-4 jobs | FP-1, FP-2; PR #1650 landed | December |
| 4 | FP-5a one field-app engine | FP-1, FP-2, FP-4; Mason's preview check (about 20 minutes) | December–January |
| 5 | FP-5b old drafts and blend tickets | FP-5a | January |
| 6 | FP-6 orders and deliveries | FP-1; Taha's #1524 and #1534 live (after 2026-12-15) | January |
| 7 | FP-7 lockdown, future dates on | all above; `I approve` (grants) | January–February |

About 8 PRs in 3 waves (the roadmap guessed 5–6; history and the second field-app engine add two). Field-application invoicing needs FP-1, FP-2, FP-4 and FP-5a before February; FP-3 and FP-5b should follow quickly.

## 5. Questions for Mason (each with a recommended answer)

1. **Which customers may a field split bill? (KI-76)** *Recommend:* only payers saved on that field's split (or an office change on one job); to bill someone else, the office adds them to the field's split first (any active customer). This stops a field invoice landing on an unrelated account by mistake.
2. **Can a payer share a field but not pay the application charge?** **DECIDED (Mason, 2026-11-08):** yes, and more: "field level splits always auto populate based on field but we need to be able to adjust the split before posting invoice and change line items at different percentages and shares." Each payer has "pays application" yes/no on the field; every invoice line starts from the field's split; before posting, the office can set any line to its own percentages (FP-5a).
3. **When a field's split changes, which work uses the new split?** *Recommend:* you pick the date it starts (today or earlier at first; future dates once the work is finished); work with a billing date on or after it uses the new split; posted invoices never change; an unposted draft keeps its split until someone presses "refresh split", which is logged.
4. **When a split doesn't divide evenly (thirds), who gets the extra penny?** *Recommend:* the primary payer (usually the grower), the same as Taha's chemical-sale split, so all invoices follow one rule.
5. **Who may archive a field, and when is it blocked?** *Recommend:* admins and sales reps can archive; it is blocked while the field has open or unbilled work (a job, an unposted invoice, an undelivered order line, an open blend ticket); only admins can restore.

## 6. Sol review record (2026-11-08)

Sol (`gpt-6-sol`, high, advisory only; not a ship gate) reviewed the backlog and this sheet with code excerpts inline: **35 findings (5 BLOCKER, 25 HIGH, 5 MED)**. Full output kept in the session scratchpad; the decisions:

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | HIGH | Cited migration bodies (`20261120100000`, `20261204100000`) may not be on `main` or live | **Refuted:** both files are on `main` at `5a921026e` (`20261204100000` landed in #1579), and the live migration ledger lists `20261204100000` as applied (read-only query, 2026-11-08). The project stamps migration files ahead of the calendar. |
| 2 | MED | Backlog inventory mixes payer sources, snapshots and acre allocations | Noted; backlog items 1 and 3 already separate them (snapshots in item 3, acres in item 1); FP-7 inventories writers and readers per table |
| 3 | BLOCKER | A future-dated version copied into `field_billing_defaults` bills early | FP-1: no future dates until FP-7 |
| 4 | HIGH | Backfill invents history | FP-1: version 1 flagged `history_known = false`, dated the migration day; old work keeps its snapshots |
| 5 | BLOCKER | Direct writes to `field_billing_defaults` stay open during dual storage | FP-1 revokes them |
| 6 | HIGH | Concurrency, replay and append-only only noted | FP-1: row lock, version ordering, payload-bound key, append-only trigger, each in "Done when" |
| 7 | HIGH | Resolver access and bad input undefined | FP-1: office-only, refuses unknown and duplicate ids |
| 8 | HIGH | Version history widens applicator access | FP-1: applicators get no direct read of version tables |
| 9 | HIGH | `price_override_cents` and `pricing_note` could be lost | FP-1: both kept on payer rows |
| 10 | HIGH | Owner customer delete still cascades fields | FP-3: owner foreign key becomes RESTRICT |
| 11 | HIGH | Payer eligibility not dated | §1a payer eligibility; Q1 wording |
| 12 | HIGH | Field acres could replace applied acres | §1a acres order per path; FP-2 |
| 13 | MED | "No acres" rule too blunt | §1a: refuse only when the path has no acres |
| 14 | HIGH | Acre remainder could go negative | §1a acre allocator |
| 15 | MED | No database check on acre values | FP-2 CHECK constraints |
| 16 | HIGH | `is_active` could un-archive | FP-3 |
| 17 | HIGH | Archive blocks incomplete | FP-3 block list; Q5 |
| 18 | HIGH | Re-copying overwrites the 5 job-share rows | FP-4: kept as `legacy` |
| 19 | HIGH | Override needs a durable marker | FP-4 `source` column |
| 20 | HIGH | Job-share format change without reader plan | FP-4 moves every reader in the same PR |
| 21 | BLOCKER | Location engine cannot bill product and application differently | FP-5a is now the per-line engine first |
| 22 | HIGH | Resolver functions have no date or job input | FP-5a and FP-5b add explicit inputs, callers updated together |
| 23 | HIGH | "Application date" incomplete | §1a billing date per path |
| 24 | HIGH | Old location-engine drafts undefined | FP-5b |
| 25 | HIGH | Side-by-side could create two bills | FP-5a: read-only preview, then one invoice |
| 26 | BLOCKER | Cents rule undefined and differs by engine | §1a cent allocator; Q4 |
| 27 | MED | "Same cents everywhere" is the wrong test | Rule 5: expected results per line type, equal inputs, explicit exceptions |
| 28 | BLOCKER | Taha's line payers missing from the order design | FP-6 reconciles per line against his live code |
| 29 | HIGH | Delivery still refuses split orders | FP-6 |
| 30 | HIGH | Order split not snapshotted | FP-6 stores version and cents at delivery |
| 31 | HIGH | Allocation RPC lacks rules | FP-6 lists them |
| 32 | HIGH | Lockdown list incomplete | FP-7 inventory |
| 33 | MED | Blanket `anon` revoke | FP-7: table-by-table only |
| 34 | HIGH | Archive and draft refresh interact badly | FP-3 keeps archived fields on existing records; Q3 "refresh split" |
| 35 | MED | Order puts tests before the rules they need | §1a first; FP-5a reordered |
