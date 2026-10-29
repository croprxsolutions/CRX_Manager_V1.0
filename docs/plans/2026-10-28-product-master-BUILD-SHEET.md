# Product Master build sheet: goals, approach and "done" for every item

**Status: GAME PLAN, reviewed by Sol 2026-10-28. NOT STARTED.** Sol (`gpt-6-sol`, high, advisory, read-only, given this sheet, the backlog and code excerpts inline) returned 36 findings, one BLOCKER. All of them are folded in below as "Sol:" notes on each package, plus a new order in section 4. Section 6 lists the findings and what was done with each. Mason, in chat, 2026-10-28, asked for a build sheet of all the Product Master items: what "done" means for each, how to approach them, a brainstorm before coding, then a Sol review to settle the final plan before any code is written. Nothing here authorizes building. Building starts when Mason says so, one work package at a time.

**Revised 2026-10-29 by the product grand plan** (`docs/plans/2026-10-29-product-GRAND-PLAN.md`, Sol-reviewed). That plan makes this sheet Stage 1 of the full product work. It adds four packages (WP-PM-14, WP-PM-16, DM-0 and WP-PM-15, section 2a below), changes seven packages (section 2a) and replaces the order in section 4. Where this sheet and the grand plan disagree, the grand plan wins.

**Sources this sheet turns into work:**
- `docs/plans/2026-10-28-product-master-setup-edits-BACKLOG.md`: the 43 items, numbered; this sheet uses the same numbers.
- `docs/plans/2026-10-28-product-data-model-REFRESH.md`: weight per gallon and active ingredients, To-Do row 2.9.
- `docs/manual/DECISION_LOG.md`, 2026-10-28: Mason's answers. Keep the generic "Post-Emergence". New products open for pricing (not turned off). Open orders block deactivation; quotes warn. Tier 1 has the lowest margin. The return-policy editor waits.

**Code facts** come from read-only reviews of `main` on 2026-10-28 (`5b0246530` and `c4889c386`). Re-check each one at build time.

**Words used below.**
- *Work package (WP-PM-n)*: one pull request.
- *Migration*: a reviewed database change.
- *RPC*: a saved database operation the app calls.
- *Shared component*: one piece of screen code used on many pages.
- 💲: touches pricing or money.

---

## 1. Rules for every work package

1. **One work package = one pull request**, delivered through `.claude/commands/ship.md`: Luna rounds, checks green, Sol last on the exact head, then merge. Plain documentation is the only exception.
2. **💲 packages** need a clean CodeRabbit review of the current head as well as Sol (AGENTS.md).
3. **Business rules live in the database.** If a rule must never be broken ("you can't deactivate a product with open orders"), the database enforces it, not just the screen (AGENTS.md hard rule). Those packages carry a migration.
4. **Migrations:** each one is new and comes with a rollback plan. One that adds grants or revokes on `products`, or changes an existing table's policy, needs Mason's `I approve` before it is applied (refresh plan §4 item 2). Nothing destructive is planned in this sheet.
5. **"Done" means seen working,** not "tests pass" (AGENTS.md). Each package's "Done when" lists what is clicked or run and what must be seen. Tests are added as supporting proof.
6. **Proof environment.**
   - Screen-only changes are proven in the local dev app (`npm run dev`).
   - Database behaviour is proven in the PostgreSQL Docker harness plus a rolled-back live smoke chain, the pattern of `scripts/smoke/prove-product-brands.mjs`.
   - **Open:** the isolated test system (Goal 6, staging) is not ready. Until it is, nothing that writes product data is tested by clicking on live. A live check is read-only, or uses a product Mason names for the test with his OK in that conversation.
7. **Shared components:** a change to a shared component (the dropdown `Combobox`, `EditableDataTable`) is checked on every page that uses it, not just Products.
8. **Re-verify each item against current code before building it.** Line numbers drift, and items marked ❓ are unconfirmed.
9. **Sol: rules are enforced in the database from the start, not "later"** (findings 26, 30). Any rule that new writes must obey goes in the database in the same package as the screen change. That includes name not blank, container size > 0, rate ≥ 0, whole-number REI/PHI, and the EPA format. Existing bad rows are handled with a `NOT VALID` constraint plus a listed cleanup, so new writes are checked at once. Import, the list and the product page all hit the same rule.
10. **Sol: proof uses a schema-matched local database** (finding 1). Every write path is proven against the Docker harness with seeded edge cases, and the real app flow is run against that local database where possible. Live checks are read-only. Any rolled-back live smoke chain, or test on a named live product, needs Mason's explicit OK in that conversation.
11. **Sol: each package names its exact permission changes in its own plan** (finding 2): new grants, revokes and policies. Nothing assumes "routine". If a package adds or changes grants on an existing table, it asks Mason for `I approve`.

---

## 2. Work packages, in build order

### Phase A: daily-use bugs (small, low risk; first)

#### WP-PM-1 · Dropdowns work properly
**Items:** 2 (dropdown shows only the current choice), 9 (doesn't reopen after a pick; stays open after Tab), 1c (Use Timing won't scroll).
**Approach.**
- In `src/components/ui/Combobox.tsx`, separate the *search text* from the *saved value*.
  - Opening the list shows every option, with the saved one highlighted and scrolled into view.
  - Typing narrows the list.
