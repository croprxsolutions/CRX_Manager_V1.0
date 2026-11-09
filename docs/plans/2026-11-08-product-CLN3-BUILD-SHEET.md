# Product Stage 8 build sheet: CLN-3, the name-vs-brand check (B-16)

**Status: PLAN, 2026-11-08. NOT STARTED.** This sheet turns CLN-3 of `docs/plans/2026-10-29-product-GRAND-PLAN.md` (Stage 8, section 6; order item 7 in section 8) into one package that can be built, in the format of `docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md`. Nothing here authorizes building; the package starts when Mason says so.

**The grand plan's whole requirement:** "a report lists every product name whose brands in brackets disagree with its brand rows, and changes nothing." The problem it closes is B-16 (`docs/plans/2026-08-18-product-data-model-MASTER-RECORD.md`): one product name carries the acceptable brands in brackets, and since August the brand list also lives in rows (`docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md`, B-16 row: "name↔row drift is unaddressed and needs its own check").

**Where this sheet and the grand plan disagree**, this sheet wins for CLN-3 *how*; the grand plan wins on order and on Mason's settled decisions. Section 2 lists each difference.

**Words used below.**
- *Brand list*: the brands a size may be filled with, by the rule `get_product_brands` uses today: for a size that belongs to a parent **and** the grouping switch is on, the parent's `product_parent_brands` rows with `status = 'active'`; otherwise the size's own `product_brands` rows. This is the same definition the Brand PR B sheet uses (`docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md`, "Words used here").
- *Name brands*: the brand names written inside round brackets in a product's name, after the clean-up rules in section 4.
- *Disagree*: a name brand that is not on the brand list, or a brand-list brand that is not in the name.

**Examples in this sheet are made up.** The repository is public, and real product names never go in a tracked file (`scripts/db-invariant-sweeps/README.md`, "Output containment"). Counts are fine.

---

## 1. Code and live facts behind this sheet

Read-only checks of `main` (`4504e3e6a`) and the live database on 2026-11-08 (one `BEGIN READ ONLY` session; counts and bracket shapes only). Re-check each one at build time.

**Live counts.**

| Fact | Value |
|---|---|
| Products | 604 (596 active) |
| Names with ` - <size>` at the end | 561 |
| Names with a round bracket `(` | 136 |
| ... with a comma inside the brackets (a list) | 76 |
| ... with one item inside the brackets | 58 |
| ... with two bracket groups | 1 (one group is a note, the other a brand list) |
| ... with an opening bracket that is never closed | 2 (the name was cut off, so the size ended up inside the list) |
| Names starting `Gen` / `Generic` | 91 |
| Names with square brackets `[ ]` | 3, all a short code at the front, never brands |
| `product_brands` rows (per size) | **0** |
| `product_parents`, `product_parent_members`, `product_parent_brands` rows | **0** each |
| Grouping switch `_product_parent_grouping_open()` | body is still `SELECT false` (off) |
| `pg_trgm`, `fuzzystrmatch`, `unaccent` extensions | none installed |

**What is inside the brackets today (shapes, not names).** Most groups are brand lists ("Brand A, Brand B 4L, Brand C"). The rest are notes that are **not** brands:
- numbers and ratios: a percent alone (9 names), `50/50` and `80/20` (10), a fertilizer analysis like `0-0-24` (2);
- words: `retired` (7), a "no return, full tote" note (1), a "full pallets" note (1);
- short ingredient or form notes such as a nitrogen or chelate code (about 6).

Typing slips seen in the lists: a double comma (an empty item), a leading space, a double space between words, and at least one brand name with two letters swapped.

