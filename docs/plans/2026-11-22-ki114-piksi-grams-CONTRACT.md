# KI-114 / #1958: Piksi Dust is stocked, sold and rated in grams (behavior contract)

Read on `origin/staging` `a77855293`; live facts read-only on 2026-11-22 (Supabase `rhyzpcqhnizqbxphqdkr`, SELECT only).

## Decision

**Mason, in chat, 2026-11-22:** "piksi dust is in grams we billed like mg but it is grams and all mg need changed to gram price is same as grams etc". This replaces the 2026-11-13 reading recorded in `20270121100000_ki137_…` ("MG means milligrams, the quantity is right"). The quantities were right; the unit was not. It also settles the 2026-11-21 label answer (Piksi Dust Plus is 18 g per acre).

## Facts (live, 2026-11-22)

- Three products carry `MG`, all Piksi, all `product_form = 'dry'`: Plus 1800G Jar `36732b8d…` (active, parent `afdae5f9…`), Infurrow 750 G Jar `c22ce37d…` (active, parent `c9933638…`), and an old inactive Plus `9a1716a2…` (no parent, container 1800). Each has `inventory_unit = unit_size = rate_unit = container_unit = 'MG'`, `pricing_version = 1`, no label-rate cap.
- The numbers are grams: container sizes 1800 and 750; the stored unit price × the rate equals the stored per-acre price (Plus: unit price × 18); the approved rates in `product_rates` already say `g` (Plus 18 g, Infurrow 6 g). Most quantities are whole jars; some stock and receipts are half jars (58,500 = 32.5 × 1800), which is fine: the decision, not the jar count, is the authority.
- `unit_conversions`: exactly one `MG` row (0.00003527396 oz) and one `g` row (0.03527396 oz), both `dry`. So, as stored, switching Piksi onto its approved 18 g rate would price and deduct 18,000 "MG" units per acre (1000× too much). Today nothing quotes Piksi from a rate: both parents are `rate_source = 'legacy'` (version 1) and the cut-over refuses them by ID.
- Rows carrying `MG` for these products: products 3 (4 columns each); `product_parents.rate_unit` 2; `inventory.unit_size` 2; `order_items.unit_size` 4 (3 orders); `delivery_items.unit_size` 4 (5 non-quick deliveries in all); `purchase_order_items.unit_size` 3 (2 POs; the open Plus line 9000/0 has no snapshot, the 2 received lines have snapshot `MG`, factor 1); `receiving_records.unit_size` 3. Four more Plus delivery lines (2 `completed`, 2 `cancelled`) still say `Dry oz`, left by KI-137 as history; their quantities are grams too.
- Stock movements (`inventory_transactions`, 13 Piksi rows) carry no unit column: every reader shows them in the product's unit, so they read as grams after the change, which is correct.
- No quote line, saved quote version, invoice line, delivery remainder, job line, blend recipe line, blend ticket line, return line or active hold uses these products. No cycle count is in progress. The rate lock is ON. Each product has one open `manual_override` cost basis.
- `pricing_workbook_export_rows` holds frozen `MG` snapshots from past exports (left as the record of what those exports said).
- Table sizes: 606 products, 297 order lines, 406 delivery lines; the postflight's full-table comparison is milliseconds.

## Outcome

One data-only migration (`20270221100000_piksi_mg_to_grams.sql`) makes every Piksi unit label say `g`, with **no quantity, price, cost, rate, margin, per-acre price or cost-basis cents changed**.

