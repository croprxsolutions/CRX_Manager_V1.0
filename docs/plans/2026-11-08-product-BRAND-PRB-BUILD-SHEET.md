# Product Master Stage 3: brand PR B build sheet (delivered brand, its EPA number, RUP records per brand)

**Status (2026-11-08):** this is a plan only. No code and no migration have been written. It was written on 2026-11-08 against `main` (`4504e3e6a`) and the live database, using read-only SQL only. For building, this sheet replaces "PR B" in `docs/plans/2026-10-22-product-brands-step1-PLAN.md` (sections 4, 5, 7 and 8). Where the two differ, this sheet wins, and section 2 lists each difference. A reference like "step 1 §4" means that plan.

**Cannot start yet.** The grand plan (`docs/plans/2026-10-29-product-GRAND-PLAN.md`, Stage 3 and overlap 13) says PR B is built only after the PAR-1/PAR-2 brand move is live and verified. Today it is not: the grouping switch is off and no parent or brand exists (section 1). PR B also has to be built on top of REG-1 step 2 (REG-DB), because both rewrite the same invoice and RUP functions. Section 9 has the full list.

**Words used here.**
- **Brand list:** the brands a size may be filled with. For a grouped size with the grouping switch on, this is its parent's `product_parent_brands` (active rows). Otherwise it is the size's own legacy `product_brands`. This is exactly what `get_product_brands` returns today.
- **Pick:** one brand recorded on one delivery line, with its amount. A line may have several picks (a split).
- **Listed pick:** a pick of a brand on the line's brand list. **Typed pick:** a brand typed by hand because it is not on the list (August D-K).
- **Snapshot:** the brand name and EPA number copied onto the pick (and later onto the invoice line) at the time, so later edits to the brand list never change history.
- **Branded line:** a delivery line whose product has at least one brand on its list, or that carries a typed pick.
- **Registration, sale capture, seeded:** as in the REG-1 sheet (`docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md`): the per-EPA-number record, the RUP and signal-word facts copied onto an invoice line when it is made, and whether the REG-1 seed has run.
- **The switch:** `app_settings` row `delivery_brand_required` (column `setting_key`), off by default. While off, nothing is ever refused for a missing brand.

---

## 1. Facts this plan is built on (checked 2026-11-08)

**Live data and switches (counts only):**