**Where brands are stored (current `main`).** Migration file stamps in this repo run ahead of the calendar, so a December stamp is not a sign of a future change. Each object below was confirmed to exist on live on 2026-11-08 (`to_regclass` / `to_regprocedure`, read only): `product_parent_brands`, `product_parent_members`, `get_product_brands(uuid)`, `get_product_grouping_open()`.
- `product_brands` (`supabase/migrations/20261022086500_product_brands.sql`): one row per brand per size; `brand_name` is trimmed, unique per size ignoring case. RLS: `SELECT` for active users; no browser writes.
- `product_parent_brands` (`20261123120000_product_parent_proposals.sql:286`): one row per brand per parent, `status` `active` or `retired`; same trim rule; `SELECT` for active users.
- `product_parent_members` (`20261108120000_product_parents.sql:138`): `product_id` is the primary key (**no `id` column**), `parent_id`. `SELECT` for active users.
- `get_product_brands(p_product_id)` (`20261123120000…:1215`) is the rule in "Words used below". It reads one product per call.
- `get_product_grouping_open()` (`20261202130000_product_grouping_open_read.sql:35`): admin-only read of the switch.

**What Brand PR B changes (sheet on branch `claude/brand-prb-build-sheet-da19f0`, read 2026-11-08, not yet merged).** PR B records which brand was **delivered** on each delivery line (`delivery_item_brands`), snapshots it onto invoices and RUP records, and keeps a review list of brands typed by hand. It leaves `get_product_brands` and what a brand list contains unchanged. Its only change to the brand tables is a new unique key `(parent_id, id)` on `product_parent_brands` (for its own foreign key), and its writers row says `upsert_parent_brand` and `upsert_product_brand` are "Unchanged by PR B" (REG-1 re-issues them). PR B also adds `_delivery_line_brand_list`, a second database copy of the same brand-list rule (risk 1). So **the brand list this check compares against means the same thing before and after PR B.** A brand typed by hand on a delivery is not on the brand list and is not part of this check; PR B's own review list handles it.

**A close precedent.** The EPA data-quality check started as a token-gated script (`scripts/epa-data-quality-report.mjs`) that Mason could not run, and was then rebuilt as the admin page `/label-data-quality` (`src/pages/LabelDataQuality.tsx`; `docs/CHANGELOG.md`, the "New admin-only page `/label-data-quality`" entry).

**A bracket reader already exists.** `suggestBrandNamesFromProductName` (`src/lib/productBrands.ts:124-143`, tests `productBrands.test.ts:31-47`) suggests brands from the name on the product page's Brands section (`ProductBrandsSection.tsx:204`). Its rules differ from section 4: it splits on `/` (so `50/50` becomes two suggested "brands"), ignores an unclosed bracket and has no note filter. CLN-3 replaces its inside with the shared reader (section 3), so the brands Mason is offered and the brands the report compares use one set of rules. The same page already reads products in pages of 1000 with `fetchAllRows` (`src/lib/pagedRead.ts:73`; `LabelDataQuality.tsx:373-391`).

**A related predicate.** `scripts/db-invariant-sweeps/predicates/product-name-vs-return-policy.sql` checks another fact carried in names. It is a standing sweep that must return zero rows; CLN-3 cannot be one (section 3).

## 2. Corrections to the grand plan, from current code

| # | Grand plan | Today | This sheet |
|---|---|---|---|
| 1 | CLN-3 comes after brand PR B (section 8, item 7) | PR B does not change brand storage or `get_product_brands` (section 1) | No technical dependency on PR B. The check is equally correct before and after it. It depends only on the brand tables, which are live. Mason chose to build it before brand entry (section 9). |
| 2 | "brand rows" | A grouped size's rows are its parent's, once the grouping switch is on; its own legacy rows are frozen history | Compare with the brand list (the `get_product_brands` rule), never with legacy rows of a grouped size |
| 3 | "a report" (form not given) | The owner cannot run scripts (the EPA-check precedent) | An admin-only section on the existing Label Data Quality page (section 3 gives the reasons; a technical choice, not one for Mason) |

## 3. Where the report lives

**Chosen: a section on the admin page `/label-data-quality`, built from the browser's normal read access. No migration, no new function, no change to any table.**

Why, against the other two options:
- **A database view or function** would need a migration (Sol review, the apply gate, a live apply) for something an admin can already read: all four brand tables and `products` allow `SELECT` to active users. The bracket rules are easier to write and test in TypeScript than in SQL regular expressions, and there is no fuzzy-match extension in the database for the typo hint.
- **A script, or a db-invariant sweep:** a sweep must return zero rows and fails `npm run db-sweeps:live` otherwise; this report is expected to list rows for months while brands are entered. A script needs an agent every time Mason wants to look. Either way its output holds product names, which must never be pasted into the repo.
- **The page** keeps the names inside the signed-in app, lets Mason open it whenever he enters brands, and changes nothing.

