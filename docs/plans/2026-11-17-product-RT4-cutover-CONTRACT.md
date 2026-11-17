# RT-4 rate cut-over: behavior contract

Status: draft for the cold challenge (2026-11-17). Grand plan: `2026-10-29-product-GRAND-PLAN.md` › RT-4 and overlap 11. RT-3 contract: `2026-11-11-product-RT3-rate-review-CONTRACT.md`. Facts read at commit `10070370e` (origin/staging) and live read-only on 2026-11-17.

## 1. Outcome and authority

**Business result.** The rate a new quote, job or field-app line picks up for a product comes from the rate Mason approved in RT-3, one parent at a time, with a one-step way back to the exact old reading. Existing quotes, invoices, jobs and orders do not change.

**Smallest change.** Readers stay as they are: all ~93 screens and functions keep reading `products.rate_per_acre` / `rate_unit` (and `product_parents` for the parent). RT-4 is one internal step that writes the approved rate into those old columns through the existing PAR-1 write path (`_apply_parent_rates` → `_copy_parent_to_size`, the only write the rate lock lets through), plus a per-parent marker of which rate the parent now shows.

Files expected:
- one migration `supabase/migrations/2027xxxx_product_rate_cutover.sql` (new RPCs, one column on `product_parents`, two new parent event types, refusals added to the RT-3 review RPCs and `correct_parent_rates`);
- `docs/changelog.d/<date>-rt4-rate-cutover.md`, `src/types/supabase.ts` regen, `.claude/schema-registry.json` refresh, a SQL proof file.
- No screen in this PR. The pilot runs from Mason's admin login, the same way RT-1 and RT-3 ran.

**New things and why the existing path cannot do them.**
- `product_parents.rate_source text NOT NULL DEFAULT 'legacy' CHECK (rate_source IN ('legacy','approved'))` and `rate_source_event_id bigint` (the parent event that last switched it). Needed so the review RPCs and the correction screen can tell a switched parent apart; nothing today records that.
- Parent event types `rates_promoted` and `rates_restored` added to `product_parent_events_event_type_check` (live today: created, updated, size_added, size_moved, identity_corrected, rates_set, rates_corrected).
- **No new snapshot table.** `product_parent_events` is already append-only (trigger `product_parent_events_append_only`, no-truncate trigger, no grants) and its `affected` column holds each size's full before and after. The `rates_promoted` event is the immutable snapshot.

**Who may act.** Admins only (`_product_parent_require_admin()`: `auth.uid()` with an active admin profile). New RPCs are `SECURITY DEFINER SET search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`, `GRANT EXECUTE TO authenticated`; the admin check is inside.

**RPCs.**
- `preview_rate_cutover(p_parent_ids uuid[], p_direction text)`: read-only, any length up to 500. Per parent: eligible or the refusal reason, the target rate and unit spelling, each size's current snapshot (the same shape `_apply_parent_rates` requires: pricing_version, unit_size, inventory_unit, product_form, rate_per_acre, rate_unit, suggested_rate, and the three per-acre prices after the change), and `parent_version`.
- `commit_rate_cutover(p_parent_ids uuid[], p_direction text, p_expected jsonb, p_reason text, p_idempotency_key text)`: all-or-nothing for the list.

**What the server derives itself (the screen sends only locators).** Parent IDs and the direction are locators. The server reads the target from `product_rates` / `product_parent_rate_outcomes` (promote) or from the parent's `rate_source_event_id` event (restore), never from the caller. `p_expected` is only a staleness check, compared field by field; a mismatch refuses the whole batch.

## 2. State and failure