| What | From | To |
|---|---|---|
| 3 products: `inventory_unit`, `unit_size`, `rate_unit`, `container_unit` | `MG` | `g` (`pricing_version` 1 → 2, as the pricing guard does for any unit edit, so an open pricing preview must refresh) |
| 2 parents: `rate_unit` | `MG` | `g` (`parent_version` 1 → 2) |
| 2 stock rows (relabelled by the product's own trigger), 4 order lines, 4 delivery lines, 3 PO lines (+2 snapshots), 3 receiving records | `MG` | `g` |
| 4 history delivery lines on Plus | `Dry oz` | `g` (Mason: "all … changed to gram"; the issued number was grams) |
| Cost basis per product | old open row closes | new open row, same cents, `migration_baseline`, starting the instant the old one ended (no gap, no overlap) |

Not changed: `unit_conversions`, `product_rates` (already `g`), stock movements, `pricing_workbook_export_rows`, suggested-rate text, and the cut-over hold list (Piksi stays on legacy pricing; releasing it is a later, separate step).

Side effect, declared: the pack-change trigger `trigger_return_net_weight_to_draft` steps each product's net-weight counters (`product_size_net_weight_state.net_weight_version` and `pack_generation` +1; the old inactive Plus gains its state row). Live has no Piksi net-weight value and no weight event, so nothing returns to draft; the migration refuses if a value exists (KI-137 precedent) and its postflight refuses if a value or event appears.

Spelling is `g` exactly: `validate_product_units` matches `unit_conversions.unit` case-sensitively.

## Authority and enforcement

Only the migration (database owner) changes these rows; no screen or RPC changes. Every row is pinned by id, links (order, delivery, order line, PO, PO line), quantities, status, snapshot and factor; any drift refuses with nothing changed. The migration bypasses, for its own statement only, each checked on before and after:

- the stock-unit locks `a1_product_unit_keeps_open_lines` and `a2_product_unit_keeps_history` (they stop a REAL unit change from reinterpreting old quantities; here the meaning is unchanged and every line moves with the product in the same transaction);
- the product setup and parent-values guards, as KI-137 and RT-2a did;
- the rate lock, by a `product_rate_correction_passes` row for exactly these three products in this transaction, each removed by its key before commit; the lock itself must be ON before and after (refuse otherwise);
- the closed-PO-line guard and the PO cost-snapshot trigger, for the one PO-line UPDATE (as KI-137's Treaty Extra fix); the snapshot is set explicitly (2 rows `MG` → `g`, the open line stays empty);
- the delivery-line parent lock, via `app.admin_override` for the one delivery-line UPDATE, restored to its prior value after.

The cost-basis unit guard closes each open basis on the stock-unit change; the migration opens a new one at the same cents. The supplier-cost-basis flag must be off for these products (else refuse).

## State, timing, rollout

- Locks: every table it writes or reads for pins, `SHARE ROW EXCLUSIVE`, `lock_timeout` 10s; READ COMMITTED.
- Refuses if a cycle count is in progress, the rate lock is off, the MG/g factors moved, any pinned row or link moved, any other row for these products exists in a corrected table, or any quote, invoice, job, blend, return, hold or remainder line now exists for them.
- After the change: a deployed screen that saves a new Piksi order or PO line with `MG` is refused (`LINE_UNIT_NOT_STOCK_UNIT`); lines without a unit take `g`; a quick-delivery line takes the product's unit (`g`) automatically. In every case the number typed is grams, which is what it always meant, so no path misreads a quantity.
- Postflight proves, table by table and null-safe: each changed row changed only in the listed columns, to the listed values, with exact version steps; the three Piksi orders, re-saved by the order-total trigger, may move only `updated_at` and `row_version` (any total change refuses); every other row of products, groups, stock, orders, order lines, deliveries, delivery lines, POs, PO lines, receipts, stock movements and cost bases is byte-identical; per product exactly one open basis (new, same cents and type, contiguous); all switched-off triggers are on; no correction pass left; the rate lock is on; no row added.

## Undo

`scripts/smoke/piksi-grams-reverse.sql` puts every label back (g → MG, and the 4 history lines → `Dry oz`) under pins on the forward state. History moves forward, never back: versions step again (3), and the open cost basis closes and a new one opens at the same cents. The 4 `Dry oz` lines never matched their product's unit, so the reverse turns off the delivery line-unit and order-line-match guards for that one statement and checks them on after. It works only before new gram-era activity (a receipt, a new line, a rate cut-over); after that it refuses, and any change back needs a separately reviewed forward correction. To use it live, copy it into a new migration through the gates.

## Proof cases (real migrated schema, Docker; `scripts/smoke/prove-piksi-grams-real-schema.mjs`)

1. **Before (B1):** with the approved 18 g rate and stock in MG, `product_price_per_acre` prices 1000× today's per-acre price (the hazard the cut-over would hit).
2. **Drift (P1/P2):** a moved pinned line, a lost PO snapshot, an unlisted receipt, an open count, or the rate lock off each refuses with nothing changed.
3. **Apply (M1):** every pinned row says `g`; no number moved; `pricing_version` 1 → 2, parents v2; one open cost basis per product at the old cents, contiguous; triggers on; no pass rows; rate lock on; control product byte-identical.
4. **Lock holds (M3):** a signed-in admin writing the Piksi rate directly afterwards is still refused (no correction pass or rights leak out of the migration).
5. **After (A1–A3):** 18 g on g stock prices exactly today's per-acre price; receiving the open 9000 PO line adds 9000 to stock with a `g` receipt; a new `MG` order line is refused; a blank unit becomes `g`.
6. **Second run (M2)** refuses.
7. **Reverse (R1)** restores every label with no number moved, versions forward, every guard on; the forward then refuses.

## Astra cold challenge (gpt-6.2-astra, high, round 1: 24 findings)

| # | Finding | Disposition |
|---|---|---|
| 1 | pricing_version contract/SQL disagree | Fixed: exactly +1, pinned at 1, proven. |
| 2 | Trigger firing matrix unproven | Fixed by evidence: live `pg_get_triggerdef` read (resnapshot fires only on product change; receipt trigger is DELETE-only); the prover runs every live trigger on the real schema. |
| 3 | Parent totals / trigger writes outside postflight | Fixed: orders, deliveries, POs and stock movements added to the byte-identical comparison. |
| 4 | Rate pass cleanup too broad; lock not asserted | Fixed: lock asserted on before/after; exactly 3 keys removed. |
| 5 | App permission boundary | Fixed: M3 proves an app admin writing the rate directly is still refused; admin_override restored to its prior value. |
| 6 | Reviewed facts accepted after drift | Fixed: versions, container size, label cap, links pinned exactly. |
| 7 | PO snapshot pins could vanish | Fixed: snapshot and factor pinned null-safe per line; proven by P1. |
| 8 | Unlisted test ignored table | Fixed: matched by kind. |
| 9 | Postflight too permissive / not null-safe | Fixed: null-safe, per-table, per-product basis check. |
| 10 | Whole-jar evidence contradicted | Fixed in Facts (half jars noted; decision is the authority). |
| 11 | Dry oz history lines need a decision | Settled by Mason's "all … changed to gram": the issued quantities were grams. Recorded here. |
| 12 | Conversion facts unpinned | Fixed: exactly one MG and one g row at the reviewed factors, table locked. |
| 13 | Stale MG submission not always refused | Declined: every path stores the typed number with `g` or refuses; the number always meant grams, so none misreads a quantity. |
| 14 | Stock movements / counts | Answered: movements carry no unit (read as grams after, correct); locked and compared byte-identical; no open count. |
| 15 | Receiving / return round trips | Partly: A2 proves a receipt after the change. No return or receipt-reversal path depends on the label beyond the unit match the prover runs; no Piksi return exists. Named as residual risk. |
| 16 | Pricing proof is scalar only | Declined beyond B1/A1: Piksi stays legacy-priced (stored per-acre prices unchanged, proven); the cut-over is a separate step with its own proof. |
| 17 | Readers of the label | Answered: screens show the stored unit string; frozen workbook exports intentionally keep `MG`. |
| 18 | Cost basis continuity | Fixed: new basis starts at the old one's `effective_to`; proven. |
| 19 | Lock timeout is not a runtime bound | Answered: tables are a few hundred rows; runtime is milliseconds. |
| 20 | Reverse cannot restore Dry oz | Fixed: reverse disables the two delivery line guards for that one statement, checks them on after; proven by R1. |
| 21 | Define what undo restores | Fixed in Undo: labels exact; versions and basis history move forward. |
| 22 | Rollback window | Fixed in Undo: reverse refuses after new gram-era activity. |
| 23 | Reverse and prover not supplied | Fixed: both written and run. |
| 24 | Smaller design | Partly taken: the product's trigger relabels stock (asserted, no fallback). Kept the closed-PO and snapshot guard bypass (the snapshot trigger would wipe the received lines' supplier snapshot). |

## Later review rounds

- **Luna round 1 (2 HIGH, both on the reverse script):** (1) it did not refuse after new gram-era use: fixed, it now locks and refuses on any Piksi quote, saved quote version, invoice, remainder, job, blend, return, active hold or jar net weight; (2) it pinned lines by id only: fixed, each line is pinned by product, order/delivery/PO links and quantity as the forward migration pinned them.
- **Luna round 2 (1 HIGH, 1 MED):** (HIGH) the reverse accepted a gram-era stock movement that netted to zero: fixed, it refuses any Piksi movement recorded from an hour before the forward's instant on (proven in R1); (MED) the net-weight trigger was not checked: fixed, it must be on before, and the postflight proves each product's counters stepped exactly once.
- **Luna round 3 (1 HIGH, 1 MED, 1 LOW):** (HIGH) a backdated movement could slip past the time check: fixed, the reverse now pins the exact set of Piksi stock movements by id (13 live rows; the prover pins its own empty set), so any new movement refuses whatever its timestamp; (MED) the reverse now checks the net-weight trigger is on and proves the counters stepped once, like the forward; (LOW) the old inactive Plus keeps its free-text suggested rate `18 MG`: deferred as a follow-up (display text only, inactive product, never used in a calculation).
- **Sol round 1 (1 BLOCKER, 2 HIGH, 3 MED, 3 LOW):** (BLOCKER) not registered as a one-shot data migration: fixed, listed in `supabase/baselines/one-shot-migrations.json`, so schema rebuilds and replays skip it; (HIGH) the reverse ignored a parent's status (a cancelled delivery reopened in the gram era): fixed, each order, delivery and PO line is pinned with its parent's status as the forward left it, proven in R1; (HIGH) forward and reverse pinned stock movements differently: fixed, both pin the same reviewed set (13 live movements by id), so any movement before apply refuses the forward rather than stranding the reverse; (MED) cost-basis flag tables unlocked: fixed, `app_settings` and `product_cost_basis_rollout` are locked in both directions; (MED) supplier links with their own unit label: fixed, both directions lock `product_supplier_links` and refuse if a Piksi link carries a `conversion_unit` (live: 2 links, none labelled); (MED) the fixture's order money is zero: refuted, the migration's own postflight compares every order and order-line column byte-for-byte (only `updated_at`/`row_version` may move) on live's real totals, so any revenue, cost or margin change refuses at apply; (LOW) M3 accepted any error: fixed, the database owner writing a Piksi rate now must hit `PRODUCT_RATES_LOCKED`; (LOW) prices compared as JavaScript numbers: fixed, compared as PostgreSQL numerics; (LOW) inactive Plus suggested-rate text: deferred (as Luna r3).
- **Luna round 5 (1 MED, 1 LOW):** (MED) the reverse did not re-check that the pinned deliveries are still not quick deliveries: fixed; (LOW) inactive Plus suggested-rate text: deferred (as above).
- **Sol round 2 (2 HIGH, 4 MED, 1 LOW):** (HIGH 1) a quote screen left open across the apply can save the old `18 MG` against gram stock (1000× under): the full fix is a pricing-version check on quote save, which is Taha's code until 12-15; sent to Mason as a decision (accept with mitigation: apply when no quote is open and sweep read-only afterwards for any Piksi quote or field-app line saved in `MG`; or park). (HIGH 2) quote templates: fixed, both directions lock `quote_templates` and refuse if one names a Piksi product (live: no templates). (MED) deadlock with a live receipt: fixed, PO tables are locked before stock, the order receiving uses, so the migration waits behind a receipt. (MED) a zero-variance gram-era count passed the reverse: fixed, both directions pin the same reviewed set of Piksi cycle-count lines (17 live, by id). (MED) the reverse did not check its own version step: fixed, products and groups must reach version 3. (MED) a field-app invoice open across the apply is refused on save (`FIELD_APP_UNIT_UNCONVERTIBLE`): accepted, it fails safe and a reload fixes it. (LOW) inactive Plus suggested-rate text: deferred.
- **Security review (Opus):** the reverse gained the rate-lock, cost-basis-flag, conversion and guard-state refusals and a byte-for-byte postflight; real prices were removed from the prover and this contract (the prover seeds made-up prices).
- **Migration drift review:** 0 BLOCKER/HIGH. M1 net-weight side effect: declared above, refusal and postflight added, proven by P2. M2 migration record added. M3 live ordering: checked by the apply script at apply time. L1 (no rate or group event row; KI-137 precedent) accepted: `product_change_history` records the product changes. L2 (safe self-refusals) noted.

## Open business decisions

None for this change. Follow-up (KI-114, #1958): Infurrow's approved rate is 6 g per acre while its suggested-rate text says "1.5 gram per G"; which is right stays open, and this change leaves that rate untouched (6 stays 6, only its label becomes `g`).