**Files** (none on `docs/reference/sol-required-paths.md`; no money word in any name, checked against `MONEY_PATH_WORDS`):
- `src/lib/productNameBrands.ts` (new): the pure functions `parseNameBrands(name)` and `compareNameBrands(nameBrands, brandList)`, plus `brandListFor(productId, members, legacyBrands, parentBrands, groupingOpen)`, which applies the `get_product_brands` rule to rows already loaded. One comment in that function names `get_product_brands` as the rule it copies.
- `src/lib/productNameBrands.test.ts` (new): the cases in section 4 and the rule cases in section 5, with made-up names only.
- `src/lib/productBrands.ts` and `src/lib/productBrands.test.ts`: `suggestBrandNamesFromProductName` keeps its name and its "leave out names already listed" behaviour but takes its brands from `parseNameBrands(name).brands`. Its existing tests are updated in the same PR (it stops splitting on `/` and stops suggesting notes; on live every `/` inside a bracket is a ratio such as `50/50`, 10 names, and none separates brands); `ProductBrandsSection.tsx` is not touched.
- `src/components/products/NameBrandCheckSection.tsx` (new): loads the rows, runs the comparison, shows the table.
- `src/lib/pagedReadCallSites.test.ts`: one line adding `products/NameBrandCheckSection.tsx` to `COMPONENT_FILES` (every component that pages with `fetchAllRows` must be listed there, or that test fails).
- `src/pages/LabelDataQuality.tsx`: one import and one line that places the section under "Label field coverage". Nothing else on the page changes.
- `docs/manual/CURRENT_STATE.md`: one line saying it shipped. No changelog note (no migration).

**What the section reads** (all through `src/lib/db.ts`, all `SELECT`, each paged with `fetchAllRows`, `{ count: 'exact' }` and a stable order; the parent tables are not in the generated types, so those reads use `supabaseUntyped`, as `src/lib/productParentProposals.ts` does):
- `products`: `id, product_name, is_active`, ordered by `product_name, id`;
- `product_brands`: `id, product_id, brand_name, is_currently_sourced`, ordered by `id`;
- `product_parent_members`: `product_id, parent_id`, ordered by `product_id` (the table has no `id` column);
- `product_parents`: `id, name`, ordered by `id`, so a grouped size's row can name the parent its list comes from;
- `product_parent_brands`: `id, parent_id, brand_name, status, is_currently_sourced`, ordered by `id`;
- `get_product_grouping_open()` once, through the existing `loadGroupingOpen()` (`src/lib/productParentProposals.ts:148`), which throws on error.

The page already loads parent names through `get_product_parents` (`LabelDataQuality.tsx:450-462`), but that load hides its errors, so the section does its own reads instead of borrowing it.

**All or nothing.** The section waits for all six reads. If any one fails (any table page or the switch), it shows one error and no rows, never a partial report: a failed `product_brands` read would otherwise put real branded products in "no brand list yet". **One load at a time:** Reload is disabled while a load runs, and each load carries a number; a result is shown only if its number is the latest, so a slow older load can never overwrite a newer one.

Five table reads and one switch read for the whole catalog, instead of 604 `get_product_brands` calls. The cost is that the rule is copied (risk 1).

## 4. How the brackets are read

`parseNameBrands(name)` returns `{ brands: string[], notes: string[], unclosed: boolean }`. "Normal form" below is what two names are compared in; the page always shows the original spelling.