**Rules that always hold.**
1. A parent may be promoted only when: `rate_source = 'legacy'`; it is active; its outcome is `approved_default` or `no_per_acre_default`; it has no draft `product_rates` rows; for `approved_default`, exactly one approved `per_acre` row with `is_quoting_default` and `basis_confirmed`; and it is not on the hold list (rule 7).
2. Promote `approved_default`: parent and every size get `rate_per_acre` = the approved `recommended`, `rate_unit` = the size's existing spelling if it is one of the approved unit's `legacy_spellings`, else the unit's first legacy spelling (`lb` → `Lb`). Seed and each forms keep their stock unit (existing `_copy_parent_to_size` rule).
3. Promote `no_per_acre_default`: `rate_per_acre` NULL; `rate_unit` NULL for liquid/dry, stock unit for seed/each (existing rule). New lines start with no rate (Mason, 2026-11-17: "Yes, leave it blank").
4. `suggested_rate` text is never touched by RT-4.
5. When the target equals today's values (live: 370 of 372 approved_default parents), no `products` or parent rate column is written; only `rate_source`, `rate_source_event_id` and the `rates_promoted` event (with `affected` holding each size's unchanged values) are recorded. `_apply_parent_rates` refuses a no-change correction, so this branch skips it.
6. When it differs, the write goes through `_apply_parent_rates(..., p_correction => true, reason)`, which locks the parent and its sizes in ID order, checks the size snapshot, takes the rate pass for this transaction only, writes `rates_corrected` rows to `product_rate_events`, and lets `trigger_recalc_product_price_per_acre` recompute the per-acre prices. The RT-4 RPC then writes its own `rates_promoted` parent event pointing at that event.
7. **Hold list (Mason, 2026-11-17):** Piksi Dust Plus and Infurrow stay on today's values ("Keep both on today's values"); promote refuses them by parent ID, written into the migration. A later MG→g rename is its own known issue.
8. Restore: only a parent with `rate_source = 'approved'`. Every size and the parent get back exactly the `before` values in the `rates_promoted` event named by `rate_source_event_id`, through the same `_apply_parent_rates` path (or no write when they already match). `rate_source` returns to `legacy`; a `rates_restored` event is appended.
9. While a parent is `approved`: `commit_rate_review` refuses any reopen, save or delete of that parent's rates or outcome ("switch it back to the old rate first"), and `correct_parent_rates` refuses it too, so the live columns can never drift from the approved rate without a restore.
10. The rate lock stays ON. RT-4 does not unlock it; promote and restore refuse if it is off (same check as `correct_parent_rates`).

**Transaction.** One RPC call is one transaction. Any refusal (ineligible, stale snapshot, price preview changed, not admin, lock off) rolls back every parent in the call. No emails, files or receipts leave the database.

**Existing rows.**
- Live 2026-11-17: 396 parents with an outcome (372 approved_default with exactly one default each, 16 no_per_acre_default, 8 needs_label_data with 8 drafts). 0 sizes differ from their parent's rate today. 1 inactive size under an approved parent. No approved_default parent is seed or each form; 6 no_per_acre_default parents are.
- Every existing parent gets `rate_source = 'legacy'` from the column default. Every reader keeps reading the same columns; a `legacy` parent reads exactly what it reads today.
- Only two approved_default parents change value or unit: Smart Choice (1.8 Dry oz → 1.8 Lb; Mason: "1.8 lb per acre"; per-acre price rises with it) and Piksi Dust Plus (held, rule 7). The 16 no_per_acre_default parents go to blank.
- Lines already saved keep their own copy: `quote_items` (actual_rate, rate_unit, suggested_rate), `invoice_items` and `job_chemicals` (rate_per_acre, rate_unit), `order_items` (actual_rate, rate_unit), blend tickets. RT-4 never writes those tables.
- Read-only check before apply: the query in §4 case P0 returns the counts above.
- The deployed app during rollout: the new column has a default and no screen sends it; old screens keep working. The parent correction screen (`ParentRatesModal`) gets a clear refusal on a switched parent from rule 9.

