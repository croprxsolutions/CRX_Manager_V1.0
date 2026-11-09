# Product Master Stage 3: brand PR B build sheet (delivered brand, its EPA number, RUP records per brand)

**Status (2026-11-08, reworked 2026-11-09 after an independent review):** this is a plan only. No code and no migration have been written. It was written on 2026-11-08 against `main` (`4504e3e6a`) and the live database, using read-only SQL only. For building, this sheet replaces "PR B" in `docs/plans/2026-10-22-product-brands-step1-PLAN.md` (sections 4, 5, 7 and 8). Where the two differ, this sheet wins, and section 2 lists each difference. A reference like "step 1 §4" means that plan.

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
| `get_product_brands(p_product_id)` | `20261123120000_product_parent_proposals.sql` | Returns the parent's active brands when the size is grouped and the grouping switch is on, otherwise the size's legacy rows. PR B uses the same rule (section 3.2). |
| `upsert_parent_brand`, `upsert_product_brand` | `20261203110000`, `20261123120000` | Unchanged by PR B. REG-DB re-issues both. |
| `_complete_delivery_authorized_impl` | `20261215110000…:950` | Authorizes admin, sales rep or the assigned driver (`:1015`); sets status `completed` (`:1102-1106`) **before** the loop that writes `quantity_delivered` (`:1107-1150`); then copies `tote_number` to this delivery's own invoice lines, skipping credit memos (`:1159-1168`); then drafts either the Bill Split invoices or one automatic invoice (`:1360-1416`). |
| `_create_bill_split_delivery_invoices` | `20261215110000…:503` | One draft invoice per payer for one delivery, each with `delivery_id` set; each payer's line holds that payer's share of the delivered quantity (`:537-584`). New since step 1 was written. |
| `_create_invoice_for_unbilled_delivery_impl_20260718` | `20261215110000…:1515` | Recovery path that bills a completed delivery. |
| `_create_invoice_from_order_impl` (whole-order) and `_create_split_invoices_from_order_provenance_impl` (landlord split) | `20260827041400`, `20261029160000` | Insert lines with no `delivery_id`. |
| `save_invoice` | public body `20261019230000…:535` | Deletes and re-inserts every line; REG-1 carries capture values through an old-line-ID map. |
| `generate_rup_sales_records(p_invoice_id, p_idempotency_key)` | `20261204100000_ki18_batch1_chicago_today.sql` | Reads lines `JOIN products WHERE p.is_rup`, copies the **product's** EPA number and signal word, and skips a line when an active record already exists for `(invoice, product)`. REG-DB re-issues it to read the sale capture, with one record per `(invoice, product, sold number, signal word)`. |
| `get_detailed_statement_data` | `20261208100000…:196` | Prints the stored `invoice_items.epa_registration`. |
| `edit_delivery` | wrapper `20261110160000…:622`; body `20260611211058…:1573` | Deletes and re-creates every line of the delivery. |

**Screens and paperwork (current `main`):**
- `src/lib/invoicePdf.ts:281-309` and `src/lib/statementPdf.ts:581`, `:636` print `item.epa_registration` only. There is no fallback to the product's number any more (step 1 cited one at `:75`; it is gone).
- `src/pages/InvoiceDetail.tsx:1043` and `:1080` are the two new-line builders (product and charge) and start a new line with `epa_registration: null`; kept lines send their stored number (`:1201`). PR B does not change them.
- The delivery receipt and completion email: `src/lib/deliveryPdf.ts` and `src/lib/deliveryCompletionEmail.ts` (sent from `FieldStop.tsx` and `DeliveryDetail.tsx:1390`, resend `:1461-1483`). The server receipt queue is live (`20261113140000_delivery_receipt_queue.sql`): `_enqueue_delivery_receipt` saves the receipt body as a snapshot at completion, and the `send-delivery-receipts` Edge Function sends it. Open PRs #1649 and #1678 continue that work (#1678 adds `20261216100000_close_delivery_receipt`). PR B adds brands to the snapshot (3.5).
- **Completion is online only** (Goal 5, Mason 2026-10-15): `FieldStop.tsx:825` and `DeliveryDetail.tsx` say nothing is saved offline, and `offlineSync.ts:383-393` replays only old `complete_delivery` / `complete_job` actions still on devices.
- `p_quantities` (delivered amount per line) is parsed or fingerprinted in many migrations, including the receipt queue and the offline receipts (`src/lib/offlineReceipts.ts`).

---

## 2. Where step 1's PR B is wrong against current code