1. **Only round brackets count.** Square brackets are a code at the front of three names, never brands.
2. **Every bracket group is read**, left to right. Text outside the brackets (the `Gen` prefix, the formulation, ` - 2.5 Gal`) is ignored.
3. **An opening bracket with no closing bracket** reads to the end of the name and sets `unclosed`, which the page shows as "bracket not closed in the name". Its last item is usually the size that ended up inside it: if the group ends in ` - ` (or an en or em dash) followed by a size (rule 6's size shape), that tail is cut off first, and a last item that is a size on its own is dropped by rule 6. So `(Brand A, Brand B - 2.5 Gal` and `(Brand A, Brand B, 2.5 Gal` both read as Brand A and Brand B.
4. **Split on commas and semicolons only.** Not on `/` (used in `50/50`), not on `&` or "and" (a brand name may contain them), and not on a comma between two digits (`2,4-D` is one name; live has 6 product names with that shape, none inside brackets today).
5. **Normal form of each item:** remove `®`, `™` and `©`; turn every run of spaces, tabs, hyphens (`-`, `–`, `—`) and underscores into one space; trim; lower-case. Periods and digits stay (`5.4` and `54` are different products). So `Brand-X  4L`, `brand x 4l` and ` Brand X 4L` are one brand; an empty item from a double comma disappears.
6. **Items that are notes, not brands,** go to `notes` and are never compared:
   - an item with no letters at all (percent, ratio, fertilizer analysis);
   - a size: the whole item is a number (digits with at most one decimal point) and a unit, nothing more (`2.5 gal`, `265g`, `12#`; an item like `4L Shield` stays a brand). Units: `gal`, `g`, `#`, `lb`, `lbs`, `oz`, `qt`, `pt`, `l`, `ml`, `kg`, `ton`, `tote`, `bulk`, `case`. **Known limit:** an item that is only a formulation code with a size-like unit (`4L`, `15G`) is read as a size. Live has one such item, the last item of an unclosed group, and it really is a size; a test pins this behaviour;
   - *not* a note: a percent followed by letters (`25% N`-style nutrient notes, 2 items on live) stays a brand under these rules and is counted in risk 2;
   - a formulation code inside a brand (`Brand B 4L`, `Brand C 2EC`, `Brand D 3.6F`) is **never** stripped: it is part of the brand's name, and `Brand B 4L` and `Brand B 4F` are different products. If the name says `Brand B 4L` and the list says `Brand B`, the report shows the difference, which is the truth; Mason makes the two spellings match;
   - a short fixed list: `retired`, `no return`, `full tote`, `full pallets`, `full pallet`. The list is in one constant with a comment; adding a word is a one-line change plus a test.
   Notes that are words but not on the list (an ingredient code, for example) are treated as brands. On a product with no brand list they only appear in the "no brand list yet" group; on a product with one they show as "in the name, not on the list", which is the truth. The page never hides a row to look cleaner.
7. **Several brands, one name:** each is compared on its own; order does not matter; a brand repeated in the name counts once.
8. **No brackets:** `brands` is empty.

**The list side** gets rule 5 only: a brand-list name is never split or filtered, so a list brand called `2,4-D Amine` or one carrying `®` still matches the same name in brackets.

**Comparing** (`compareNameBrands`): sets of normal forms.
- *In the name, not on the list* and *on the list, not in the name*: each listed with its original spelling.
- *Possible spelling difference:* when one entry on each side is within two letter changes of the other (edit distance ≤ 2, and the shorter name has at least 5 characters), the page shows them side by side as "spelled differently?" instead of as two separate problems. Pairs are made closest first, and each entry is used in at most one pair. **No hint when the two differ only in digits or in a trailing formulation code** (`Brand B 4L` against `Brand B 4F`), because those are different products. This is a hint only; it never counts as a match. About 20 lines, tested, no library.
- A brand on the list that is **not currently sourced** and missing from the name is still shown, marked "not currently sourced", because Mason may have left it out on purpose.

## 5. What the page shows

One table, admin only (the page is already admin only: `src/appPages.tsx:411`). Each row is one product (size). Grouped sizes are each listed, because each size has its own name.

| Group | Meaning | Shown |
|---|---|---|
| **Disagrees** | The name has brands and the brand list has brands, and they differ | Name, active or not, in name only, on list only, spelled-differently pairs, and where the list comes from (this size, or parent "<name>") |
| **Brands in the name, no brand list yet** | The name has brands; the brand list is empty | Name and the name brands. This is a worklist for brand entry. On 2026-11-08 the 107 products whose brackets hold brand names fall here, because live has 0 brand rows; the other 29 bracketed names hold notes only and appear in no group. |
| **Brand list, no brands in the name** | The name has no brand brackets; the brand list has brands | Name and the list |
| **Bracket not closed** | `unclosed` | A flag on whichever group the row is in; a product in no other group is still listed here, so no unclosed name is hidden |

Products that agree, and products with neither, are counted at the top (for example "N products agree; M have no brands in the name or the list") but not listed. Inactive products are included and marked, because an inactive product's name can still disagree with its rows. The section shows when it loaded, has one Reload button (which only reads again) and writes nothing; each name links to the product page, where brands are edited as today.

## 6. Done when

All of these, observed, not only tested:

1. **Unit tests** (`productNameBrands.test.ts`) pass for: several brands; no brackets; two bracket groups (one a note); an unclosed bracket ending in a size, both as its own item and as ` - 2.5 Gal` on the last brand; a double comma; leading, trailing and double spaces; hyphen versus space; different case; `®`/`™`; a percent, a ratio and a fertilizer analysis as notes; `retired` as a note; a one-letter and a two-letter typo (hint shown, still not a match); a three-letter difference (no hint); `Brand B 4L` against `Brand B 4F` (no hint); one name brand close to two list brands (closest pair only); the same brand twice; `2,4-D` kept whole; an en dash treated like a hyphen; a lone `4L` item read as a size (the known limit); a list brand with `®` matching a name without it. Rule cases: a grouped size with the switch on uses the parent's **active** brands only (a retired one is ignored), even when the parent itself is turned off (`get_product_brands` does not check the parent's `is_active`); the same size with the switch off uses its own legacy rows; an ungrouped size uses its own rows. The updated `suggestBrandNamesFromProductName` tests pass (no `/` split, no notes suggested).
2. **Real read-only sample, today's live data** (the page signed in as an admin, against production, which it only reads):
   - The "no brand list yet" group's count equals this read-only count, run in the same session (a SQL approximation of rules 3 to 6; on 2026-11-08 it returned **107** of 136 bracketed names, so 29 hold notes only). A difference is explained row by row before the package is called done.
     ```sql
     BEGIN READ ONLY;
     WITH items AS (
       SELECT p.id, lower(btrim(regexp_replace(regexp_replace(it, '[®™©]', '', 'g'), '[\s_–—-]+', ' ', 'g'))) AS item
       FROM products p,
            regexp_matches(p.product_name, '\(([^)]*)(\)|$)', 'g') g,
            regexp_split_to_table(
              regexp_replace(g[1], '\s+[–—-]\s+([0-9]+(\.[0-9]*)?|\.[0-9]+) ?(gal|g|#|lb|lbs|oz|qt|pt|l|ml|kg|ton|tote|bulk|case)\s*$', '', 'i'),
              '[,;]') it)
     SELECT count(DISTINCT id) FROM items
      WHERE item <> '' AND item ~ '[a-z]'
        AND item !~ '^([0-9]+(\.[0-9]*)?|\.[0-9]+) ?(gal|g|#|lb|lbs|oz|qt|pt|l|ml|kg|ton|tote|bulk|case)$'
        AND item NOT IN ('retired', 'no return', 'full tote', 'full pallets', 'full pallet');
     ```
   - "Disagrees" and "Brand list, no brands in the name" are empty, because live has 0 brand rows.
   - The SQL is slightly broader than the parser: it cuts a ` - size` tail from every group (rule 3 does so only for an unclosed one) and splits on every comma (rule 4 keeps `2,4`). Neither shape is inside a bracket on live today, so the counts agree; if they ever differ, the difference is explained row by row.
   - Ten rows of the "no brand list yet" group, chosen across the shapes in section 1 (a long list, a one-item list, the two-group name, both unclosed names), are checked by eye against their bracket text.
   - **How it runs before merge:** this branch's local dev build, signed in as Mason's admin user, pointed at production. The section only reads, so this needs no gate. The live-site screenshot (step 6) comes after deploy.