**Timing.**
- Double click / retry after timeout: same `p_idempotency_key` with the same request returns the first receipt; the same key with a different request is refused (existing `save_idempotency` / replay pattern, fingerprint over actor, parent IDs sorted, direction, expected, reason).
- Two admins on one parent, or a size edited between preview and commit: `_lock_product_parent` plus the snapshot check refuses the later one with a stale message; nothing is half-written.
- A promote racing an RT-3 save: the review RPC and the cut-over both lock the parent row; whichever is second sees the other's change (rule 9 or a stale version).
- Late response: the receipt lists each parent's event ID; a retry after success replays it.

**Undo and history.**
- The original switch records the admin, time, reason, and every size's before/after in `rates_promoted`; value changes also write `rates_corrected` / `product_rate_events` rows.
- Restore records the admin and reason in `rates_restored` and puts back the snapshot values. A second restore on a `legacy` parent is refused ("already on the old rate"). Promote again after a restore takes a new snapshot of what is live then.
- History is never edited.

## 3. Delivery

- One database PR to `staging`: migration plus proof, no screen. It is safe with the app already deployed (new column has a default; the only behavior change for old screens is rule 9's refusal on switched parents, and no parent is switched until the pilot).
- Gates: prover, Luna, Sol (database path), staging DB apply, then release to production through the normal release flow.
- Live runs after the migration is live, each a live write outside a migration that needs Mason's explicit yes in the session: (1) pilot: Smart Choice (value and unit change), MSO XL (no-change promote), one no_per_acre_default parent (goes blank); check a new quote line on each, then restore one and check it reads exactly as before, then re-promote it. (2) The rest of the eligible parents in one call. Mason: "Pilot a few, then the rest".
- Later, not in this PR (RT-4b): move every remaining writer to the rate RPC, revoke direct column writes (Mason-gated), drop the field app's invented 'oz', the Piksi MG→g rename.

## 4. Proof cases

All run on the local prover / a migrated local database with test data, as the real caller (admin and non-admin JWT claims), never on production data.

- P0 (live, read-only): before apply, the counts in §2 Existing rows still hold; after apply, every parent is `legacy` and products/parents md5 is unchanged.
- P1: when an admin promotes a parent whose approved rate equals today's, then no `products` row changes (md5 of the sizes equal), `rate_source = 'approved'`, one `rates_promoted` event.
- P2: when an admin promotes a dry parent from 1.8 `Dry oz` to approved 1.8 `lb`, then the parent and every size read 1.8 `Lb`, the per-acre prices equal `product_price_per_acre` for the new unit, one `rates_corrected` and one `rates_promoted` event.
- P3: when an admin promotes a `no_per_acre_default` parent (liquid and seed form), then `rate_per_acre` is NULL, liquid `rate_unit` NULL, seed `rate_unit` = stock unit, per-acre prices NULL.
- P4: when an admin restores P2's parent, then every size's rate, unit and per-acre prices equal the pre-promote values exactly, `rate_source = 'legacy'`, one `rates_restored` event; a second restore is refused.
- P5: refusals, each with nothing written: not admin; `needs_label_data`; a parent with a draft; a held (Piksi) parent; already `approved`; lock off; one stale size in a batch of three (none of the three change).
- P6: when a parent is `approved`, then `commit_rate_review` reopen/save/delete and outcome change on it, and `correct_parent_rates` on it, are refused; after restore they work again.
- P7: same idempotency key twice returns the same receipt and writes once; same key with a different parent list is refused.
- P8: adding a size to an `approved` parent copies the approved rate (existing add-a-size path).
- P9: an existing quote line and job line on a promoted product keep their saved rate and unit.
- P10 (live, after the pilot, read-only plus a browser check): a new quote line for Smart Choice shows 1.8 lb and the new per-acre price; after restore it shows 1.8 Dry oz and $2.21/acre.

## Settled business decisions (Mason, 2026-11-17)

- Products with no per-acre default: "Yes, leave it blank" when switched.
- Piksi Dust Plus and Infurrow: "Keep both on today's values"; held from promote.
- Smart Choice: "1.8 lb per acre".
- Rollout: "Pilot a few, then the rest".

## Open business decisions

None known. The cold challenge may raise some.