| Fact | Value |
|---|---|
| `product_brands` (legacy, per size) | 0 rows |
| `product_parents`, `product_parent_members`, `product_parent_brands` | 0 rows each |
| `epa_registrations` | 0 rows (REG-1 step 1 live; not seeded) |
| `_product_parent_grouping_open()` | returns `false` (PAR-2 grouping and brand move not switched on) |
| `delivery_item_brands`, any brand column on `delivery_items`, `invoice_items` or `rup_sales_records` | do not exist |
| `delivery_brand_required` setting | does not exist |
| Latest live migration | `20261215110000_chem_sale_bill_split_invoices` (Taha's #1524, merged as `b1a5c0e80`). This repo's migration stamps run ahead of the calendar on purpose (each new one sorts after the newest on main), so a December stamp on a November date is normal; the version was read from the live ledger. |

**Live tables PR B reads or extends:**

| Table | What matters |
|---|---|
| `product_brands` | `id, product_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup (nullable), signal_word, row_version`. Unique `(product_id, id)` and `(product_id, lower(brand_name))`. Strict EPA-number CHECK `^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$`. |
| `product_parent_brands` | Same brand columns plus `parent_id, status ('active','retired'), legacy_brand_ids uuid[]`. Unique active name per parent (partial index). **No unique `(parent_id, id)`**, so PR B adds one for its composite foreign key. Only `authenticated: SELECT` granted; one SELECT policy. |
| `delivery_items` | `id, delivery_id, order_item_id, product_id, quantity, unit_size, quantity_delivered, tote_number, quantity_prebooked_released`. Read policy `del_items_select`: admin, sales rep, or the delivery's assigned driver. |
| `invoice_items` | `epa_registration text` exists (no CHECK); `tote_number` is copied from the delivery at completion. REG-DB adds the sale-capture columns and the line guard (REG-1 sheet §3.1, §3.3). |
| `rup_sales_records` | `invoice_id, product_id, product_name, epa_registration, quantity, unit, unit_price_cents, total_cents, signal_word, compliance_status, compliance_notes, voided_*`. `idx_rup_sales_records_active (invoice_id, product_id) WHERE voided_at IS NULL` is **not unique**; the one-record-per-product rule lives only in the function. |

**Live functions PR B changes or builds on:**

| Function | Latest source | What PR B relies on |
|---|---|---|
| `get_product_brands(p_product_id)` | `20261123120000_product_parent_proposals.sql` | Returns the parent's active brands when the size is grouped and the switch is on, otherwise the size's legacy rows. PR B uses the same rule (section 3.2). |
| `upsert_parent_brand`, `upsert_product_brand` | `20261203110000`, `20261123120000` | Unchanged by PR B. REG-DB re-issues both. |
| `_complete_delivery_authorized_impl` | `20261215110000…:950` | Authorizes admin, sales rep or the assigned driver (`:1015`); sets status `completed` **before** the loop that writes `quantity_delivered` (`:1100-1117`); then copies `tote_number` to this delivery's own invoice lines (`:1158-1168`); then drafts either the Bill Split invoices or one automatic invoice (`:1360-1416`). |
| `_create_bill_split_delivery_invoices` | `20261215110000…:503` | One draft invoice per payer for one delivery, each with `delivery_id` set; each payer's line holds that payer's share of the delivered quantity (`:537-584`). New since step 1 was written. |
| `_create_invoice_for_unbilled_delivery_impl_20260718` | `20261215110000…:1515` | Recovery path that bills a completed delivery. |
| `_create_invoice_from_order_impl` (whole-order) and `_create_split_invoices_from_order_provenance_impl` (landlord split) | `20260827041400`, `20261029160000` | Insert lines with no `delivery_id`. |
| `save_invoice` | public body `20261019230000…:535` | Deletes and re-inserts every line; REG-1 carries capture values through an old-line-ID map. |
| `generate_rup_sales_records(p_invoice_id, p_idempotency_key)` | `20261204100000_ki18_batch1_chicago_today.sql` | Reads lines `JOIN products WHERE p.is_rup`, copies the **product's** EPA number and signal word, and skips a line when an active record already exists for `(invoice, product)`. REG-DB re-issues it to read the sale capture, with one record per `(invoice, product, sold number, signal word)`. |
| `get_detailed_statement_data` | `20261208100000…:196` | Prints the stored `invoice_items.epa_registration`. |
| `edit_delivery` | wrapper `20261110160000…:622`; body `20260611211058…:1573` | Deletes and re-creates every line of the delivery. |

**Screens and paperwork (current `main`):**
- `src/lib/invoicePdf.ts:281-309` and `src/lib/statementPdf.ts:581`, `:636` print `item.epa_registration` only. There is no fallback to the product's number any more (step 1 cited one at `:75`; it is gone).
- `src/pages/InvoiceDetail.tsx:1043` and `:1080` set `epa_registration: null` when a line is added or changed.
- The delivery receipt and completion email: `src/lib/deliveryPdf.ts` and `src/lib/deliveryCompletionEmail.ts` (sent from `FieldStop.tsx` and `DeliveryDetail.tsx:1390`, resend `:1461-1483`). **Open PRs #1649 and #1678 move receipt sending to a server queue** (`20261113140000_delivery_receipt_queue.sql` is live; #1678 adds `20261216100000_close_delivery_receipt`). PR B adds brand lines wherever the receipt is built after those land (section 6).
- `p_quantities` (delivered amount per line) is parsed or fingerprinted in eleven migrations, including the receipt queue and the offline receipts (`src/lib/offlineReceipts.ts`).

---

## 2. Where step 1's PR B is wrong against current code

| # | Step 1 said | Today | This sheet |
|---|---|---|---|
| 1 | Brands sit on each size (`product_brands`), and the composite key binds to `product_brands(product_id, id)` | PAR-2 moves brands to the parent (`product_parent_brands`); ungrouped sizes keep legacy rows | A pick references either kind, with one composite key each (3.1) |
| 2 | The split for a short delivery travels as a reserved `_brands` entry inside `p_quantities` | Eleven migrations parse or fingerprint `p_quantities` (receipt queue, offline receipts, evidence, preflight) | No change to `p_quantities`. A short split is saved first with `set_delivery_brands`, then completion checks it (4.C). |
| 3 | `invoice_items.epa_registration` holds two numbers joined (`524-475; 34704-890`) for a split | REG-DB treats the line's number as the **sold number** and looks up its registration | A split line keeps no single number. The per-brand detail goes in a new database-owned column, `brand_lines` (3.1, 4.D). |
| 4 | A reprint reads the brand rows that were current at posting | The line itself can hold the as-issued snapshot | The invoice line's `brand_lines` is the as-issued copy, and it is frozen while the invoice is posted (4.D). |
| 5 | RUP records are grouped by `(invoice, product, EPA number, unit price)` | REG-DB groups by `(invoice, product, sold number, captured signal word)` | PR B keeps REG-DB's grouping and feeds it one entry per delivered brand (4.E) |
| 6 | Invoice writers: auto, quick, unbilled, landlord split, whole-order | Taha's Bill Split adds `_create_bill_split_delivery_invoices` | Added to the writer list (4.D) |
| 7 | The invoice PDF falls back to the product's number | No fallback today | Nothing to remove |
| 8 | Three email builders to merge onto one helper | Sending moves to a server queue (#1649, #1678) | Brand lines are added to the single place the receipt is built after those PRs land (section 6) |
| 9 | The typed-brand review list is also shown in the product's Brands section | REG-1 edits `ProductBrandsSection.tsx`; the grand plan forbids building PR B alongside a package editing `ProductDetail.tsx` | Review list only on its own Products-page tab; PR B does not touch `ProductDetail.tsx` or `ProductBrandsSection.tsx` |
| 10 | A typed brand needs its EPA number | D-K: an unlisted brand never blocks | The number is optional. A blank one is flagged on the review list, the draft invoice and the RUP record (Question 1). |

---

## 3. Shared design

### 3.1 Tables and columns (one migration)

**`delivery_item_brands`** (new). One row per pick. RLS on, and no write grant to any client role.
- `id uuid` primary key; `delivery_item_id`, `delivery_id`, `product_id`. A composite foreign key `(delivery_item_id, delivery_id, product_id)` references `delivery_items(id, delivery_id, product_id)` `ON DELETE CASCADE`, so the copies can never disagree with the line. PR B adds `UNIQUE (id, delivery_id, product_id)` on `delivery_items`, a non-destructive constraint.
- `source text` CHECK in (`parent`, `size`, `typed`):
  - `parent`: `parent_id` and `parent_brand_id` set, with a composite key to `product_parent_brands(parent_id, id)` (PR B adds that unique constraint);
  - `size`: `legacy_brand_id` set, with a composite key `(product_id, legacy_brand_id)` to `product_brands(product_id, id)`, so a Roundup line can never carry a Liberty brand;
  - `typed`: no brand reference.
  - A CHECK enforces exactly this shape.
- **Snapshot:** `brand_name text NOT NULL` (same trim and length rules as the brand tables), `epa_registration text` (strict EPA-number CHECK when not null; NULL only for a typed pick whose number could not be read), `manufacturer text`.
- `quantity numeric NOT NULL CHECK (quantity > 0)`, in the line's own unit.
- **Sale facts, captured at completion** (4.C): `rup_status text` in (`yes`, `no`, `unknown`), `signal_word text`, `facts_source text` (`registration:<number>@<version>` once seeded, `brand:<id>@<row_version>` before the seed, `typed`), `captured_at timestamptz`. All are NULL before completion.
- **Review (typed picks only):** `review_state text` in (`pending`, `added`, `dismissed`), `reviewed_by`, `reviewed_at`, `review_brand_ref uuid` (the brand it was added as).
- **Who and history:** `entered_by`, `entered_at`, `updated_at` (set by the shared `update_updated_at` trigger on every change); `superseded_at`, `superseded_by`, `supersede_reason`, `superseded_by_event_id` (foreign key to `delivery_brand_events(id)`). A row is **current** when `superseded_at IS NULL`.
- **Unique current pick:** at most one current row per `(delivery_item_id, lower(brand_name), coalesce(epa_registration, ''))`.
- **Read policy:** the same rule as `del_items_select` (admin, sales rep, or the delivery's assigned driver), written against `delivery_id`. `GRANT SELECT` to `authenticated` only; `REVOKE ALL` from `PUBLIC`, `anon` and `service_role`. Server code never reads the table directly: the receipt worker gets brands through its own service_role RPC (3.5).

**`delivery_brand_events`** (new, append-only; update and delete refused by trigger). One row per save, correction or review, keyed by `id uuid` primary key, with `event_type` in (`set`, `completed`, `corrected`, `reviewed`), `delivery_id`, `reason`, `invoice_ids uuid[]` (the invoices a correction touched), `before_rows jsonb`, `after_rows jsonb`, `actor`, `actor_name`, `created_at`. Readable by the same rule as `delivery_item_brands`. No client write grant.

**`invoice_items.brand_lines jsonb`** (new column; NULL by default). Meaning:
- `NULL`: the line has no delivered-brand information (an unbranded product, or a line not made from a delivery). It behaves exactly as today and as REG-DB.
- `[]`: a branded line whose delivery recorded no brand (only possible while the switch is off). It prints "Brand not recorded" and keeps no EPA number, never the generic's own number.
- `[ {brand_name, epa_registration, manufacturer, delivered_quantity, rup_status, signal_word, facts_source, typed, pick_ids} … ]`: one entry per delivered brand, in a fixed order (brand name, then EPA number).
- It is written only by the database, under REG-DB's capture pass. The client column grant is revoked, which fits REG-1 Q7 (all client writes on `invoice_items` revoked).

**`rup_sales_records.brand_name text`** (new, NULL for an unbranded record). Two brands with one EPA number in one record show both names, joined with "; ".

**`app_settings` row `delivery_brand_required`** = `false`, inserted by the migration.

### 3.2 Brand-list resolution (one internal helper)

`_delivery_line_brand_list(p_product_id uuid) RETURNS TABLE(source, parent_id, brand_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, row_version)` (no grant). It uses `get_product_brands`'s rule: the parent's active brands when the size is grouped **and** `_product_parent_grouping_open()` is true; otherwise the size's legacy rows. A product **has brands** when this returns at least one row, whether or not each brand is currently sourced. The picker offers only currently sourced brands. A typed name that matches a listed brand is stored as that listed pick (4.A).

### 3.3 Locking

PR B keeps REG-DB's lock order (REG-1 sheet §3.2), and every writer takes its locks in this order:
1. REG-DB's shared registration lock, as each re-issued function already does first.
2. The delivery row `FOR UPDATE`.
3. Its lines (ID order).
4. Brand rows `FOR SHARE`: legacy, then parent brands, in ID order.
5. Picks.
6. Then invoices and their lines, then RUP records, as REG-DB orders them.

`correct_delivery_brands` locks the delivery first, then the invoices it touches (ID order), so it never inverts with posting.

### 3.4 Retry safety and authorization (every public RPC)

- Each RPC takes `p_idempotency_key text DEFAULT NULL`. A missing key is refused (`IDEMPOTENCY_KEY_REQUIRED`) on every write path, following the bound-receipt pattern the delivery functions use today (`check_idempotency_intent` with a request fingerprint, then `_bind_replay_receipt`, as in `20261019200000_bind_delivery_job_replay_receipts_batch3a.sql`).
- Every replay lookup is scoped by **operation name** as well as key and fingerprint (`set_delivery_brands`, `correct_delivery_brands`, `review_typed_brand`), so one key reused across two RPCs never returns the other's result. A key reused with a different payload is refused (`IDEMPOTENCY_KEY_REUSED`).
- Authorization runs **before** the replay lookup (the `20260716173342` rule), so a stranger cannot read someone else's cached result.
- `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon`, `GRANT EXECUTE … TO authenticated` for public RPCs.
- **Every** `SECURITY DEFINER` function in PR B, public or internal, has `SET search_path = public, pg_temp` and schema-qualifies its references; the postflight check reads `proconfig` and fails on any without it.
- **Internal helpers** (`_delivery_line_brand_list`, `_delivery_brand_lines_json`, `_invoice_line_brand_entries` and any other `_`-prefixed function) get `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` explicitly, because PostgreSQL grants `EXECUTE` to `PUBLIC` by default. The migration's postflight check fails if any of them is executable by those roles.

### 3.5 Receipt worker access

`_delivery_brand_lines_json(p_delivery_id uuid) RETURNS jsonb` (internal, `SECURITY DEFINER`, no grant) returns each line's current picks in the receipt's shape. The service_role worker RPC that hands the receipt body to the sender (today `claim_delivery_receipts` from `20261113140000`, or wherever #1649 and #1678 leave it) is re-issued in B-1 to include that JSON, with its grants unchanged. The worker never gets table access. If those PRs have not landed when B-1 is built, B-1 re-issues whichever function then builds the receipt, and the builder records which one in the migration's caller analysis.

---

## 4. PR B-1 · The database PR

Built from each re-issued function's body **on live at build time** (after REG-DB). Each re-issue is diffed against `pg_get_functiondef` before review. The migration stamp must sort after REG-DB's claimed stamps (`20261218100000` to `20261218130000`) and any peer claim. Grep the peer worktrees and the shared notes folder at build.

### 4.A `set_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin, sales rep, or the delivery's assigned driver. This is the completion rule (`_complete_delivery_authorized_impl:1015`), not a new one.
- **When:** while the delivery is `scheduled` or `in_progress`. Otherwise `DELIVERY_BRANDS_LOCKED` (after completion, use 4.F).
- **Input:** `p_lines` is `[{delivery_item_id, picks: [{brand_id?, typed_name?, typed_epa?, typed_manufacturer?, quantity}]}]`. Each named line's current picks are replaced in one step. Lines that are not named are untouched. An empty `picks` array clears that line.
- **Rules:**
  - Each line belongs to the delivery (`DELIVERY_ITEM_NOT_ON_DELIVERY`).
  - A listed pick's brand must be on that line's brand list (3.2), or `BRAND_NOT_FOR_PRODUCT`. A retired parent brand is refused.
  - A typed pick needs a name. Its number must pass the strict CHECK if given. A typed name equal to a listed brand (case-insensitive) is stored as the listed pick when the numbers agree or the typed number is blank. When the numbers differ, it is stored as typed and flagged on the review list ("number differs from the list").
  - The pick amounts must each be above zero, and their sum must be at most the line's loaded `quantity` (`BRAND_SPLIT_OVER_LOADED`). While scheduled they are normally equal to it. A smaller sum is allowed so a short split can be saved just before completion (4.C).
  - Snapshots come from the brand row (or from the typed values), never from the client for a listed pick.
- **Writes:** one `set` event. Replacing picks before completion deletes the old rows outright, because nothing has been issued yet (as step 1 allowed). The event keeps them.
- **Returns:** the line's current picks.

### 4.B `edit_delivery` (re-issued)
Today it deletes and re-creates every line (`20260611211058…:1573`), and the screen always sends lines. After re-issue:
- the picks of each line whose `order_item_id`, `product_id` and `quantity` are unchanged are carried to the re-created line, with their snapshots, in the same transaction;
- the picks of a changed or removed line are dropped. The result lists those lines, so the screen flags them for a new pick.

Cancel, void and restore leave picks alone. Picks go when `update_order_items` removes a cancelled delivery's lines (cascade), which is acceptable because nothing was delivered.

### 4.C The completion rule (inside `_complete_delivery_authorized_impl`)
It runs right after the loop that writes `quantity_delivered` (today `:1110-1150`) and before the tote copy and invoice drafting. It cannot be a status trigger, because the status flips to `completed` before the delivered amounts exist. Every completion path goes through this function: `complete_delivery`, `start_and_complete_delivery`, the receipt-queue entry points and offline replays. The builder lists every caller from `pg_proc` and the harness asserts each one reaches the rule. For each line:

1. **Delivered zero:** its picks are removed (one `completed` event keeps them).
2. **One pick:** its amount is set to the delivered amount (same brand, smaller amount; nothing is guessed).
3. **Several picks:** their sum must equal the delivered amount. When it does not:
   - switch on: refused with `BRAND_SPLIT_MISMATCH: line <product> delivered <n>, brands add up to <m>`;
   - switch off: kept as is, and flagged "split does not match delivered" on the draft invoice. RUP uses the proportions (4.E).
4. **Branded line with no pick:**
   - switch on: refused with `BRAND_REQUIRED: pick the brand for <product>`;
   - switch off: completes. The line's invoice gets `brand_lines = []` (3.1).
5. **Listed pick no longer on the list** (the size moved parent, or the brand was retired, since the pick):
   - switch on: refused with `BRAND_LIST_CHANGED`, naming the line;
   - switch off: kept with its snapshot and flagged.
6. **Capture sale facts** on every current pick, so a later registration change never rewrites the sale:
   - **seeded:** from the pick's number's registration (`rup_status`, `signal_word`, `registration:<n>@<v>`). A number with no registration gets `unknown`;
   - **before the seed:** from the brand row (`is_rup` true → `yes`, false → `no`, NULL → `unknown`);
   - **typed:** `unknown`, unless seeded and its number has a registration.

A **short split** is saved with `set_delivery_brands` first and completion second: two calls from the screen, queued in that order offline (section 5). **Not chosen:** a reserved key inside `p_quantities` (step 1's plan). It would change the parsing and fingerprints of eleven functions, including the receipt queue and offline receipts, for a case that is rare (a short delivery of a split line).

Stock shortages still never block (To-Do 2.6). Lot and tote numbers are not read or required anywhere in PR B (August T-7, R-5).

### 4.D Snapshot onto invoice lines
**Which picks belong to an invoice line** (used here, by RUP in 4.E and by the correction in 4.F):
- **An invoice with a `delivery_id`** (the automatic invoice, the quick-delivery draft, the unbilled-recovery invoice, each Bill Split payer invoice): the current picks of **that** delivery's line for the same `order_item_id`. Never a sibling delivery's.
- **An invoice with no `delivery_id`** (whole-order, landlord split): the current picks of every completed, not-voided delivery of that order line, added up per brand (same name and number).

**Writing it.** REG-DB routes every invoice-line insert through `_capture_invoice_line_sale`. PR B extends that one helper to:
- compute `brand_lines` for a line that has an `order_item_id`, by the rule above. `NULL` when the product has no brands and no typed pick exists; `[]` when it is branded but unpicked;
- set the line's sold number (`epa_registration`) to the single brand's number when `brand_lines` has exactly one entry with a number. Otherwise set it to NULL, **never** the generic product's own number, and leave the line's own capture columns NULL with `sale_facts_source = 'brands'`. A line with `brand_lines` NULL is captured exactly as REG-DB does.

Every insert path gets this through the helper, including `_create_bill_split_delivery_invoices`, where each payer's line shows **all** the brands delivered on that line. The completion's tote-copy step gains the same re-copy for the open **draft** lines of this delivery's own invoices (the quick-delivery draft and the partial-delivery trim). `save_invoice` carries `brand_lines` through its old-line-ID map, the same way REG-DB carries the capture columns. A line the office adds by hand gets `brand_lines` NULL.

**Frozen once issued.** REG-DB's invoice-line guard is extended: `brand_lines` changes only under the capture pass, and never on a `posted`, `overdue` or `paid` invoice. Posting re-copies `brand_lines` (and the sold number) from the current picks for every line made from a delivery, in the same transaction as RUP generation. That way an invoice that was unposted, corrected and posted again prints the same brands its RUP records hold.

**No invoice amount, quantity or cost changes anywhere.** The cap triggers (`20261010120000`, `20261029160000`) do not read the new column. The harness compares every money column before and after.

### 4.E RUP register (re-issue of REG-DB's `generate_rup_sales_records`)
- **A line with `brand_lines` NULL:** exactly REG-DB's behaviour.
- **Where the entries come from:** for a line made from a delivery, from that line's **current picks** through the internal helper `_invoice_line_brand_entries(invoice_item_id)` (same shape as `brand_lines`), never from the stored `brand_lines`. At posting the two are identical, because posting re-copies `brand_lines` in the same transaction; after a posted-invoice correction (4.F) only the picks have changed, so the rebuilt records follow the corrected brand while the issued invoice keeps its snapshot.
- **A line with brand entries:** one candidate record per entry.
  - **Quantity:** the line's quantity divided across the entries in proportion to `delivered_quantity`.
  - **Cents:** `extended_cents` divided the same way in whole cents.
  - **Remainders:** the last entry in the fixed order takes the remainder of both, so the records add up to the line exactly. A Bill Split payer's line therefore records its share of each brand, and a line whose quantity the office changed is divided in the delivered proportion. The draft invoice warns before posting when a non-Bill-Split line's quantity no longer matches the delivered total.
  - **Which entries need a record:** the entry's `rup_status` is `yes`, or REG-DB's posting rule finds the number's registration `yes` at posting; when the entry is `unknown` **and** either the generic product is restricted-use or the entry is a **typed** brand, it is recorded too, with `compliance_status = 'warning'` and the note "RUP status of delivered brand not confirmed" (Question 2). A listed brand whose status is unknown under a non-RUP generic is not recorded; its brand row is the place to fix that.
  - **What each record holds:** the entry's EPA number, signal word and `brand_name`.
- **A line with `brand_lines = []` on a restricted-use product:** one record with a blank EPA number, `compliance_status = 'warning'` and note "Brand not recorded at delivery" (Question 3). The sale is never silently dropped.
- **Grouping:** REG-DB's key `(invoice, product, sold number, signal word)`, with each brand entry treated as its own sold number. Entries sharing a key are added into one record, and their brand names joined. REG-DB's "an existing active record that disagrees is an error" rule and its posting lock stay.
- `get_rup_sales_register` returns `brand_name`.

### 4.F `correct_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin only. The reason is required. Only on a `completed` delivery.
- **What it does:** it never overwrites a completed pick. It marks the old current picks superseded (`superseded_*`) and inserts the new ones, with sale facts captured by 4.C step 6 at correction time. The new picks must add up to the delivered amount, and each listed pick must be on the line's **current** brand list from `_delivery_line_brand_list` (3.2), checked by source, parent and product, not by the foreign key alone; anything else is refused (`BRAND_NOT_FOR_PRODUCT`), exactly as in `set_delivery_brands`. A typed pick follows the 4.A rules.
- **Then, per invoice the rule in 4.D gives** (locked in ID order):
  - `draft` or `unposted`: re-copy `brand_lines` and the sold number;
  - `posted`, `overdue` or `paid`: the invoice stays exactly as issued. Every active RUP record of that invoice is voided with the reason (`voided_at`, `voided_by`, `void_reason`; PARKED-006 handling), then the invoice's records are regenerated by 4.E from the **current** picks, in one transaction. All of the invoice's records are rebuilt, because one record can combine several lines. So the invoice and the register never disagree silently: each rebuilt record's `compliance_notes` says "Brand corrected after invoicing on <date>: invoice shows <old brands>", and `InvoiceDetail.tsx` and the invoice PDF reprint show "Brand corrected on <date>: delivered brand was <new brands>" under the line, read from the `corrected` event (B-3). The issued `brand_lines` stays frozen (Question 4);
  - `voided` or `cancelled`: delivery only.
- **Logging:** one `corrected` event with every invoice ID it touched.

### 4.G `review_typed_brand(p_pick_id uuid, p_action text, p_brand_id uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin only.
- `p_action = 'link'` points the typed pick at a brand **already on** the line's brand list (`review_brand_ref`), so it shows as reviewed. It never changes the pick's snapshot.
- `'dismiss'` records the dismissal.
- **Adding a new brand to a list stays in the existing brand RPCs** (`upsert_parent_brand` / `upsert_product_brand`, with REG-DB's registration rules). The review screen calls that first, then `link`. PR B adds no second brand writer.
- One `reviewed` event.

### 4.H Read RPCs
- `get_delivery_brands(p_delivery_id)`: each line, its brand list (3.2) and its current picks. Same read rule as the delivery.
- `get_typed_brands_for_review()`: admin only; pending typed picks with delivery, product and line.
- `get_deliveries_missing_brands(p_from date, p_to date)`: admin only; completed branded lines with no picks (the switch-on backlog report, section 10).

### 4.I Files, harness, risks
- **Files:**
  - `supabase/migrations/<stamp>_delivery_brands.sql` and its ledger record `docs/reference/migrations.d/<stamp>_delivery_brands.md`;
  - `docs/changelog.d/<date>-delivery-brands-db.md`;
  - `scripts/smoke/prove-delivery-brands-real-schema.mjs` with its `smoke-specs.json` entry;
  - `src/lib/rpcContracts.test.ts` (new RPC shapes);
  - `src/types/index.ts` (the `DeliveryItemBrand` type and the new fields);
  - `.claude/schema-registry.json` (regenerated after apply, in a follow-up registry refresh PR).
- **Harness:** the real-schema prover runs every case in section 7 against a copy of the live structure.
- **Risks:**
  - This re-issues money-path functions (completion, every invoice writer, posting, RUP). No amount changes, and the prover compares all money columns.
  - A missed invoice writer would print the generic number. The harness lists every `pg_proc` body that inserts `invoice_items` and fails if one bypasses the helper (REG-DB already requires this).
- **Sol list:** yes (`supabase/`).

---

## 5. PR B-2 · Capture screens (after B-1 is live)

- **Delivery page** (`src/pages/DeliveryDetail.tsx`, office and phone layouts) and **driver stop** (`src/pages/FieldStop.tsx`):
  - a **Brand** picker per branded line, showing the currently sourced brands, plus **Other brand…** (name, EPA number, manufacturer; the number is optional and marked "from the jug label");
  - **Split** adds a second brand with an amount. Picks save any time before completion.
- **Completion screens:**
  - a line with no pick asks for one;
  - a short split line asks how much of each brand went off the truck, pre-filled with what was loaded, then saves it (`set_delivery_brands`) before calling completion;
  - the refusal codes from 4.C are shown as plain sentences naming the line.
- **Screen state is keyed by delivery:** the picks, the pending save and its request number belong to one delivery ID and are cleared when the screen opens another delivery, closes, or reloads after a reopen; a reply whose delivery ID or request number is not the current one is ignored.
- **Retries reuse their key:** each save intent gets one retry key when the user saves, kept with the pending save (in the offline queue when offline) and reused on every retry until a reply confirms it. Changing the choices makes a new save with a new key, which supersedes the older one on screen; an older save that still lands is overwritten by the newer one, because saves are applied in queue order.
- **One save at a time per delivery:** while a brand save is in flight, the picker and the Complete button are disabled; each save carries a request number and a reply for an older number is ignored. Completion is offered only after the latest save has come back, and it sends nothing about brands (the database reads the saved picks). A failed save leaves the screen's choices in place, shows the error, and keeps Complete disabled until a save succeeds.
- **Offline (`src/lib/offlineQueue.ts`, `src/lib/offlineSync.ts`):** `set_delivery_brands` is its own queued action, ordered before that delivery's completion action, with its own retry key. A queued completion that is refused after the switch went on is shown for office follow-up, as other refused replays are today.
- **Deliveries list** (`src/pages/Deliveries.tsx`): one-click **Mark Delivered** shows "Pick the brand on the delivery page first" for `BRAND_REQUIRED`.
- **Edit delivery:** the lines whose picks were dropped (4.B) are flagged.
- **Products page** (`src/pages/Products.tsx`): a **Brands to review** tab (admin), using a new `src/components/products/TypedBrandReview.tsx`. "Add to list" calls the existing brand RPC, then `review_typed_brand('link')`. PR B-2 does **not** edit `ProductDetail.tsx` or `ProductBrandsSection.tsx`.
- **Admin settings** (`src/pages/SettingsPage.tsx`): the `delivery_brand_required` switch, showing the count from `get_deliveries_missing_brands` beside it.
- **Quick delivery:** no picker in the modal. It is completed on its delivery page, where the picker is (step 1 §5).
- **New client helper:** `src/lib/deliveryBrands.ts`, which calls `assertRpcResult()` after each RPC.
- **Sol list:** yes (`src/pages/Products.tsx`, `src/pages/SettingsPage.tsx`, `src/lib/offlineSync.ts`, `src/lib/offlineQueue.ts`, plus "deliver" in file names).

## 6. PR B-3 · Paperwork and records (after B-1 is live; may land with or after B-2)

- **Delivery receipt PDF** (`src/lib/deliveryPdf.ts`) and the **completion email:** under each line, each brand with its EPA number and amount, or "Brand not recorded".
  - The email is built wherever #1649 and #1678 leave the receipt body (the server receipt queue or `src/lib/deliveryCompletionEmail.ts`). The builder finds that single place at build time and adds brands there, so every send and resend carries them.
  - The proof covers the first send and a resend.
- **Invoice PDF** (`src/lib/invoicePdf.ts`):
  - the EPA column prints the line's number;
  - for a split line, the entries' numbers joined;
  - under the line, the brand names and amounts from `brand_lines`;
  - "Brand not recorded" for `[]`.
- **Statement:** `get_detailed_statement_data` is re-issued in B-1 to return `brand_lines`. `src/lib/statementPdf.ts:581`, `:636` print the joined numbers when the line's own number is blank.
- **Invoice editing** (`src/pages/InvoiceDetail.tsx`):
  - the brands are shown read-only on lines made from a delivery;
  - the `epa_registration: null` resets at `:1043` and `:1080` no longer clear a delivery line's stored number (the database owns it after REG-DB, so the client stops sending it);
  - warnings before posting: "Brand typed at delivery, not yet checked", "Brand not recorded", "Split does not match delivered", and "Quantity changed from delivered".
- **Compliance page** (`src/pages/Compliance.tsx`): the RUP register shows a **Brand** column and the new notes. `InvoiceDetail.tsx` and the invoice PDF show the post-invoice correction note from the `corrected` event (4.F). The capture screen's one-save-at-a-time rule (section 5) gets a screen test with a late, stale reply.
- **Sol list:** yes (`invoicePdf.ts`, `statementPdf.ts`, `deliveryPdf.ts`, `InvoiceDetail.tsx` carry money words). The `pdf-output-reviewer` agent runs on the three PDFs.

---

## 7. Done when (prover cases; B-1 in the real-schema harness, B-2/B-3 with screen tests and a local run)

**Brand lists and picks**
- P1. Ungrouped size with legacy brands: listed pick saved, snapshot from the brand row. A Liberty brand on a Roundup line is refused (`BRAND_NOT_FOR_PRODUCT`).
- P2. Grouped size with the switch on: the parent's active brands are the list. A retired parent brand is refused. A legacy brand ID on a grouped size is refused.
- P3. Typed brand with a number completes and lands on the review list. A typed brand with a blank number completes and is flagged. A typed name equal to a listed brand with the same number is stored as listed.
- P4. A driver not assigned to the delivery, a non-active user and an anonymous caller are refused. The same retry key with the same request changes nothing; the same key with a different request is refused; a key with no request is refused.

**Completion**
- P5. Switch on: a branded line with no pick is refused, naming the line. After the pick, it completes. The check sees the final delivered amounts (the case a status trigger would miss).
- P6. A 30/15 split loaded at 45, delivered 40: completion is refused until the 40 split is saved; after saving, it completes. A split that does not add up is refused. A line delivered at zero keeps no picks.
- P7. Switch off: every case above completes, records what was picked, and gives `brand_lines = []` with no EPA number (never the generic's).
- P8. A pick whose size moved parent before completion is refused with the switch on and kept with the switch off.
- P9. No lot or tote number anywhere: every case completes. A tote number, when present, is still copied as today.
- P10. Every caller of `_complete_delivery_authorized_impl` from `pg_proc` reaches the rule, including the receipt queue and an offline replay.

**Invoices**
- P11. Automatic invoice: one-brand line → the line's number is the brand's, and `brand_lines` has one entry; split line → no single number, two entries; unbranded product → as REG-DB.
- P12. Bill Split: each payer's invoice line carries both brands; RUP divides each payer's share by brand, and the cents add up exactly per payer.
- P13. One order line delivered in two trips with different brands, each trip billed alone: each invoice shows only its own trip's brands. A whole-order invoice and a landlord split invoice add up both trips per brand.
- P14. Quick-delivery draft and partial-delivery trim: draft lines are re-copied at completion.
- P15. `save_invoice` keeps `brand_lines` through a save. A client write to `brand_lines` is refused. A posted line's `brand_lines` cannot change.
- P16. No money column (`quantity`, `unit_price_cents`, `extended_cents`, `cost_cents`, invoice totals) changes in any case compared with the same flow without brands.

**RUP**
- P17. A split restricted-use line posts two records with the right numbers, amounts and cents adding up exactly. Two lines of one product and one brand number on one invoice produce one record.
- P18. A brand with RUP `no` under a restricted-use generic gives no record for that brand. A brand with RUP `unknown` under a restricted-use generic is recorded with the note. Before and after the seed, both behave as REG-DB defines.
- P19. A restricted-use line with `brand_lines = []` gives one record with a blank number and the "Brand not recorded" warning.
- P20. Unpost, void and re-post behave as before under the new grouping (PARKED-006).

**Correction and review**
- P21. Correction on a draft re-copies the invoice line.
- P22. Correction on a posted, an overdue and a paid invoice: the invoice's stored lines and `brand_lines` are unchanged and its reprint adds the correction note; all of the invoice's RUP records are voided with the reason and rebuilt; an unchanged sibling line's quantity and cents are still in the register.
- P23. Correction → unpost → re-post: the new issue and its RUP records agree.
- P24. A brand's EPA number changed afterwards leaves old deliveries, invoices and RUP records unchanged.
- P25. `review_typed_brand('link')` leaves the pick's snapshot unchanged; adding a brand goes through the existing brand RPC.

**Editing, grants**
- P26. Changing only a scheduled delivery's date keeps the picks. Changing one line's quantity drops only that line's picks.
- P27. Grants and policies read directly from `information_schema` and `pg_policy`: clients can read the new tables under the delivery rule, nobody can write them, and the `brand_lines` column grant is revoked. An admin session cannot reveal a missing grant (August C-25), so this is checked directly.
- P28. Every `_`-prefixed helper is not executable by `PUBLIC`, `anon`, `authenticated` or `service_role`.
- P29. A correction naming a brand from another parent, or from another size's legacy list, is refused (`BRAND_NOT_FOR_PRODUCT`).
- P30. One key and payload sent to `set_delivery_brands` and then `correct_delivery_brands` runs both; the same key with a changed payload is refused.
- P31. The receipt worker's service_role RPC returns a delivery's brand lines (single, split, typed, none) while service_role still has no table privilege on `delivery_item_brands`.
- P32. A typed restricted-use brand delivered under a non-RUP generic, before the seed, gets a warning RUP record.
- P33. After a posted-invoice correction, the rebuilt records name the corrected brand and the invoice's `brand_lines` is unchanged.
- P34. Every PR B `SECURITY DEFINER` function has the pinned `search_path`; every superseded pick points at an existing event.

---

## 8. What is out of scope

- Picking the brand at receiving, stock and cost by brand, and refusing a brand that is not in stock (step 2).
- The cancelled-registration warnings at quote, product and delivery pick (grand plan overlap 8; after REG-1).
- Brands on field-application, job and blend-ticket invoices, which still record the generic's number (step 1 §2), and the year-end summary by brand.
- Adding typed brands from the product's Brands section (section 2, row 9).

---

## 9. Dependencies, overlap and order (checked read-only 2026-11-08)

| Needs | Why | State |
|---|---|---|
| **PAR-2 brand move live and verified** | Grand plan Stage 3 and overlap 13. PR B is designed against parent brand lists. | Not started on live: `_product_parent_grouping_open()` is `false`; 0 parents, 0 brands. Mason's grouping data step is in progress. |
| **REG-1 step 2 (REG-DB) merged and live** | PR B extends REG-DB's `_capture_invoice_line_sale`, invoice-line guard, `generate_rup_sales_records`, lock order and every invoice writer it re-issues. Building PR B first would re-issue the same functions twice. | Unblocked now that #1524 is merged; being built on branch `claude/reg1-step2-db` (stamps `20261218100000`–`20261218130000`) |
| REG-1 seed | Not required. PR B captures from brand rows before the seed and from registrations after it (4.C step 6). | Mason-gated, not run |
| #1649, #1678 (receipt sending) | B-3 adds brands to the receipt wherever these leave it | Open |
| Brand data | Admins enter brands (on parents once grouped). The switch stays off until the lists exist. | Mason |

**Shared files:**
- PR B touches neither `ProductDetail.tsx` nor `ProductBrandsSection.tsx` (REG-1's screens edit both).
- B-2 edits `Products.tsx` and `SettingsPage.tsx`: re-check open PRs on both before starting.
- RT-1 (rates) is a separate build sheet. Its later rate packages may touch invoice writers; whichever lands second rebuilds from live bodies.
- Taha's open PRs (#1534, #1576, #1587) touch invoice and order screens. Check for overlap before B-3, and never push to them.

**Order:**
1. REG-DB is live.
2. The PAR-2 move is live and verified.
3. B-1 (Sol), then its live apply through the migration-apply gate, with the switch off.
4. B-2 and B-3 (Sol each).
5. Admins clear the missing-brands report.
6. Mason turns the switch on.

---

## 10. Steps that need Mason

1. **Grouping and brand move (PAR-2):** his grouping data step, then the move switch-on. Both are already gated in PAR-2.
2. **Brand lists:** entering each generic's brands with their EPA numbers (admin work; no code).
3. **Apply B-1 live.** It is non-destructive with routine grants, so it goes through the normal apply gate with Sol proofs. If the gate classifies it otherwise, it needs Mason's `approve <code>`.
4. **Turn on `delivery_brand_required`** once B-2 and B-3 are live and proven and the missing-brands report is empty. It is a live setting change, so it needs his explicit yes in that session.

---

## 11. Questions for Mason

1. **A typed brand whose EPA number cannot be read** (smudged jug, no label): the plan lets the delivery finish with the number blank, and flags it on the review list, the draft invoice and the RUP record. **Recommended.** The alternative is to require a number, which would stop the truck.
2. **A delivered brand whose restricted-use status is unknown, under a restricted-use generic, or any typed brand whose status is unknown:** the plan records it on the RUP register with a warning to confirm. **Recommended.** The alternative skips it, which risks a missing regulated record.
3. **A restricted-use line delivered with no brand recorded** (only while the switch is off): the plan writes an RUP record with a blank number and a warning, to be fixed by the admin correction. **Recommended.** The alternative is no record until corrected.
4. **A brand corrected after the invoice was sent:** the plan keeps the sent invoice unchanged, fixes the RUP register, and prints a "brand corrected on <date>" note on the invoice screen and any reprint. **Recommended.** The alternative is to void and reissue the invoice, which changes paperwork the customer already has.

---

## 12. Review record

**Luna round 1** (gpt-6-luna xhigh, head `4d6bef007`): 7 findings.
- BLOCKER, latest live migration dated in the future: **refuted.** Repo stamps run ahead of the calendar; `20261215110000` is on main (`b1a5c0e80`) and in the live ledger. Clarified in section 1.
- HIGH, internal helpers keep PostgreSQL's default `PUBLIC` execute: **fixed** (3.4, explicit revoke plus postflight check).
- HIGH, a corrected posted invoice and the RUP register can show different brands: **fixed** (4.F notes on both, Question 4).
- HIGH, the service_role receipt worker cannot read brand picks: **fixed** (3.5, the worker's RPC returns them; no table grant).
- MED, a correction could record another parent's brand: **fixed** (4.F checks the current brand list).
- MED, replay lookup not scoped by operation: **fixed** (3.4).
- MED, overlapping saves on the capture screen: **fixed** (section 5, one save at a time with stale replies ignored).

**Luna round 2** (head `ef8e0722c`): 7 findings, all **fixed**.
- HIGH, a typed RUP brand under a non-RUP generic was not recorded: typed unknowns now get a warning record (4.E, Question 2, P32).
- HIGH, regeneration after a posted correction read the frozen `brand_lines`: 4.E now reads current picks through `_invoice_line_brand_entries` (P33).
- HIGH, the receipt helper had no pinned `search_path`: every `SECURITY DEFINER` function pins it, checked in postflight (3.4, P34).
- MED, events had no ID for `superseded_by_event_id`: `id` primary key and a foreign key added (3.1).
- MED, screen state not isolated by delivery: keyed by delivery and cleared on switch (section 5).
- MED, retries could mint new keys: one key per save intent until confirmed (section 5).
- LOW, no `updated_at` on picks: added with the shared trigger (3.1).