3. **Disagreement cases on the private test copy** (the same local test database the Stage 2 packages use; never live): seed brand rows so that one size agrees, one has an extra brand on the list, one is missing a brand from the list, one has a two-letter typo, one is grouped with the switch on (parent list used), and one is grouped with the switch off (own list used). The page shows each exactly as expected, and for every seeded product the list the page used equals what `get_product_brands` returns for that product. **Seeding steps,** because the app's writers refuse some of this: insert the parent, member and parent-brand rows directly as `postgres` (`upsert_parent_brand` refuses while the switch is off, `PRODUCT_PARENT_GROUPING_NOT_OPEN`); for the switch-on cases run `CREATE OR REPLACE` on `_product_parent_grouping_open()` to return `true` on the local copy only, and restore `false` for the switch-off cases; call `get_product_brands` as a signed-in active test admin (a real local session, or `set_config('request.jwt.claims', …)` with that user's id), because it refuses without `auth.uid()`.
4. **Failure and reload** (a component test with mocked reads): one failed table read shows the error and no rows; a slow first load finishing after a second load does not replace the second load's result.
5. **It changes nothing:** with the network panel open, press the section's Reload. It shows only `GET` requests to `/rest/v1/products`, `product_brands`, `product_parent_members`, `product_parents` and `product_parent_brands`, plus one `POST` to `/rest/v1/rpc/get_product_grouping_open` (an RPC read is sent as a POST); no `POST`, `PATCH` or `DELETE` to any table and no other RPC. (The page's own first load also calls `get_label_coverage_report` and `get_product_parents`; those are not this section's.)
6. Screenshot of the section on the live page after deploy (names blurred or not attached to the PR, because the repo is public) shown to Mason in the session.