- A click on the box opens it, even when it is already focused.
- Tab or Escape closes it.
- The scroll bug is expected to disappear with #2; confirm it does.
- Find every page that uses `Combobox` and check each.
**Done when:**
- On the product page, clicking a filled Category, Vendor, Manufacturer and Use Timing box shows the full list each time, with the current choice marked.
- Typing narrows the list; a second click after a pick reopens it; Tab closes it.
- The full Use Timing list scrolls and every option can be clicked.
- Every other page that uses `Combobox` behaves the same, checked by hand.
- The list works with the keyboard (arrow keys, Enter, Escape).

**Sol (findings 3–5):**
- Keep free-text entry. Category, Vendor and Manufacturer accept new values typed in, so the fix must not remove that.
- Define exactly what Escape (cancel the typing), Tab and blur (keep what's typed) do.
- "Saved choice" needs its own marker, separate from the keyboard highlight. Today `aria-selected` follows the highlight (`Combobox.tsx:168`, confirmed).
- Test scrolling separately (mouse wheel, touch, keyboard to the last option); don't assume #2 fixes it.
- Test with a screen reader.

**Size / risk:** S. Moderate reach: a shared component used beyond Products. No database change.

#### WP-PM-2 · 💲 Pricing page behaves predictably
**Items:**
- 3: pricing mode resets on every open, on the product page and the list.
- 4 ❓: margin typing may scramble ("25" → 2.05%).
- 41: "Gross Margin = Markup" wording.
- 42: "Phase 2 release gate" text on the Cost Basis card.
**Approach.**
- **#3, two options:**
  - (a) No database change: when a product has both prices and margins saved, default to **price-driven** (the customer-facing number), with the mode switch visible and one click to change it.
  - (b) Store the last-used mode on the product. That needs a column and a grant on `products`, so it's Mason-gated.
  - **Recommend (a).**
- **#4:** reproduce it first. If it's real, keep the typed text as text while editing, and convert to a fraction only on blur or save.
- **#41:** label markup as "Markup %" and keep "Net margin %".
- **#42:** hide the card for non-admins, or reword it in plain English when the feature is off.
**Done when:**
- Opening a product with saved prices shows a usable mode right away, and the price boxes aren't locked. Same on the list.
- Typing "25" in a Net Margin box shows 25 while typing and saves 25.0%. Proven on all three tiers, plus decimals ("22.5").
- Labels read "Net margin %" and "Markup %".
- No internal "release gate" wording is visible.
- The pricing preview's numbers are unchanged for the same inputs (before/after comparison).

**Sol (findings 6–8):**
- Record "price-driven when both are saved" as a deliberate default.
- Prove that opening a product last edited by margin changes no price. Compare integer-cent prices before and after opening and saving.
- The margin test covers typing, blur, the preview, apply and reload, on all three tiers.
- Before relabelling "Gross Margin = Markup", check the server's calculation against a hand-worked cost and price. It may be a formula problem, not just a label. The current text is at `ProductDetail.tsx:1472`, confirmed.

**Size / risk:** S. 💲, so CodeRabbit plus Sol. No database change if (a).

#### WP-PM-3 · Turning products off safely
**Items:**
- 5: the inline Active switch skips the check.
- 6: a failed check lets deactivation through.
- 7: reps see a Deactivate button that always fails.
- 27: block on open orders, warn on quotes.
- 26: no bulk reactivate.

**Approach.** Move the rule into the database, so every path obeys it: the bulk button, the inline switch, the product page, and any future screen.
- **Block deactivation** while the product has:
  - lines on orders in `confirmed` or `partially_fulfilled`;
  - lines on purchase orders in `draft`, `submitted` or `partially_received`.

  Either a trigger refuses `is_active → false`, or an admin RPC `set_product_active(p_product_ids, p_active, p_idempotency_key)` does the checking and the trigger refuses everything else.
- **The screen asks the database first, and shows warnings before confirming:**
  - quotes that are `draft`, `sent` or `revised`, or `accepted` but not yet converted;
  - stock on hand;
  - crop programs;
  - scheduled jobs.

  Stock, crop programs and jobs warn as recommended; confirm with Mason at build time.
- **Who sees the buttons:** reps don't see Deactivate (admin-only, matching the database).
- **Reactivate:** inactive products can be selected, and there's a Reactivate action.
- **Brainstorm for Sol:**
  - Is a trigger or an RPC the better boundary?
  - Which quote statuses count as "open"?
  - Should an order line that is fully delivered but not yet invoiced count?
**Done when:**
- In the harness:
  - deactivating a product with a confirmed order line is refused, whatever the path (direct update, bulk, inline);
  - one with only an open quote is allowed;
  - a non-admin is refused;
  - a repeat with the same retry key returns the first result.
- In the app:
  - the inline switch and the bulk button both show the same refusal message, naming the order;
  - an open quote shows a warning that can be confirmed;
  - a rep sees no Deactivate button;
  - an inactive product can be selected and reactivated.
- If the open-order check can't run, deactivation is refused, not allowed.

**Sol (findings 9–14). This settles the trigger-vs-RPC question:**
- **Both.** An admin RPC with `p_idempotency_key` handles the deactivate and reactivate action. A database guard (trigger) refuses every other `is_active` change that breaks the rule, including today's direct updates from the list (`Products.tsx:663-673`, confirmed).
- **The race.** An order or PO line could be added while the product is being turned off. Lock the product row the same way in both operations, refuse adding an inactive product to an order or PO line, and refuse reopening an order that holds one. Prove both timings in the harness.
- **Define "open" from the real lifecycle before coding.** `confirmed` and `partially_fulfilled` block. The open question is whether `fulfilled` (all delivered, not yet invoiced) still blocks; decide it from the invoicing lifecycle.
- **"Accepted but not converted"** is found through the quote-to-order link, not the status alone. Test draft, sent, revised, accepted-converted, accepted-unconverted, expired and closed quotes.
- **Warnings come from the database operation itself.** The confirm is tied to the same product set, so a stale warning can't be confirmed. Test a change between the warning and the confirm.
- **Bulk is all-or-nothing.** The operation names each blocking order or PO. Test a mixed selection, a lookup failure, a retry and a non-admin call.

**Size / risk:** M. Migration (trigger or RPC, idempotency key, grants). Touches orders and inventory, so it gets a strong review.

#### WP-PM-4 · Customer sales sheet and list views are correct
**Items:**
- 8 💲: the sales sheet includes turned-off products.
- 25: Active/Inactive filter; search EPA and manufacturer; RUP, signal word, form and unit columns.
- 40: exports include compliance and unit fields.

**Approach.**
- The sales sheet always excludes inactive products, whatever the filter, and its count matches what it prints.
- Add an Active / Inactive / All filter, defaulting to **Active**.
- Widen search, and add optional columns.
- Internal exports gain EPA, RUP, signal word, REI/PHI, form and units.
- The customer sales sheet does **not** gain internal fields.
- Make the selected-rows export match Download All.

**Done when:**
- With one inactive product in the catalog, the downloaded sales sheet doesn't list it, and its title count matches the rows.
- The filter shows only active products by default.
- Searching an EPA number finds the product.
- The internal CSV has the new columns.
- The customer PDF shows no cost, margin or internal notes. Check the file itself.

**Sol (findings 15–16):**
- Apply the active rule to the data the PDF is built from, and take the count from the rows actually printed. Don't use the on-screen list count.
- Check who can download internal exports.
- Test the Active, Inactive and All filters, plus selected-row export.
- Include a product whose name has commas, quotes or a leading `=`, `+`, `-` or `@`, so the spreadsheet doesn't run it as a formula.

**Size / risk:** S. 💲 (customer-facing prices), so CodeRabbit plus Sol. No database change.

### Phase B: Use Timing (Mason's request)

#### WP-PM-5 · Use Timing: several timings and new options
**Items:**
- 1a: more than one timing.
- 1b: Post-Emerge Corn, Post-Emerge Soybeans, Pre-Emerge, keeping "Post-Emergence".
- 32: a stale hidden timing after a category change.

**Approach.**
- **Database:** add a list column `use_timings text[]`, back-filled from `use_timing`.
  - Reads switch to the list. The old column is kept and kept in sync for one release, so nothing downstream breaks; dropping it later is a separate, Mason-gated destructive step.
  - Options live in one shared constant, not hard-coded on the page.
- **Screen:** a multi-select on the product page.
- **Readers to update:**
  - the pricing workbook (`productPricingWorkbook.ts`, and `use_timing_snapshot` in `20260722091359_supplier_pricing_workbook_v2_product_info.sql`);
  - `PricingChangePreviewModal`;
  - bulk import, which accepts "A; B";
  - the CSV/PDF exports.
- **#32:** when the category changes away from Herbicide or Foliar, the page asks whether to clear the timings. Or the timings simply stay hidden but are shown in a note. Recommend: ask.
- **Brainstorm for Sol:**
  - A `text[]` column, or a link table?
  - How does the workbook round-trip a list?
  - Should the option list become a database CHECK or stay in the app? Recommend the app for now, since Mason may add options.

**Done when:**
- An herbicide can be given "Pre-Emerge Corn" and "Post-Emerge Soybeans" at once; after saving and reloading, both show.
- Every existing product's single timing appears unchanged after the back-fill (count before = count after).
- A workbook export then re-import of a two-timing product keeps both.
- Bulk import accepts "Pre-Emerge; Post-Emergence".
- Changing the category away from Herbicide asks about the timings.
- The new options appear in the list.

**Sol (findings 17–19). This settles the storage question:**
- **Storage.** Use `text[]`, and the list is the one authoritative value. The old single column can't hold two values, so it is never written by app code again.
  - Its compatibility value is defined: for example, the first timing, kept by a trigger.
  - Any old writer of the single column is found and switched before the migration, so nothing silently replaces the list.
  - Audit every writer, not only readers.
- **Workbook and import.** They get an exact list format: fixed order, defined escaping, empty vs blank, legacy snapshots and conflicts.
  - Prove export → import → export keeps both timings and changes no price.
  - No bare "A; B" split unless its escaping is tested.
- **Allowed values.** The database checks them, from a small options table Mason can add to rather than a hard CHECK.
- **Category changes.** Decide whether timings may stay on products that aren't Herbicide or Foliar. Recommend: no. A category change clears them after a confirm, so no hidden stale value can remain.

**Size / risk:** M. Migration (new column, back-fill, grants on `products`, so Mason-gated `I approve`), plus several readers.

### Phase C: 💲 pricing and setup gaps

#### WP-PM-6 · 💲 New-product flow and the "Unit" field
**Items:**
- 20: after Create you land on the list; new products should open for pricing.
- 16: "Unit" (`unit_size`) can't be set, yet job and crop-program price math uses it.
- 17: changing a stocked, priced product's unit gives no warning.
- 37: Duplicate product.

**Approach.**
- **#20:** after Create Product, go to the new product's page with a "Now set prices" prompt. The insert must return the new id. Mason decided products stay active.
- **#16, the central question:** is `unit_size` the same thing as `inventory_unit`?
  - Trace every reader (`JobDetail.tsx`, `cropProgramHelpers.ts`, `chemCalculator.ts`, `QuoteBuilder.tsx`).
  - If they mean the same, set `unit_size` from Inventory Unit on save, and back-fill blanks by migration.
  - If they differ, show "Unit" with an explanation.
  - **Brainstorm for Sol:** which is safer?
- **#17:** changing Inventory Unit or Product Form on a product with prices, stock or open lines shows a warning listing what is affected. It also notes that prices are not rescaled and the cost basis resets. Optionally, require a reason.
- **#37:** "Duplicate" copies setup and compliance fields, but clears SKU, container, pricing and cost, then opens the copy.

**Done when:**
- Creating a product lands on that product, and prices can be entered right away.
- A product created in the app gets the right stock unit, and a job line using it prices correctly. Shown with a real calculation on a test job in the harness or local dev; never a live job.
- No existing product ends up with a blank `unit_size` where `inventory_unit` is set (read-only count before and after).
- Changing a priced product's Inventory Unit shows the warning before saving.
- Duplicate creates a new product with the same chemistry fields and blank prices.

**Sol (findings 20–23). Finding 20 is the one BLOCKER:**
- **Do not "set `unit_size` from Inventory Unit".** Job and crop-program math treats `unit_size` as the billed stock unit (`JobDetail.tsx` 3742–3824, confirmed), while the product page says prices are per inventory unit. Before any back-fill:
  1. Audit the stored values: where they agree, where they differ, which are blank.
  2. Audit every money reader: jobs, crop programs, quotes, the calculators.
  3. Settle **one canonical priced unit**, enforced in PostgreSQL.
  4. Back-fill only rows with a verified mapping. Mason sees the mismatch list first.
  WP-PM-6 is split: **6a** is the unit audit and the canonical unit (blocking); **6b** is the new-product flow and Duplicate.
- **Missing prices.** New products stay active (Mason's call). So prove every quote, job, export and order path refuses a missing price rather than silently using $0.
- **Unit and form changes need more than a warning.** They go through a database-reviewed change. It either blocks while there is stock or open lines, or applies an explicit, stated conversion. Historical amounts are never relabelled silently. Form changes in WP-PM-8 follow the same rule (finding 28).
- **Duplicate product** gets a field-by-field copy list and a review screen.
  - Clear pricing, cost, SKU and size-specific fields.
  - Require confirming the EPA number, rates, RUP and intervals before the copy is used.
  - Fold the data model's DM-5 (copy from a sister product) into this design.

**Size / risk:** M. 💲. Migration likely (canonical unit). State its grants in the package plan.

#### WP-PM-7 · 💲 One clear way to change cost and price
**Items:**
- 34: four ways to change cost, and the reason is asked twice.
- 35: a pick list for the price-change source.
- 36: warn on tier order. Tier 1 has the lowest margin, so the warning fires when Tier 2 is below Tier 1 or Tier 3 below Tier 2.

**Approach.**
- **#34:** keep one cost path, the "Update cost" dialog with one reason. Make the Current Cost box read-only. Review whether the list's inline cost edit and the manual replacement cost should go through that same dialog.
- **#35:** offer a pick list of sources (vendor price list, rebate program, market adjustment, PO cost, other) plus free text for "other". The stored value stays text, so no migration.
- **#36:** add the warning to the pricing preview, on the screen and ideally in the preview RPC so the price sheet gets it too.
  - It is a warning that must be acknowledged, not a block, matching the other price warnings.
  - Placing it in the RPC is a migration.
- **Brainstorm for Sol:**
  - Which cost paths can be removed without breaking `cost_history` or the cost-basis gate?
  - Does the price-sheet (0.1) acknowledgement mechanism extend to a new warning code safely?

**Done when:**
- Cost can be changed in one place, and the reason is asked once.
- The change shows in Cost History with that reason.
- The source can be picked from the list.
- Setting Tier 2 below Tier 1 shows the new warning, and it must be acknowledged before applying. The same happens through the price sheet, if it's in the RPC.
- Existing warnings (over 10%, below cost, under floor) still fire, checked with the same inputs before and after.

**Sol (findings 24–25):**
- **Cost writers.** First list every one: the detail page box and dialog, the list's inline cost, manual replacement cost, inventory receipts and PO costs, the workbook. Keep the legitimate automatic sources, and route all of them through one audited database rule. Remove duplicate screen entry points only after that map exists.
- **The tier-order warning** goes in the authoritative preview/apply RPC.
  - It compares final integer-cent prices and has a stable warning code.
  - It is acknowledged against the same version and values.
  - A screen-only warning could be bypassed by another price writer.
  - Test price-driven, margin-driven and the workbook, and confirm the old warning codes are unchanged.

**Size / risk:** M. 💲. Migration (the preview RPC).

### Phase D: product setup foundations (the weight-per-gallon work needs these)

#### WP-PM-8 · Product setup is complete and checked
**Items:**
- 14: changing Form wipes units unevenly.
- 15: small validation gaps.
- 13: the Container Unit box shows blank.
- 21: an "incomplete setup" flag and filter.
- 22: EPA number format check.
- 23: show max label rate and explain the three rate fields.
- 24: warn on a new category, vendor or manufacturer.

**Approach.**
- **#14:** a Form change clears the inventory, container *and* rate units together, with a confirm. Setting the form for the first time clears nothing.
- **#15:**
  - trim the name and SKU, and refuse a blank-after-trim name;
  - Rate Per Acre must be ≥ 0;
  - REI/PHI accept whole numbers only, and refuse "12.5" with a message instead of truncating;
  - empty text saves as blank (null).
  - Database CHECKs for these are a later option.
- **#13:** keep an "(existing)" option, as Inventory Unit does.
- **#21:** define "complete setup": category, form, inventory unit, container size and unit, and for registered pesticides EPA number, signal word, RUP and REI/PHI. Add a badge on the product page and an "Incomplete" filter on the list.
- **#22:** reuse the brand form's `EPA_REGISTRATION_PATTERN` on the product page.
  - Existing bad values are flagged, not wiped.
  - A database CHECK only after cleanup, using a `NOT VALID` constraint first.
- **#23:** show max label rate read-only, with a link to Label Review. Add one-line help on Suggested Rate, Rate Per Acre and Max Label Rate.
- **#24:** "This creates a new category. Did you mean Herbicide?", with near-match suggestions.

**Done when:**
- Each validation refuses with a clear message on the product page.
- The list shows how many products are incomplete, and the filter lists them.
- A badly formatted EPA number can't be saved on the product page, and existing bad ones are listed.
- Typing "herbicde" as a category triggers the new-value warning.
- A Form change asks before clearing units.

**Sol (findings 26–28):**
- **Database checks.** Section 1 rule 9 applies: the validations go into the database in this package, with `NOT VALID` plus a cleanup list for existing bad rows.
- **"Complete setup" needs an applicability rule.** Classify each product as a registered pesticide, a non-pesticide or other. Tell "unknown" apart from a real 0 or "not applicable" for REI/PHI. Test representative products of each kind.
- **The EPA check proves format only,** not that the registration is valid.
- **Form changes.** A first-time form choice keeps compatible values. A later change follows WP-PM-6a's database-reviewed unit-change rule, tested on priced, stocked and open-line products.

**Size / risk:** M. Migration (validation constraints).

#### WP-PM-9 · More product forms (seed, biologicals, "each")
**Item:** 33.
**Approach.**
- Decide the list with Mason (business call).
- Widen the `product_form` CHECK as a migration, a superset that keeps `liquid` and `dry`.
- Every reader that branches on liquid/dry (unit lists, the calculators) must handle the new forms. A weight calculation refuses them by name.
**Done when:**
- A seed product can be set up with a sensible unit.
- Every page that branches on form handles it without errors, checked page by page.
- Weight math refuses it with a clear message.
**Sol (finding 29):**
- Item 33 also covers new **units and container types**, so they are handled together: unit conversions, allowed containers, the calculators and the database checks.
- "Seed" and "each" each need a defined form and unit before the CHECK is widened.

**Size / risk:** M. Migration (CHECK superset). Needs Mason's list first.

### Phase E: bulk import and bulk update

#### WP-PM-10 · Bulk import is safe and clear
**Items:**
- 10: rejects common spellings, with no row or reason.
- 11: silently skips rows and maps columns wrongly.
- 12: allows container size 0.
- 19: duplicates.
- 29: compliance columns and a template.

**Approach.**
- Normalize values before saving ("Liquid" → `liquid`, "jug" → `Jug`).
- Show a per-row preview with errors and reasons before anything is saved.
- Use a real CSV parser (quotes, line breaks).
- Remove ambiguous column aliases ("unit", "type").
- Container size must be > 0.
- Warn on name, SKU or EPA matches with existing products, with an option to skip them.
- Add RUP, signal word, REI/PHI, max label rate and notes columns, plus a downloadable template.

**Done when:**
- Importing a test file with 10 known-bad rows shows each bad row with its reason, and saves only what the user confirms.
- Re-importing the same file offers to skip the duplicates.
- A quoted note containing a line break imports intact.
- The template round-trips.
- All proven on local dev against test data, never by importing into live.

**Sol (findings 30–31):**
- **Same rules as manual edits.** Import isn't screen-only: it hits the same database constraints (from WP-PM-8) and the same pricing RPC rules as a manual edit.
- **Duplicates.** Define which matches are real duplicates and which are allowed variants (the same chemical in another size).
- **Repeat-safe import.** The import runs as a repeat-safe operation with a stated result: all-or-nothing, or exactly which rows saved.
- **Testing.** Test malformed files, column mapping, regulated fields and a partial failure against the local database.

**Size / risk:** M. Probably a migration (an import RPC).

#### WP-PM-11 · Fix many products at once
**Items:** 28 (bulk update of existing products), 39 (list edit mode turns ~600 rows into edit boxes).
**Approach.**
- **Recommend:** extend the full Excel workbook route (already reviewed for prices) to non-price details, with the same preview-and-acknowledge pattern.
- For the list: edit one row at a time (or a page of rows), add an unsaved-changes warning, and a phone card layout.
- **Brainstorm for Sol:** should detail changes go through the price workbook's RPC, or a separate one? A separate one is likely, to keep price approvals clean.
**Done when:**
- An admin fixes the signal word on 20 products through one upload, sees a preview of exactly those 20 changes, and confirms.
- History shows the changes.
- Leaving the list with unsaved edits warns.
**Sol (finding 32 and the PM-11 question):**
- **Split it.**
  - **11a:** the bulk detail upload. It uses a separate, repeat-safe detail-change RPC, not the price workbook's, because price approval and detail rules differ. The preview shows the exact field changes, and the same values are committed in one step.
  - **11b:** the ~600-row list editing and the phone layout.
- **History.** "History shows the changes" needs the audit table, so WP-PM-12a moves before this package.

**Size / risk:** M–L. Migration (a new RPC).

### Phase F: history and downstream records

#### WP-PM-12 · Who changed what, and records that copied old values
**Items:**
- 30: history says only "updated".
- 31 ❓: correcting REI/PHI or EPA may not reach open jobs or invoices.

**Approach.**
- **#30:** a database trigger writes before/after values for setup fields into a product change-history table, readable by staff. Cost stays in `cost_history`, admin-only. Show it on the product page.
- **#31:** confirm first which records copy these values.
  - Posted invoices must keep what was printed: they're regulated records.
  - Open, unposted jobs could offer "refresh from product".
  - **Brainstorm for Sol and Mason:** which records should follow a correction?

**Done when:**
- Changing a product's signal word shows "who, when, old → new" on the product page.
- The rule for #31 is written down, and either implemented or confirmed unnecessary.

**Sol (findings 33–34):**
- **Split it.** **12a** is the change-history foundation; it moves early (section 4). **12b** is corrections to existing records.
- **12a's history table:**
  - row level security, with records nobody can edit;
  - who changed it is taken from the database session, never sent by the screen;
  - before and after values are written in the same step as the change;
  - cost fields stay out of the staff-visible history;
  - tested through direct updates, RPCs, imports, and each role's access.
- **12b first maps every record** that copies or reads EPA, REI or PHI: jobs, quotes, invoices, labels, RUP records.
  - Open records can review a correction.
  - Posted invoices stay as printed. A wrong posted record goes through a formal correction, never a silent edit.

**Size / risk:** M. Migration (new table plus trigger).

### Phase G: later / database-heavy

#### WP-PM-13 · Show reorder point and stock on the product page
**Item:** 43. Read-only display, with a link to Inventory to edit it. Small; no database change.
**Done when (Sol, finding 35):**
- The stock number shown matches the Inventory page for the same product, with the location (or total), unit and "as of" time stated.
- The reorder point matches Inventory.
- The link opens that product's inventory.
- Checked on a product with stock and one without.

**Parked:**
- **18** (return policy, full-tote-only, packaging, families): Mason, "Later".
- **38** (EPA lookup fills new products): folded into the data model's EPA auto-fill (WP-4).

## 2a. Changes from the grand plan (2026-10-29)

**New packages:**
- **WP-PM-14 · RUP "known incomplete" notice** (grand plan overlap 10). The RUP flags are known to be incomplete ("there are a lot more"). Wherever the RUP register or RUP counts are shown, a notice says they are incomplete until the flags are reviewed (DATA-7). Screen only.
  *Done when:* the notice shows on every RUP register and count screen, checked by hand; one change removes it when DATA-7 is done.
- **DM-0 · Data hygiene**, moved here from the weight work (grand plan overlap 9). Every product gets a form. Blank SKUs (Mason types them, no placeholders, D-R), the duplicate `9768NR` SKU (re-SKU, don't merge), three duplicate-name groups and the test row are resolved without hard deletes. The code builds review lists; the data step is Mason's.
  *Done when:* zero blank forms; every SKU identifies one sellable; every old reference still resolves (read-only check before and after). WP-PM-10 and WP-PM-11a land only after this data step.

- **WP-PM-15 · 💲 Vendors on the product page** (grand plan overlap 12; Mason, 2026-10-29: one product, many vendors). Built on the existing `product_supplier_links` (one preferred link per product is already enforced) and `supplier_price_observations`. The product page lists every vendor the product is bought from, with item name, item number, pack and last cost (cost admin-only), and one preferred. `products.vendor` becomes a read-only copy of the preferred vendor's name, kept in step by the database on preferred change, rename and unlink; a product with links always has exactly one preferred. A new PO suggests the preferred vendor and its last cost converted to the PO's unit (none if it can't be converted), and allows any linked vendor; an unlinked vendor offers to link. Need Reordering groups by preferred vendor and shows the others' last cost. Cost stays admin-only in the database. Old POs, receipts and invoices keep their vendor. Full rules: grand plan overlap 12.
  *Done when:* a product linked to two vendors shows both, with one preferred; changing the preferred vendor updates the product's vendor everywhere it is shown; a new PO suggests the preferred vendor and its last cost and accepts the other; a second preferred link is refused; a non-admin sees no cost; all proven in the harness and the local app.

- **WP-PM-16 · "View label" link** (grand plan overlap 15; Mason, 2026-10-29). Every product with an EPA number gets a "View label" button on the product page, and each brand row one for its own EPA number, opening EPA's public label search for that number (address format confirmed at build time). No EPA number shows "Add an EPA number to see the label". Screen only; Stage 2's REG-1 later saves the label PDF link.
  *Done when:* on three real products with EPA numbers and one brand row, "View label" opens EPA's page for that exact number; a product without a number shows the hint; nothing is written.

**Changed packages:**
- **WP-PM-5:** each option has a stable code, a timing code ("Post-Emerge" and "Post-Emergence" are both `post_emergence`) and an optional crop, so later crop and timing pairs need no relabelling.
- **WP-PM-6a:** Mason approves each row where `unit_size` and `inventory_unit` disagree; old billed units and amounts never change; the package lists every remaining `unit_size` reader.
- **WP-PM-6b:** basic Duplicate only. After PAR-1 (Stage 2), Duplicate becomes "Add a size" or "New product" (grand plan overlap 13). DM-5 is dropped.
- **WP-PM-8:** the rate help text is worded so it stays true after the rate rebuild.
- **WP-PM-9:** no unit aliases. Each new spelling gets its exact conversion row, allowed form and container rule, added and tested before any product uses it (`validate_product_units` matches exactly).
- **WP-PM-10:** rates are written through one function.
- **WP-PM-11a · the setup workbook** (grand plan overlaps 5 and 11; Mason, 2026-10-29): one file, separate from the price workbook, with Setup, Rates, and Vendors and pack sizes tabs (Stage 2 adds Ingredients, Weights and Crop Uses). Each tab has its own repeat-safe RPC and a preview; nothing saves until confirmed. Rates are editable here during setup, through the one rate-writing function, and the price workbook's rate columns become read-only. A **"Lock rates"** switch locks the live rates in the database, whatever route writes them (drafts from the later rate rebuild stay editable); switching it is logged with a reason, and who may switch it is grand plan question 11. The one exception while locked is a dedicated one-product admin correction with a reason, expected version and retry key. Confirmation is per tab; a stale row is refused by name. Full rules: grand plan overlap 11. *Added to Done when:* with the lock off, a Rates-tab upload changes 20 rates after the preview; with it on, the same upload, an import and a list edit are each refused; an admin's single-product edit with a reason still works and is logged.

---

## 3. After the Product Master work: weight per gallon, then active ingredients (To-Do 2.9)

These follow `docs/plans/2026-10-28-product-data-model-REFRESH.md` and are summarized here so the full order is in one place. Each is its own PR with its own "done when" in that plan.

1. **DM-0 Data hygiene.** Every product gets a `product_form`; EPA formats are checked. This overlaps WP-PM-8 and 9, so do it with them.
2. **DM-2 Weight per gallon.**
   - Liquids store lb/gal, and dry packages net weight.
   - The **loader worksheet and blend ticket** show weight; a missing weight is refused by name.
   - *Done when:* a test blend with three liquids shows each product's weight and the total, matching a hand calculation, and a product with no weight is refused by name.
3. **DM-1 Active ingredients.**
   - Actives and strength per product, with a fast entry screen.
   - Admin-only cost per lb of active.
   - *Done when:* two products with the same active show comparable lb-of-active per gallon and cost per lb, checked by hand on two real labels.
4. **DM-4 EPA auto-fill** (includes item 38).
5. **DM-5 Copy from a sister product: dropped (2026-10-29).** One parent record per chemical (grand plan PAR-1, first in Stage 2) holds the shared values for every size, so nothing needs copying; the nickname moved to PAR-1.

**Sol (finding 36):** the weight and ingredient math must state:
- exact unit factors;
- the density and strength bases (% by weight vs lb per gallon; acid equivalent vs active ingredient);
- integer-cent rounding;
- what happens when a conversion would produce fractional cents.

Hand-check one dry and one liquid example, a missing weight, and two real labels before claiming two products are comparable.

---

## 4. Order and dependencies (final, after Sol's review)

Sol's recommended order is adopted. The change-history foundation and the database checks come before the workflows that rely on them, and the large mixed packages are split.

**Revised 2026-10-29 by the grand plan (its section 5).** This order replaces the 2026-10-28 one:

| Order | Package | Depends on | Database change | 💲 |
|---|---|---|---|---|
| 1 | WP-PM-1 Dropdowns | none | no | |
| 2 | WP-PM-14 RUP "known incomplete" notice | none | no | |
| 3 | WP-PM-16 "View label" link | none | no | |
| 4 | WP-PM-2 Pricing page | none | no (option a) | 💲 |
| 5 | WP-PM-4 Sales sheet and list | none | no | 💲 |
| 6 | WP-PM-12a Change-history foundation | none | yes (new table + trigger) | |
| 7 | WP-PM-3 Turning products off | PM-12a | yes (RPC + guard) | |
| 8 | WP-PM-8 Setup checks in the database | PM-1, PM-12a | yes (constraints) | |
| 9 | WP-PM-9 Product forms, units, containers | Mason's list; PM-8 | yes (CHECK superset, conversion rows) | |
| 10 | DM-0 Data hygiene | PM-8, PM-9 | review lists; Mason's data step | |
| 11 | WP-PM-5 Use Timing | PM-1, PM-8 pattern | yes, Mason-gated grants | |
| 12 | WP-PM-6a Unit audit + one canonical priced unit | PM-8, PM-9 | yes | 💲 |
| 13 | WP-PM-6b New-product flow + basic Duplicate | PM-6a | maybe | 💲 |
| 14 | WP-PM-7 One cost path + tier-order warning in the RPC | PM-2, PM-12a | yes (preview RPC) | 💲 |
| 15 | WP-PM-15 Vendors on the product page | PM-7 | yes (sync trigger, preferred rule, read policies) | 💲 |
| 16 | WP-PM-10 Bulk import | PM-5, PM-8; lands after DM-0's data step | probably (import RPC) | |
| 17 | WP-PM-11a Setup workbook + rate lock | PM-8, PM-12a, PM-15; lands after DM-0's data step | yes (RPCs, lock setting, rate-column guard) | |
| 18 | WP-PM-11b List editing + phone layout | PM-1 | no | |
| 19 | WP-PM-12b Corrections to existing records | PM-12a | likely | |
| 20 | WP-PM-13 Reorder display | none | no | |
| then | Grand plan Stage 2: PAR-1, PAR-2, DM-2, DM-1, REG-1, DM-4, DM-1b | PM-6a, PM-8, PM-9, DM-0 | yes | 💲 (DM-1) |

**Running in parallel.** Packages 1 and 4 (dropdowns, change history) touch different files, so they could run in parallel sessions. Packages 2 and 3 both touch `Products.tsx`, so build them one after the other.

## 5. Open questions

**For Mason (business calls). All five were answered 2026-10-28, each as recommended ("1.yes add seed and each/unit, 2. Yes 3. Yes. 4. Yes. 5. No"):**
1. Add the forms **seed** and **each/unit**.
2. Stock on hand, crop programs and scheduled jobs **warn but allow**.
3. Open jobs **offer to update** after a correction; posted invoices never change.
4. A fully delivered, not yet invoiced order **blocks** deactivation until it is invoiced.
5. **No** Use Timing on other categories; changing the category clears it after a confirm.

The questions as asked:
1. **Product forms (WP-PM-9):** which forms besides liquid and dry? For example seed, biological, "each/unit" items. Recommend: seed and each, for now.
2. **Deactivation warnings (WP-PM-3):** stock on hand, crop programs and scheduled jobs warn but don't block. Confirm.
3. **Corrections reaching existing records (WP-PM-12, #31):** when a product's REI/PHI or EPA number is corrected, should open (unposted) jobs offer to update? Recommend yes for open jobs; posted invoices never change.

4. **A fully delivered but not yet invoiced order (WP-PM-3, from Sol):** does it still stop a product from being turned off? Recommend **yes**, until it is invoiced, so the invoice can still find the product.
5. **Timings on other categories (WP-PM-5, from Sol):** should a product that isn't Herbicide or Foliar Fertilizer be able to keep a Use Timing? Recommend **no**: changing the category clears them after a confirm.

**Engineering questions:** answered by Sol on 2026-10-28 and folded into each package's "Sol:" notes:
- WP-PM-3: both an RPC and a database guard.
- WP-PM-5: `text[]` with an options table.
- WP-PM-6a: audit before any back-fill.
- WP-PM-7: map every cost writer first.
- WP-PM-11a: a separate RPC.
- Proof: a schema-matched local database.

## 6. Sol review record (2026-10-28)

**Reviewer:** `gpt-6-sol`, high effort, advisory, read-only. It was given this sheet, the backlog and code excerpts from `ProductDetail.tsx`, `Products.tsx`, `Combobox.tsx`, `JobDetail.tsx` and `cropProgramHelpers.ts`, plus status values from the schema registry.

**Run checks:** the run was validated (exit 0, start and tail canaries echoed, one verdict line). Result: 36 findings: 1 BLOCKER, 17 HIGH, 16 MED, 2 LOW. Its code quotes were spot-checked against `main`: `Combobox.tsx:168` (`aria-selected` follows the highlight), the direct updates at `Products.tsx:663-673`, the "Gross Margin = Markup" label at `ProductDetail.tsx:1472`, and the `orders.status` values.

**Disposition:** every finding was accepted and folded in as a "Sol:" note on its package, plus section 1 rules 9–11 and the new order in section 4. None was refuted.

| Findings | Where it landed |
|---|---|
| 1, 2 | Section 1, rules 10–11 (proof environment; name permission changes) |
| 3–5 | WP-PM-1 |
| 6–8 | WP-PM-2 |
| 9–14 | WP-PM-3 |
| 15–16 | WP-PM-4 |
| 17–19 | WP-PM-5, plus Mason question 5 |
| 20 (BLOCKER), 21–23 | WP-PM-6, split into 6a and 6b |
| 24–25 | WP-PM-7 |
| 26–28 | WP-PM-8, plus section 1 rule 9 |
| 29 | WP-PM-9 |
| 30–31 | WP-PM-10 |
| 32 | WP-PM-11, split into 11a and 11b |
| 33–34 | WP-PM-12, split into 12a and 12b |
| 35 | WP-PM-13 "Done when" |
| 36 | Section 3, the data-model math |

**Effect on scope.** More packages now carry a database change (PM-3, PM-7, PM-8, PM-10, PM-11a, PM-12a). Rules are enforced in the database rather than only on screen, as the hard rules require. That makes the work more reliable but larger than first sketched.
