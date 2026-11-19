# RT-4b rate writers: behavior contract

Status: SETTLED 2026-11-18, after one Astra cold challenge (gpt-6-astra high, 49 findings; settlement below). Facts read at `origin/staging` `b7b0d9c66` and live read-only on 2026-11-18. RT-4a contract: `2026-11-17-product-RT4-cutover-CONTRACT.md` (its scope note names RT-4b). Grand plan: `2026-10-29-product-GRAND-PLAN.md` › RT-4 ("direct app writes are revoked (Mason-gated); every writer moves to the rate RPC; the field app's invented `'oz'` is removed"; done when "A direct column write fails" and "Every writer listed in the re-audit is proven").

## 1. Outcome and authority

**Business result.** A product's per-acre rate (`products.rate_per_acre`, `rate_unit`, `suggested_rate`) can change only through a database rate function that checks the admin, the lock and the expected values, and logs the change. The browser cannot write those three columns directly. Nothing a customer sees changes.

**Scope of the promise.** The three stored columns, for the API roles (`PUBLIC`, `anon`, `authenticated`, `service_role`, `metabase_ro`). A seed/each product's rate unit is not a rate choice: `validate_product_units` sets it to the stock unit on every write, as today. A change of form or stock unit that moves a rate's meaning stays governed by the rate lock (`guard_product_rate_lock` `v_basis_changed`, refused while locked) and, for stock units with history, by #1952. Migrations and the database owner are outside the app boundary.

**Re-audit of every rate writer (2026-11-18).**

| Writer | Path | After RT-4b |
|---|---|---|
| Product page, ungrouped product (`ProductDetail.tsx:618`) | **direct `UPDATE products`** (column grant to `authenticated`, `20260718190000:370-387`) | rate boxes read-only; rates change through `correct_product_rates` (lock on, "Correct rates") or the setup workbook Rates tab `set_product_rates` (lock off). The direct save never carries rate keys. |
| Product page, grouped size | direct update, rate keys already stripped (`PARENT_OWNED_FIELDS`) | unchanged |
| Products list inline edit (`Products.tsx:826`) | direct, `product_name`/`category` only | unchanged |
| Label data quality (`LabelDataQuality.tsx:530/591/822`) | direct, signal word / EPA only | unchanged |
| Setup workbook Rates tab (ungrouped products, `productSetupWorkbook.ts:298`); bulk import (`apply_product_setup` inserts without rates, then `set_product_rates`) | definer RPCs | unchanged |
| Correct rates | `correct_product_rates` (definer, pass) | unchanged |
| Parent rates / correct parent rates | `set_parent_rates` / `correct_parent_rates` → `_apply_parent_rates` | unchanged |
| New product, add a size, move a size, approve parent groups | `create_product_with_parent` (refuses rate keys), `add_product_size`, `move_product_size`, `approve_product_parent_groups` (definer) | unchanged |
| Price workbook apply, cost-basis apply, pricing approval | `apply_product_pricing_change_set` via `approve_pricing_change_set` / `apply_product_cost_basis_change_set` (definer; staged rate keys refused by `refuse_price_workbook_rate_change`; rewrites current trimmed values only) | unchanged; the refusal message now names the rate tools. Live: 0 untrimmed rate units or text. |
| Approved-rate switch | `commit_parent_rate_cutover` (RT-4a) | unchanged |
| `validate_product_units` trigger | sets a seed/each rate unit to its stock unit inside any write | unchanged (trigger-set columns need no column privilege) |
| Edge functions, scripts | none write rates (search of `supabase/functions/`, `scripts/`) | — |

Every writer except one is already a definer RPC owned by `postgres` behind the rate lock and RT-4a's freeze (live 2026-11-18: all `prosecdef`, owner `postgres`). RT-4b closes the one direct path.

**Smallest change.**
- One migration `20270126100000_product_rate_direct_writes_revoked.sql`:
  - `REVOKE INSERT (rate_per_acre, rate_unit, suggested_rate), UPDATE (…) ON public.products FROM PUBLIC, anon, authenticated, service_role, metabase_ro` (column level; table-level INSERT/UPDATE was already revoked from `authenticated` in `20260718190000:354`).
  - Re-emit `refuse_price_workbook_rate_change` with a message naming the rate tools (it said "change them on the product page").
  - `REVOKE ALL … FROM metabase_ro` on RT-4a's two RPCs (#1958 tidy-up; live default function ACL never grants `metabase_ro`, so no behavior change).
  - Postflight on effective privileges (`has_column_privilege` / `has_function_privilege`, so inherited grants count): no API role can write the three columns; every other column privilege an API role had is still there; the rate-writing helpers (`_write_product_rates`, `_apply_parent_rates`, `_copy_parent_to_size`, `apply_product_pricing_change_set`) are not executable by any API role (live: none are); RT-4a's RPC grants are as intended.