## 7. Risks

1. **The brand-list rule is copied, not called.** If a later package changes `get_product_brands` (for example to include retired brands, or a new source), this page would compare against the old rule. After PR B there are three copies to keep in step: `get_product_brands`, PR B's `_delivery_line_brand_list`, and this page's `brandListFor`. Mitigation: the comment in `brandListFor` names the function; done-when step 3 compares the two; any future migration that re-issues `get_product_brands` adds `src/lib/productNameBrands.ts` to its file list. If that proves fragile, a later read-only RPC that returns every list at once can replace the copy (a migration, so only if needed).
2. **Non-brand words in brackets show as brands.** Some fertilizer and adjuvant names hold a note that is a word (about six today, such as an ingredient or chelate code), and they are counted in the 107. They are not added to the note list on purpose: a short code can also be a real brand name, and hiding a real brand is worse than showing a note. They show up in the "no brand list yet" group forever unless Mason enters brands or renames them. Accepted: hiding them would need guessing, and the grand plan says the report changes nothing.
3. **Typo hints can pair the wrong two brands** when two real brands differ by two letters. It is only a hint and never counts as a match.
4. **Names in a public repo.** Tests and this sheet use made-up names only; screenshots stay out of the PR.
5. **Size of the catalog.** Five paged reads of about 600 rows each is small. If the catalog grows tenfold it is still a few seconds on one admin page.
6. **The reads are not one snapshot.** If an admin changes brands or turns grouping on while the section is loading, one row can briefly show a false disagreement. The report is advisory and changes nothing, so this is accepted: the section shows the time it loaded and a Reload button, and a row is trusted only after a reload. A single database snapshot would need a new function and a migration (risk 1's upgrade path covers both).
7. **Overlapping edits to `LabelDataQuality.tsx`.** REG-1's screen PR (2b) and PAR-1's screen PR also edit this page. CLN-3 adds one import and one line, so a clash is a trivial merge; build it in whichever order they land.

**Sol list:** no (no listed path; no migration). Lands on green checks after Luna, held open 4 hours under Taha's rule. **Mason-gated:** no live action (no live write, no permission change). Build order is decided: before brand entry (section 9).

## 8. Order and dependencies

- **Can be built now.** Every table and function it reads is live on `main`. It does not depend on PR B (section 2, row 1).
- **Useful from** the first brand rows: Mason's brand entry for ungrouped sizes, or PAR-2's grouping data step for grouped ones. Before then it is a worklist of names that carry brands.
- **The grand plan's order** put it after PR B. Mason chose to build it early instead, as a brand-entry worklist (section 9).

## 9. Questions for Mason

**Decided, no answer needed:** the report is a section on the existing admin page **Label Data Quality**, so you can open it yourself any time, with no database change (section 3 gives the reasons).

**Decided (Mason, 2026-11-09: "I agree build report before typing in brands"): build it before brand entry starts.**
The report lists every product whose name has brand names in brackets that do not match the brands saved for that product. It changes nothing. Built first, it works as Mason's brand-entry worklist (today about 100 products whose names carry brands not entered yet; a few of those are notes, not brands), then as the check that the two stay in step. This replaces the grand plan's after-PR-B order; PR B does not change what this report reads, so nothing waits on it.

**No decision needed, but Mason should know:** when the report shows a disagreement, it does not say which side is right. You fix each one yourself, by renaming the product or by editing its brand list on the product page, as today.

## 10. Review record

| Round | Reviewer | Result |
|---|---|---|
| 1 (`d1afedcac`) | Luna, xhigh | 2 findings. MED: the read list lacked `product_parents`, so the page could not name a grouped size's parent (added; read count corrected). LOW: the sample SQL's size rule had no end anchor (anchored here and in rule 6; the live count stayed 107). |
| 2 (`ecee6419e`) | Luna, xhigh | 3 findings. MED: the sample SQL did not strip `®™©` like the parser (fixed). MED: separate reads are not one snapshot (accepted as risk 6: advisory report, load time and Reload shown). LOW: an unclosed bracket on a product in no group was hidden (now always listed). |
| 3 (`a87462895`) | Luna, xhigh | 4 findings. HIGH (refuted): "the brand tables may not be live yet" because of their December file stamps; every object was confirmed on live, now stated in section 1. MED: overlapping reloads (one load at a time, latest wins). MED: partial failure (all six reads or nothing). LOW: the size rule accepted malformed numbers (tightened in rule 6 and the SQL). |
| 4 (`44e94a208`) | Luna, xhigh | 2 findings. MED (refuted, already risk 2): word notes such as an ingredient code show as brands; kept on purpose, since a short code can be a real brand, and the count now says they are included. LOW: an unclosed group ending `- 2.5 Gal` kept the size on the last brand (rule 3 now cuts it). |
| 5 (`387782b3c`) | Luna, xhigh | 1 finding. LOW: the sample SQL did not cut rule 3's size tail (added; the live count stayed 107). |
| 6 (`ac1912221`) | Luna, xhigh | 1 finding. MED (refuted): "strip a size like `4L` from a brand". In crop chemical names `4L`, `2EC`, `3.6F` are formulation codes that belong to the brand name; stripping them would match two different products. Rule 6 now says so. |
| 7 (`577f2bcb5`) | Luna, xhigh | 1 finding. LOW: a stray closing bracket after the unit list (removed). No BLOCKER or HIGH in any round; this last commit only fixes that typo. |
| 8 (`82d3dff85`) | Independent Opus review (read-only, checked code and live) | 17 findings, none blocking; it confirmed every table, column grant, the rule and the 107 count. Fixed: reuse the existing bracket reader `suggestBrandNamesFromProductName` so suggestions and the report share rules; done-when 5 now checks the section's own requests (an RPC is a POST); `2,4-D` is not split; the live-data run is a local build that reads production; local seeding steps spelled out; `pagedReadCallSites.test.ts` added to the files; PR B wording corrected and its `_delivery_line_brand_list` added to risk 1; the `4L`-as-size limit, percent-with-letters notes, en dashes, typo pairing, inactive parents and the list side are now stated and tested; one docs file named; Decision 1 dropped (a technical choice, now made). Refuted: "there is no changelog file" (it is `docs/CHANGELOG.md`; the citation now names it). Not acted on: "rebase on current main" (the PR changes one new file, and the merge is pinned to its head). |
| 9 (`8d9c464ed`) | Luna, xhigh | 2 findings. LOW: "every bracketed product" overstated the worklist (now 107 of 136; 29 are notes only). LOW: the sample SQL did not treat en and em dashes like the parser (added; the live count stayed 107). |
| 10 (`a4203a039`) | Luna, xhigh | 3 findings. MED (refuted, same as round 2): the reads are not one snapshot; accepted as risk 6 because the report is advisory, shows its load time and a row is trusted only after Reload. LOW: dropping the `/` split could merge slash-separated brands; live has none (every bracketed `/` is a ratio), now stated. LOW: "Mason-gated: nothing" read as contradicting section 9; reworded. |