| # | Step 1 said | Today | This sheet |
|---|---|---|---|
| 1 | Brands sit on each size (`product_brands`), and the composite key binds to `product_brands(product_id, id)` | PAR-2 moves brands to the parent (`product_parent_brands`); ungrouped sizes keep legacy rows | A pick references either kind, with one composite key each (3.1) |
| 2 | The split for a short delivery travels as a reserved `_brands` entry inside `p_quantities` | Many migrations parse or fingerprint `p_quantities` (receipt queue, offline receipts, evidence, preflight) | No change to `p_quantities`. A short split is saved first with `set_delivery_brands`, then completion checks it (4.C). |
| 3 | `invoice_items.epa_registration` holds two numbers joined (`524-475; 34704-890`) for a split | REG-DB treats the line's number as the **sold number** and looks up its registration | A split line keeps no single number. The per-brand detail goes in a new database-owned column, `brand_lines` (3.1, 4.D). |
| 4 | A reprint reads the brand rows that were current at posting | The line itself can hold the as-issued snapshot | The invoice line's `brand_lines` is the as-issued copy, and it is frozen once posted (4.D). A brand fix after posting is REG-1's void and reissue (4.F). |
| 5 | RUP records are grouped by `(invoice, product, EPA number, unit price)` | REG-DB groups by `(invoice, product, sold number, captured signal word)` | PR B keeps REG-DB's grouping and feeds it one entry per delivered brand (4.E) |
| 6 | Invoice writers: auto, quick, unbilled, landlord split, whole-order | Taha's Bill Split adds `_create_bill_split_delivery_invoices` | Added to the writer list (4.D) |
| 7 | The invoice PDF falls back to the product's number | No fallback today | Nothing to remove |
| 8 | Three email builders to merge onto one helper | Sending moves to a server queue (#1649, #1678) | Brands are added to the receipt snapshot that `_enqueue_delivery_receipt` saves, and the Edge Function prints them (3.5, section 6) |
| 9 | The typed-brand review list is also shown in the product's Brands section | REG-1 edits `ProductBrandsSection.tsx`; the grand plan forbids building PR B alongside a package editing `ProductDetail.tsx` | Review list only on its own Products-page tab; PR B does not touch `ProductDetail.tsx` or `ProductBrandsSection.tsx` |
| 10 | A typed brand needs its EPA number | D-K: an unlisted brand never blocks | The number is optional at the truck. A blank one is flagged on the review list and the draft invoice; a restricted-use line cannot post until it is recorded (Question 1). |

---

## 3. Shared design

**Rule for this sheet:** where REG-1 (`docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md`) already settled a rule for invoice lines and RUP records, PR B follows it per brand and does not re-decide it. The one place PR B departs from a REG-1 rule is listed as Question 4.

### 3.1 Tables and columns (one migration)

**`delivery_item_brands`** (new). One row per pick. RLS on.
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
- **Who and history:** `entered_by`, `entered_at`, `updated_at` (the shared `public.update_updated_at()` trigger); `superseded_at`, `superseded_by`, `supersede_reason`, `superseded_by_event_seq` (foreign key to `delivery_brand_events(seq)`). A row is **current** when `superseded_at IS NULL`.
- **Unique current pick:** at most one current row per `(delivery_item_id, lower(brand_name), coalesce(epa_registration, ''))`.
- **Grants:** `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated` and `service_role` (Supabase's default privileges give `authenticated` write and `TRUNCATE` on new tables, and RLS does not cover `TRUNCATE`), then `GRANT SELECT` to `authenticated` only.
- **Read policy:** the same rule as `del_items_select` (admin, sales rep, or the delivery's assigned driver), written against `delivery_id`.

**`delivery_brand_events`** (new, append-only; update and delete refused by trigger). `seq bigint GENERATED ALWAYS AS IDENTITY` primary key (a strict order, used by the stale-save guard in 4.A), `event_type` in (`set`, `edited`, `completed`, `corrected`, `reviewed`), `delivery_id` (foreign key `ON DELETE RESTRICT`; deliveries are never hard-deleted today), `reason`, `invoice_ids uuid[]`, `before_rows jsonb`, `after_rows jsonb`, `actor`, `actor_name`, `created_at`. Same grants and read rule as `delivery_item_brands`.

**`invoice_items.brand_lines jsonb`** (new column; NULL by default). Meaning:
- `NULL`: the line has no delivered-brand information (an unbranded product, a credit memo, or a line not made from a delivery). It behaves exactly as REG-DB.
- `[]`: a branded line whose delivery recorded no brand (only possible while the brand-required switch is off). It prints "Brand not recorded" and keeps no EPA number, never the generic's own number.
- `[ {brand_name, epa_registration, manufacturer, delivered_quantity, rup_status, signal_word, facts_source, typed, pick_ids, completed_at} … ]`: one entry per delivered brand, ordered by trip completion time, then brand name, then EPA number. A completed trip with no picks adds an entry with `brand_name` NULL ("no brand recorded") for its amount.
- It is written only by the database, under REG-DB's capture pass. The client column grant is revoked, which fits REG-1 Q7 (all client writes on `invoice_items` revoked).

**`rup_sales_records.brand_name text`** (new, NULL for an unbranded record). Two brands with one EPA number in one record show both names, joined with "; ".

**`app_settings` row `delivery_brand_required`** = `false`, inserted by the migration. This is a live data row, so the apply gate may not class the migration as "routine grants only" (section 10).

### 3.2 Brand-list resolution (one internal helper)

`_delivery_line_brand_list(p_product_id uuid) RETURNS TABLE(source, parent_id, brand_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, row_version)`. It uses `get_product_brands`'s rule: the parent's active brands when the size is grouped **and** the grouping switch (`_product_parent_grouping_open()`) is on; otherwise the size's legacy rows. A product **has brands** when this returns at least one row. The picker shows currently sourced brands first and the rest under "Not currently bought (old stock)", so the screen offers exactly what the RPC accepts: any brand on the list. A typed name that matches a listed brand is stored as that listed pick (4.A).

### 3.3 Locking

Two kinds of writer, and neither waits on the other in a cycle:
- **Delivery-side writers** (`set_delivery_brands`, `edit_delivery`, completion, `correct_delivery_brands`): REG-DB's shared registration lock first (each re-issued function already takes it first), then the delivery row `FOR UPDATE`, its lines (ID order), brand rows `FOR SHARE` (legacy, then parent, ID order), picks, and last any **draft or unposted** invoices they re-copy (ID order), skipping any invoice that is no longer draft or unposted once locked.
- **Posting** keeps REG-DB's order (invoices first, REG-1 sheet §3.2). It reads the stored `brand_lines` only. It never reads or locks picks, deliveries or brand rows, so it never waits on a delivery-side writer.

Because the line guard refuses a `brand_lines` change on a posted invoice, a delivery-side writer that locks an invoice just after it was posted skips it instead of failing.

### 3.4 Retry safety and authorization (every public RPC)

- Each RPC takes `p_idempotency_key text DEFAULT NULL`. A missing key is refused (`IDEMPOTENCY_KEY_REQUIRED`) on every write path, following the bound-receipt pattern the delivery functions use today (`check_idempotency_intent(key, operation, actor, fingerprint)`, then `_bind_replay_receipt`, as in `20261019200000_bind_delivery_job_replay_receipts_batch3a.sql`). That pattern keeps one row per key: the same key on a different operation is refused (`IDEMPOTENCY_CROSS_OP_KEY_REUSE`), and the same key and operation with a different payload is refused.
- The three new operations (`set_delivery_brands`, `correct_delivery_brands`, `review_typed_brand`) are added to the operation list of the `require_bound_replay_receipt_20261015` constraint trigger, by dropping and recreating it with the drift preflight the batch migrations use (`20261123110000…:237-250`).
- Authorization runs **before** the replay lookup (the `20260716173342` rule), so a stranger cannot read someone else's cached result.
- Every `SECURITY DEFINER` function in PR B, public or internal, has `SET search_path = public, pg_temp` and schema-qualifies its references.
- Public RPCs: `REVOKE ALL … FROM PUBLIC, anon`, `GRANT EXECUTE … TO authenticated`.
- Internal helpers (`_delivery_line_brand_list` and any other `_`-prefixed function) get `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` explicitly, because PostgreSQL grants `EXECUTE` to `PUBLIC` by default.
- The migration's postflight check fails if any helper is executable by those roles or any PR B `SECURITY DEFINER` function lacks the pinned `search_path`.

### 3.5 Delivery receipt

The receipt body is saved as a snapshot when the receipt is queued, by `_enqueue_delivery_receipt` (`20261113140000_delivery_receipt_queue.sql:185-243`, `SECURITY DEFINER`); `claim_delivery_receipts` only hands that saved body to the worker. B-1 re-issues `_enqueue_delivery_receipt` so each entry in `receipt -> 'lines'` also carries `brands: [{name, epa_registration, quantity}]` (or `brand_recorded: false`), read from the current picks inside the same transaction as completion. The worker never needs table access. The `send-delivery-receipts` Edge Function (`supabase/functions/send-delivery-receipts/logic.ts:13`, `:55`) only knows `{name, qty}` today, so B-3 changes it to print the brands, and its deploy needs Mason's explicit yes (section 10). If #1649 or #1678 has moved receipt building elsewhere when B-1 is built, B-1 re-issues whichever function then builds the snapshot and names it in the caller analysis.

---

## 4. PR B-1 · The database PR

Built from each re-issued function's body **on live at build time** (after REG-DB). Each re-issue is diffed against `pg_get_functiondef` before review. The migration stamp must sort after REG-DB's claimed stamps (`20261218100000` to `20261218130000`) and any peer claim. Grep the peer worktrees and the shared notes folder at build.

### 4.A `set_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_base_event_seq bigint, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin, sales rep, or the delivery's assigned driver. This is the completion rule (`_complete_delivery_authorized_impl:1013-1019`), not a new one.
- **When:** while the delivery is `scheduled` or `in_progress`. Otherwise `DELIVERY_BRANDS_LOCKED` (after completion, use 4.F).
- **Stale-save guard:** `p_base_event_seq` is the delivery's highest event `seq` the screen loaded (NULL when it has none). If the delivery's highest `seq` is different, the save is refused (`BRAND_PICKS_CHANGED`) and the screen reloads. A replay with the same key returns the original result before this check runs.
- **Input:** `p_lines` is `[{delivery_item_id, picks: [{brand_id?, typed_name?, typed_epa?, typed_manufacturer?, quantity}]}]`. Each named line's current picks are replaced in one step. Lines that are not named are untouched. An empty `picks` array clears that line.
- **Rules:**
  - Each line belongs to the delivery (`DELIVERY_ITEM_NOT_ON_DELIVERY`).
  - A listed pick's brand must be on that line's brand list (3.2), checked by source, parent and product, or `BRAND_NOT_FOR_PRODUCT`. A retired parent brand is refused.
  - A typed pick needs a name. Its number must pass the strict CHECK if given. A typed name equal to a listed brand (case-insensitive) is stored as the listed pick when the numbers agree or the typed number is blank. When the numbers differ, it is stored as typed and flagged on the review list ("number differs from the list").
  - The pick amounts must each be above zero, and their sum must be at most the line's loaded `quantity` (`BRAND_SPLIT_OVER_LOADED`). A smaller sum is allowed so a short split can be saved just before completion (4.C).
  - Snapshots come from the brand row (or from the typed values), never from the client for a listed pick.
- **Writes:** one `set` event; its `seq` is returned as the next base. Replacing picks before completion deletes the old rows outright, because nothing has been issued yet. The event keeps them.
- **Returns:** the delivery's current picks and the new base `seq`.

### 4.B `edit_delivery` (re-issued)
Today its body deletes and re-creates every line (`20260611211058…:1573-1585`), so every line gets a new ID. After re-issue:
- the picks of each line whose `order_item_id`, `product_id`, `quantity` and `unit_size` are unchanged are re-pointed to the re-created line's new ID, with their snapshots, in the same transaction;
- the picks of a changed or removed line are dropped. The result lists those lines, so the screen flags them for a new pick;
- one `edited` event records the carried and dropped picks, so an open screen's next save is refused as stale (4.A) and it reloads with the new line IDs.

Cancel, void and restore leave picks alone. Picks go when `update_order_items` removes a cancelled delivery's lines (cascade); nothing was delivered, and the cancellation is already in the order's history.

### 4.C The completion rule (inside `_complete_delivery_authorized_impl`)
It runs right after the loop that writes `quantity_delivered` (today `:1107-1150`; the status is set `completed` just before it at `:1102-1106`) and before the tote copy (`:1159-1168`) and invoice drafting. It cannot be a status trigger, because the status flips before the delivered amounts exist. Every completion path goes through this function: `complete_delivery`, `start_and_complete_delivery`, and old offline replays still sitting on devices. The builder lists every caller from `pg_proc`, and the harness asserts each one reaches the rule. For each line:

1. **Delivered zero:** its picks are removed (one `completed` event keeps them).
2. **One pick:** its amount is set to the delivered amount (same brand, smaller amount; nothing is guessed).
3. **Several picks:** their sum must equal the delivered amount. When it does not:
   - brand-required switch on: refused with `BRAND_SPLIT_MISMATCH: line <product> delivered <n>, brands add up to <m>`;
   - switch off: kept as is and flagged "split does not match delivered" on the draft invoice.
4. **Branded line with no pick:**
   - switch on: refused with `BRAND_REQUIRED: pick the brand for <product>`;
   - switch off: completes. The line's invoice gets `brand_lines = []` (3.1).
5. **Listed pick no longer on the list** (the size moved parent, or the brand was retired, since the pick): never refused, because the snapshot already records what went off the truck. A legacy pick whose brand was moved is re-pointed to its parent brand through `product_parent_brand_sources` (`20261123120000`); otherwise it is kept with its snapshot and flagged for review.
6. **Capture sale facts** on every current pick, so a later brand-list edit never rewrites the sale:
   - **seeded:** from the pick's number's registration (`rup_status`, `signal_word`, `registration:<n>@<v>`). A number with no registration gets `unknown`;
   - **before the seed:** from the brand row (`is_rup` true → `yes`, false → `no`, NULL → `unknown`);
   - **typed:** `unknown`, unless seeded and its number has a registration.

A **short split** is saved with `set_delivery_brands` first and completion second: two calls from the screen, both online. **Not chosen:** a reserved key inside `p_quantities` (step 1's plan). It would change the parsing and fingerprints of every function that reads `p_quantities`, for a rare case.

The Bill Split auto-split path in completion runs inside `EXCEPTION WHEN OTHERS` and falls back to manual split billing (`20261215110000:~1281-1300`). A brand-helper error there must not be swallowed: the brand work runs before that block, and P26 proves an error in it fails completion instead of silently changing the billing.

Stock shortages still never block (To-Do 2.6). Lot and tote numbers are not read or required anywhere in PR B (August T-7, R-5).

**The acceptance rule "a brand must be picked when the product has brands" is enforced only once the brand-required switch is on** (section 9, order step 6). Until then PR B records and flags, and never blocks.

### 4.D Snapshot onto invoice lines
**Which picks belong to an invoice line** (used here and by the correction in 4.F):
- **Credit memos** (`invoice_type = 'credit_memo'`): never. `brand_lines` stays NULL, the same exclusion the tote copy uses (`20261215110000:1159-1168`).
- **An invoice with a `delivery_id`** (the automatic invoice, the quick-delivery draft, the unbilled-recovery invoice, each Bill Split payer invoice): the current picks of **that** delivery's line for the same `order_item_id`. Never a sibling delivery's.
- **An invoice with no `delivery_id`** (whole-order, landlord split): the current picks of every completed, not-voided delivery of that order line. Picks merge into one entry only when name, number, captured `rup_status` and signal word all match. A completed trip with no picks adds a "no brand recorded" entry for its delivered amount.

**Writing it.** REG-DB routes every invoice-line insert through `_capture_invoice_line_sale`. PR B extends that one helper:
- It computes `brand_lines` for a line that has an `order_item_id`, by the rule above: `NULL` when the product has no brands and no typed pick exists, `[]` when it is branded but unpicked.
- **One entry with a number:** the line's sold number (`epa_registration`) is that brand's number, and the line's own capture columns are copied from the pick's captured facts (`sale_facts_source = 'brand_pick'`), never re-captured from the registration at invoice time. So the line looks to every REG-DB check like an ordinary captured line.
- **Several entries, or one entry with no number:** the sold number is NULL, **never** the generic product's own number, and `sale_facts_source = 'brands'`. REG-DB's checks that read the line's capture (posting's `INVOICE_LINE_NOT_CAPTURED`, the Compliance "not reviewed" list and "Restricted-use sales to record") are extended to read each `brand_lines` entry instead for these lines: a line counts as captured when every entry is captured, and each `unknown` entry appears on the not-reviewed list.
- A line with `brand_lines` NULL is captured exactly as REG-DB does.

Every insert path gets this through the helper, including `_create_bill_split_delivery_invoices`, where each payer's line shows **all** the brands on the load (B-3 prints them as "on the load", with the payer's share as the line quantity).

**Re-copy on every pick change, never at posting.** `brand_lines`, the sold number and the copied capture are re-copied on the **draft and unposted** lines a pick change affects: at completion (this delivery's own invoices, the quick-delivery draft, the partial-delivery trim, and the open drafts of order-level invoices covering the lines it just completed), in `edit_delivery`, and in `correct_delivery_brands`. Posting does **not** re-copy: `post_invoice` hashes the lines before and after posting and refuses if they changed (`20261022022000_post_binds_reviewed_invoice_version.sql:480-487`), so posting reads exactly the stored `brand_lines` the office reviewed.

**`save_invoice`** carries `brand_lines` through its old-line-ID map, as REG-DB carries the capture columns. For a kept line with `brand_lines` not NULL:
- a **quantity** change keeps `brand_lines`, the sold number and the capture (Question 4: this is the one departure from REG-1's "a quantity change re-captures the line", because re-capturing would put the generic's number on a branded line);
- a **product** change sets `brand_lines` NULL and the line is captured as a new line.
A line the office adds by hand gets `brand_lines` NULL.

**Frozen once issued.** REG-DB's invoice-line guard is extended: `brand_lines` changes only under the capture pass, and never on a `posted`, `overdue` or `paid` invoice.

**No invoice amount, quantity or cost changes anywhere.** The cap triggers (`20261010120000`, `20261029160000`) do not read the new column. The harness compares every money column before and after.

**One-time effect at apply:** adding the column changes every invoice's posting-content hash once, so a screen loaded before the apply gets `INVOICE_CHANGED_SINCE_LOADED` on its first post and must reload (the same one-time effect noted in `20261027060000`).

### 4.E RUP register (re-issue of REG-DB's `generate_rup_sales_records`)
- **A line with `brand_lines` NULL:** exactly REG-DB's behaviour.
- **A line with brand entries:** one candidate record per entry, read from the stored `brand_lines`.
  - **Allocating the line's quantity and cents to entries:**
    - a Bill Split payer's line: in proportion to `delivered_quantity`;
    - any other line: in entry order (trip order), each entry taking up to its delivered amount until the line's quantity is used up. If the line's quantity is above the delivered total, the excess is added to the last entry. So a whole-order line still at 60 after trips of A 60 and B 40 records A 60, not A 36 and B 24.
    - Cents follow the quantity in whole cents; quantities are rounded to the line quantity's own scale (the builder confirms the column's scale from live). The last entry takes both remainders, so the records add up to the line exactly.
  - **Which entries need a record (REG-1's rule, per entry):** the entry's captured `rup_status` is `yes`, **or** the registration of that entry's number says `yes` at posting. Over-recording is the safe side; a captured `yes` is never lowered by a later change. An entry captured `unknown` under a restricted-use generic, or a typed entry captured `unknown`, is also recorded, with `compliance_status = 'warning'` and the note "RUP status of delivered brand not confirmed" (Question 2). A listed entry `unknown` under a non-RUP generic is not recorded, and shows on REG-DB's Compliance not-reviewed list (4.D).
  - **What each record holds:** the entry's EPA number, signal word and `brand_name`.
- **A record never has a blank EPA number** (REG-1's rule). On a restricted-use line, an entry with no brand recorded, a `brand_lines = []` line, or a typed entry with no number refuses posting with `BRAND_NOT_RECORDED: record the brand and its EPA number for <product> before posting` (Questions 1 and 3). The office fixes it with the correction in 4.F while the invoice is still a draft. The truck is never stopped by this.
- **Grouping:** REG-DB's key `(invoice, product, sold number, signal word)`, with each entry treated as its own sold number. Entries sharing a key are added into one record and their brand names joined. REG-DB's "an existing active record that disagrees is an error" rule and its posting lock stay.
- `get_rup_sales_register` returns `brand_name`.

### 4.F `correct_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin only. The reason is required. Only on a `completed` delivery.
- **Posted invoices are never edited (REG-1's rule).** If any invoice that 4.D links to a corrected line is `posted`, `overdue` or `paid`, the correction is refused with `INVOICE_POSTED: void <number> and reissue it first`. That is REG-1's path: void the posted invoice and make a replacement, which captures and posts normally.
- **What it does:** it never overwrites a completed pick. It marks the old current picks superseded (`superseded_*`) and inserts the new ones. Sale facts: a new pick for the **same brand** (name and number) as a superseded pick of that line copies that pick's captured facts; a **different** brand is captured now, and its `facts_source` is marked `corrected:<date>`. The new picks must add up to the delivered amount, and each listed pick must be on the line's **current** brand list (3.2), checked by source, parent and product (`BRAND_NOT_FOR_PRODUCT`). A typed pick follows the 4.A rules.
- **Then:** re-copies the affected `draft` and `unposted` invoice lines (4.D). Voided and cancelled invoices are left alone.
- **Logging:** one `corrected` event with every invoice ID it re-copied.

### 4.G `review_typed_brand(p_pick_id uuid, p_action text, p_brand_id uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin only.
- `p_action = 'link'` points the typed pick at a brand **already on** the line's brand list (`review_brand_ref`), so it shows as reviewed. It never changes the pick's snapshot.
- `'dismiss'` records the dismissal.
- **Adding a new brand to a list stays in the existing brand RPCs** (`upsert_parent_brand` / `upsert_product_brand`, with REG-DB's registration rules). The review screen calls that first, then `link`. PR B adds no second brand writer.
- One `reviewed` event.

### 4.H Read RPCs
- `get_delivery_brands(p_delivery_id)`: each line, its brand list (3.2), its current picks, and the delivery's highest event `seq`. Same read rule as the delivery.
- `get_typed_brands_for_review()`: admin only; pending typed picks with delivery, product and line.
- `get_deliveries_missing_brands(p_from date, p_to date)`: admin only; completed branded lines with no picks (the switch-on backlog report, section 10).
- `get_detailed_statement_data` is re-issued to return `brand_lines`.

### 4.I Files, harness, risks
- **Files:**
  - `supabase/migrations/<stamp>_delivery_brands.sql` and its ledger record `docs/reference/migrations.d/<stamp>_delivery_brands.md`;
  - `docs/changelog.d/<date>-delivery-brands-db.md`;
  - `scripts/smoke/prove-delivery-brands-real-schema.mjs` with its `smoke-specs.json` entry;
  - `src/lib/rpcContracts.test.ts`, `src/lib/rpcIdempotencyScope.test.ts`, `src/lib/rlsContracts.test.ts` (new RPCs, operations and tables);
  - `src/types/index.ts` (the `DeliveryItemBrand` type and the new fields);
  - `.claude/schema-registry.json` (regenerated after apply, in a follow-up registry refresh PR).
- **Harness:** the real-schema prover runs every B-1 case in section 7 against a copy of the live structure.
- **Risks:**
  - This re-issues money-path functions (completion, every invoice writer, RUP, the receipt snapshot). No amount changes, and the prover compares all money columns.
  - A missed invoice writer would print the generic number. The harness lists every `pg_proc` body that inserts `invoice_items` and fails if one bypasses the helper (REG-DB already requires this).
  - The one-time posting hash change (4.D).
- **Sol list:** yes (`supabase/`).

---

## 5. PR B-2 · Capture screens (after B-1 is live)

**Online only.** Since Goal 5 (Mason, 2026-10-15), a delivery is completed only with signal and nothing new is queued offline (`FieldStop.tsx:825`, `offlineSync.ts:383-393`). Brand saves follow the same rule: with no signal, the screen says "Brands save when you have signal" and does nothing. PR B adds nothing to the offline queue, `offlineSync.ts` or `stage_offline_action`.

- **Delivery page** (`src/pages/DeliveryDetail.tsx`, office and phone layouts) and **driver stop** (`src/pages/FieldStop.tsx`):
  - a **Brand** picker per branded line: currently sourced brands first, then "Not currently bought (old stock)", plus **Other brand…** (name, EPA number, manufacturer; the number is optional and marked "from the jug label");
  - **Split** adds a second brand with an amount. Picks save any time before completion.
- **Completion screens:**
  - a line with no pick asks for one;
  - a short split line asks how much of each brand went off the truck, pre-filled with what was loaded, then saves it (`set_delivery_brands`) before calling completion;
  - the refusal codes from 4.C are shown as plain sentences naming the line.
- **Saving safely:**
  - The screen's picks belong to one delivery ID and are reloaded from `get_delivery_brands` when it opens another delivery or reopens.
  - Each save gets one retry key from the existing `useIdempotencyKey` hook, reused on every retry of that same save and replaced only when the choices change.
  - One save at a time: while a save or a completion is in flight, the picker, Split and Complete are disabled, and a reply for anything but the latest request is ignored. Complete is offered only after the latest save has come back. Completion sends nothing about brands; the database reads the saved picks.
  - A `BRAND_PICKS_CHANGED` refusal (someone else saved, or the delivery was edited) reloads the picks and says so.
  - A failed save leaves the screen's choices in place, shows the error, and keeps Complete disabled until a save succeeds.
- **Deliveries list** (`src/pages/Deliveries.tsx`): one-click **Mark Delivered** shows "Pick the brand on the delivery page first" for `BRAND_REQUIRED`.
- **Edit delivery:** the lines whose picks were dropped (4.B) are flagged.
- **Products page** (`src/pages/Products.tsx`): a **Brands to review** tab (admin), using a new `src/components/products/TypedBrandReview.tsx`. "Add to list" calls the existing brand RPC, then `review_typed_brand('link')`. PR B-2 does **not** edit `ProductDetail.tsx` or `ProductBrandsSection.tsx`.
- **Admin settings** (`src/pages/SettingsPage.tsx`): the `delivery_brand_required` switch, showing the count from `get_deliveries_missing_brands` beside it. The change is logged with `logActivity`. Any admin can flip the setting, as with other `app_settings` rows (`settings_update` is admin-only); that gap is accepted, and section 10 keeps the switch-on as Mason's call.
- **Quick delivery:** no picker in the modal. It is completed on its delivery page, where the picker is (step 1 §5).
- **New client helper:** `src/lib/deliveryBrands.ts`, which calls `assertRpcResult()` after each RPC.
- **Sol list:** yes (`src/pages/Products.tsx`, `src/pages/SettingsPage.tsx`, plus "deliver" in file names).

## 6. PR B-3 · Paperwork and records (after B-1 is live; may land with or after B-2)

- **Delivery receipt PDF** (`src/lib/deliveryPdf.ts`): under each line, each brand with its EPA number and amount, or "Brand not recorded". Every caller fetches the brands: `DeliveryDetail.tsx`, `FieldStop.tsx`, and the batch print in `Deliveries.tsx:1100-1115` (`generateBatchDeliveryPdf`).
- **Receipt email:** the `send-delivery-receipts` Edge Function prints the `brands` that `_enqueue_delivery_receipt` saves in the snapshot (3.5). Its deploy needs Mason's explicit yes, and is downloaded and diffed after deploy. The proof covers a first send and a resend.
- **Invoice PDF** (`src/lib/invoicePdf.ts`) and every caller: `INVOICE_ITEM_COLUMNS` in `src/lib/costFields.ts:49` adds `brand_lines`, which carries it to the single-invoice print, the batch print through `buildInvoicePdfDataFromRow` (`Invoices.tsx`) and the field-invoice panels.
  - the EPA column prints the line's number;
  - for a split line, the entries' numbers joined;
  - under the line, the brand names and amounts from `brand_lines` (on a Bill Split payer's line, labelled "on the load");
  - "Brand not recorded" for `[]` or a no-brand entry.
- **Statement:** `src/lib/statementPdf.ts:581`, `:636` print the joined numbers when the line's own number is blank, from `get_detailed_statement_data`'s `brand_lines`.
- **Invoice screen** (`src/pages/InvoiceDetail.tsx`):
  - the brands are shown read-only on lines made from a delivery;
  - warnings before posting: "Brand typed at delivery, not yet checked", "Brand not recorded", "Split does not match delivered", and "Quantity changed from delivered"; and the plain sentence for `BRAND_NOT_RECORDED` (4.E).
- **Compliance page** (`src/pages/Compliance.tsx`): the RUP register shows a **Brand** column and the new notes; the not-reviewed list shows `unknown` brand entries (4.D).
- **Sol list:** yes (`invoicePdf.ts`, `statementPdf.ts`, `deliveryPdf.ts`, `InvoiceDetail.tsx` carry money words, and `supabase/functions/`). The `pdf-output-reviewer` agent runs on the three PDFs.

---

## 7. Done when (prover cases; B-1 in the real-schema harness, B-2/B-3 with screen tests and a local run)

"Switch" below means the brand-required switch; "grouping switch" means `_product_parent_grouping_open()`.

**Brand lists and picks**
- P1. Ungrouped size with legacy brands: listed pick saved, snapshot from the brand row. A Liberty brand on a Roundup line, a brand from another parent and a brand from another size's legacy list are refused (`BRAND_NOT_FOR_PRODUCT`).
- P2. Grouped size with the grouping switch on: the parent's active brands are the list. A retired parent brand is refused. A legacy brand ID on a grouped size is refused. A not-currently-sourced listed brand is accepted.
- P3. Typed brand with a number completes and lands on the review list. A typed brand with a blank number completes and is flagged. A typed name equal to a listed brand with the same number is stored as listed.
- P4. A driver not assigned to the delivery, a non-active user and an anonymous caller are refused. The same key with the same request changes nothing (one event); the same key with a different request is refused; the same key on another of the three operations is refused (`IDEMPOTENCY_CROSS_OP_KEY_REUSE`); a missing key is refused.
- P5. A save with an old `p_base_event_seq` is refused after a newer save and after an `edit_delivery`; a same-key replay of the older save returns its original result.

**Completion**
- P6. Switch on: a branded line with no pick is refused, naming the line. After the pick, it completes. The check sees the final delivered amounts (the case a status trigger would miss).
- P7. A 30/15 split loaded at 45, delivered 40: with the switch on, completion is refused until the 40 split is saved; after saving, it completes. A line delivered at zero keeps no picks.
- P8. Switch off: every case above completes, records what was picked, and gives `brand_lines = []` with no EPA number (never the generic's).
- P9. A legacy pick whose size was then grouped completes in both switch states and is re-pointed to its parent brand; a pick of a retired brand completes and is flagged.
- P10. No lot or tote number anywhere: every case completes. A tote number, when present, is still copied as today.
- P11. Every caller of `_complete_delivery_authorized_impl` from `pg_proc` reaches the rule, including an old offline completion replay.

**Invoices**
- P12. Automatic invoice: one-brand line → the line's number is the brand's, its capture is copied from the pick (`brand_pick`), and REG-DB's posting check treats it as captured; split line → no single number, two entries, captured per entry; unbranded product → as REG-DB.
- P13. Bill Split: each payer's invoice line carries all the load's brands; RUP divides each payer's share by brand in proportion, and the cents add up exactly per payer.
- P14. One order line delivered in two trips with different brands, each trip billed alone: each invoice shows only its own trip's brands. A whole-order invoice and a landlord split invoice list both trips; two trips of one brand with different captured status stay separate entries; a trip with no picks adds a no-brand entry.
- P15. Quick-delivery draft, partial-delivery trim and a whole-order draft made before the delivery are all re-copied at completion. A credit memo line keeps `brand_lines` NULL.
- P16. `save_invoice` keeps `brand_lines` through a save; a quantity change keeps the brand, number and capture; a product change clears `brand_lines` and captures as new. A client write to `brand_lines` is refused. A posted line's `brand_lines` cannot change.
- P17. Posting changes no line (the posting hash check passes) and reads the stored `brand_lines`.
- P18. No money column (`quantity`, `unit_price_cents`, `extended_cents`, `cost_cents`, invoice totals) changes in any case compared with the same flow without brands.

**RUP**
- P19. A split restricted-use line posts two records with the right numbers, amounts and cents adding up exactly. Two lines of one product and one brand number on one invoice produce one record. A whole-order line at 60 after trips of A 60 and B 40 records A 60.
- P20. A brand captured `no` whose registration says `yes` at posting is recorded (REG-1's rule); one captured `yes` keeps its record after a flip to `no`. An `unknown` entry under a restricted-use generic, and a typed `unknown` entry under a non-RUP generic, are recorded with the warning. A listed `unknown` entry under a non-RUP generic is not recorded and shows on the Compliance not-reviewed list.
- P21. A restricted-use line with `brand_lines = []`, a no-brand entry, or a typed entry with no number refuses posting with `BRAND_NOT_RECORDED`; after the draft-time correction it posts.
- P22. Unpost, void and re-post behave as before under the new grouping (PARKED-006).

**Correction and review**
- P23. Correction with only draft or unposted invoices re-copies them; a split-only change keeps each brand's captured facts; a different brand records `corrected:<date>`.
- P24. Correction when a linked invoice is posted, overdue or paid is refused with `INVOICE_POSTED`; after void and reissue it succeeds and the replacement carries the corrected brands.
- P25. A brand's EPA number changed afterwards leaves old deliveries, invoices and RUP records unchanged. `review_typed_brand('link')` leaves the pick's snapshot unchanged; adding a brand goes through the existing brand RPC.

**Editing, receipts, grants, concurrency**
- P26. Changing only a scheduled delivery's date keeps the picks under the new line IDs; changing one line's quantity or unit size drops only that line's picks; both write an `edited` event. An error in the brand step during a Bill Split completion fails the completion instead of falling back.
- P27. The receipt snapshot from `_enqueue_delivery_receipt` carries each line's brands (single, split, typed, none) and service_role has no table privilege on the new tables.
- P28. Grants and policies read directly from `information_schema` and `pg_policy`: `authenticated` can only SELECT the new tables under the delivery rule; `anon`, `service_role` and `PUBLIC` have nothing; the `brand_lines` column grant is revoked; every `_` helper is not executable by `PUBLIC`, `anon`, `authenticated` or `service_role`; every PR B `SECURITY DEFINER` function has the pinned `search_path`; the receipt-binding trigger lists the three new operations. An admin session cannot reveal a missing grant (August C-25), so this is checked directly.
- P29. Completion re-copying an order-level draft while that draft is being posted, in both orders at once: no deadlock, and the posted invoice is skipped, not changed.

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
| #1649, #1678 (receipt sending) | B-1 adds brands to the receipt snapshot wherever these leave it (3.5) | Open |
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
3. **Apply B-1 live.** It is non-destructive, but it also inserts the `delivery_brand_required` setting row and recreates the receipt-binding trigger on `idempotency_keys`, so the apply gate may not class it as routine grants only. If so, it needs Mason's `approve <code>`.
4. **Deploy the `send-delivery-receipts` Edge Function change** (B-3). An Edge Function deploy always needs his explicit yes; it is downloaded and diffed after deploy.
5. **Turn on `delivery_brand_required`** once B-2 and B-3 are live and proven and the missing-brands report is empty. It is a live setting change, so it needs his explicit yes in that session.

---
---

## 11. Questions for Mason

1. **A typed brand whose EPA number cannot be read** (smudged jug, no label): the delivery still finishes, and the line is flagged on the review list and the draft invoice. On a restricted-use product, the invoice cannot be posted until the office records the number (REG-1: a RUP record never has a blank number). **Recommended.** The alternative is to require the number at the truck, which would stop the delivery.
2. **A delivered brand whose restricted-use status is unknown, under a restricted-use generic, or any typed brand whose status is unknown:** it goes on the RUP register with a warning to confirm (over-recording is the safe side). **Recommended.** The alternative is only listing it on the Compliance review list, which risks a missing regulated record.
3. **A restricted-use line delivered with no brand recorded** (only while the brand-required switch is off): the invoice cannot be posted until the office records the brand. **Recommended**, because a RUP record can never have a blank number. The alternative is posting with the generic product's number, which may be the wrong label.
4. **The office changes the quantity on a branded invoice line:** the plan keeps the delivered brand and its EPA number. This departs from your REG-1 rule ("a quantity change re-captures the line from the product's current label") only for branded lines, because re-capturing would put the generic's number on a line whose brand is known. **Recommended.** The alternative is to follow REG-1 exactly, which prints the generic's number after any quantity edit.

A brand corrected after the invoice was sent follows REG-1: void and reissue the invoice. No question needed.

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

**Luna round 3** (head `5b0923c2f`): 6 findings, all **fixed**.
- HIGH, correction took the delivery lock before the registration lock: it now follows the shared order (3.3, P35).
- HIGH, a registration change before posting could add an RUP record: the captured status decides (4.E, P36).
- MED, an order-level draft made before delivery stayed "Brand not recorded": completion refreshes it (4.D, P37).
- MED, the RPC accepted unsourced brands the picker hid: the picker now shows them as old stock (3.2, P38).
- MED, edits during an in-flight completion: controls stay locked and the database refuses late saves (section 5).
- MED, an old save could land after a newer one: `p_base_event_id` stale-save guard (4.A, P39).

**Luna round 4** (head `d26bd4bcd`): 5 findings, all **fixed**.
- HIGH, whole-order aggregation merged trips with different captured facts: entries merge only when the facts match (4.D, P40).
- HIGH, trips with no picks were folded into the recorded brand: they become their own unrecorded entry (4.D, 4.E, P40).
- HIGH, a correction re-read changed facts: same-brand corrections keep the original facts; a new brand is marked as captured at correction (4.F, P41).
- MED, a reopen lost the pending save's key: kept in the queue's durable store (section 5, P42).
- MED, restarting request counters: random request IDs (section 5).
- Note: rounds 2 to 4 each found a HIGH in how RUP facts follow a sale. Each was a different gap, and the rule is now one sentence: the facts captured at the sale decide, and are only re-read for a brand that was not on the sale.

**Luna round 5** (head `87dd75cf5`): 2 MED, no BLOCKER or HIGH. Both **fixed** in one commit with no rule change, so no rerun is needed (codex-review Step 3A).
- MED, offline completion waited for a save reply: offline, completion queues behind the pending save (section 5).
- MED, the correction note was added to unchanged lines' records: only records built from a corrected line get it (4.F).

**Codex GitHub review** (head `b13da08f8`): 1 P2, **fixed**. Coalescing offline saves could drop an earlier line's pick: pending saves now merge by line (section 5, P43).

**Independent Opus review** (2026-11-09, head `a327319de`): 6 HIGH, 9 MED, 12 LOW, all checked against the code and **fixed** in one rework; the root cause of four HIGHs was that rounds 2 to 4 re-decided rules REG-1 and the current app already settle.
- HIGH, an offline brand-save queue the app no longer has (Goal 5: completion is online only): **cut**; section 5 is online only (old P42, P43 removed).
- HIGH, posting re-copied `brand_lines`, which `post_invoice`'s before/after hash check would refuse: **cut**; posting reads the stored copy, every pick change re-copies drafts (4.D, P17).
- HIGH, captured status alone decided RUP, against REG-1's "captured yes OR registration yes at posting": **fixed**, REG-1's rule per entry (4.E, P20).
- HIGH, split lines escaped REG-DB's capture checks and Compliance lists: **fixed**, single-brand lines copy the pick's capture, split lines are checked per entry (4.D, P12, P20).
- HIGH, correcting a posted invoice contradicted REG-1 ("void and reissue") and could flip unchanged records: **cut**; correction refuses posted invoices (4.F, P24), old Question 4 and P22, P23, P33, P35 removed.
- HIGH, `save_invoice` quantity change re-captured the generic's number: **fixed** and raised as Question 4 (4.D, P16).
- MED: receipt snapshot is built by `_enqueue_delivery_receipt`, and the Edge Function needs a change and deploy (3.5, sections 6, 10); missing PDF callers (section 6); cross-operation key reuse is refused and the receipt-binding trigger needs the new operations (3.4, P4, P28); `authenticated` revoke (3.1); `edit_delivery` new line IDs, event and `unit_size` (4.B, P26); credit memos excluded (4.D, P15); allocation in trip order and quantity rounding (4.E, P19); `BRAND_LIST_CHANGED` refusal removed (4.C, P9); lock order rewritten so posting never waits on a delivery writer (3.3, P29). All **fixed**.
- LOW: line references corrected (section 1, 4.C); "switch" disambiguated (section 7); section 5 contradictions removed by the rewrite; event order by `seq` (3.1, 4.A); admin can flip the setting, accepted and logged (section 5); acceptance enforced only at switch-on, stated (4.C); one-time posting hash change (4.D); Bill Split "on the load" label (section 6); apply gate classification (section 10); auto-split error swallowing (4.C, P26); event delete behaviour (3.1). All **fixed** or stated.
- Not verified by the reviewer and re-checked here: live counts and the latest live migration were read on 2026-11-08 (section 1).
