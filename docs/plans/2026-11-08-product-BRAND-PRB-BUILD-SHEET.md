# Product Master Stage 3: brand PR B build sheet (delivered brand, its EPA number, RUP records per brand)

**Status (2026-11-08, reworked 2026-11-09 after an independent review):** this is a plan only. **Question 5 answered (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just warn"): a brand problem never stops a delivery or an invoice; it warns and is listed for the office.** Sections 3, 4, 5, 7, 9 and 10 were rewritten to that rule; the brand-required switch is removed. No code and no migration have been written. It was written on 2026-11-08 against `main` (`4504e3e6a`) and the live database, using read-only SQL only. For building, this sheet replaces "PR B" in `docs/plans/2026-10-22-product-brands-step1-PLAN.md` (sections 4, 5, 7 and 8). Where the two differ, this sheet wins, and section 2 lists each difference. A reference like "step 1 §4" means that plan.

**Re-check 2026-11-10 (night):** the PAR-2 precondition is met on live, and REG-1 step 2 was rebuilt as #1746 with a different design (section 13). Mason answered Questions 8 and 9 the same night. **Section 14 is the current design and wins over sections 3 to 7 wherever they differ**; read section 14 first.

**Cannot start yet (2026-11-08 text, kept for history).** The grand plan (`docs/plans/2026-10-29-product-GRAND-PLAN.md`, Stage 3 and overlap 13) says PR B is built only after the PAR-1/PAR-2 brand move is live and verified. Today it is not: the grouping switch is off and no parent or brand exists (section 1). PR B also has to be built on top of REG-1 step 2 (REG-DB), because both rewrite the same invoice and RUP functions. Section 9 has the full list.

**Words used here.**
- **Brand list:** the brands a size may be filled with. For a grouped size with the grouping switch on, this is its parent's `product_parent_brands` (active rows). Otherwise it is the size's own legacy `product_brands`. This is exactly what `get_product_brands` returns today.
- **Pick:** one brand recorded on one delivery line, with its amount. A line may have several picks (a split).
- **Listed pick:** a pick of a brand on the line's brand list. **Typed pick:** a brand typed by hand because it is not on the list (August D-K).
- **Snapshot:** the brand name and EPA number copied onto the pick (and later onto the invoice line) at the time, so later edits to the brand list never change history.
- **Branded line:** a delivery line whose product has at least one brand on its list, or that carries a typed pick.
- **Registration, sale capture, seeded:** as in the REG-1 sheet (`docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md`): the per-EPA-number record, the RUP and signal-word facts copied onto an invoice line when it is made, and whether the REG-1 seed has run.
- **Brand problem:** on a branded line, no brand recorded, a typed brand with no EPA number, brand amounts that do not add up to what was delivered, or more billed than was delivered.
- **Warn, never block** (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just warn"): no brand problem ever refuses a completion or a posting. It shows a warning and puts the line on an office follow-up list (4.H). There is no brand-required switch.

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
| 10 | A typed brand needs its EPA number | D-K: an unlisted brand never blocks | The number is optional at the truck. A blank one is flagged on the review list and the draft invoice; the invoice still posts, that entry gets no RUP record and is on the RUP brand gaps list (Question 5). |

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
- **Snapshot:** `brand_name text NOT NULL` (same trim and length rules as the brand tables), `epa_registration text` (strict EPA-number CHECK when not null; NULL for a typed pick whose number could not be read, or a listed brand whose row has no number; either is treated as "EPA number not recorded": warned, no RUP record, listed (4.E)), `manufacturer text`.
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
- `[]`: a branded line whose delivery recorded no brand (allowed: a missing brand never refuses completion). It prints "Brand not recorded" and keeps no EPA number, never the generic's own number.
- `[ {brand_name, epa_registration, manufacturer, delivered_quantity, rup_status, signal_word, facts_source, typed, pick_ids, completed_at} … ]`: one entry per delivered brand, ordered by trip completion time, then brand name, then EPA number. A completed trip with no picks adds an entry with `brand_name` NULL ("no brand recorded") for its amount **when at least one other trip of the line has picks**; when no trip has any pick, the value is `[]` (one shape per case).
- It is written only by the database, under REG-DB's capture pass. The client column grant is revoked, which fits REG-1 Q7 (all client writes on `invoice_items` revoked).

**`rup_sales_records.brand_name text`** (new, NULL for an unbranded record). Two brands with one EPA number in one record show both names, joined with "; ".

### 3.2 Brand-list resolution (one internal helper)

`_delivery_line_brand_list(p_product_id uuid) RETURNS TABLE(source, parent_id, brand_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, row_version)`. It uses `get_product_brands`'s rule: the parent's active brands when the size is grouped **and** the grouping switch (`_product_parent_grouping_open()`) is on; otherwise the size's legacy rows. A product **has brands** when this returns at least one row. The picker shows currently sourced brands first and the rest under "Not currently bought (old stock)", so the screen offers exactly what the RPC accepts: any brand on the list. A typed name that matches a listed brand is stored as that listed pick (4.A).

### 3.3 Locking

**One order for everyone: REG-DB's** (REG-1 sheet §3.2): REG-DB's shared registration lock (`pg_advisory_xact_lock(hashtext('crx_epa_registration'))`, shared) as the **first statement**, then invoices (ID order), then registrations, parents, products, brands, then lines and records. The seed and number changes take that lock exclusive before anything else, so no writer ever holds an invoice or delivery lock while waiting for the seed, and nothing waits in a cycle.
- **Delivery-side writers** (`set_delivery_brands`, `edit_delivery`, completion, `correct_delivery_brands`, `review_typed_brand`). Every writer of a delivery's brand events holds that delivery row `FOR UPDATE` (step 3) before writing its event, so one delivery's events commit one at a time and their `seq` order is their commit order:
  1. REG-DB's shared registration lock, as the first statement;
  2. read, without locking, the **draft or unposted** invoices whose lines they may re-copy (4.D), then lock them `FOR UPDATE` in ID order and drop any that is no longer draft or unposted;
  3. the delivery row `FOR UPDATE`, its lines (ID order), brand rows `FOR SHARE` (legacy, then parent, ID order), picks.
  Invoices the writer creates itself (completion's drafts) are new rows and need no prior lock. An invoice created by someone else after step 2 is not re-copied by that writer; the posting step below catches it.
- **Posting** keeps REG-DB's order (shared lock, then its invoice). It never locks picks or brand rows. After its invoice lock, it takes the delivery row of each delivery-made line `FOR SHARE` (ID order). A brand writer that is mid-flight holds that row `FOR UPDATE`, so posting waits for it to commit and then reads its picks; a writer that starts later waits for posting's invoice lock (if it re-copies that invoice) or sees the invoice posted and skips it. Either way posting never checks against picks that are about to change underneath it. This cannot cycle: the writer takes the delivery row only after any invoice lock it needs, and posting holds no delivery row while waiting for an invoice.
- **Read-only staleness check at posting:** after the delivery rows are held, and before the line hash is taken, posting recomputes, for each delivery-made line **whose `product_id` still equals its delivery line's** (a line whose product the office changed is detached, 4.D, and is skipped), the expected `brand_lines` from the current picks (a plain read) and refuses with `BRAND_LINES_STALE: reload and save the invoice` if the stored copy differs. Nothing is rewritten, so the posting hash check is unaffected. Re-saving the draft (`save_invoice`, 4.D) refreshes it. Because `brand_lines` is part of the lines `post_invoice` hashes, any brand change after the office loaded the invoice (a re-copy or a save) makes posting refuse with the existing `INVOICE_CHANGED_SINCE_LOADED`, so the office always posts the brands it saw; the screen reloads and shows them.

### 3.4 Retry safety and authorization (every public RPC)

- Each RPC takes `p_idempotency_key text DEFAULT NULL`. A missing key is refused (`IDEMPOTENCY_KEY_REQUIRED`) on every write path, following the bound-receipt pattern the delivery functions use today (`check_idempotency_intent(key, operation, actor, fingerprint)`, then `_bind_replay_receipt`, as in `20261019200000_bind_delivery_job_replay_receipts_batch3a.sql`). That pattern keeps one row per key: the same key on a different operation is refused (`IDEMPOTENCY_CROSS_OP_KEY_REUSE`), and the same key and operation with a different payload is refused.
- The three new operations (`set_delivery_brands`, `correct_delivery_brands`, `review_typed_brand`) are added to the operation list of the `require_bound_replay_receipt_20261015` constraint trigger, by dropping and recreating it with the drift preflight the batch migrations use (`20261123110000…:237-250`).
- Authorization runs **before** the replay lookup (the `20260716173342` rule), so a stranger cannot read someone else's cached result.
- Every `SECURITY DEFINER` function in PR B, public or internal, has `SET search_path = public, pg_temp` and schema-qualifies its references.
- Public RPCs: `REVOKE ALL … FROM PUBLIC, anon`, `GRANT EXECUTE … TO authenticated`.
- Internal helpers (`_delivery_line_brand_list` and any other `_`-prefixed function) get `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` explicitly, because PostgreSQL grants `EXECUTE` to `PUBLIC` by default.
- The migration's postflight check fails if any helper is executable by those roles or any PR B `SECURITY DEFINER` function lacks the pinned `search_path`.

### 3.5 Delivery receipt

The receipt body is saved as a snapshot when the receipt is queued, by `_enqueue_delivery_receipt` (`20261113140000_delivery_receipt_queue.sql:185-243`, `SECURITY DEFINER`); `claim_delivery_receipts` only hands that saved body to the worker. B-1 re-issues `_enqueue_delivery_receipt` so each entry in `receipt -> 'lines'` also carries `brands: [{name, epa_registration, quantity}]` (or `brand_recorded: false`), read from the current picks inside the same transaction as completion. The worker never needs table access. The `send-delivery-receipts` Edge Function (`supabase/functions/send-delivery-receipts/logic.ts:13`, `:55`) only knows `{name, qty}` today, so B-3 changes it to print the brands, and to print a line with no `brands` key (a snapshot queued before B-1) exactly as today, so a receipt still pending at deploy sends unchanged, and its deploy needs Mason's explicit yes (section 10). If #1649 or #1678 has moved receipt building elsewhere when B-1 is built, B-1 re-issues whichever function then builds the snapshot and names it in the caller analysis.

---

## 4. PR B-1 · The database PR

Built from each re-issued function's body **on live at build time** (after REG-DB). Each re-issue is diffed against `pg_get_functiondef` before review. The migration stamp must sort after REG-DB's claimed stamps (`20261218100000` to `20261218130000`) and any peer claim. Grep the peer worktrees and the shared notes folder at build.

### 4.A `set_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_base_event_seq bigint, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin, sales rep, or the delivery's assigned driver. This is the completion rule (`_complete_delivery_authorized_impl:1013-1019`), not a new one.
- **When:** while the delivery is `scheduled` or `in_progress`. Otherwise `DELIVERY_BRANDS_LOCKED` (after completion, use 4.F).
- **Stale-save guard:** `p_base_event_seq` is the delivery's highest event `seq` the screen loaded (`0` when it has none; NULL is refused). If the delivery's highest `seq` is different, the save is refused (`BRAND_PICKS_CHANGED`) and the screen reloads. A replay with the same key returns the original result before this check runs.
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
It keeps its live `p_idempotency_key` and bound replay receipt (live signature checked 2026-11-09); a replay returns the original result and writes no second `edited` event. Today its body deletes and re-creates every line (`20260611211058…:1573-1585`), so every line gets a new ID. It already accepts only deliveries that are not completed; the builder confirms that from the live body and, if any completed path exists, refuses it for a delivery with picks (`DELIVERY_BRANDS_LOCKED`; corrections go through 4.F). After re-issue:
- **before** the old lines are deleted (the pick foreign key cascades), the current picks are copied into a temporary table;
- the picks of each line whose `order_item_id`, `product_id`, `quantity` and `unit_size` are unchanged are re-inserted from that copy against the re-created line's new ID, with their snapshots, in the same transaction;
- the picks of a changed or removed line are dropped. The result lists those lines, so the screen flags them for a new pick;
- one `edited` event records the carried and dropped picks, so an open screen's next save is refused as stale (4.A) and it reloads with the new line IDs.

Cancel and void leave picks alone. Picks go when `update_order_items` removes a cancelled delivery's lines (cascade); nothing was delivered, so no issued paper or record loses anything, and the cancellation is already in the order's history. There is no live `restore_delivery` (checked 2026-11-09); any later path that re-creates a delivery's lines starts them with no picks, and the screen shows the no-brand warning.

### 4.C The completion rule (inside `_complete_delivery_authorized_impl`)
It runs right after the loop that writes `quantity_delivered` (today `:1107-1150`; the status is set `completed` just before it at `:1102-1106`) and before the tote copy (`:1159-1168`) and invoice drafting. It cannot be a status trigger, because the status flips before the delivered amounts exist. Every completion path goes through this function: `complete_delivery`, `start_and_complete_delivery`, and old offline replays still sitting on devices. Every path, old offline replays included, gets the same rule, and the rule never refuses for a brand problem. The builder lists every caller from `pg_proc`, and the harness asserts each one reaches the rule. For each line:

1. **Delivered zero:** its picks are removed (one `completed` event keeps them).

The `completed` event records, for every line, its delivered amount and the size of its brand list at that moment, for the missing-brands report (4.H).
2. **One pick:** when the delivered amount is at most the pick's amount, the pick is set to the delivered amount (same brand, smaller amount; nothing is guessed). When more was delivered than the pick covers, the pick is kept as saved and the line is treated as a split that does not match (step 3), so the extra is never credited to that brand.
3. **Several picks whose sum is not the delivered amount:** completes; the picks are kept as saved and the line is flagged "split does not match delivered" on the draft invoice and the missing-brands list (4.H).
4. **Branded line with no pick:** completes. The line's invoice gets `brand_lines = []` (3.1), and the line is on the missing-brands list.
5. **Listed pick no longer on the list** (the size moved parent, or the brand was retired, since the pick): never refused, because the snapshot already records what went off the truck. A legacy pick whose brand was moved is re-pointed to its parent brand through `product_parent_brand_sources` (`20261123120000`); otherwise it is kept with its snapshot and flagged for review.
6. **Capture sale facts** on every current pick, so a later brand-list edit never rewrites the sale:
   - **seeded:** from the pick's number's registration (`rup_status`, `signal_word`, `registration:<n>@<v>`). A number with no registration gets `unknown`;
   - **before the seed:** from the brand row (`is_rup` true → `yes`, false → `no`, NULL → `unknown`);
   - **typed:** `unknown`, unless seeded and its number has a registration.

A **short split** is saved with `set_delivery_brands` first and completion second: two calls from the screen, both online. **Completion checks the screen saw the current picks:** `complete_delivery` and `start_and_complete_delivery` gain one trailing `p_brand_base_seq bigint DEFAULT NULL`. As `20261113140000` did, each old signature is **dropped** and the new one created with the same grants, so no overload without the check remains; the migration's caller analysis lists every caller (screens, `process_offline_action`) and the postflight asserts one signature each. When given, completion is refused with `BRAND_PICKS_CHANGED` if the delivery's highest brand event `seq` (`0` when it has no events) differs, so a driver never completes with picks someone else saved after the screen loaded. The capture screens and the list always send it, as `0` for a delivery with no brand events, so NULL means only "an old caller that asked for no check" and a first save after the screen loaded is still caught. It joins the request fingerprint only when not NULL, so existing retries keep their fingerprints. A caller that sends NULL (an old queued replay, or an app bundle cached from before B-2) completes against the current picks rather than being refused, because Mason's rule is warn, never block (Question 5). The `completed` event records "picks not confirmed on the completing screen", and the draft invoice shows the warning "Brands not checked at completion". The one-click **Mark Delivered** on the Deliveries list sends the `seq` it loaded with the list, so it is refused too if the picks changed after the list loaded.

**Not chosen:** a reserved key inside `p_quantities` (step 1's plan). It would change the parsing and fingerprints of every function that reads `p_quantities`, for a rare case.

The Bill Split auto-split path in completion runs inside `EXCEPTION WHEN OTHERS` and falls back to manual split billing (`20261215110000:~1281-1300`). A brand-helper error there must not be swallowed: the brand work runs before that block, and P26 proves an error in it fails completion instead of silently changing the billing.

Stock shortages still never block (To-Do 2.6). Lot and tote numbers are not read or required anywhere in PR B (August T-7, R-5).

**The acceptance rule "a brand must be picked when the product has brands" (step 1) is never enforced** (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just warn"). PR B records, warns and lists, and never blocks.

### 4.D Snapshot onto invoice lines
**Which picks belong to an invoice line** (used here and by the correction in 4.F):
- **Credit memos** (`invoice_type = 'credit_memo'`): never. `brand_lines` stays NULL, the same exclusion the tote copy uses (`20261215110000:1159-1168`).
- **An invoice with a `delivery_id`** (the automatic invoice, the quick-delivery draft, the unbilled-recovery invoice, each Bill Split payer invoice): the current picks of **that** delivery's line for the same `order_item_id`. Never a sibling delivery's.
- **An invoice with no `delivery_id`** (whole-order, landlord split): the current picks of every completed, not-voided delivery of that order line. Each trip's picks stay **separate entries in trip order**, even when two trips delivered the same brand, so 4.E can allocate by trip; RUP records are merged afterwards by record key (4.E Grouping). A completed trip with no picks adds a "no brand recorded" entry for its delivered amount, under the same rule as 3.1 (`[]` when no trip has any pick).

**Writing it.** REG-DB routes every invoice-line insert through `_capture_invoice_line_sale`. PR B extends that one helper:
- It computes `brand_lines` for a line that has an `order_item_id`, by the rule above: `NULL` only when no covered delivery line had a brand list **at completion** and no pick of any kind (listed or typed, current or retired) exists; entries from the saved picks whenever any exist, whatever today's list says; `[]` when a line had a brand list at completion but no pick was made. "Had a brand list" is read from the `completed` event (4.C), never from today's list, so a brand retired before a recovery or later invoice is made can never turn a missing brand into an unbranded line.
- **One entry with a number:** the line's sold number (`epa_registration`) is that brand's number, and the line's own capture columns are copied from the pick's captured facts (`sale_facts_source = 'brand_pick'`), never re-captured from the registration at invoice time. So the line looks to every REG-DB check like an ordinary captured line.
- **Several entries, or one entry with no number:** the sold number is NULL, **never** the generic product's own number, and `sale_facts_source = 'brands'`. REG-DB's checks that read the line's capture (posting's `INVOICE_LINE_NOT_CAPTURED`, the Compliance "not reviewed" list and "Restricted-use sales to record") are extended to read each `brand_lines` entry instead for these lines: a line counts as captured when every entry is captured, and each `unknown` entry **that gets no RUP record** appears on the not-reviewed list (an `unknown` entry whose registration says `yes` at posting is recorded, 4.E, and is not listed).
- A line with `brand_lines` NULL is captured exactly as REG-DB does.

Every insert path gets this through the helper, including `_create_bill_split_delivery_invoices`, where each payer's line shows **all** the brands on the load (B-3 prints them as "on the load", with the payer's share as the line quantity).

**Only onto a line of the same product.** A re-copy (here, in `edit_delivery`, `correct_delivery_brands` and `save_invoice`) writes `brand_lines` only onto an invoice line whose `product_id` equals the delivery line's `product_id`. A line whose product the office changed is detached for good: it keeps `brand_lines` NULL and REG-DB's capture, and no later pick change or correction re-attaches the old product's brand to it.

**Re-copy on every pick change, never at posting.** `brand_lines`, the sold number and the copied capture are re-copied on the **draft and unposted** lines a pick change affects: at completion (this delivery's own invoices, the quick-delivery draft, the partial-delivery trim, and the open drafts of order-level invoices covering the lines it just completed), in `edit_delivery`, and in `correct_delivery_brands`. Posting does **not** re-copy: `post_invoice` hashes the lines before and after posting and refuses if they changed (`20261022022000_post_binds_reviewed_invoice_version.sql:480-487`), so posting reads exactly the stored `brand_lines` the office reviewed.

**`save_invoice`** recomputes `brand_lines` for each kept delivery-made line from the current picks (so a reload and save heals a stale draft), and recomputes the sold number and the copied capture **together with it** from the same picks, so the brand, its number and its facts always describe the same brand. Lines with `brand_lines` NULL carry the capture as REG-DB does through its old-line-ID map. For a kept line with `brand_lines` not NULL:
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
    - a Bill Split payer's line, and a **landlord split** payer's line: in proportion to `delivered_quantity`, so each payer gets the same share of every brand. The per-brand amounts across all payer lines of one **payer group** are allocated together. A payer group is, for Bill Split, the payer lines of one order line on invoices with the **same `delivery_id`** (`_create_bill_split_delivery_invoices` makes one set of payer invoices per delivery, `20261215110000_chem_sale_bill_split_invoices.sql:543,571-575`, and 4.D gives each only that trip's brands); for a landlord split (no `delivery_id`), every payer line of the order line, against every trip. A payer group only ever includes lines on **active** invoices (not `voided`, `cancelled` or deleted): voiding keeps the old invoice's items (`_void_invoice_split_provenance_impl_20260719`, `20261206110000`), so without this a void and reissue would count a payer twice. The same rule applies everywhere a payer group is used: allocation, the billed-above-delivered check and the gaps-list comparison. The allocation is a pure function of every payer line's quantity and the load's brand amounts, with payer lines in the order of their **invoice's** `invoices.id` (stable: `save_invoice` re-creates lines, never the invoice; one payer line per order line per payer invoice) and the largest remainder on the last, so each payer invoice's posting computes the same split whatever order they post in. What is allocated is the **payers' billed total** (the sum of every payer line, never more than delivered, 4.E problems), divided between brands in proportion to their delivered amounts, so for each brand the payers add up exactly to that brand's share of the billed total: the whole delivered amount when the payers bill all of it (A 60 and B 40, 100 billed: A 60, B 40), less when they bill less (60 billed: A 36, B 24). Records never exceed what was invoiced. If a sibling payer line's quantity changes after another payer posted, the brands no longer reconcile; that line is listed on the RUP brand gaps list rather than refused;
    - any other line with no brand problem (entries add up to delivered, billed at or below delivered): in entry order (trip order), each entry taking up to its delivered amount until the line's quantity is used up. So a whole-order line still at 60 after trips of A 60 and B 40 records A 60, not A 36 and B 24. A line with any brand problem is never allocated (below).
    - Cents follow the quantity in whole cents: allocation runs over **every** entry of the line, whether or not it needs a record; each entry's exact share of the line's cents (its share of the **line quantity**) is rounded **down** to a whole cent with exact numeric math, then the cents left over are handed out one at a time to the entries with the largest dropped fractions (ties: earlier entry first), so no entry is ever negative (a 1-cent line split evenly gives the first entry 1 cent and the second 0; a 2-cent line of four 0.5 picks gives each 0 then hands 1 cent each to the first two). Quantities use the same method at the line quantity's own scale (the builder confirms the column's scale from live). **Cents are allocated per payer line, by design:** each payer invoice's records add up exactly to that invoice line's own cents (the invoice is the money authority), so across a payer group one brand's cents may differ from its exact group share by under 1 cent per payer line (two 1-cent payer lines split A 60 / B 40 record A 2 cents, B 0). Quantities are reconciled group-wide as above; cents are not. The whole line quantity is always allocated (a line billed above delivered is a brand problem and is never allocated), and the leftover method above makes the entries add up to the line exactly. Only then are the entries that need a record (below) written, so the records total the recorded share, not the whole line: a $100.00 line of A 60 (record) and B 40 (no record) records A $60.00 and nothing for B.
  - **Which entries need a record (REG-1's rule, per entry):** the entry's captured `rup_status` is `yes`, **or** the registration of that entry's number says `yes` at posting. Over-recording is the safe side; a captured `yes` is never lowered by a later change. An entry captured `unknown`, listed or typed, under any generic, whose number's registration does **not** say `yes` at posting, is **not** recorded (if the registration says `yes` at posting, the first rule applies and it is recorded); it shows on REG-DB's Compliance not-reviewed list (4.D) for the office to confirm (Question 2, Mason 2026-11-09: review list only).
  - **What each record holds:** the entry's EPA number, signal word and `brand_name`.
- **Brand problems never refuse posting** (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just warn"). A record still never has a blank EPA number and never a guessed split (REG-1's rule). **A line with any brand problem gets no RUP record at all** (Mason, 2026-11-09, Question 6): the whole line goes on the **RUP brand gaps** list (4.H) with its delivered, picked and billed amounts and the problem, and the office finishes it by hand (void and reissue). The problems are:
  - an entry with no brand recorded, or `brand_lines = []`: "brand not recorded";
  - an entry with no EPA number (typed, or a listed brand whose row has none): "EPA number not recorded";
  - entries that do not add up to what was delivered, more or less: "brand amounts do not match delivered";
  - billed above the delivered total: "billed above delivered". For a Bill Split or landlord split line the billed total is the **sum of every payer line in its payer group** (above: one delivery for Bill Split, the whole order line for a landlord split; current quantities, posted or not), compared with that group's delivered amount, so two payers billing 70 each on 100 delivered is this problem for every payer line, and none of them gets a record.
  No partial record is ever written for such a line, so no amount or cent is ever split by a guess.
  Every posted branded line with a brand problem is listed, whatever its generic's restricted-use status, because a restricted-use brand can sit under a generic that is not (the hole behind Question 5). For a line with `brand_lines` not NULL, REG-DB's numberless-line refusal (`INVOICE_LINE_RUP_NO_EPA`) is replaced by this listing. **Mason, 2026-11-09: "we should never block a sale due to missing epa number"**, so REG-DB is to drop that refusal for lines with `brand_lines` NULL too (passed to the REG-1 session for PR #1688); PR B re-issues whatever REG-DB has live and never adds a missing-number refusal of its own. **An entry number with no registration row** (a typed number not in the seed, REG-1 sheet §4.C's `INVOICE_LINE_NO_REGISTRATION`) is likewise never refused on a line with `brand_lines` not NULL: PR B's re-issued posting skips that refusal for branded lines; the entry counts as registration not `yes`, so it is recorded only when captured `yes` (4.E rule), otherwise it gets no record and shows on the Compliance not-reviewed list. The B-1 preflight fails the build if the re-issued body still raises `INVOICE_LINE_NO_REGISTRATION` for a branded line.
  Before posting, the invoice screen shows each problem and the office confirms "Post anyway" (section 6). The office can fix a problem first with the correction in 4.F while the invoice is a draft; after posting, the fix is REG-1's void and reissue, and a voided invoice's lines leave the list.
- **Grouping:** REG-DB's key `(invoice, product, sold number, signal word)`, with each entry treated as its own sold number. Entries sharing a key are added into one record and their brand names joined. The merged record keeps the most cautious status of its entries and every entry's note. REG-DB's "an existing active record that disagrees is an error" rule and its posting lock stay.
- `get_rup_sales_register` returns `brand_name`.

### 4.F `correct_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_reason text, p_base_event_seq bigint, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin only. The reason is required. Only on a `completed` delivery.
- **Stale-correction guard:** the same `p_base_event_seq` check as 4.A (`BRAND_PICKS_CHANGED`), so two admins correcting the same delivery from the same screen state cannot silently overwrite each other.
- **Posted invoices are never edited (REG-1's rule).** If any invoice that 4.D links to a corrected line is `posted`, `overdue` or `paid`, the correction is refused with `INVOICE_POSTED: void <number> and reissue it first`. That is REG-1's path: void the posted invoice and make a replacement, which captures and posts normally. **Checked again under the lock:** after it holds the delivery row `FOR UPDATE` (3.3 step 3), the correction re-reads every invoice linked to the corrected lines and refuses the same way if any is now posted, overdue or paid. Posting holds that delivery row `FOR SHARE` (3.3), so an invoice posted before the correction got the row is visible to this re-read, and one posted after waits for the correction and then refuses with `BRAND_LINES_STALE`. A new draft found only by the re-read is not re-copied; its posting check catches it.
- **What it does:** it never overwrites a completed pick. It marks the old current picks superseded (`superseded_*`) and inserts the new ones. Sale facts: a new pick for the **same brand** (name and number) as a superseded pick of that line copies that pick's captured facts; a **different** brand is captured now, and its `facts_source` is marked `corrected:<date>`. The new picks must add up to the delivered amount, and each listed pick must be on the line's **current** brand list (3.2), checked by source, parent and product (`BRAND_NOT_FOR_PRODUCT`). A typed pick follows the 4.A rules.
- **Then:** re-copies the affected `draft` and `unposted` invoice lines (4.D). Voided and cancelled invoices are left alone.
- **Logging:** one `corrected` event with every invoice ID it re-copied.
- **Receipts:** a receipt already queued or sent keeps the brands as recorded at completion, and nothing is re-sent automatically. A reprint reads the current picks and, for any line whose picks were corrected after completion, prints "Corrected <date>: was <old brand and EPA number>" under it, so it never silently disagrees with the receipt that was sent. A resend from the delivery page queues a **new** receipt through `_enqueue_delivery_receipt`, which builds the brands from the current picks when it is queued, so it carries the correction; the builder confirms the live resend path does this and, if it re-sends a saved body instead, changes it to queue a fresh snapshot (P27).

### 4.G `review_typed_brand(p_pick_id uuid, p_action text, p_brand_id uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`
- **Who:** admin only.
- `p_action = 'link'` points the typed pick at a brand **already on** the line's brand list (`review_brand_ref`), so it shows as reviewed. It never changes the pick's snapshot.
- `'dismiss'` records the dismissal.
- **Adding a new brand to a list stays in the existing brand RPCs** (`upsert_parent_brand` / `upsert_product_brand`, with REG-DB's registration rules). The review screen calls that first, then `link`. PR B adds no second brand writer.
- One `reviewed` event.

### 4.H Read RPCs
- `get_delivery_brands(p_delivery_id)`: each line, its brand list (3.2), its current picks, and the delivery's highest event `seq`. Same read rule as the delivery.
- `get_typed_brands_for_review()`: admin only; pending typed picks with delivery, product and line.
- `get_deliveries_missing_brands(p_from date, p_to date)`: admin only; completed lines with `quantity_delivered > 0` that had a brand list **at completion** and either have no current picks, have picks that do not add up to the delivered amount, or have a current pick with no EPA number (a typed pick without one, or a listed brand whose row has none), each listed with its reason (the office's follow-up list; it never blocks anything). So every delivery-side brand problem is visible before its invoice posts. Whether a line had a brand list is read from the `completed` event, which records each line's brand-list size at that moment (4.C), so retiring a brand later never hides an old gap. A line completed **before B-1 was applied** has no such event: it is listed separately as "completed before brand capture" when its product has a brand list today, and its invoices keep REG-DB's behaviour (`brand_lines` NULL), exactly as before PR B; nothing is backfilled or guessed.
- `get_rup_brand_gaps(p_from date, p_to date)`: admin only; posted, not-voided invoice lines with a brand problem (4.E), plus any line with `brand_lines` NULL that needed a RUP record but had no sold number (an unbranded restricted-use product with no EPA number: it gets no record, never a blank one, once REG-DB follows Mason's never-block rule), listed "EPA number not recorded"; plus every posted line made from a delivery line whose product the office changed (detached, 4.D) where that delivery line had picks that would get a RUP record under 4.E, listed "product changed after delivery" with the delivered product, brands and amount; plus every **payer group and product** (Bill Split: per `delivery_id`; landlord split: per order line, 4.E) whose posted payer records, brand by brand (summed per product, sold number and signal word, the same grouping the records use, 4.E, across every split line of that product in the group, so repeated lines such as tier splits are compared together; quantities are compared, and each posted payer line's cents against its own per-line allocation), **for the brands that get a RUP record** (the same rule as 4.E: captured `yes`, **or** registration `yes` at posting), differ from the allocation 4.E would give **those posted payers** today (recomputed from every payer line's current quantity, so a sibling change shows; a payer still draft or unposted is left out and never counts as missing); a brand that correctly gets no record under that rule is never compared ("payer split changed after posting"; recomputed from the records, not trusted from the allocation), each with the invoice, product, generic's restricted-use status, problem, and the quantity and cents not recorded. Computed from the frozen `brand_lines` and the records, so it needs no new table.
- `get_detailed_statement_data` is re-issued to return `brand_lines`.

### 4.J (removed) Brand-required switch
Removed by Question 5 (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just warn"): no `delivery_brand_settings` table, no `set_delivery_brand_required`, no settings toggle.

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
  - a line with no pick shows "No brand picked for <product>" with **Pick brand** and **Complete anyway**; a split that does not add up shows the same warning;
  - a short split line asks how much of each brand went off the truck, pre-filled with what was loaded, then saves it (`set_delivery_brands`) before calling completion;
  - nothing about brands refuses completion; only `BRAND_PICKS_CHANGED` (someone else saved) can, and it reloads.
- **Saving safely:**
  - The screen's picks belong to one delivery ID and are reloaded from `get_delivery_brands` when it opens another delivery or reopens.
  - Each save gets one retry key from the existing `useIdempotencyKey` hook, reused on every retry of that same save and replaced only when the choices change.
  - One save at a time: while a save or a completion is in flight, the picker, Split and Complete are disabled, and a reply for anything but the latest request is ignored. Complete is enabled whenever no request is in flight, and sends the base `seq` it loaded or saved (`p_brand_base_seq`); the database reads the saved picks.
  - A `BRAND_PICKS_CHANGED` refusal (someone else saved, or the delivery was edited) reloads the picks and says so.
  - A failed save leaves the screen's choices in place, shows the error, and completion does not run; pressing Complete again retries the save first. Leaving the page (back, another part of the app, closing it) with unsaved choices asks "Brand choices not saved. Leave anyway?"; a reopened page shows the server's saved picks and the last save time, so completion never silently uses choices the driver thinks were saved.
  - **Unsaved changes:** any pick change on the screen marks it unsaved; pressing Complete with unsaved changes **saves them first** (`set_delivery_brands`) and calls completion only after that save succeeds, with the `seq` it returned, so completion always uses the picks the screen shows. If the save fails, completion is not called.
- **Deliveries list** (`src/pages/Deliveries.tsx`): one-click **Mark Delivered** completes as today; a branded line with no pick lands on the missing-brands list.
- **Edit delivery:** the lines whose picks were dropped (4.B) are flagged.
- **Correct brands after completion** (`src/pages/DeliveryDetail.tsx`, admin only, office layout): on a `completed` delivery, a **Correct brands** button opens the same picker pre-filled with the current picks, a required reason, and **Save correction**, which calls `correct_delivery_brands` (4.F) with the `seq` the page loaded and its own retry key from `useIdempotencyKey`. `INVOICE_POSTED` shows "Void <number> and reissue it first"; `BRAND_PICKS_CHANGED` reloads. The RUP brand gaps and Deliveries missing brands lists (6) link each row to this screen.
- **Products page** (`src/pages/Products.tsx`): a **Brands to review** tab (admin), using a new `src/components/products/TypedBrandReview.tsx`. "Add to list" calls the existing brand RPC, then `review_typed_brand('link')`: each step has its own retry key from `useIdempotencyKey`, kept until that step returns; the row's buttons are disabled while either is in flight; after any error the tab reloads, and a pick whose brand was added but not linked shows **Link to existing** for the added brand. PR B-2 does **not** edit `ProductDetail.tsx` or `ProductBrandsSection.tsx`.
- **Quick delivery:** no picker in the modal. It is completed on its delivery page, where the picker is (step 1 §5).
- **New client helper:** `src/lib/deliveryBrands.ts`, which calls `assertRpcResult()` after each RPC.
- **Sol list:** yes (`src/pages/Products.tsx`, plus "deliver" in file names).

## 6. PR B-3 · Paperwork and records (after B-1 is live; may land with or after B-2)

- **Delivery receipt PDF** (`src/lib/deliveryPdf.ts`): under each line, each brand with its EPA number and amount, or "Brand not recorded"; when the picks do not add up to delivered it also prints "Brand amounts do not match delivered: <picked> of <delivered> recorded". The receipt email and the invoice print show the same line. Every caller fetches the brands: `DeliveryDetail.tsx`, `FieldStop.tsx`, and the batch print in `Deliveries.tsx:1100-1115` (`generateBatchDeliveryPdf`).
- **Receipt email:** the `send-delivery-receipts` Edge Function prints the `brands` that `_enqueue_delivery_receipt` saves in the snapshot (3.5). Its deploy needs Mason's explicit yes, and is downloaded and diffed after deploy. The proof covers a first send and a resend.
- **Invoice PDF** (`src/lib/invoicePdf.ts`) and every caller: `INVOICE_ITEM_COLUMNS` in `src/lib/costFields.ts:49` adds `brand_lines`, which carries it to the single-invoice print, the batch print through `buildInvoicePdfDataFromRow` (`Invoices.tsx`) and the field-invoice panels.
  - the EPA column prints the line's number;
  - for a split line, the entries' numbers joined;
  - under the line, the brand names and amounts from `brand_lines` (on a Bill Split payer's line, labelled "on the load");
  - "Brand not recorded" for `[]` or a no-brand entry, and "Brand amounts do not match delivered: <picked> of <delivered> recorded" when the entries do not add up to delivered.
- **Statement:** `src/lib/statementPdf.ts:581`, `:636` print the joined numbers when the line's own number is blank, from `get_detailed_statement_data`'s `brand_lines`.
- **Invoice screen** (`src/pages/InvoiceDetail.tsx`):
  - the brands are shown read-only on lines made from a delivery;
  - warnings before posting: "Brand typed at delivery, not yet checked", "Brand not recorded", "EPA number not recorded", "Split does not match delivered", "Billed above delivered", "Quantity changed from delivered" and "Product changed from delivered <product>: delivered brands <brands> not on this line" (a line whose product the office changed, 4.D; it posts under the new product's REG-DB capture, and the delivered brands go on the gaps list). Posting a line with a brand problem asks once to confirm (`ConfirmModal`, "Post anyway") and says which part gets no RUP record (4.E).
- **Compliance page** (`src/pages/Compliance.tsx`): the RUP register shows a **Brand** column and the new notes; the not-reviewed list shows `unknown` brand entries (4.D); a new **RUP brand gaps** list shows `get_rup_brand_gaps` (4.H), next to a **Deliveries missing brands** list from `get_deliveries_missing_brands`.
- **Sol list:** yes (`invoicePdf.ts`, `statementPdf.ts`, `deliveryPdf.ts`, `InvoiceDetail.tsx` carry money words, and `supabase/functions/`). The `pdf-output-reviewer` agent runs on the three PDFs.

---

## 7. Done when (prover cases; B-1 in the real-schema harness, B-2/B-3 with screen tests and a local run)

"Grouping switch" means `_product_parent_grouping_open()`. There is no brand-required switch.

**Brand lists and picks**
- P1. Ungrouped size with legacy brands: listed pick saved, snapshot from the brand row. A Liberty brand on a Roundup line, a brand from another parent and a brand from another size's legacy list are refused (`BRAND_NOT_FOR_PRODUCT`).
- P2. Grouped size with the grouping switch on: the parent's active brands are the list. A retired parent brand is refused. A legacy brand ID on a grouped size is refused. A not-currently-sourced listed brand is accepted.
- P3. Typed brand with a number completes and lands on the review list. A typed brand with a blank number completes and is flagged. A typed name equal to a listed brand with the same number is stored as listed.
- P4. A driver not assigned to the delivery, a non-active user and an anonymous caller are refused. The same key with the same request changes nothing (one event); the same key with a different request is refused; the same key on another of the three operations is refused (`IDEMPOTENCY_CROSS_OP_KEY_REUSE`); a missing key is refused.
- P5. A save with an old `p_base_event_seq` is refused after a newer save and after an `edit_delivery`; a same-key replay of the older save returns its original result.

**Completion**
- P6. A branded line with no pick on any trip completes, gives `brand_lines = []` (two trips, one with picks and one without, give the picked entries plus one `brand_name` NULL entry) with no EPA number (never the generic's), and is on the missing-brands list. The rule sees the final delivered amounts (the case a status trigger would miss).
- P7. A 30/15 split loaded at 45, delivered 40, not re-saved: completes, keeps 30/15, flagged and listed; saved as 25/15 first: completes with no flag. A line delivered at zero keeps no picks.
- P8. No brand problem refuses completion through any entry point, `process_offline_action` included.
- P9. A legacy pick whose size was then grouped completes and is re-pointed to its parent brand; a pick of a retired brand completes and is flagged.
- P10. No lot or tote number anywhere: every case completes. A tote number, when present, is still copied as today.
- P11. Every caller of `_complete_delivery_authorized_impl` from `pg_proc` reaches the rule, including an old offline completion replay.

**Invoices**
- P12. Automatic invoice: one-brand line → the line's number is the brand's, its capture is copied from the pick (`brand_pick`), and REG-DB's posting check treats it as captured; split line → no single number, two entries, captured per entry; unbranded product → as REG-DB.
- P13. Bill Split and landlord split: each payer's invoice line carries all the load's brands; RUP divides each payer's share by brand in proportion, the cents add up exactly per payer, and for each brand the quantities across all payers add up exactly to delivered (A 60 and B 40 split in half gives A 30 and B 20 on each).
- P14. One order line delivered in two trips with different brands, each trip billed alone: each invoice shows only its own trip's brands. A whole-order invoice and a landlord split invoice list both trips; two trips of one brand stay separate entries; trips A 30, B 40, A 30 billed at 60 record A 30 and B 30; a trip with no picks adds a no-brand entry.
- P15. Quick-delivery draft, partial-delivery trim and a whole-order draft made before the delivery are all re-copied at completion. A credit memo line keeps `brand_lines` NULL.
- P16a. A delivery completed before B-1's apply, with a brand list today, is listed "completed before brand capture" and its invoice keeps `brand_lines` NULL. An invoice line whose product the office changed from P to Q is never re-copied with P's brand by a later correction or save. A 50/50 payer split where one payer posts and the other's quantity then changes is listed "payer split changed after posting". A payer split needing rounding, where one payer posts, the other re-saves its unchanged draft (new line IDs) and then posts: the records reconcile exactly to delivered, and nothing is listed.
- P16b. A brand `unknown` at delivery whose registration says `yes` at posting is recorded. A reprint after a correction shows "Corrected" with the old brand. An unbranded restricted-use line with no EPA number posts with no record and is listed "EPA number not recorded".
- P16. The only listed brand of a line is retired after completion: a later invoice and a re-save still carry that brand's snapshot entry, never `NULL` or the generic's number. `save_invoice` keeps `brand_lines` through a save; a quantity change keeps the brand, number and capture; a product change clears `brand_lines` and captures as new. A client write to `brand_lines` is refused. A posted line's `brand_lines` cannot change.
- P17. Posting changes no line (the posting hash check passes) and reads the stored `brand_lines`.
- P18. No money column (`quantity`, `unit_price_cents`, `extended_cents`, `cost_cents`, invoice totals) changes in any case compared with the same flow without brands.

**RUP**
- P19. A split restricted-use line posts two records with the right numbers, amounts and cents adding up exactly. Two lines of one product and one brand number on one invoice produce one record. A whole-order line at 60 after trips of A 60 and B 40 records A 60.
- P20. A brand captured `no` whose registration says `yes` at posting is recorded (REG-1's rule); one captured `yes` keeps its record after a flip to `no`. An `unknown` entry, listed or typed, under a restricted-use generic or not, is not recorded and shows on the Compliance not-reviewed list, unless its registration says `yes` at posting, when it is recorded.
- P21. Each brand problem posts and is never refused: `brand_lines = []`, a no-brand entry, a no-number entry, entries adding up to less or more than delivered, billed above delivered. Each such line gets no RUP record at all and is on `get_rup_brand_gaps` with its amounts, under a restricted-use generic and under one that is not; no record has a blank EPA number. No posting is refused for a missing EPA number on any line. Voiding the invoice removes its lines from the list.
- P22. Unpost, void and re-post behave as before under the new grouping (PARKED-006).

**Correction and review**
- P23. Correction with only draft or unposted invoices re-copies them; a split-only change keeps each brand's captured facts; a different brand records `corrected:<date>`.
- P24. Correction when a linked invoice is posted, overdue or paid is refused with `INVOICE_POSTED`; after void and reissue it succeeds and the replacement carries the corrected brands.
- P25. A brand's EPA number changed afterwards leaves old deliveries, invoices and RUP records unchanged. `review_typed_brand('link')` leaves the pick's snapshot unchanged; adding a brand goes through the existing brand RPC.

**Editing, receipts, grants, concurrency**
- P26. Changing only a scheduled delivery's date keeps the picks under the new line IDs; changing one line's quantity or unit size drops only that line's picks; both write an `edited` event. An error in the brand step during a Bill Split completion fails the completion instead of falling back.
- P27. The receipt snapshot from `_enqueue_delivery_receipt` carries each line's brands (single, split, typed, none); a resend after a correction carries the corrected brand and service_role has no table privilege on the new tables.
- P28. Grants and policies read directly from `information_schema` and `pg_policy`: `authenticated` can only SELECT the new tables under the delivery rule; `anon`, `service_role` and `PUBLIC` have nothing; the `brand_lines` column grant is revoked; every `_` helper is not executable by `PUBLIC`, `anon`, `authenticated` or `service_role`; every PR B `SECURITY DEFINER` function has the pinned `search_path`; the receipt-binding trigger lists the three new operations. An admin session cannot reveal a missing grant (August C-25), so this is checked directly.
- P30. A line whose picks do not add up to delivered is on the missing-brands report until corrected. A line delivered at zero is not on the report; a line completed with no pick while its brand was listed stays on the report after that brand is retired.
- P32. A posting of a draft whose stored `brand_lines` no longer matches the picks is refused with `BRAND_LINES_STALE` and changes nothing; after a re-save it posts. Completion and posting of the same order-level draft, run at once in both orders, never deadlock.
- P33. `edit_delivery` with an unchanged line keeps its picks across the delete and re-insert; it refuses a completed delivery with picks.
- P36e. After the seed, a driver types a never-seen EPA number on a single-brand line (captured `unknown`): posting succeeds, no RUP record is written, and the pick is on the Compliance not-reviewed list; the same typed number captured `yes` is recorded.
- P36f. An admin corrects a completed delivery's wrong brand from the delivery page; its draft invoice re-copies. A receipt snapshot queued before B-1 (no `brands` key) sends after B-3 deploys with its lines as today.
- P36d. A delivery of P with picks whose invoice line the office changed to Q posts without `BRAND_LINES_STALE`; its `brand_lines` stays NULL. When P's pick is restricted-use, the draft shows "Product changed from delivered P" before posting, posting asks once to confirm, and the posted line is listed "product changed after delivery". Two brands sharing one EPA number with different signal words, where a sibling payer shifts quantity between them with the total unchanged: listed "payer split changed after posting". A 100-unit delivery with picks of 90 prints "Brand amounts do not match delivered: 90 of 100 recorded" on the receipt and invoice.
- P36c. A correction starts with no linked invoice; a recovery invoice is created and posted before the correction takes the delivery row: the correction refuses with `INVOICE_POSTED`. Posting that starts after the correction holds the row waits, then refuses with `BRAND_LINES_STALE`. A Bill Split of 100 units of a brand captured `no` is not listed "payer split changed after posting". A 50/50 Bill Split of A 60 (registration `yes`) and B 40 (captured and registered `no`), both payers posted unchanged: records total A 60, no B record, and nothing is listed. An order with two split lines of the same product and brand (10 and 20 delivered), both payers posted unchanged: the merged records total 30 and nothing is listed. The A 60 / B 40 line at $100.00 records A $60.00 and no B cents. A 100-unit Bill Split 50/50 where one payer's invoice is voided and reissued at 50: the billed total is 100, the replacement gets its records, and nothing is listed. An order line delivered by two Bill Split trips of 50, each billed 25 + 25: each trip's records total 50 and nothing is listed. A Bill Split with A 60 and B 40 delivered where the payers bill 30 each: records total A 36 and B 24. A Bill Split with 100 delivered where each payer bills 70: neither payer gets a record and both are listed "billed above delivered". A 100-unit restricted-use brand split 50/50, queried after the first payer posts and before the second: nothing is listed; after both post unchanged: nothing is listed. A brand captured `yes` whose registration is now `no`, split 50/50, where the sibling payer's quantity changes after the first payer posted: listed "payer split changed after posting".
- P36a. The seed (exclusive registration lock) runs while a completion is in progress: whichever takes the registration lock first finishes; the other waits and then succeeds. Neither holds an invoice or delivery lock while waiting, so there is no deadlock.
- P36b. A brand save is mid-flight (holding the delivery row) on a delivery whose invoice was created after the save read its invoices; posting that invoice waits for the save, then refuses with `BRAND_LINES_STALE`. Posting started first: the save waits for posting to commit, then finds the invoice posted and leaves it alone (it is listed if its brands differ, 4.H).
- P36. A completion sent with an old `p_brand_base_seq` is refused with `BRAND_PICKS_CHANGED`; one with the current `seq` completes; one without it completes as today and its fingerprint is unchanged. A list loaded with no brand events (sends `0`), then a first save, then Mark Delivered: refused.
- P31. Two corrections from the same base: the second is refused with `BRAND_PICKS_CHANGED`.
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
| **REG-DB follows Mason's "never block a sale due to missing epa number"** | PR B promises no posting is refused for a missing number (4.E) | Passed to the REG-1 session for #1688 on 2026-11-09. B-1's preflight reads the live `post_invoice` and `generate_rup_sales_records` bodies and **fails the build** if `INVOICE_LINE_RUP_NO_EPA` is still raised; P21 proves it. |
| REG-1 seed | Not required. PR B captures from brand rows before the seed and from registrations after it (4.C step 6). | Mason-gated, not run |
| #1649, #1678 (receipt sending) | B-1 adds brands to the receipt snapshot wherever these leave it (3.5) | Open |
| Brand data | Admins enter brands (on parents once grouped). Until a generic has a list, it has no brands and nothing is asked. | Mason |

**Shared files:**
- PR B touches neither `ProductDetail.tsx` nor `ProductBrandsSection.tsx` (REG-1's screens edit both).
- B-2 edits `Products.tsx`: re-check open PRs on it before starting.
- RT-1 (rates) is a separate build sheet. Its later rate packages may touch invoice writers; whichever lands second rebuilds from live bodies.
- Taha's open PRs (#1534, #1576, #1587) touch invoice and order screens. Check for overlap before B-3, and never push to them.

**Order:**
1. REG-DB is live.
2. The PAR-2 move is live and verified.
3. B-1 (Sol), then its live apply through the migration-apply gate.
4. B-2 and B-3 (Sol each).
5. The office works the missing-brands and RUP brand gaps lists as part of normal follow-up (nothing waits on them).

---

## 10. Steps that need Mason

1. **Grouping and brand move (PAR-2):** his grouping data step, then the move switch-on. Both are already gated in PAR-2.
2. **Brand lists:** entering each generic's brands with their EPA numbers (admin work; no code).
3. **Apply B-1 live.** It is non-destructive, but it recreates the receipt-binding trigger on `idempotency_keys`, so the apply gate may not class it as routine grants only. If so, it needs Mason's `approve <code>`.
4. **Deploy the `send-delivery-receipts` Edge Function change** (B-3). An Edge Function deploy always needs his explicit yes; it is downloaded and diffed after deploy.

---
---

## 11. Questions for Mason

1. **A typed brand whose EPA number cannot be read** (smudged jug, no label): the delivery still finishes, and the line is flagged on the review list and the draft invoice. **Answered by Question 5:** the invoice still posts with a warning; that entry gets no RUP record (never a blank number) and is on the RUP brand gaps list.
2. **A delivered brand whose restricted-use status is unknown, under a restricted-use generic, or any typed brand whose status is unknown:** **Answered (Mason, 2026-11-09): review list only.** It is not put on the RUP register; it shows on the Compliance not-reviewed list for the office to confirm.
3. **A restricted-use line delivered with no brand recorded:** **answered by Question 5:** it posts with a warning, gets no RUP record (never the generic's number, never a blank one) and is on the RUP brand gaps list.
4. **The office changes the quantity on a branded invoice line:** the plan keeps the delivered brand and its EPA number. This departs from your REG-1 rule ("a quantity change re-captures the line from the product's current label") only for branded lines, because re-capturing would put the generic's number on a line whose brand is known. **Answered (Mason, 2026-11-09): keep the brand.**

5. **Block or warn: which invoice lines with a brand problem can still be posted?** A brand problem is: no brand recorded, a typed brand with no EPA number, brand amounts that do not match what was delivered, or more billed than was delivered. Today the plan blocks posting only when the **generic product** is restricted-use. Luna's rounds 6, 9 and 10 kept finding the same hole: a restricted-use **brand** can sit under a generic that is not, so the restricted-use sale can slip past. **Answered (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just warn"): never block, only warn.** Nothing about brands refuses a completion or a posting, and the brand-required switch is removed. The hole is closed by listing instead: every posted branded line with a brand problem, under any generic, is on the RUP brand gaps list, and the unknown part gets no record rather than a blank or guessed one (4.E). The cost Mason accepted: a restricted-use sale can post with its record incomplete until the office follows up (void and reissue).

6. **Brand amounts that do not match** (picked A 70 + B 20, delivered 100, billed 50). **Answered (Mason, 2026-11-09): record nothing for that line and list it.** Three Luna rounds kept finding holes in recording part of such a line.
7. **A driver on an old copy of the app completes after someone else saved brands.** **Answered (Mason, 2026-11-09): complete and warn** ("Brands not checked at completion", 4.C).

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

**Luna round 6** (head `67db76063`): 2 HIGH, 3 MED, all **fixed**.
- HIGH, a mismatched split (kept while the switch was off) could put a guessed split on the register: a restricted-use line refuses posting until the amounts are fixed (4.E, P21).
- HIGH, a typed brand with no number on a non-RUP generic had no safe path: any line with a typed no-number entry refuses posting until the number is recorded (4.E, Question 1, P21).
- MED, two corrections could overwrite each other: `p_base_event_seq` on corrections (4.F, P31).
- MED, old offline completions could be stranded after switch-on: replays are always treated as switch-off and land on the report (4.C, P30).
- MED, any admin could flip the switch early: new `set_delivery_brand_required` RPC refuses switch-on while the backlog is open, and a trigger blocks direct edits (4.J, P30).

**Luna round 7** (head `698b98f8d`): 3 HIGH, 4 MED.
- HIGH, delivery writers locked invoices after the registration lock, while posting does the reverse: **fixed**, everyone uses REG-DB's invoices-first order, with a read-only `BRAND_LINES_STALE` check at posting for an invoice a writer did not lock (3.3, 4.D, P32). Lock order was also a round 3 finding; this rewrite removes the second order altogether.
- HIGH, the switch-on check cannot see a product that should be branded but has no brand rows: **refuted in part**. By the acceptance rule a product with no brand rows has no brands, and entering lists is Mason's step; an advisory list of restricted-use products with no brand list is added to the settings screen (4.J).
- HIGH, the database could not tell an old offline replay from an online completion: **fixed**, by entry point (`process_offline_action` passes an internal flag the client cannot reach) (4.C, P34).
- MED, a settable flag could be forged to flip the switch: **fixed**, the trigger checks `current_user` is the owner role (4.J, P34).
- MED, the cascade would delete picks before `edit_delivery` could carry them: **fixed**, copied first (4.B, P33).
- MED, `edit_delivery` on a completed delivery: **fixed**, refused for a delivery with picks (4.B, P33).
- MED, merging entries could drop a warning: **fixed**, the merged record keeps the most cautious status and all notes (4.E, P35).

**Luna round 8** (head `b48930035`): 2 HIGH, 2 MED, all **fixed**.
- HIGH, the old-offline-replay exemption could be used by a new call: **removed.** This exemption drew findings in rounds 6, 7 and 8, so it is deleted rather than patched again: no completion path is exempt, and a refused old replay goes to the existing offline work review page (4.C, P34). The cost is that a pre-October queued completion, if any is still on a phone at switch-on, needs an office follow-up.
- HIGH, an owner-role check could not prove which function changed the switch: **fixed** by moving the switch to its own table that only `set_delivery_brand_required` writes (3.1, 4.J, P34).
- MED, zero-delivered lines blocked switch-on: excluded from the report (4.H, P30).
- MED, retiring a brand could hide an old gap: the report reads the brand-list size recorded at completion (4.C, 4.H, P30).

**Luna round 9** (head `4e3989a2a`): 2 HIGH, 2 MED, all **fixed**.
- HIGH, quantity billed above the delivered total was given to the last brand: a restricted-use line billed above delivered refuses posting until fixed (4.E, P21).
- HIGH, completion did not check the screen saw the current picks: optional trailing `p_brand_base_seq` on the completion RPCs, always sent by the capture screens (4.C, section 5, P36).
- MED, no read policy on the switch table: active-user SELECT policy (3.1, P36).
- MED, mismatched splits from before switch-on did not block it: they are on the backlog report (4.H, P30).

**Luna round 10** (head `0bba6bcea`): 6 HIGH, 2 MED.
- **Stopped patching (AGENTS.md: the same mechanism three rounds running).** Three HIGHs here (an unpicked RUP brand under a non-RUP generic posts with no record; excess billed on such a line goes to the brand; the "registration says yes" and "listed unknown under a non-RUP generic is not recorded" rules conflict), and HIGHs in rounds 6 and 9, all come from one rule: brand problems block posting only on a restricted-use **generic**. The business choice that removes it is **Question 5** (block posting for any branded line with a brand problem). **Open until Mason answers**; sections 4.E and 7 are rewritten to his answer.
- HIGH, `save_invoice` could pair new brand lines with an old capture: **fixed**, recomputed together (4.D).
- HIGH, a save could change brands the office had already reviewed: **fixed**; `brand_lines` is in the posting hash, so the existing `INVOICE_CHANGED_SINCE_LOADED` refusal makes the office reload and see them (3.3).
- HIGH, a trailing argument could leave an old overload without the check: **fixed**; old signatures dropped, one signature asserted (4.C).
- MED, Mark Delivered on the list skipped the stale check: **fixed**; it sends the `seq` it loaded (4.C).
- MED, the 30-day backlog window could miss older gaps: **fixed**; all dates (4.J).

**Codex GitHub review** (head `fd673f866`): 3 P2, all **fixed**.
- Landlord split lines allocated each payer from the first trip, over-recording one brand: landlord splits use the proportional rule, reconciled across payers (4.E, P13).
- Merging same-brand trips lost the trip order allocation needs: trips stay separate entries; records merge afterwards (4.D, P14).
- NULL meant both "no events yet" and "no check": empty history is `0`, NULL only for old callers (4.A, 4.C, P36).

**Mason's answer to Question 5 (2026-11-09):** "do not be strict on RUP license don't ever block just warn". Applied to the whole plan: no brand problem refuses completion or posting; the brand-required switch (3.1 table, 4.J, settings toggle, order steps 5-6, Mason step 5) is removed; posting records only what is known and lists the rest on a new RUP brand gaps list (4.E, 4.H, P21); Questions 1 and 3 follow from it. Kept, because they protect data rather than enforce RUP: `BRAND_PICKS_CHANGED` (someone else saved), `BRAND_NOT_FOR_PRODUCT` (a brand from another product), `BRAND_SPLIT_OVER_LOADED` (more than was loaded), and REG-1's own rules for lines with no brand information.

**Mason, 2026-11-09:** "we should never block a sale due to missing epa number". PR B already never refuses for it; 4.E and P21 now say no line, branded or not, is refused for a missing number, and the REG-1 session was told so REG-DB's own `INVOICE_LINE_RUP_NO_EPA` refusal can follow.

**Luna round 11** (head `74dc6f201`): 1 HIGH, 1 MED, both **fixed**.
- HIGH, "records add up to the line" contradicted "the extra billed above delivered gets no record": cents follow each entry's share of the line quantity; the unrecorded extra and its cents go on the RUP brand gaps list (4.E, 4.H).
- MED, a leftover line still said section 10 turns the removed switch on: deleted (4.J).

**Luna round 12** (whole branch, head `ee5a9e274`): 4 HIGH, 5 MED, all **fixed**.
- HIGH, section 2 row 10 still said a restricted-use line cannot post: rewritten to warn and list.
- HIGH, a single pick was stretched to the delivered amount: only shrunk; more delivered than picked is a mismatch (4.C).
- HIGH, two mismatch rules disagreed: allocation applies only when entries add up; short entries record their own amounts, over-entries record nothing, both listed (4.E).
- HIGH, Complete could run with unsaved picks on screen: disabled while anything is unsaved (section 5).
- MED, payer split rounding depended on posting order: a pure function in line-ID order; a later sibling change is listed (4.E).
- MED, cancel then restore could lose picks: no live restore path; re-created lines start empty with a warning (4.B).
- MED, receipts after a correction: kept as recorded; reprint and resend read current picks (4.F).
- MED, `edit_delivery` retry safety: keeps its live key and bound receipt (4.B).
- MED, typed-brand review two-step retry: per-step keys, buttons locked, reload and "Link to existing" (section 5).

**Luna round 13** (whole branch, head `95e67ba91`): 1 HIGH, 3 MED, 1 LOW, all **fixed**.
- HIGH, the never-block promise depended on REG-DB without a check: new dependency row; B-1's preflight fails if `INVOICE_LINE_RUP_NO_EPA` is still live (section 9, P21).
- MED, a listed brand with no EPA number could not be stored: the snapshot allows it and it is treated as "EPA number not recorded" (3.1, 4.E).
- MED, completion without the base `seq` skipped the stale check: kept as warn-not-block per Question 5, recorded on the event and warned on the invoice (4.C).
- MED, a resend could repeat the old snapshot: a resend queues a fresh snapshot from current picks (4.F, P27).
- LOW, event `seq` order versus commit order: every event writer, `review_typed_brand` included, holds the delivery row first (3.3).

**Luna round 14** (whole branch, head `2b08b0f69`): 3 HIGH, 3 MED. Stopped patching the mismatch math (rounds 11, 12 and 14) and asked Mason; all now **settled**.
- HIGH, a brand retired before a later invoice could turn a missing brand into an unbranded line: **fixed**, brand presence is read from the completion event (4.D).
- HIGH, under-delivery records could exceed the billed line; MED, P21 disagreed with 4.E: **settled by Mason (Question 6): any brand problem means no record for the line, whole line listed** (4.E, P21).
- HIGH, completion without the base `seq`: **settled by Mason (Question 7): complete and warn** (4.C).
- MED, Question 2 unanswered: **answered, review list only** (4.E, P20; P35 removed).
- MED, Question 4 unanswered: **answered, keep the brand** (4.D).

**Codex GitHub review** (head `612e13530`): 1 P2, **fixed**. Retiring a line's last listed brand could make a later invoice treat it as unbranded: `brand_lines` comes from the saved picks whenever any exist, and is NULL only when the line had no brand list at completion and no pick at all (4.D, P16).

**Luna round 15** (whole branch, head `9af766ad2`): 2 HIGH, 1 MED, all **fixed**.
- HIGH, deliveries completed before B-1 have no completion event: listed "completed before brand capture", invoices unchanged from today, nothing backfilled (4.H, P16a).
- HIGH, a re-copy could put the old product's brand on a line the office changed to another product: re-copy only onto a line of the same product; a changed line is detached (4.D, P16a).
- MED, a payer split changed after one payer posted could leave unreconciled records unlisted: the gaps list recomputes each split order line's posted records against delivered (4.H, P16a).

**Codex GitHub review** (head `82ef98391`): 1 P2, **fixed**. Ordering payer allocation by the invoice-line ID broke when `save_invoice` re-created a line: ordered by the payer invoice's stable ID instead (4.E, P16a).

**Luna round 16** (whole branch, head `da2f3c280`): 1 HIGH, 2 MED, all **fixed**.
- HIGH, "registration says yes at posting" and "unknown is not recorded" conflicted: an unknown entry is recorded when its registration says yes at posting (4.E, P20, P16b).
- MED, a reprint after a correction silently differed from the sent receipt: it prints "Corrected <date>: was ..." (4.F, P16b).
- MED, an unbranded restricted-use line with no EPA number had no follow-up once the refusal goes: it is on the RUP brand gaps list (4.H, P16b).

**Codex GitHub review** (head `be75a7dc1`): 2 P2, both **fixed**.
- The lock order put invoices before REG-DB's registration lock, the reverse of REG-1 §3.2, so a seed could deadlock with completion: every writer now takes the shared registration lock first, then invoices, then the delivery (3.3, P36a).
- Posting's read-only check could read picks while a brand writer that missed the new invoice was still uncommitted: posting now holds each delivery-made line's delivery row `FOR SHARE` before the check, so it waits for that writer (3.3, P36b).

**Luna round 17** (head `636608e3c`): 1 HIGH, 2 MED, all **fixed**.
- HIGH, a correction could miss an invoice created and posted after it read the invoice list: it re-reads the linked invoices after taking the delivery row and refuses if any is posted; posting waits on that row (4.F, P36c).
- MED, the gaps list could flag a split brand that correctly gets no RUP record: only brands that get a record are compared (4.H, P36c).
- MED, unsaved brand choices could be lost silently by leaving the page: leaving asks first, and a reopened page shows the saved picks and save time (5).

**Codex GitHub review** (heads `97be9e606`, `0b2e108ac`): 2 P2, both **fixed**.
- The split check compared brands that correctly get no RUP record: only recorded brands are compared (4.H, P36c).
- The split check compared per order line, but records merge across lines of one product: it compares per order, product and sold number (4.H, P36c).

**Luna round 18** (head `eaa74448d`): 1 HIGH, 2 MED, all **fixed**.
- HIGH, the posting staleness check would refuse a line whose product the office changed: detached lines are skipped (3.3, P36d).
- MED, two shapes for a line with no picks: `[]` only when no trip has a pick; a no-pick trip beside picked trips is a NULL-brand entry (3.1, 4.D, P6).
- MED, cents rounding unstated: half-up to a whole cent, exact numeric, last entry takes the remainder (4.E).

**Codex GitHub review** (head `682bbe0a8`): 2 P2, both **fixed**.
- Cents were allocated only across recorded entries, so a non-RUP brand's money went to a RUP record: allocation runs over every entry first, then only eligible records are written (4.E, P36c).
- The split check's eligibility missed captured-`yes` brands: it uses 4.E's rule, captured `yes` or registration `yes` (4.H, P36c).

**Luna round 19** (head `682bbe0a8`): 2 HIGH, both **fixed**.
- HIGH, the last recorded entry took the non-RUP brand's cents: same as the Codex fix above, allocation runs over every entry first (4.E).
- HIGH, rounding each share half-up could leave the last entry negative: round down, then hand out leftover cents by largest dropped fraction (4.E).

**Codex GitHub review** (head `26f804f54`): 1 P2, **fixed**.
- The split check compared the first posted payer's records with the whole delivered amount, so a normal half-posted split was listed: it compares posted payers' records with their recomputed allocation and leaves unposted payers out (4.H, P36c).

**Luna round 20** (head `26f804f54`): 1 HIGH, **fixed**.
- HIGH, payer splits could hide overbilling (two payers billing 70 each on 100 delivered recorded 50 each, and the check passed): the billed-above-delivered problem sums every payer line of the order line (4.E, P36c).

**Luna round 21** (head `a4103d72b`): 1 HIGH, **fixed**.
- HIGH, payer split allocation said brands add up to the full delivery even when payers bill less: it allocates the payers' billed total, so records never exceed what was invoiced (4.E, P36c).

**Codex GitHub review** (head `a4103d72b`): 1 P2, **fixed**.
- The split billed total summed every payer line of the order line, so two correct 50-unit Bill Split trips looked like 100 billed against 50: Bill Split payer groups are per delivery; landlord splits stay order-wide (4.E, P36c).

**Luna round 22** (head `4c8ef020d`): 1 HIGH, 2 MED, all **fixed**.
- HIGH, an invoice line moved to another product dropped the delivered RUP brand with no gap listed: such lines are listed "product changed after delivery" (4.H, P36d).
- MED, the split check grouped without signal word: it uses the records' grouping, including signal word (4.H, P36d).
- MED, paperwork showed a short split without saying so: receipt, email and invoice print "Brand amounts do not match delivered" (6, P36d).

**Codex GitHub review** (head `93d725cc1`): 1 P2, **fixed**.
- REG-1's `INVOICE_LINE_NO_REGISTRATION` would refuse a typed number with no registration row: branded lines skip that refusal; the entry is recorded only if captured `yes`, else reviewed (4.E, P36e).

**Luna round 23** (head `9c65aebf3`): 1 HIGH, 1 LOW, both **fixed**.
- HIGH, an invoice line moved from delivered product P to Q posted with no warning before posting: the draft warns "Product changed from delivered P" and posting asks once to confirm (warn, never block; 6, P36d).
- LOW, Complete was both disabled while unsaved and said to save first: Complete stays enabled, saves unsaved changes first and completes only after that save succeeds (5).

**Luna round 24** (head `8a074b436`): 1 HIGH, 2 LOW, all **fixed**.
- HIGH, no screen called `correct_delivery_brands`: B-2 adds **Correct brands** on a completed delivery (admin), linked from the gaps lists (5, P36f).
- LOW, an `unknown` entry recorded because its registration says `yes` still showed as not reviewed: only unrecorded `unknown` entries are listed (4.D).
- LOW, receipt snapshots queued before B-1 lack `brands`: the worker prints them as today (3.5, P36f).

**Codex GitHub review** (head `b919c4636`): 1 P2, **fixed**.
- A voided split invoice's items stayed in the payer group, so a void and reissue looked overbilled: payer groups include only active invoices, for allocation, the overbilling check and the gaps list (4.E, P36c).

**Luna round 25** (head `b919c4636`): no BLOCKER or HIGH; 2 MED, both **fixed**.
- MED, cents were rounded per payer line, so a brand's group-wide cents could drift: kept by design and stated (each invoice's records match its own cents; drift is under 1 cent per payer line); quantities stay group-wide (4.E).
- MED, the gaps list compared Bill Split records order-wide, so differences in two deliveries could cancel: it compares per payer group (Bill Split per delivery, landlord split per order line) (4.H).

**Luna round 26** (head `91cf0b6b4`): no BLOCKER or HIGH; 1 MED, **fixed**.
- MED, a picked brand with no EPA number appeared on no list until its invoice posted: Deliveries missing brands also lists current picks with no EPA number (4.H).

---

## 13. Re-check against live and `main` (2026-11-10 night, before any code)

Checked read-only on live (counts and function bodies only) and on `main` at `69774ac6e`. No code or migration was written.

### 13.1 Precondition: PAR-1/PAR-2 brand move: **met**

| Fact | Live, 2026-11-10 |
|---|---|
| `_product_parent_grouping_open()` body | `SELECT true` (switched on, `20261229100000`, #1712) |
| `product_parents` / `product_parent_members` | 456 / 593 |
| `product_parent_brands` | 200 (135 active) |
| `product_brands` (legacy, ungrouped sizes) | 162 |
| Grouping batches | recorded on #1708 |

### 13.2 REG-1 step 2 as built (#1746, `20261231200000`/`210000`/`220000`): **differs from what this sheet assumed**

Live has `invoice_line_rup_captures` and the unique index `rup_sales_records_one_active_per_line`; `epa_registrations` has 0 rows (seed not run); `rup_sales_records` has 0 rows. Contract: `docs/plans/2026-11-10-reg1-step2-record-line-link-CONTRACT.md`.

| This sheet assumed (REG-DB, #1688) | #1746 as built | Kind |
|---|---|---|
| A record carries the line's **sold number**; PR B feeds it each brand's number (4.D, 4.E) | **The number is the product's own** (Mason's #1688 decision, kept in #1746; `_invoice_line_rup_facts`: "The number is the product's own") | **Business rule: Question 8** |
| Records grouped by `(invoice, product, sold number, signal word)`; a split line gives one record per brand (4.E) | **At most one active record per invoice line** (`UNIQUE (invoice_item_id) WHERE voided_at IS NULL`, plus a guard trigger on `rup_sales_records`) | **Business rule: Question 9** |
| `_capture_invoice_line_sale` helper and capture columns on `invoice_items` (`sale_facts_source` etc.) | Neither exists. Capture is a private table `invoice_line_rup_captures`, written by the AFTER trigger `trg_zz_capture_invoice_line_rup` at every line save | Engineering: 4.D rewritten after the answers |
| Record when captured `yes` **or** registration `yes` at posting | Captured at save; any Yes (product tick, product's number, line's number) makes it restricted use; a Yes always wins | Engineering: PR B follows #1746 per brand |
| Posting refusals `INVOICE_LINE_NOT_CAPTURED`, `INVOICE_LINE_RUP_NO_EPA`, `INVOICE_LINE_NO_REGISTRATION` to be replaced for branded lines | None of them exist; a missing number never blocks; gaps go to `get_epa_sales_to_check()` ("Sales to check") | Engineering: simpler; the RUP brand gaps list may fold into Sales to check |
| Field-application invoices out of scope | Field-application invoices now get records (Mason, 2026-11-10); return credits never do; voiding an invoice voids its records | Engineering: scope note in section 8 |

### 13.3 Questions for Mason (NEEDS MASON - DECISION REQUIRED)

**Question 8. Which EPA number goes on a restricted-use record when the driver recorded the brand?**
Your REG-1 rule (2026-11-09, kept 2026-11-10) is "the product's own number". Brand PR B exists to record the brand that actually went off the truck, for example a Liberty-brand jug delivered against the generic glufosinate. If the record keeps the generic's number, recording the brand changes the paperwork but not the restricted-use record.
- **Recommended: the delivered brand's number** when the driver recorded a brand that has a number; the product's own number in every other case, exactly as today.
- Alternative: always the product's own number, with the brand name added to the record as a note.

**Question 9. One invoice line, two brands delivered (a split): how many restricted-use records?**
#1746 allows exactly one active record per invoice line (that rule ended eight rounds of Sol findings about matching records to lines).
- **Recommended: one record per brand on that line** (two brands, two records, each pointing at the same line and naming its brand). The one-record rule becomes "one per line per brand"; a line with no brand recorded keeps one record as today.
- Alternative: split the invoice line into one line per brand when the invoice is made. Simpler records, but it changes how invoices look and touches invoice amounts.

**Question 9 answered (Mason, 2026-11-10): "One record per brand".** A line delivered as two brands gets two records, each pointing at that line and naming its brand; #1746's one-active-record-per-line rule becomes one per line per brand. Invoice lines are not split.

**Question 8 answered (Mason, 2026-11-10): "The brands own number".** Section 14 applies both answers. After the rewrite the sheet gets a fresh independent review before B-1 is built.

---

## 14. Design on REG-1 as built (#1746), with Mason's answers to Questions 8 and 9 (2026-11-10)

**This section wins over sections 3 to 7.** Rule: only what #1746, Questions 8 and 9, or the section 14 reviews (14.8) changed is rewritten here; every other rule in sections 3 to 7 (picks, stale-save guards, `edit_delivery` carry-over, completion warnings, correction, typed-brand review, payer-group allocation, receipts, screens) stands, except the lines struck in 14.7.

### 14.1 The two answers

- **Question 8, "The brands own number":** a brand entry with an EPA number is captured and recorded under **that number**. A line with no brand recorded (`[]`, or a no-brand trip entry) and a brand entry with no number use the product's own number exactly as #1746 does.
- **Question 9, "One record per brand":** a line with brand entries gets **one record per brand**, all naming the same `invoice_item_id`. Two trips of the same brand (same name and same EPA number) on one line merge into that brand's one record; if the brand's number changed between trips, each number gets its own record, so no record ever carries a number that was not on the jug. A line with `brand_lines` NULL or `[]` keeps #1746's one record per line. Invoice lines are never split.

### 14.2 Split B-1 into two database PRs, and the order

Engineering choice, to keep each Sol review small. Neither changes an amount.
- **B-1a (delivery side):** `delivery_item_brands`, `delivery_brand_events`, `_delivery_line_brand_list`, `set_delivery_brands`, `edit_delivery` carry-over, the completion rule (4.C steps 1 to 5 and the `p_brand_base_seq` check), `correct_delivery_brands` (picks only), `review_typed_brand`, `get_delivery_brands`, `get_typed_brands_for_review`, `get_deliveries_missing_brands`. The receipt snapshot (3.5) moved to B-3 (15.10, Sol round 2). It re-issues no invoice or RUP function.
- **B-1b (invoice and RUP side):** everything in 14.4. It re-issues none of B-1a's functions: the re-copy hangs off `delivery_brand_events` (14.4).
- **Order:** B-1a live → the REG-1 fix in 14.6 live → the REG-1 seed run (Mason) → B-1b live (its preflight refuses before the seed, 14.4) → B-2 and B-3. Before the seed, #1746 records nothing per line and by Mason's 2026-11-10 decision no sales are made, so nothing branded is posted before B-1b.

### 14.3 What changes from sections 3 to 7

| Section | Old rule (REG-DB, never built) | Now |
|---|---|---|
| 3.1 picks | Sale facts captured on each pick at completion | **Removed.** REG-1 captures at invoice-line save. A pick keeps only its snapshot (name, EPA number, manufacturer, signal word from the brand row, amount). 4.C step 6 is deleted. |
| 3.1 `brand_lines` entries | carry `rup_status`, `signal_word`, `facts_source` | Carry `brand_name`, `epa_registration`, `manufacturer`, `signal_word`, `delivered_quantity`, `typed`, `pick_ids`, `completed_at` only. |
| 3.1 `[]` | "keeps no EPA number, never the generic's" | Q8: the line keeps the product's own number and is recorded per line like any REG-1 line. |
| 3.1 two brands, one number | one record, names joined | One record per brand (Q9); `brand_key` tells them apart (14.4). |
| 3.1 `brand_lines` grant | revoke the column grant | #1746 already revoked app-role writes on `invoice_items`. `service_role` keeps its writes; the trigger sets `brand_lines` on every insert and update (14.4), so no role can set it by hand. |
| 3.3 locking and `BRAND_LINES_STALE` | posting holds each delivery row `FOR SHARE` and refuses a stale draft | **Both removed.** Posting takes no delivery lock and never refuses over brands (Q5): it records from the stored `brand_lines`. A posted line whose stored brands differ from the current picks is listed `brand_lines_stale` on Sales to check. Delivery-side writers keep today's order (delivery row, then invoice lines; completion's order since `20261215110000`); posting keeps #1746's (invoice and lines, then the shared registration lock). Posting never waits on a delivery row, so the two orders cannot form a cycle. |
| 4.D writing `brand_lines` | through REG-DB's `_capture_invoice_line_sale` | A trigger (14.4) on every insert and update; delivery-side changes reach existing drafts through an event trigger (14.4). |
| 4.D the line's own number | sold number = brand's number; NULL for a split | Exactly one entry with a number: the line's `epa_registration` is that number. Anything else (several entries, `[]`, a no-brand or no-number entry): the product's own number, set by the trigger even if the line held a brand number before. |
| 4.D `save_invoice` | quantity change keeps the pick's copied capture | `save_invoice` deletes and re-inserts lines, so #1746 captures them again as of that save (accepted by Mason for lines, `20261231210000:30`); the per-brand capture inherits the same accepted rule. A Yes at posting still wins. |
| 4.E which entries get a record | captured `yes` or registration `yes` at posting | #1746's rule per brand: any Yes at save (the product's tick, the product's number, the brand's number) records; a Yes always wins; a Yes at posting wins. |
| 4.E grouping | `(invoice, product, sold number, signal word)` | Struck. One record per line per brand. |
| 4.E brand problems | no record, separate gaps list | **Q6 problems (no record for the line, listed):** non-empty entries that do not add up to delivered; billed above delivered. **Not problems (Q8):** `[]`, a no-brand trip entry, a no-number brand: recorded under the product's own number, and listed for follow-up. |
| 4.E allocation | as written | Unchanged (payer groups, trip order, quantity at `numeric(12,4)`, cents round down then largest leftover). Each record holds its brand's share of its line. |
| 4.F correction facts | a same-brand pick copies the old pick's facts; `corrected:<date>` | Struck: picks hold no facts. A corrected draft line is captured again by the re-copy, as any save. |
| 4.F correction vs posting | posting waits on the delivery row `FOR SHARE` | Posting no longer locks the delivery, so the correction locks the invoices instead: after the delivery row, it takes every linked invoice row `FOR UPDATE` in `id` order and then re-reads their status, refusing with `INVOICE_POSTED` as before. `post_invoice` holds the invoice row `FOR UPDATE` until it commits (`20261022022000:459`), so a posting either commits first (the re-read sees it and refuses) or waits for the correction (and then posts the re-copied lines). Order: correction = delivery, then invoices; posting = invoice, never the delivery; no cycle. A draft created after the re-read keeps the picks it saw; if those are older, it is listed `brand_lines_stale` after posting and never refused (Q5). |
| 4.H `get_rup_brand_gaps` | a new admin list | Folded into REG-1's `get_epa_sales_to_check()` (re-issued) as reasons: `brand_split_mismatch`, `billed_above_delivered`, `brand_not_recorded`, `brand_no_epa_number`, `brand_lines_stale`, `payer_split_changed`, and per-brand `restricted_use_to_record` / `not_reviewed`. |
| 4.H, P16a, P36d "product changed after delivery" | listed, warned | Struck: `save_invoice` refuses a product change on an order-linked line with quantity above zero (`GENERATED_INVOICE_LINEAGE_IDENTITY_IMMUTABLE`, `20261118110000:200-214`). |

### 14.4 B-1b database pieces

- **`invoice_items.brand_lines jsonb`** (NULL by default).
- **Trigger `trg_fill_invoice_line_zbrands`** (BEFORE INSERT OR UPDATE, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, named to fire after `trg_fill_invoice_line_epa` and before `trg_refuse_posted_invoice_child_write`): on an invoice that is `posted`, `overdue` or `paid`, it sets `NEW.brand_lines := OLD.brand_lines` and leaves the number alone, so cost, tote and return-credit updates on posted lines still pass the posted-child guard. Otherwise, on every insert and update, it recomputes `brand_lines` from the current picks by 4.D's rules (which picks; `[]` vs NULL from the completion event) and sets the line's number per 14.3. A line with no `order_item_id` gets NULL. Because it recomputes on every write, `save_invoice`'s re-insert and its id-restore update both end with fresh values.
- **Re-copy on pick changes:** an AFTER INSERT trigger on `delivery_brand_events` (every brand writer, completion included, writes one event after its picks) touches the delivery's lines on `draft` and `unposted` invoices (this delivery's invoices, and order-level invoices covering its order lines), so the trigger above recomputes them. The order-level touch goes through `guard_terminal_order_invoice_items` (`orders FOR UPDATE NOWAIT`); an `ORDER_LIFECYCLE_BUSY_RETRY` there is retryable, and B-2's screens retry it once.
- **Backfill at apply:** the migration touches every `draft`/`unposted` line with an `order_item_id` once, so lines made between B-1a and B-1b get their brands.
- **`invoice_line_brand_rup_captures`** (private, like `invoice_line_rup_captures`: owner `postgres`, RLS on, every grant revoked; its admin policy only states intent, as #1746's does): `invoice_item_id` (FK `ON DELETE CASCADE ON UPDATE CASCADE`), `brand_key text NOT NULL`, `brand_name`, `epa_registration`, `rup_status`, `signal_word`, `source`, `captured_at`; primary key `(invoice_item_id, brand_key)`. `brand_key` = `lower(brand_name) || '|' || coalesce(normalized snapshot number, '')`, or `'~none|'` for a no-brand entry, never NULL. `captured_at` changes on every re-capture, as in #1746.
- **`_invoice_brand_rup_facts(product, brand number, brand signal word)`:** #1746's rule with the brand's number in place of the line's; Yes when the product's tick, the product's number's registration or the brand number's registration says Yes; the captured number is the brand's (or the product's when the brand has none); the signal word is the captured number's registration's (the brand's number, or the product's when the brand has none, as `_invoice_line_rup_facts` does), else the brand snapshot's, else the product's.
- **`_capture_invoice_line_rup` re-issued:** the brand capture runs **before** #1746's early return, keyed by the brand set: brands no longer on the line are deleted, new ones captured, kept ones keep their row (a Yes always wins). Before the seed nothing is captured.
- **`generate_rup_sales_records` re-issued, three branches per line:** `brand_lines` NULL or `[]` → #1746's per-line path; non-empty with no Q6 problem → one record per brand captured Yes, with its allocated quantity and cents, `brand_name`, `brand_key`, the brand's number and signal word; non-empty with a Q6 problem → no record. The posting-time capture of missing rows and the Yes-at-posting upgrade run per brand too.
- **`rup_sales_records`:** add `brand_name text`, `brand_key text`. Replace `rup_sales_records_one_active_per_line` with a unique active index on `(invoice_item_id, coalesce(brand_key, ''))`, and extend `trg_rup_sales_record_line` so a line's active records are either one with `brand_key` NULL or any number with it set, never both.
- **`_epa_registration_unrecorded_posted_lines` re-issued** per brand (a brand number turning Yes lists the split lines it sits on, and a line counts as recorded only when that brand has its record; the product's number lists each brand too, and a line whose brands do not reconcile is listed once under any number it carries, Sol r3), and **`get_epa_sales_to_check()`** with the reasons in 14.3. The line-level brand reasons are listed only for a line that may owe a record: a line is left out only when the product, every number on the line, every stored or current brand and every brand on the size's list is known not restricted (Taha, PR #1825).
- **`get_rup_sales_register`** is `RETURNS TABLE` (`20261014220000:100-107`): adding `brand_name` is a DROP and CREATE with its grants and the frontend type.
- **Seed:** B-1b's preflight refuses unless `_epa_registrations_seeded()`, so the pre-seed path never meets a branded line. Brand numbers not in the seed (typed ones) stay `not_reviewed` until someone adds a registration.

### 14.5 Prover cases changed (section 7)

- P12, P19, P20: per-brand records follow #1746; a split line gives two records on one line; two trips of one brand give one record; a brand record carries its brand's signal word.
- P21: entries not adding up and billed above delivered give no record and are listed; `[]`, a no-brand trip and a no-number brand are recorded under the product's own number and listed.
- P15, P23: completion, the partial trim, `set_delivery_brands`, `edit_delivery` and a correction re-copy open drafts through the event trigger; a posted order-level invoice is left alone and a later trip's completion (tote copy) still succeeds.
- P32 replaced: posting a draft whose brands changed after the office loaded it is refused only by the existing `INVOICE_CHANGED_SINCE_LOADED`; a posted line made stale later is listed `brand_lines_stale`. Completion and posting of one draft, run together in both orders with a registration edit waiting, never deadlock.
- New: `save_invoice` with a price change on an order-linked branded line, after the seed: `brand_lines` and the captures survive the id restore. A `service_role` write of `brand_lines` is overwritten. A line can never hold a per-line and a per-brand record at once. B-1b's apply refuses before the seed.
- Removed: captured facts on picks, `BRAND_LINES_STALE`, `INVOICE_LINE_RUP_NO_EPA`, `INVOICE_LINE_NO_REGISTRATION`, `get_rup_brand_gaps`, "product changed after delivery".

### 14.6 REG-1 bug found by this review (fix before the seed runs)

`_save_invoice_scoped_impl` re-inserts lines, then moves each kept order-linked line back to its old id (`UPDATE invoice_items SET id = preserved.source_item_id`, `20261118110000:276`). #1746's capture trigger has already captured the re-inserted id, and `invoice_line_rup_captures.invoice_item_id` is `ON UPDATE NO ACTION` (checked on live 2026-11-10). So after the seed, re-saving such a line should fail with a foreign-key error. #1746's prover case 14 re-saves lines without an `order_item_id`, so it never reached this path. Not yet reproduced. Proposed fix, a small migration of its own before the seed: make that foreign key `ON UPDATE CASCADE`, plus a prover case re-saving an order-linked line after the seed.

### 14.7 Struck from sections 3 to 7

3.1's `[]` "never the generic's number" and its joined-name records; 3.3's posting delivery lock, staleness check and `BRAND_LINES_STALE`; 4.C step 6; 4.D's `brand_pick` and `sale_facts_source` rules; 4.E's grouping key; 4.F's fact copying and `corrected:<date>`; 4.H's `get_rup_brand_gaps`; P6's "no EPA number"; P16's "client write refused" (now overwritten); P16a and P36d's product-change cases; P32 and P36b's `BRAND_LINES_STALE`.

### 14.8 Review of section 14 (2026-11-10)

**Luna round 1** (head `14c9fac5e`): 1 HIGH, 1 MED, 1 LOW.
- HIGH, lines made between B-1a and B-1b keep NULL brands: **fixed**, backfill at apply plus the seed-first order (14.2, 14.4).
- MED, an admin read policy without a grant cannot work: **refuted**; deliberately the same as #1746's private capture table, whose policy only states intent and which no app role reads.
- LOW, no `updated_at` on the capture table: **refuted**; `captured_at` is rewritten on every re-capture, as in #1746, and is the only time that matters.

**Independent Opus review** (same head, read against the migrations): 2 BLOCKER, 6 HIGH, 8 MED, 6 LOW.
- BLOCKER, the trigger fired only on insert or product change, so drafts were never re-copied: **fixed**, recompute on every write plus the event trigger (14.4).
- BLOCKER, `save_invoice` lost brands and, after the seed, fails on the id restore: **fixed** for B-1b (recompute on every write; `ON UPDATE CASCADE`); the existing #1746 half is 14.6.
- HIGH, recomputing a posted line would trip the posted-child guard: **fixed**, posted lines keep `OLD.brand_lines`.
- HIGH, posting's delivery lock made a three-way deadlock with a waiting registration edit; HIGH, completion locks the delivery first; HIGH, `BRAND_LINES_STALE` blocks posting against Q5: **fixed together** by removing posting's delivery lock and staleness refusal (14.3).
- HIGH, NULL `brand_key` for a no-brand entry: **fixed**, sentinel key (14.4).
- HIGH, generator paths could record a problem line or double-record: **fixed**, three branches plus a record guard (14.4).
- MED: stale brand number on a split (fixed, 14.3); generic's signal word on a brand record (fixed, `_invoice_brand_rup_facts`); brand capture skipped by the early return (fixed); pre-seed path (fixed, seed first); unrecorded-lines list per brand (fixed); leftover rules (struck, 14.7); `service_role` overwrite and `SECURITY DEFINER` trigger (fixed); `save_invoice` re-capture (stated as #1746's accepted rule).
- LOW: product-change cases unreachable (struck); `get_rup_sales_register` DROP and CREATE (stated); order busy retry (stated); seed and typed numbers (stated); which PR adds the posting lock (moot, removed). `BRAND_PICKS_CHANGED` on completion and an internal error failing a Bill Split completion: **refuted**; Mason's Q5 record keeps `BRAND_PICKS_CHANGED` as data protection, and an internal error is not a brand problem.

**Luna round 2** (head `33d1d6c1a`): no BLOCKER or HIGH; 2 MED.
- MED, a brand whose number changed between trips gets two keys: **kept by design and stated** (14.1): one record per number, so a record never carries a number that was not delivered.
- MED, `brand_lines` had no signal word for the brand snapshot fallback: **fixed**, picks and entries carry the brand row's `signal_word` (14.3).

**Codex GitHub review** (heads `14c9fac5e`, `33d1d6c1a`): 3 P2.
- P2, NULL `brand_key` for a no-brand entry: **already fixed** by the `'~none|'` sentinel (14.4).
- P2, removing posting's delivery lock left a correction able to race a posting: **fixed**, the correction locks the linked invoices and re-reads them (14.3, 4.F row).
- P2, a no-number brand's signal word skipped the product number's registration: **fixed**, the signal word follows the captured number (14.4).

---

## 15. Behavior contract for B-1a as built (2026-11-11, `plan-contract`)

Read on `main` `eda8b1597` and live (read-only) on 2026-11-11. Section 14 and the rules of sections 3 and 4 that it keeps still hold. This section records only how B-1a meets them against the live code, and where the build departs from the sheet's mechanism (never its behaviour).

### 15.1 Facts (live, 2026-11-11)

- Preconditions met: `_product_parent_grouping_open()` is `SELECT true`; `epa_registration_seed_run` has its row (seeded 2026-11-11 15:14 UTC, 347 registrations); the `invoice_line_rup_captures` foreign key is `ON UPDATE CASCADE` (`20270102160000`, 14.6).
- Completion chain: `complete_delivery` → `_complete_delivery_replay_impl_20261015` (authorization, replay, period check) → `_complete_delivery_period_preflight_impl` → `_complete_delivery_aggregate_impl` (1,075 characters; the **only** caller of `_complete_delivery_authorized_impl`) → `_complete_delivery_authorized_impl`. `start_and_complete_delivery` and `process_offline_action` both call `complete_delivery(`. A replay returns inside `_complete_delivery_replay_impl_20261015` and never reaches the aggregate step.
- `edit_delivery` (wrapper with bound receipt) → `_edit_delivery_replay_impl_20261015`, which re-creates lines only when `p_items` is given and the delivery is `scheduled`, and refuses any delivery that is not `scheduled` or `in_progress`.
- `_enqueue_delivery_receipt` is called only by `complete_delivery`; the receipt body is a snapshot.
- `delivery_items` has no `(id, delivery_id, product_id)` unique; `product_parent_brands` has no `(parent_id, id)` unique; `product_brands` has `(product_id, id)`. Admins can `UPDATE delivery_items` directly (`del_items_update`).
- `_product_parent_replay(key, scope, fingerprint)` (PAR-1, reused by REG-1's `set_epa_registration`) serialises a key, refuses a key used by another operation (`IDEMPOTENCY_CROSS_OP_KEY_REUSE`, from `check_idempotency`), and refuses a different actor or payload (`IDEMPOTENCY_PAYLOAD_MISMATCH`).

### 15.2 Mechanism choices (engineering; behaviour unchanged)

1. **Where the completion rule runs:** `_complete_delivery_aggregate_impl` is re-issued with the same signature and grants. It checks the brand base `seq`, calls `_complete_delivery_authorized_impl` unchanged, then runs the completion rule (4.C steps 1, 2 and 5) and writes the `completed` event. The 28,953-character body is **not** re-issued. The rule now runs after the tote copy and invoice drafting rather than before; that order no longer matters, because 14.3 removed capture at completion and B-1b re-copies drafts off the `completed` event. **Except split drafts (B-1b H1, 2026-11-11):** Bill Split and landlord auto-split drafts are written inside the body, before the rule, and are never re-copied (their stored provenance claim must keep matching). B-1b therefore re-issues this aggregate step once more to name the delivery being completed in the transaction-local setting `crx.brand_completing_delivery` while the body runs; the reader (16.2.1) reads that delivery as the rule will leave it, so every line written during a completion holds the final brands. A brand error fails the whole completion, because the rule is outside the Bill Split `EXCEPTION` block (P26).
2. **`p_brand_base_seq`:** `complete_delivery` and `start_and_complete_delivery` are renamed to `_complete_delivery_evidence_impl_20270104` and `_start_and_complete_delivery_impl_20270104` (EXECUTE revoked from every app role) and replaced by thin wrappers with one trailing `p_brand_base_seq bigint DEFAULT NULL` and the same grants. A non-NULL value travels down in the transaction-local setting `crx.brand_base_seq`. The aggregate step (fresh completions only, delivery row already locked) compares it with the delivery's highest event `seq` other than `line_removed` (0 when none; an office `reviewed` event counts, Luna round 4) and clears the setting. It **never refuses**: equal records `picks_confirmed: true`; stale or not a plain number completes against the current picks and records `picks_confirmed: false` (reviewer round 1, 15.10); no value sent (today's app) records `picks_confirmed: null`, which the office list does not flag. The `seq` is **not** part of the fingerprint: a same-key retry is the same completion, so a committed one replays and an uncommitted one is checked again on retry.
3. **Retry safety:** the three new writers use `_product_parent_replay` plus `save_idempotency` (the REG-1 pattern) instead of the bound-receipt trigger, so the receipt-binding trigger on `idempotency_keys` is not recreated. The guarantees are the same: key required, cross-operation reuse refused, another actor or payload refused, and authorization before the lookup.
4. **`edit_delivery`:** only the thin wrapper is re-issued. On a fresh call it copies the current picks before the body runs. When the body reports `items_changed`, it re-inserts the picks of each new line whose `order_item_id`, `product_id`, `quantity` and `unit_size` equal an old line with picks, when exactly one old line and one new line share those four values (otherwise those picks are dropped and listed, never guessed), copying each pick with its entry and review history, writes one `edited` event, and adds `brand_picks_kept` and `brand_lines_dropped` to the result and to the saved receipt, so a replay returns the same answer.
5. **Integrity by key:** `delivery_item_brands (delivery_item_id, delivery_id, product_id)` references `delivery_items (id, delivery_id, product_id)` `ON DELETE CASCADE` (new unique), so a direct admin update of a picked line's product is refused; parent picks reference `product_parent_brands (parent_id, id)` (new unique); legacy picks reference `product_brands (product_id, id)`.
6. **No registration lock** on delivery-side writers (14.3: they keep today's order, delivery row then invoices).

### 15.3 Rules that always hold

- Only `SECURITY DEFINER` functions write picks or events. App roles get `SELECT` only, under the delivery read rule (admin, sales rep, or the delivery's assigned driver). Events are append-only (update, delete and truncate refused).
- Every brand writer holds the delivery row `FOR UPDATE` before reading the highest `seq` and writing its event, so `seq` order is commit order for each delivery. The one exception is the line-delete trigger: its `line_removed` event takes no delivery lock (Mason, 2026-11-11, DECISION_LOG), so it can commit out of `seq` order; `line_removed` events never count toward the stale-save base.
- Nothing about brands refuses a completion (Q5), a stale `seq` included; `BRAND_PICKS_CHANGED` refuses only a brand save or correction.
- A listed pick's snapshot comes from the brand row; a typed pick's from its typed values. A correction never overwrites a pick: it supersedes it.
- No amount, quantity, cost, stock or invoice row changes in B-1a. The only invoice reads are the correction's posted check.

### 15.4 Who may act

| Action | Who | Server check |
|---|---|---|
| `set_delivery_brands` | active admin, sales rep, or the assigned driver | delivery `scheduled` or `in_progress`, else `DELIVERY_BRANDS_LOCKED`; each line on the delivery; a listed brand on the line's list (3.2) |
| completion rule | whoever may complete (unchanged) | runs inside completion |
| `correct_delivery_brands` | active admin | delivery `completed`; reason required; each named line's picks add up to delivered, or are empty (brand unknown: the line goes back on the office list); linked invoices locked `FOR UPDATE` in `id` order after the delivery row, refused `INVOICE_POSTED` if posted, overdue or paid |
| `review_typed_brand` | active admin | pick is typed and current; `link` needs a brand on the line's current list |
| `get_delivery_brands` | the delivery read rule (a driver only while active) | |
| `get_typed_brands_for_review`, `get_deliveries_missing_brands` | active admin | |

### 15.5 Existing rows

The new tables start empty. A delivery completed before the apply has no `completed` event: `get_deliveries_missing_brands` lists such a line "completed before brand capture" only when its product has a brand list today. Deliveries scheduled or in progress at the apply have no picks and complete as today, with a `completed` event. The deployed app never sends `p_brand_base_seq`, so every completion until B-2 records `picks_confirmed: null` and is not flagged for it. Read-only check after the apply: both new tables exist with RLS on and app roles limited to `SELECT`; each delivery completed after the apply has one `completed` event; a pick count above 0 is fine (the new RPCs are callable as soon as the apply lands), and every pick sits on a delivery that is not cancelled or voided.

### 15.6 Proof cases (local real-schema prover, test data only)

- When a driver not on the delivery, an inactive user or an anonymous caller saves picks, then refused. Same key and same save, then one event and the same answer; different payload, then `IDEMPOTENCY_PAYLOAD_MISMATCH`; another operation's key, then `IDEMPOTENCY_CROSS_OP_KEY_REUSE`; no key, then `IDEMPOTENCY_KEY_REQUIRED`.
- When a brand from another parent, from another size's legacy list, or a retired parent brand is saved, then `BRAND_NOT_FOR_PRODUCT`. A not-currently-sourced listed brand is accepted. A typed name equal to a listed brand with the same or a blank number is stored as the listed pick; with a different number, as typed and pending review.
- When picks add up to more than loaded, then `BRAND_SPLIT_OVER_LOADED`. When a save uses an old base `seq` (after another save or an `edit_delivery`), then `BRAND_PICKS_CHANGED`.
- When a delivery completes through `complete_delivery`, `start_and_complete_delivery` or an offline replay, with a branded line and no pick, a split that does not add up, or zero delivered, then it completes: zero delivered keeps no picks, one pick above delivered is trimmed to delivered, and one `completed` event records each line's delivered amount and brand-list size. A replay writes no second event.
- When completion is sent with a stale `p_brand_base_seq`, then it completes against the current picks with `picks_confirmed: false`; with the current one, `true`; none sent, `null` (not flagged). An office review does make a loaded `seq` stale (Luna round 4). A delivered amount with more than 4 decimals completes and keeps its pick (listed as a mismatch).
- When a legacy pick's size is grouped before completion, then the pick is re-pointed to its parent brand and its snapshot is unchanged.
- When `edit_delivery` changes only the date and sends the same items, then the picks are kept under the new line IDs; when one line's quantity changes, then only that line's picks drop. Both write one `edited` event.
- When an admin corrects a delivery with a linked posted invoice, then `INVOICE_POSTED`; with only drafts, then the old picks are superseded and the new ones current. Two corrections from one base: the second is `BRAND_PICKS_CHANGED`. A non-admin is refused.
- When the receipt is queued, then its lines are exactly as before B-1a and `_enqueue_delivery_receipt` is unchanged (brands on the receipt ship with B-3).
- When grants are read from the catalog, then app roles have only `SELECT` on the new tables, no helper is executable by an app role, and every new `SECURITY DEFINER` function pins `search_path`.
- When the same flow runs with and without picks, then no money, quantity, stock or invoice column differs.

### 15.7 Delivery

B-1a ships alone, database only. The deployed app keeps working unchanged: the new parameters default to NULL and the new RPCs are unused until B-2. Recovery is a forward repair in its own reviewed migration: it restores the re-issued functions from their pre-apply bodies (pinned by md5 in the preflight) and the two original signatures, and drops the new functions. The two tables and their rows stay, because every completion after the apply writes a `completed` event and the new RPCs are callable at once; dropping them would need its own explicitly approved migration. B-1b follows as its own PR.

### 15.8 Open business decisions

None. Every behaviour above is one of Mason's earlier answers (Q1 to Q9) or an engineering choice.

### 15.9 Cold challenge (Astra, 2026-11-11) and what changed

Astra's challenge of this contract was triaged against the live code. **Fixed in the migration:** rollback keeps the tables (forward repair, 15.7); an ambiguous edit match drops picks instead of guessing (15.2.4); edit carry keeps review fields; the driver read rule needs an active profile; pick amounts are above zero, not NaN, at most 4 decimals; a typed name shared by two listed brands with no number stays typed for review; a correction may empty a line; the office list adds `brand_no_longer_listed` and flags "completed before brand capture" only for a line with no picks; the delivery row is locked before `edit_delivery` copies picks. **Kept, with reasons:** the base `seq` stays out of the completion fingerprint (15.2.2); lock order (delivery, then invoices by id) matches posting, which never locks a delivery; direct admin edits of `delivery_items` have no app path (the composite key still refuses a product change on a picked line); one statement per read gives one snapshot. **Later parts:** the corrected-receipt resend and invoice and RUP copies are B-1b and B-3; screens are B-2.

### 15.10 Reviewer round 1 (rls-security, compliance, migration-drift; 2026-11-11) and what changed

- **HIGH (both reviewers):** completion trimmed a single pick to a delivered amount with more than 4 decimals, which broke the pick CHECK and refused the whole completion. Now the trim runs only when the delivered amount fits 4 places; otherwise the pick stays and the office list shows a mismatch. Corrections and the office list compare at 4 places. Prover case 14.
- **MED:** a stale `p_brand_base_seq` refused the completion. Mason's rule is warn only, so it now completes with `picks_confirmed: false` (prover case 6). An office review (`reviewed` event) no longer moves the stale-save base, so it cannot make a driver's loaded picks stale.
- **LOW fixed:** table owners set explicitly; the postflight also checks the re-issued internal bodies stay unexecutable; `_delivery_brand_resolve_picks` marked VOLATILE; reads and reviews skip soft-deleted deliveries; ledger wording.
- **LOW accepted:** picks cascade away with no brand event when an order clean-up deletes a cancelled delivery's line (the earlier events still hold them); retries after access is lost get the access error (house rule); `review_brand_ref` has no foreign key (it names either kind of brand); a wrongly shaped typed EPA number refuses that save, not the completion; B-2 types RPC picks narrower than `DeliveryItemBrand`; B-1b must refuse copying brands onto an already-posted invoice; refresh the schema registry after apply.
- **Drift review MED fixed:** the reporting role `metabase_ro` and the `delivery_brand_events.seq` counter are revoked like the newest tables, and the postflight checks both. **After apply (applied-docs PR):** re-pin the four sweep allowlist entries for the new `complete_delivery` and `start_and_complete_delivery` signatures, run `npm run db-sweeps:live`, regenerate the schema registry, flip the ledger record with the live version and name, and record live ordering against the DM-4 and RT-3 stamps (20270104100000 and 20270104110000, both lower than this one).
- **Luna round 1 (gpt-6-luna xhigh, head e831d365f):** HIGH "the receipt shows picks before the trim" **refuted**: the receipt is queued by `_complete_delivery_evidence_impl_20270104` after the whole completion chain returns, so after the brand step; prover case 11 now trims a pick (3 loaded, 2 delivered) and the receipt shows 2. MED "a bad `crx.brand_base_seq` value errors the completion" **fixed**: anything that is not a plain number reads as not confirmed (prover case 6 sets a garbage value; the completion runs without error). LOW "table policies let admins and reps read brand rows of a soft-deleted delivery" **accepted**: it matches `del_items_select` on `delivery_items` itself; the RPC reads skip soft-deleted deliveries.
- **Sol round 1 (gpt-6-sol high, head 19ff6f882):** HIGH "a direct delete of a scheduled delivery line cascades its picks away with no event or stale-base change" **fixed**: a BEFORE DELETE trigger on `delivery_items` (`_delivery_brands_on_line_delete`) records the line's current picks as one `line_removed` event first, which moves the stale-save base; `edit_delivery` sets `crx.delivery_brand_edit` around its body so its re-create is recorded once, as `edited` (prover cases 8 and 15). MED "a correction of 2.3333 is accepted for 2.33333 delivered and the office list shows no mismatch" **refuted, by design**: a pick holds 4 places, so 4 places is the closest a correction can record; the full delivered amount stays on the line. MED "an admin can link a typed pick to a listed brand with a different EPA number" **accepted**: the review is the admin's judgment after checking the jug; the typed snapshot (name, number) is kept beside the link, so the difference stays visible.
- **Luna round 2 (head ea266325d):** HIGH "the line-delete trigger writes its event without locking the delivery, so a concurrent brand save can commit a lower seq after it" **fixed**: the trigger locks the delivery row first, like every other brand writer, then checks for picks. A delete and a brand save on the same line at the same instant can now deadlock; Postgres cancels one and the other completes, which is acceptable for a rare office action. Not proven by a two-session test (the prover runs one session at a time).
- **Luna round 3 (head f60c67273):** HIGH "the receipt prints brand amounts from a split that does not add up to delivered" **fixed**: a line's brand amounts appear on the receipt only when its picks add up to delivered (4 places); otherwise the receipt names the brands without amounts and the office list shows the mismatch (prover case 11). MED "an office dismissal can be undone by a driver save loaded before it" **fixed**: a `reviewed` event moves the stale-save base again. That is safe now, because a stale base never refuses a completion (it records picks_confirmed false; prover case 14). MED "the round 2 trigger lock can deadlock a completion that holds the delivery and waits on the line" **fixed by removing the lock**: the `line_removed` event is history only and no longer moves the stale-save base, so it needs no ordering with other writers; a save that names the deleted line is refused as `DELIVERY_ITEM_NOT_ON_DELIVERY`, and the rest of the delivery still saves (prover case 15). This replaces the round 2 fix above. Builder's record: the line-delete trigger has drawn two HIGHs (Sol round 1, Luna round 2); the business fallback, if it draws more, is to refuse deleting a line that has recorded brands.
- **Luna round 4 (head 50e6673df):** HIGH "a session can set `crx.delivery_brand_edit` or `crx.brand_base_seq` itself, skipping the `line_removed` event or recording picks as confirmed" **refuted with live evidence (read-only, 2026-11-11)**: `authenticated` and `anon` cannot log in (`rolcanlogin` false), so app users reach the database only through PostgREST, one request per transaction, which runs no `SET` and exposes no `pg_catalog.set_config`; the only `public` function that calls `set_config` with a non-literal name (`_snapshot_quote_item_cost`) is not executable by `authenticated`; every brand setter clears its value before returning, and a failed call rolls its local setting back. A session that can set these values directly is a trusted server role that could already write the tables. MED "a `line_removed` event can sort by seq before a save that committed first" **accepted**: since round 3 the event is history only and moves no stale-save base, so a listing order off by one concurrent save changes no decision; its `created_at` and contents stay exact.
- **Sol round 2 (gpt-6-sol high, head d6ee8e279):** HIGH "unconfirmed picks are emailed to the customer and missing from the office list" and HIGH "a correction leaves an already queued or sent receipt showing the old brand" **fixed by moving the receipt brands to B-3**: B-1a no longer re-issues `_enqueue_delivery_receipt`, so the receipt is exactly as today (prover case 11 checks its body is unchanged). The brand lines reach no customer until B-3 changes the sender anyway, and B-3 already owns the resend after a correction (4.F), so the receipt, its printer and its correction handling are built and reviewed together. This also retires the Luna round 3 receipt fix. The office half is **fixed** here: a completion from an out-of-date screen (a stale seq) lists each picked line as `picks_not_confirmed` until an admin corrects that line (prover cases 12 and 14). A completion that sent no seq (today's app, before B-2) records `picks_confirmed: null` (not stated) and is not flagged, so the list is not flooded before the screens ship. MED "a line deletion does not advance the stale-save base, so a completion can record picks confirmed" **refuted**: the deleted line is no longer on the delivery, and every remaining line's picks are exactly what the screen loaded, so "confirmed" is true for what was delivered (Luna round 3 design). MED "2.33335 delivered with 2.3334 recorded shows no mismatch" **refuted, by design**: the same 4-place rule as Sol round 1. LOW "history seq can disagree with commit order" **accepted**, as in Luna round 4.
- **Luna round 5 (head 211c65677):** BLOCKER "a build-sheet note reads as an instruction to reviewers" **fixed**: the round 3 note is reworded as the builder's record of a fallback. HIGH "a correction misses a posted invoice linked through `invoice_items.delivery_item_id`" **refuted with live evidence (read-only, 2026-11-11)**: live `invoice_items` has no delivery-line column, and no migration adds one; invoices link by `delivery_id` or `order_item_id`, both checked. HIGH "posted credit memos are skipped by the posted-invoice refusal" **refuted, by design**: a credit memo never carries brand lines (4.D, P15), so a brand correction changes nothing on it, the same exclusion completion uses for tote numbers. MED "a correction that adds the first pick to an unconfirmed line leaves `picks_not_confirmed`" **fixed**: any `corrected` event after the completion that names the line (before or after rows) clears it (prover case 12).
- **Taha's review (PR #1808, head b797f1e74):** no BLOCKER, HIGH or MED. LOW "the line-delete trigger can still deadlock with a completion, against its comment" **comment fixed, risk accepted**: the event's delivery foreign key takes a key-share lock on the delivery, so a completion holding the delivery while it waits on a line being deleted can deadlock; Postgres cancels one and it is retried. The trigger fires with the line already held, so it cannot take the delivery first; the case needs a direct delete of a picked line during its completion. LOW "a negative brand seq refuses a completion" **fixed**: the wrappers no longer refuse it; it reads as not confirmed, like any value that is not a plain number (prover case 6).

---

## 16. Behavior contract for B-1b (2026-11-11, `plan-contract`)

Read on `main` `167126d17` and live (read-only) on 2026-11-11, after B-1a's apply (ledger `20261111235530`). Section 14 holds; this section records how B-1b meets it against the live code, which mechanisms it chooses, and what the cold challenge (16.10) changed. Migration stamp `20270106110000`.

### 16.1 Facts (live, 2026-11-11)

- Preconditions met: B-1a live; `epa_registration_seed_run` has its row (seeded 2026-11-11 15:14 UTC); the capture foreign key is `ON UPDATE CASCADE` (`20270102160000`); `rup_sales_records` has 0 rows.
- Sales: no invoice posted since 2026-11-06 (0 in 30 days, 0 since the seed); 0 brand picks; 0 deliveries completed since B-1a; 11 order-linked lines on draft or unposted invoices. No sales before the switch-on (Mason, 2026-11-10). No brand can be picked from the app until B-2 ships the picker.
- BEFORE triggers on `invoice_items` fire by name; the new `trg_fill_invoice_line_zbrands` sorts after `trg_fill_invoice_line_vendor` and before `trg_guard_split_invoice_items`. AFTER: `trg_zz_capture_invoice_line_rup` (capture), `zz_cap_delivery_invoice_items`, `zz_cap_order_invoice_items` (billing caps).
- `_refuse_posted_invoice_child_write` lets a posted line's update through only when nothing but `cost_cents`, `return_credit_cogs_cents`, `tote_number` and `updated_at` changed. `_fill_invoice_line_epa` returns a posted line unchanged on update (it fills a blank number only on a draft or unposted invoice, or on a product change, which the posted guard refuses). So a posted cost or tote update stays allowed.
- A touch of a draft line that changes no price, cost, quantity or product passes the below-cost, price-required and both billing-cap triggers (each returns early when the quantity did not rise). `guard_terminal_order_invoice_items` takes `orders FOR UPDATE NOWAIT` and can raise `ORDER_LIFECYCLE_BUSY_RETRY` or `ORDER_INVOICE_TERMINAL`.
- The billing caps compare invoice quantities directly with `round(quantity_delivered, 4)`, so invoice and delivery quantities are already the same unit everywhere; B-1b adds no conversion. Across every active invoice of an order, billed never exceeds delivered.
- `invoice_items.quantity` is `numeric(12,4)`; `extended_cents` is bigint. `rup_sales_records.epa_registration` allows NULL: #1746's per-line record carries a blank number when the line has none, and Sales to check lists it `no_epa_number`.
- `generate_rup_sales_records` is called only by `_post_invoice_impl_20260714` and `_post_deleted_delivery_recovery_invoice_20260719`, both without an idempotency key; it refuses an invoice that is not posted, and upgrades to Yes at posting only when `posted_at = now()`. Admins and sales reps may also call it on an already-posted invoice (it then adds missing records only).
- `invoice_items` is readable by admins and by the invoice's creator and salesperson; app roles cannot write it directly.
- The deployed Sales to check screen (`EpaRegistrationSetup.tsx`) keys rows by `line_id` and maps `reason` through a fixed text table; the register screen (`Compliance.tsx`) lists records by their own id. No invoice, email, statement or PDF path selects `brand_lines` (`INVOICE_ITEM_COLUMNS` does not include it).
- `get_rup_sales_register` is `RETURNS TABLE`, admin only (`require_admin`), EXECUTE for `authenticated` and `service_role`.

### 16.2 What B-1b builds (one migration, plus the Sales to check screen's types and labels)

1. **The reader, `_invoice_line_brand_lines(invoice_id, order_item_id, product_id)`**, used to write the snapshot (fill trigger, re-copy, backfill), to detect staleness, and by posting to refuse a stale line a record (16.2.3).
   - **A delivery being completed** (named in `crx.brand_completing_delivery`, no `completed` event yet) is read as B-1a's rule will leave it: whether a line had a brand list comes from the current list, and a single pick above the delivered amount (when that amount fits 4 places) reads as the delivered amount. Lines drafted during the completion (plain, Bill Split, landlord split, backdated) hold the final brands.
   - **Covered lines.** None for a credit memo or a line with no `order_item_id`. An invoice with a `delivery_id` covers that delivery's lines for the order line; one without covers every delivery of the order line. Only deliveries with status `completed` and not deleted, and only delivery lines of the same product.
   - **State.** Per covered line: its current picks, and whether its `completed` event recorded a brand list. A line completed before B-1a has no event, so no list.
     - No covered line has a pick or a list: `NULL`.
     - Some had a list but none has a pick: `[]`.
     - Otherwise, one entry per current pick. Each covered line with no pick (a legacy trip included) adds one no-brand entry for its delivered amount.
   - **Order (total, so repeated reads are identical).** By covered line (completion time, delivery id, delivery line id). Within a line by lower brand name, then normalized number, then pick id.
   - **Entry fields.** `brand_key`, `brand_name`, `epa_registration`, `manufacturer`, `signal_word`, `quantity` (the pick's amount, or the line's delivered amount for a no-brand entry), `line_delivered` (`round(quantity_delivered, 4)` of its covered line), `typed`, `pick_id`, `delivery_id`, `delivery_item_id`, `completed_at`.
   - **`brand_key`.** `'b:' || lower(btrim(brand_name)) || '|' || coalesce(normalized number, '')` for a brand, `'n:'` for a no-brand entry. The tag keeps them apart whatever a typed name says.
2. **Fill trigger `trg_fill_invoice_line_zbrands`** (BEFORE INSERT OR UPDATE).
   - On an invoice that is not `draft` or `unposted`: an update keeps `OLD.brand_lines` and leaves the number alone; an insert gets NULL.
   - Otherwise `brand_lines` := the reader's result, and the number is set:
     - all entries share one `b:` key with a number: that number (two trips of one brand print the brand's number, which Q8 and Q9 mean);
     - `brand_lines` not NULL (including `[]`, a no-brand entry, a no-number brand or several brands), or newly NULL after holding brands: the product's own number;
     - NULL before and after: `trg_fill_invoice_line_epa`'s number, unchanged.
   - Any writer's value for `brand_lines`, `service_role`'s included, is overwritten.
3. **Re-copy at the end of the writer's transaction.** A constraint trigger on `delivery_brand_events` (AFTER INSERT, `DEFERRABLE INITIALLY DEFERRED`, for each row) runs `_invoice_brand_recopy(delivery_id)` at commit.
   - It therefore sees the final picks: after a correction supersedes and re-inserts them (its event is written first), and after a `line_removed` delete has cascaded.
   - `_invoice_brand_recopy`, per covering invoice in id order (draft or unposted, not deleted, not a credit memo), in its own sub-transaction:
     - skip a split-group invoice (one with a `split_invoice_provenance` row): it keeps the brands it was made with, which are final (16.2.1), and counts as skipped;
     - lock the invoice row `FOR SHARE NOWAIT`, re-checking the status on the row as it now is; another writer holding it makes this a caught error (the brand write never waits) and the draft keeps its brands until its next save;
     - skip it if it is no longer draft or unposted;
     - otherwise update its covered lines whose stored `brand_lines` differs from the reader, so the fill trigger recomputes them.
   - Any error in one invoice is caught and raised as a warning; that draft stays as it was (Q5). Busy order lock, terminal order, lock timeout and deadlock are all covered.
   - Several events in one transaction re-copy several times; the later ones find nothing different.
   - **Never a wrong record:** posting writes no brand record for a line whose stored `brand_lines` differs from the reader at that moment (a split draft corrected after it was made, or a draft the re-copy skipped). The line is listed `brand_lines_stale`. A NULL or `[]` line keeps #1746's per-line record, unless the picks now name brands (a split draft made with no pick, corrected afterwards): then no record under the product's number, and the line is listed `brand_lines_stale` (Sol r1).
4. **Allocation `_invoice_line_brand_allocation(line_id)`.**
   - **Input.** Reads only stored values: the line's `brand_lines`, its `quantity` and `extended_cents`, and the stored `brand_lines` and quantities of its payer group.
   - **Arithmetic.** `numeric` (no overflow), quantities as whole units of 0.0001, cents as whole cents. Floor division only; leftovers go to the largest remainders, ties to the earlier entry.
   - **Returns** `problem` (NULL or a reason) and the per-`brand_key` merged `quantity` and `cents`. A zero quantity, or a group billing zero, allocates nothing.
   - **Problems.** Q6: the line gets no record and is listed. Checked in this order:
     1. `brand_split_mismatch`: a covered delivery line with picks whose picks do not add up to its `line_delivered`. Checked per covered line, so errors on two trips cannot cancel out.
     2. `overlapping_invoices`: another active invoice line for the same order line covers an overlapping set of trips under a different coverage, for example a whole-order invoice and a delivery invoice both active.
     3. `payer_split_changed`: a payer-group member's stored `brand_lines` differs from this line's.
     4. `billed_above_delivered`: the group's billed total is above the covered delivered total.
   - **Payer group.** Every line with the same `order_item_id` and product on active invoices (not deleted, voided, cancelled or a credit memo) whose `delivery_id` is the same as this invoice's (both NULL for whole-order invoices), ordered by invoice id and then line id. The rule is the same for every member, split or not.
   - **Group of one.** Entries in order, each up to its amount, until the line quantity is used.
   - **Group of several.**
     - Group brand shares: billed total × entry ÷ delivered total.
     - Payers in order: each takes its row from the remaining brand shares and remaining total by the same rule; the last takes the rest.
     - Every payer row adds up to its line quantity and every brand column to its share, whatever order the payers post in.
   - **Cents per line.** Each entry's share of `extended_cents` by its allocated quantity, so a line's entries add up to its cents. Entries sharing a `brand_key` merge after allocation.
5. **Brand captures.**
   - **Table.** Private `invoice_line_brand_rup_captures` (14.4), plus a `basis` column: the first entry's display name, snapshot number and signal word, and the product id and product number.
   - **Re-issued `_capture_invoice_line_rup`.** After its seeded check, when the line has non-empty `brand_lines` or holds brand captures, it first takes the shared registration lock, then syncs the brand rows:
     - a line with `brand_lines` NULL or `[]`, or no product: every brand row deleted;
     - otherwise:
       - rows for keys no longer present are deleted;
       - a new key is captured;
       - a key whose basis changed is captured again;
       - a key with an unchanged basis is kept.
     - A Yes stays Yes on the same product.
     - It then runs #1746's per-line capture, unchanged.
   - **Facts.** `_invoice_brand_rup_facts(product, brand number, brand signal word)` as 14.4. The captured number is the brand's, else the product's, else none. Merged entries take the first entry's display name and facts, by the total order above.
6. **Records.**
   - **Columns.** `rup_sales_records` gains `brand_name` and `brand_key`.
   - **Indexes.** A unique active index on `(invoice_item_id, COALESCE(brand_key, ''))` replaces the per-line one. `_guard_rup_sales_record_line` also refuses a line holding a per-line record and a brand record at once.
   - **`generate_rup_sales_records`** (md5-pinned) branches per line:
     - `brand_lines` NULL or `[]`: #1746's per-line path, unchanged.
     - Non-empty: the posting-time capture of missing brand keys, and the Yes-at-posting upgrade, per brand (same `posted_at = now()` rule). Then the allocation. With a problem, no record. Otherwise one record per `brand_key` that is captured Yes, has a positive allocated quantity and has no active record. Each record carries:
       - the allocated quantity and cents, `brand_name` and `brand_key`;
       - the captured number and signal word;
       - the line's unit and unit price.
   - **Blank numbers.** A record has no number only where #1746's per-line record would: neither the brand nor the product has one. It is then listed `no_epa_number`.
7. **Lists.**
   - **Scope.** `get_epa_sales_to_check()` and `_epa_registration_unrecorded_posted_lines` are re-issued. Posted lines only, as #1746.
   - **Row shape.** One row per line, `brand_key` and reason: #1746's fields plus `brand_key`, `brand_name` and `allocated_quantity`.
   - **Line-level reasons.**
     - `brand_split_mismatch`, `overlapping_invoices`, `payer_split_changed`, `billed_above_delivered`;
     - `brand_lines_stale`: stored differs from the reader, NULL and `[]` included;
     - `brand_not_recorded`: `[]` or any `n:` entry;
     - #1746's own reasons for NULL and `[]` lines.
   - **Brand-level reasons.** `restricted_use_to_record`, `not_reviewed`, `now_restricted_use`, `not_captured`, `no_epa_number`, and `brand_no_epa_number` (a `b:` brand with no number).
   - **Which brands are listed.** Only brands with a positive allocated quantity. A record for A never counts for B.
   - **`payer_split_changed` after posting.** Also listed when a posted line's active brand records no longer match its allocation computed now (a sibling changed after it posted).
   - **Screens.**
     - `get_rup_sales_register` is dropped and re-created adding `brand_name` at the end, with the same grants and admin gate.
     - `src/types` `RUPSalesRecord` and `SaleToCheck` gain the new fields.
     - `EpaRegistrationSetup.tsx` gains text for each new reason and keys rows by line, brand and reason.
8. **From the B-1a review (Sol round 4 MED).** `get_typed_brands_for_review` leaves out picks on voided or cancelled deliveries, and `review_typed_brand` refuses them with the `BRAND_PICK_NOT_FOUND` it already gives a deleted delivery. Both keep their signature and grants.
9. **Escaping.** B-1b's only new text is on the admin Sales to check screen, which React renders as text. No invoice, email or PDF path prints `brand_lines` (checked: `INVOICE_ITEM_COLUMNS`, `supabase/functions`). B-3 prints brand fields through `escapeHtml` in the receipt email and any HTML, and as plain jsPDF text on PDFs.
10. **Backfill at apply.** `_invoice_brand_recopy` over every draft or unposted invoice with order-linked lines, the same caught sub-transactions. The migration notes how many it skipped. The 11 live lines and their orders' states are read before the apply.
11. **Preflight.** It refuses unless:
    - B-1a's tables exist;
    - `_epa_registrations_seeded()` is true;
    - every re-issued body matches its md5 pin.

    It locks `invoices`, `invoice_items` and `rup_sales_records` in #1746's order.

### 16.3 Rules that always hold

- No amount, quantity, price, cost or stock changes anywhere. Only `brand_lines` changes, plus `epa_registration` on draft or unposted lines.
- A posted, overdue or paid line's `brand_lines` and number never change. A written `brand_lines` is always overwritten by the trigger.
- Brand completeness (no pick, a split that does not add up, no number, a typed brand) never refuses posting, saving, completion or correction (Q5). Existing refusals stay: authorization, stale saves, posted invoices on correction, billing caps.
- A split is never guessed: a line with a Q6 problem gets no record. A record never claims more than its allocated share.
- A line's active records are one per-line record or per-brand records, never both, and at most one per brand key.
- Posting records from the stored snapshot the office reviewed; a later change shows as `brand_lines_stale`, never as a different record.

### 16.4 Who may act

- **Writers.** No new callable writer. Writes happen inside existing writers (invoice saves, completion, brand RPCs) through triggers owned by `postgres`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`. Every new helper has EXECUTE revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`.
- **Reads.** `get_epa_sales_to_check()` and `get_rup_sales_register` stay admin only.
- **Who sees `brand_lines`.** Whoever may already read the invoice line (admins, the invoice's creator and salesperson). The brand on the invoice is what the customer is billed for, so this is intended.

### 16.5 Existing rows

- Live has 0 records and 0 picks.
- **Draft lines.** Draft or unposted lines are backfilled once at apply (`NULL`, or `[]` where a delivery completed after B-1a had a list).
- **Posted lines.** They keep `brand_lines` NULL and #1746's behaviour.
- **Older deliveries.** A delivery completed before B-1a gives `NULL` until an admin corrects its brands (then it has picks like any other), and adds a no-brand entry when an order-level invoice also covers a newer picked trip.
- **The deployed app** sends nothing new.
- **One reload.** Adding the column changes each draft's posting hash once, so a screen loaded before the apply must reload before posting (`INVOICE_CHANGED_SINCE_LOADED`, as in `20261027060000`).

### 16.6 Timing

- **Correction, edit, completion or line delete, then posting.** The re-copy runs at the writer's commit, holding the delivery (and the order where the writer holds it), then each draft invoice `FOR SHARE`. Posting holds its invoice `FOR UPDATE`, then the shared registration lock, and never waits on a delivery or a brand event.
  - **Posting first:** the re-copy does not wait (`NOWAIT`): it skips the invoice, which posts with the brands it had. If the brands changed, it is listed `brand_lines_stale`.
  - **Re-copy first:** posting waits and then records the re-copied snapshot. `post_invoice`'s version check refuses a screen loaded before the re-copy (`INVOICE_CHANGED_SINCE_LOADED`), as for any change.
- **A registration edit (exclusive) queued between the two.** Every holder of the registration lock takes it shared. PostgreSQL's deadlock check reorders soft waits, so no cycle forms. A re-copy that still fails is caught and leaves the draft; a posting is never the victim of a brand path.
- **No new idempotent RPC.** Posting calls the generator with no key, so an unpost and repost writes fresh records.

### 16.7 Proof cases (local real-schema prover, test data only)

- **One brand.** When a delivery of one brand completes with an automatic draft invoice, then the line has one entry and the brand's number. Posting writes one brand record under that number, brand name and signal word.
- **Two brands, one line.**
  - When a line delivered as A 60 and B 40 is posted at 100 and both are restricted use, then two records of 60 and 40 whose cents add up to the line.
  - When only A is restricted use, then one record of 60 with A's cents.
  - When it is billed at 60, then A 60 and no B record, and B is not listed as unrecorded.
- **Bill Split.**
  - Billed 50 and 50: each payer records A 30 and B 20.
  - Billed 30 and 30: A 36 and B 24 in total, in either posting order.
  - A sibling's stored brands differ: both lines are listed `payer_split_changed` with no records.
- **Problems.**
  - Picks add up to 90 of 100 delivered: no record, and the line is listed `brand_split_mismatch`.
  - Two trips of 50 with picks of 60 and 40: `brand_split_mismatch`, not cancelled out.
  - A 5-place delivered amount uses the 4-place value, as correction does.
- **Q8 cases.**
  - A line with `[]`, or a no-number brand under a numbered product: one record under the product's number, listed.
  - A no-number brand under a numberless product: a record with no number, listed `no_epa_number` (as #1746).
  - A typed brand named `~none` keeps its own key.
- **Several trips.** When two trips of the same brand feed a whole-order line, then one record. Trips A 30, B 40, A 30 billed at 60 record A 30 and B 30. Entries tied on completion time read in the same order every time.
- **Completions that draft split invoices (H1).** A real Bill Split completion (one pick 3 loaded / 2 delivered, plus a brand-listed line with no pick): every payer line holds the trimmed entry and `[]`, the stored claim equals `_split_invoice_content_claim`, posting writes each payer's records, nothing is listed stale. The same for a real landlord auto-split and a backdated plain completion. A split draft corrected after it was made keeps its brands and claim, posts with no record and is listed `brand_lines_stale`.
- **Re-copy.**
  - A correction (event before the picks), a line delete and a later trip re-copy open drafts with the final picks.
  - A posted invoice is not touched; a posted line whose picks changed is listed `brand_lines_stale`.
  - The order row locked by another session: the brand write still commits and the draft stays as it was.
- **Race, both orders.** A correction and a posting of the same draft, run in two sessions with a registration edit queued, in both orders: neither errors, nothing deadlocks, and the outcome matches 16.6.
- **Saving and posted lines.**
  - `save_invoice` re-saves an order-linked branded draft with a price change: `brand_lines` and the brand captures survive the id restore.
  - A brand change re-captures only the changed key.
  - Posted cost and tote updates still pass.
- **Overwrites and records.**
  - `service_role` writes `brand_lines`: the trigger overwrites it.
  - A per-line record exists and a brand record is inserted on that line (as postgres): refused.
  - Unpost and repost: fresh active records.
- **Lists and grants.**
  - A typed pick on a voided delivery is not on the review list, and `review_typed_brand` refuses it.
  - Grants read from the catalog: no app role reads the capture table or runs a helper; every new `SECURITY DEFINER` function pins `search_path`; the register keeps its grants and returns `brand_name`.
- **Money.** The same flow run with and without brands leaves no money, quantity or invoice total different.
- **Apply.** Before the seed, the preflight refuses. A draft under a terminal order does not stop the backfill.

### 16.8 Delivery and order

- **Ships alone.** B-1b ships as one PR: the migration, the two `src/types` additions and the Sales to check labels. It works with the deployed app; the register's extra column is ignored until B-3.
- **Order with B-2 and B-3.** Until B-2's picker, no picks exist, so entries never appear; only `[]` lines appear, which post like #1746 lines and are listed. B-2's picker must not go live before B-3's invoice warnings ("Post anyway", section 6) or with them.
- **Recovery.** A forward repair in its own reviewed migration:
  - drops the fill trigger and the re-copy trigger;
  - restores the re-issued bodies from their md5-pinned originals;
  - keeps the new columns, the capture table and its rows, and the two-column active index. The old generator never writes brand records, and the index still allows one per-line record per line. The per-line index comes back only if no line holds more than one active record.

### 16.9 Open business decisions

None. Q5, Q6, Q8 and Q9 and the no-sales rule (Mason, 2026-11-10) settle every behaviour above. Leaving picks on cancelled deliveries off the review list follows the same reasoning as voided ones.

### 16.10 Cold challenge (Astra, gpt-6-astra high, 2026-11-11) and what changed

40 findings (4 BLOCKER). Each is fixed in 16.1-16.8 or answered with evidence:

- **Fixed in the design.**
  - **1 BLOCKER (copy saw the old picks).** The re-copy is deferred to commit (16.2.3).
  - **2 BLOCKER (generator read current picks).** The generator reads only the stored snapshot (16.2.1, 16.2.4).
  - **3 BLOCKER (blank number vs never block).** #1746's per-line record already allows a blank number and lists it; brand records follow the same rule (16.2.6). The old "never blank" sentence was wrong.
  - **4 BLOCKER (recovery).** It keeps the two-column index and the columns (16.8).
  - **Snapshot shape (5, 6).** `NULL`, `[]` and entries are defined, legacy trips included (16.2.1, 16.5).
  - **Line number (7).** One brand key gives the brand's number (16.2.2).
  - **Key collision (8).** Tagged keys.
  - **Re-capture (9-11).** A `basis` column decides re-capture, and the first entry's facts win.
  - **Allocation (12-15).** A total order; per-trip validation; the 4-place rule; positive shares only.
  - **Payer groups (16-18).** The group rule is the same for every member; `overlapping_invoices` and `payer_split_changed` cover the rest.
  - **Locks and timing (19-21).** The re-copy's lock and status re-read, the registration lock taken first, and the deferred trigger.
  - **Screens and wording (25, 34, 38).** The response shape and the screen's text and keys; the Q5 wording narrowed.
- **Answered with evidence.**
  - **22.** Changes without a brand event are listed stale; drafts heal at their next save.
  - **23.** Q5 and Q6 settle it.
  - **24.** No picks exist before B-2, and the B-2/B-3 order is in 16.8.
  - **26.** Live census: 0 posted since the seed.
  - **27.** Sub-transactions, with a terminal-order case.
  - **28, 31, 32.** Live trigger and caller bodies (16.1).
  - **29.** Lock order.
  - **30.** Invoice readers (16.4).
  - **33.** B-1a's live correction rule, unchanged here.
  - **35.** `numeric`.
  - **36.** The billing caps already equate the units.
  - **37.** The cases in 16.7.
  - **39.** A positive-quantity product change is refused; a zero line allocates nothing.
- **40 (suggestion).** Adopted in substance.