- `ProductDetail.tsx`: the direct save always drops rate keys; rate boxes are read-only; "Correct rates" stays as today (lock on, ungrouped); with the lock off, the panel says to use the Setup Workbook's Rates tab. `ProductRateCorrectionModal.tsx`: its `PRODUCT_RATES_NOT_LOCKED` toast says the same (`correct_product_rates` still says "change them on the product page"; re-emitting that large function for a race-only message is not worth it).
- `FieldAppChemicalEntry.tsx` `selectProduct`: a product line's rate unit falls back to the stock unit, then blank, never an invented `'oz'`; `unit` and `price_unit` fall back to blank. Live: 0 products have a blank stock unit, so no live line changes. Manual and custom lines keep their `'oz'` starting choice (the user picks the unit; not a product rate). Saved-line reload (`FieldApplicationInvoice.tsx:1397`) is a saved copy: unchanged.
- RT-4a leftovers (#1958): seed saved lines in the RT-4a prover (W9); re-run the RT-3 prover: if it passes, #1935 fixed the ki137 refusal and the #1958 box is ticked; if it fails, fix its later-migration rule here. Outcome: it still refused on ki137; both ki137 and this migration are now listed as reviewed later files.

**Files expected.** The migration, `docs/reference/migrations.d/…md`, `docs/changelog.d/2026-11-18-rt4b-rate-writers.md`, `src/pages/ProductDetail.tsx` (+ test), `src/components/products/ProductRateCorrectionModal.tsx`, `src/components/field-app/FieldAppChemicalEntry.tsx` (+ test), `scripts/smoke/prove-rate-writers-real-schema.mjs`, `scripts/smoke/prove-rate-cutover-real-schema.mjs` (W9), docs (`KNOWN_ISSUES`, `CURRENT_STATE`, RT-4a contract scope note).

**Who may act.** Unchanged: rate RPCs are admin-only (`is_admin()` / `_product_parent_require_admin()`). The revoke removes a path; it adds none.

## 2. State and failure

**Rules that always hold.**
1. No API role holds INSERT or UPDATE on the three rate columns, directly or inherited. Every other column privilege is unchanged.
2. Definer rate functions keep working: they run as `postgres`, which owns the table.

**Existing rows.** No data changes. Readers unchanged.

**Rollout.** A release applies the migration before the app deploys. The deployed app sends a rate key in a direct save only when an admin edited a rate box, which is disabled while the lock is on (live: locked; RT-4a refuses to unlock once any parent is approved). If the lock were off and an admin edited a rate on one of the 5 ungrouped products before the new app deploys, the save fails with a permission error and nothing is written. Accepted.

**Timing, undo.** No rate function body changes, so their locking, retry keys and receipts are as already proven. A tab opened while rates were open and saved after they were locked was already refused (`PRODUCT_RATES_LOCKED`); the new screen never sends rate keys. Rollback, only if rates must be edited directly again: a reviewed migration granting INSERT/UPDATE on the three columns to `authenticated` only (what `20260718190000` granted); it reopens the route Mason chose to close, so it needs his yes. A screen failure is fixed forward or the app reverted; the grant stays revoked.

## 3. Delivery

One PR to `staging` (migration + screens): the screen change works with the old database (it only stops sending columns and uses existing RPCs), and the migration is safe with the old screen (above). Gates: real-schema prover, Luna, Sol, `/security-review` (permission change), staging DB apply proof, browser check on the test app.

## 4. Proof cases

Prover (local container, all migrations replayed, real roles):
- **W1.** When an active admin, as `authenticated`, with the lock off, runs a separate `UPDATE` of each rate column alone on a visible product (to a new value, and to its same value), then each fails with `permission denied` and the row is unchanged; the same admin's `UPDATE … SET product_name` changes exactly 1 row.
- **W2.** When an admin inserts a product naming any one rate column, then permission denied. A product insert naming no rate column succeeds, and a seed product's rate unit is its stock unit (trigger). A non-admin's update affects 0 rows (RLS) and `anon` is refused.
- **W3.** After the revoke, each RPC writer still writes rates for an admin, with its usual event: `set_product_rates` (lock off), `apply_product_setup` import with rates, `create_product_with_parent` then `set_parent_rates`, `add_product_size` copies the parent rate, `move_product_size` copies the target's rate, `correct_product_rates` and `correct_parent_rates` (lock on). The other definer writers (grouping, price workbook, switch) are owned by `postgres` like these, so a column grant cannot affect them; their own provers cover them.
- **W4.** `metabase_ro` cannot execute either RT-4a RPC; `authenticated` can.
- **W5.** Every other `products` column privilege is the same before and after (migration postflight).

Screen tests and browser:
- **W6.** Product page, ungrouped product: rate boxes disabled; lock off shows the workbook hint; a details save sends no rate key. Lock on: "Correct rates" still opens.
- **W7.** Field app: a product with no rate unit and no stock unit leaves the units blank (was `oz`); with a stock unit it takes the stock unit.
- **W8 (staging browser).** Open an ungrouped product and a grouped size on the test app; save a details change; reload and see it saved, with rates unchanged.

RT-4a leftovers:
- **W9 (deferred to a follow-up, 2026-11-18: it needs a customer, quote, order, invoice and job fixture chain; the RT-4a prover's line-table hashes already show the switch writes no line).** The RT-4a prover seeds one saved line on a switched product's size in each of `quote_items`, `invoice_items`, `job_chemicals`, `order_items`, with its own rate, unit, quantity and price; the saved-line hash is unchanged across the switch and the switch back.

## Open business decisions

1. **Remove direct rate writes** (grand plan: Mason-gated). Mason, 2026-11-18: "Yes, remove it".

Out of scope, named: Piksi MG→g (Mason 2026-11-13: MG means milligrams; 2026-11-17: keep both Piksi parents on today's values; held by ID in RT-4a); a one-step "change a switched parent's rate" tool (Mason 2026-11-17: "Switch back, fix, switch on"); the OCR blend-ticket import test against `PRODUCT_PARENT_RATE_APPROVED_BLEND` (Taha's item on #1958).

## Challenge settlement (Astra, 49 findings)

**Corrected:** 1, 2, 4 (scope of the promise); 3 (basis changes stay under the lock); 6 (postflight: helpers not executable); 8 (writer table completed); 14 (price workbook message re-emitted; modal toast); 29, 30, 31 (W1/W2 per column, admin with a visible row, row counts, positive insert); 32 (W3 widened; ownership argument for the rest); 35 (W7); 36 (W9 lines on the switched product); 38, 39, 40 (postflight compares effective privileges, not catalog rows); 41 (file name fixed); 45, 46 (rollback: `authenticated` only, Mason's yes); 48 (RT-3 prover outcome rule).

**Disproved with evidence:**
- 5: RT-4b changes no rate function; it changes only who may write the columns directly. Their own checks are unchanged and proven by their provers.
- 7: `validate_product_units` reads `unit_conversions`, `product_form_units`, `quote_items`, `job_chemicals` (`20261104150000:50-125`), which `authenticated` can already read; it is unchanged and the W2 positive insert runs it.
- 9: `ProductDetail` creates products through `create_product_with_parent` / `add_product_size` (`productParents.ts:128/135`); no direct insert exists, and the payload now always drops rate keys.
- 10, 11: the deployed app loads `persisted` from the database, so an unedited rate is dropped; a box is enabled only while rates were open, and a save after locking was already refused by `guard_product_rate_lock`.
- 12, 13, 26, 27, 28, 33: no rate function body changes; ownership races are refused by `guard_product_parent_values` and the RT-4a triggers.
- 15: the setup workbook's Rates tab lists ungrouped products and saves through `set_product_rates` (`productSetupWorkbook.ts:19, 298`).
- 16, 19: live 2026-11-18: 0 negative, 0 zero, 0 non-decimal rates.
- 18, 22: live: 0 untrimmed units or text; 0 products without a form or stock unit.
- 21: live: 0 products without a stock unit, so no line gets a blank unit.
- 37, 42, 43, 44: the release flow (live apply before the merge to `main`, then the PWA bundle check) handles timing; the migration is one transaction with `lock_timeout` and a postflight; the failure mode is a clean permission error with nothing written.

**Declined or out of scope:** 17 (a `correct_product_rates` expected-object key gap: pre-existing, admin-only), 20, 23, 24, 25 (pre-existing field-app behavior not touched here), 34 (browser proof stays W6/W8 with reload), 47, 49 (the metabase and prover tidy-ups are small #1958 items this task includes).

No DECISION finding is a business choice: 3, 4, 23, 46 and 48 are technical and settled above.
