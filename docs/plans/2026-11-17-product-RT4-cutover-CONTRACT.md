# RT-4a rate cut-over: behavior contract

Status: settled after one Astra cold challenge (gpt-6-astra high, 67 findings, 2026-11-17); two business questions open for Mason (end). Grand plan: `2026-10-29-product-GRAND-PLAN.md` › RT-4 and overlap 11. RT-3 contract: `2026-11-11-product-RT3-rate-review-CONTRACT.md`. Facts read at commit `10070370e` (origin/staging) and live read-only on 2026-11-17.

**Scope name.** This is **RT-4a**: promote approved rates to live per parent, with rollback. The grand plan's RT-4 "done when" also needs RT-4b (move every writer to the rate RPC, revoke direct writes (Mason-gated), drop the field app's invented `'oz'`, Piksi MG→g rename). RT-4 is not complete until RT-4b lands.

## 1. Outcome and authority

**Business result.** The rate a new quote, job or field-app line picks up comes from the rate Mason approved in RT-3, one parent at a time, with a one-step way back to the old rate and unit. Saved quotes, invoices, jobs and orders do not change.

**Smallest change.** Readers stay as they are: every screen and function keeps reading `products.rate_per_acre` / `rate_unit` (grand plan: "decided before any pilot"). RT-4a writes the approved rate into those columns through the existing PAR-1 path (`_apply_parent_rates` → `_copy_parent_to_size`), one parent per call, as the grand plan requires ("RT-4 promotes approved rows to live, one parent at a time"; the locked correction path is "never in a batch").

**Files expected.**
- One migration `supabase/migrations/2027xxxx_product_rate_cutover.sql`:
  - two columns on `product_parents`;
  - widen `product_parent_events_event_type_check` with `rates_promoted`, `rates_restored`;
  - RPCs `preview_parent_rate_cutover`, `commit_parent_rate_cutover`;
  - source-aware refusals in `guard_product_rate_lock`, `correct_parent_rates`, `move_product_size`, and new BEFORE triggers on `product_rates` and `product_parent_rate_outcomes`.
- Changelog fragment, `src/types/supabase.ts` regen, `.claude/schema-registry.json` refresh, SQL proof file.
- No screen. Mason runs it from his admin login in the app's browser pane by calling the RPCs over the app's own API (PostgREST) with his session, exactly as the RT-1 derivation and RT-3 review ran on 2026-11-17 (`docs/changelog.d/2026-11-17-rt1-derivation-run.md`).

**New state, and why existing state cannot do it.**
- `product_parents.rate_source text NOT NULL DEFAULT 'legacy' CHECK (rate_source IN ('legacy','approved'))`.
- `product_parents.rate_source_event_id bigint REFERENCES product_parent_events(id)`, with `CHECK ((rate_source = 'approved') = (rate_source_event_id IS NOT NULL))`. It points at the `rates_promoted` event that holds the snapshot; NULL while legacy.
- Nothing records today which rate a parent shows; the refusals below need it.
- **Snapshot, no new table.** `product_parent_events` is append-only (update/delete trigger, no-truncate trigger, no write grants; authenticated active profiles may SELECT). The `rates_promoted` event stores, in `after_values`, an explicit versioned payload: `{"v":1, "legacy": {"rate_per_acre", "rate_unit", "suggested_rate"} of the parent, "sizes": [{product_id, rate_per_acre, rate_unit}], "approved": {rate_id, row_version, outcome, outcome_version, recommended, unit_code, written_unit}}`. Nothing in it is more sensitive than the product page already shows.

**Who may act.** Admins only (`_product_parent_require_admin()`). The new RPCs are `SECURITY DEFINER SET search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`, `GRANT EXECUTE TO authenticated`. Internal helpers stay revoked.

**RPCs.**
- `preview_parent_rate_cutover(p_parent_id uuid, p_direction text)`: read-only. Returns eligibility or the refusal, the target rate and unit, and the expected-state object for commit. Advisory only: commit re-checks everything.
- `commit_parent_rate_cutover(p_parent_id uuid, p_direction text, p_expected jsonb, p_reason text, p_idempotency_key text)`.
  - `p_direction` is `promote` or `restore`.
  - `p_reason` is required (`_product_parent_reason`, non-blank, bounded).
  - `p_idempotency_key` is required and non-blank.
  - Errors use `PRODUCT_PARENT_…: <plain text>` so the app shows them.

**Server-derived values.** The parent ID and direction are locators. The target always comes from `product_rates` / `product_parent_rate_outcomes` (promote) or from the event named by `rate_source_event_id` (restore), never from the caller. `p_expected` is a strict staleness check:
- `parent_version`;
- the approved rate's `id` and `row_version`, and `outcome_version`;
- each size's preview snapshot as `_apply_parent_rates` requires.

Unknown keys, missing keys, duplicates or any mismatch refuse.

## 2. State and failure

**Order of work in one call (one transaction):**
1. Lock the rate-lock row `FOR SHARE` (held to commit, so a concurrent unlock waits).
2. `_lock_product_parent` (parent, then sizes in ID order).
3. Lock the parent's `product_rates` and outcome rows.
4. All eligibility checks, after the locks.
5. Write.

No advisory locks. A refusal anywhere rolls back everything.

**Rules that always hold.**
1. **Promote eligibility.** All of these must hold:
   - `rate_source = 'legacy'`, the parent is active, and the rate lock is on;
   - the outcome is `approved_default` or `no_per_acre_default`, with no draft rows;
   - for `approved_default`: exactly one approved, `basis_confirmed`, `per_acre`, `is_quoting_default` row, with `recommended > 0` and a unit that `_product_rate_unit_ok` accepts for the parent's current form;
   - not on the hold list (rule 7);
   - when the unit changes, no `blend_recipe_items` row and no blend ticket line with a blank unit references a size (both reuse the product's current unit when loaded or billed; live 2026-11-17: 0 rows for every product whose value changes).
2. **Promote `approved_default`.**
   - Liquid/dry: the parent gets the approved `recommended`, and its unit becomes the parent's existing spelling when that spelling is one of the approved unit's `legacy_spellings`; otherwise the unit's first legacy spelling (`lb` → `Lb`).
   - Sizes get the same through the existing copy. Live: every size's unit spelling equals its parent's.
   - Seed/each: the parent unit stays NULL and sizes keep their stock unit (existing `_apply_parent_rates` / `_copy_parent_to_size` behavior). Live: no approved_default parent is seed or each form.
3. **Promote `no_per_acre_default`.**
   - `rate_per_acre` NULL on the parent and sizes.
   - Liquid/dry `rate_unit` NULL; seed/each sizes keep their stock unit. The field app shows the stock unit for a NULL rate unit (existing fallback); the rate stays blank.
   - New lines start with no rate (Mason, 2026-11-17: "Yes, leave it blank"). No reader parses `suggested_rate` text into a rate (reader trace 2026-11-17).
4. **Only rate fields move.**
   - `suggested_rate` is passed through unchanged (the parent's current value).
   - `_copy_parent_to_size` also writes category and use timings from the parent. Live: every size already equals its parent on suggested text, category and timings, and the call refuses if any size differs at commit.
5. **No-change promote** (live: 370 of 372 approved_default parents). It takes the same locks and checks as rule 1, verifies the snapshot, and refuses on any mismatch. It writes no rate column. It records the marker and the event, and it bumps `parent_version` so an old preview cannot replay.
6. **Changing promote.**
   - Goes through `_apply_parent_rates(..., p_correction => true, reason)`. That checks the size snapshot and per-acre prices, takes the rate pass for this transaction, writes one `corrected` row per size to `product_rate_events` and one `rates_corrected` parent event, and lets `trigger_recalc_product_price_per_acre` recompute prices.
   - It is followed by the `rates_promoted` event and the marker.
   - Independent check for Smart Choice: 1.8 Lb × $19.65/Lb = $35.37 per acre at tier 1.
7. **Hold list (Mason, 2026-11-17, "Keep both on today's values").**
   - Piksi Dust Plus (`afdae5f9-3410-4f17-975b-07a1650089ae`) is refused by ID, and the migration checks that the ID still names "Piksi Dust Plus".
   - Piksi Dust Infurrow (`c9933638-…`) is already `needs_label_data`, so promote refuses it anyway.
   - The hold excludes them from RT-4a only. Ordinary locked corrections stay as they are.
8. **Restore.**
   - Only when `rate_source = 'approved'`; inactive parents may be restored.
   - Puts the parent's snapshot `legacy` rate and unit back and copies down to every current size through the same `_apply_parent_rates` path. When nothing differs, no write happens.
   - Restore covers exactly `rate_per_acre` and `rate_unit`. `suggested_rate` was never changed. Per-acre prices are recomputed from today's stock prices, so a price change made since promotion is kept, not undone.
   - Then `rate_source = 'legacy'`, `rate_source_event_id` NULL, `parent_version` bumped, and a `rates_restored` event citing the promote event.
   - A size added after promotion gets the parent's legacy rate like its siblings; live sizes never differ from their parent today.
9. **An approved parent cannot drift**, through any route. The guard runs in the database on the tables themselves:
   - `guard_product_rate_lock` refuses any rate-column change on a size of an `approved` parent unless that transaction holds a rate pass, **even when the lock is off**. So unlocking later reopens only legacy parents.
   - The only definer paths that write a rate pass: RT-4a commit, `correct_parent_rates` (now refuses `approved` parents: "switch it back to the old rate first"), and add-a-size (copies the parent's own rate, which is allowed).
   - New BEFORE triggers on `product_rates` and `product_parent_rate_outcomes` refuse any insert, update or delete for an `approved` parent. That covers `commit_rate_review`, `save_draft_product_rate`, derive, and anything else.
   - `move_product_size` refuses moving a size into or out of an `approved` parent.
10. **Rate lock.** RT-4a refuses while the lock is off and never changes it.

**Existing rows (live, 2026-11-17).**
- Parents: 456 total, 413 active.
- Outcomes:
  - 372 approved_default: 538 sizes, 1 inactive; each has one valid default with `recommended > 0`; 0 seed/each.
  - 16 no_per_acre_default: 18 sizes, 6 seed/each.
  - 8 needs_label_data, with 8 drafts.
- 17 active parents have no outcome; they stay legacy until decided. 5 active products are in no parent; they stay as they are.
- 0 sizes differ from their parent on rate, unit, suggested text, category or timings. No parent unit or suggested text has stray spaces.
- Saved lines keep their own copy:
  - `quote_items`, `invoice_items`, `job_chemicals` and `order_items` hold their own rate and unit;
  - season rollover and quote-to-order copy the line's own rate.
  - The two re-reads of the product's current unit are blend recipes (no unit column) and blank-unit blend lines. Rule 1 refuses a unit change while either exists; live has none for the changing products.
- Every parent starts `legacy`, and readers see exactly today's values.
- The deployed app keeps working:
  - the new columns have defaults;
  - the parent history screen does not read `event_type`;
  - `ParentRatesModal` shows `PRODUCT_PARENT_…` errors as plain text.

**Timing.**
- **Retry or double click.** The same key with the same request (fingerprint: actor, parent, direction, expected, reason) returns the first receipt through the existing `_product_parent_replay` / `save_idempotency` pattern; the same key with a different request is refused. The receipt says what was done and when, not the current state.
- **Two admins, or an edit after preview.** The version or snapshot check refuses the later one; nothing is half-written.
- **Unlock during a call.** It waits on the `FOR SHARE` lock (step 1).
- **A user's open screen.** A screen opened before the switch keeps the rate it already loaded until reloaded. That is the same as any rate correction today: the rate is captured when the product is picked.
- **Copying an old quote** (rollover, convert to order) keeps the saved rate.

**Undo and history.**
- Promote records: admin, time, reason, the snapshot, the approved row and version it used, plus per-size correction events when values change.
- Restore records the admin and reason. A second restore is refused ("already on the old rate").
- Promote after restore takes a new snapshot of the then-live values. Those equal the original legacy values, because nothing can change an approved parent's rate in between (rule 9).
- History is never edited.

## 3. Delivery

- **One database PR to `staging`:** migration plus proof, no screen. It is compatible with the deployed app (defaults, no reader change, no parent switched until the pilot).
- **Gates:** prover, Luna, Sol (database path), staging apply, then release to production through the normal release flow.
- **Before any rollback of the migration,** every parent must be restored to `legacy`. The columns, event types and events stay (forward-repair only).
- **Live runs** come after the migration is live in production. Each is a live write outside a migration and needs Mason's explicit yes in that session.
  1. **Reader proof before the pilot** (grand plan): on staging, a new quote line, job line, field-app line and quote PDF for a changed product and a blank product show the expected rate, unit and price.
  2. **Pilot:** Smart Choice (value and unit change), MSO XL (no change), Autumn Super 51 WDG (goes blank). Then:
     - check a new quote line for each in the app;
     - restore Smart Choice and Autumn Super, and check they read exactly as before;
     - re-promote both.
     - Stop and restore on any mismatch. The recovery owner is the agent running it, with Mason's yes.
  3. **The rest:** a reviewed list (the preview output for every eligible parent: IDs, targets, exclusions), committed one parent per call by a small loop in the browser pane. The loop is resumable: already-approved parents are skipped and listed. The receipt reconciles every intended parent.

## 4. Proof cases

These run on the local prover with test data, as real roles (`SET ROLE authenticated` with JWT claims for an active admin, an active non-admin, an inactive admin, `anon`), never on production data.

- **P0 (live, read-only).** Before apply, the counts in §2 still hold. After apply, every parent is `legacy`, and an ID-ordered md5 of the pre-existing `products` and `product_parents` columns is unchanged.
- **P1.** When an admin promotes an unchanged parent, then no `products` rate column changes, `rate_source = 'approved'`, `parent_version` goes up by 1, and there is one `rates_promoted` event with the v1 payload.
- **P2.** When an admin promotes 1.8 `Dry oz` → approved 1.8 `lb` on a dry parent priced $19.65/Lb, then the parent and sizes read 1.8 `Lb`, tier-1 per-acre is $35.37, and there are 2 `corrected` size events (2 sizes), 1 `rates_corrected` and 1 `rates_promoted`.
- **P3.** When an admin promotes a `no_per_acre_default` liquid parent and a seed parent, then the rate is NULL, the liquid unit is NULL, the seed unit is the stock unit, and per-acre prices are NULL.
- **P4.** When an admin restores P2's parent (after a stock-price change in between), then the rate and unit are back to 1.8 `Dry oz` and per-acre prices use the new stock price. When P3's liquid parent is restored, its old rate and unit return. A second restore is refused.
- **P5.** These are refused, with nothing written:
  - a non-admin, an inactive admin, or `anon`;
  - a `needs_label_data` parent, a parent with a draft, or the held Piksi parent;
  - an already-approved parent, or an inactive parent on promote;
  - the lock being off;
  - a stale `parent_version`, rate `row_version` or outcome version;
  - a stale size snapshot;
  - a unit change while a blend recipe item or a blank-unit blend line references a size;
  - a size that differs from its parent on suggested text, category or timings;
  - a blank reason or key;
  - unknown keys in `p_expected`.
- **P6.** When a parent is `approved`, then these are all refused:
  - `commit_rate_review` reopen, save or delete;
  - `save_draft_product_rate`;
  - an outcome change;
  - `correct_parent_rates`;
  - `move_product_size` in or out;
  - a direct `UPDATE products SET rate_per_acre` with the lock **off**.

  After a restore they work again.
- **P7.** The same key twice returns the same receipt and writes once. The same key with a different reason is refused.
- **P8.** Adding a size to an `approved` parent copies its approved rate. A later restore gives that size the legacy rate.
- **P9.** An existing quote line and job line on a promoted product keep their saved rate and unit, and so does season rollover.
- **P10 (staging, browser, before the pilot).** The reader proof in §3, step 1.
- **P11 (live, after the pilot, browser).** A new quote line for Smart Choice shows 1.8 Lb and $35.37/acre at tier 1. After restore it shows 1.8 Dry oz and $2.21/acre.

## Challenge settlement (Astra, 67 findings)

**Corrected in this contract:**
- 1, 29, 56, 60, 67: one parent per call; a reviewed list and a resumable loop.
- 2: parent spelling; live sizes match.
- 3, 4, 53: only rate fields move; checked live and refused at commit.
- 5: seed/each wording.
- 6, 7, 8: restore covers rate and unit; prices recompute from current prices.
- 9: restore copies the parent down.
- 10: moves refused.
- 11: inactive parents restorable.
- 12, 13, 14, 15, 55: the source-aware database guard and table triggers.
- 16, 17: revalidation and `recommended > 0`.
- 19, 20, 21, 22, 24, 25: locking order, checks after locks, version bump, expected-state fields.
- 28, 30: reason, key and `p_expected` validation.
- 32, 33, 34: FK and check on the pointer; v1 payload with the approved source.
- 35, 36, 64: wording.
- 38: real roles.
- 49: independent $35.37.
- 51: hold by ID with a name check.
- 57: restore Smart Choice and Autumn Super.
- 58: reader proof before the pilot.
- 59: stop rule and recovery owner.
- 61: rollback order.
- 63: column-scoped md5.
- 66: named RT-4a.

**Disproved with evidence:**
- 18: only Smart Choice changes unit (`Lb`, priced per `Lb`); the 370 no-change parents write nothing.
- 23: membership changes run through `_lock_product_parent`, and moves into or out of approved parents are now refused.
- 26: preview is advisory and commit re-checks.
- 27: the existing replay/save idempotency pattern is used by `correct_parent_rates` and `commit_rate_review` on live.
- 31: the receipt is historical by design.
- 37: the payload holds nothing beyond product-page data.
- 39: the browser-pane runner was used for RT-1 and RT-3.
- 40: `ParentRatesModal` shows `PRODUCT_PARENT_…` text (`ParentRatesModal.tsx:148`, `errorSanitizer.ts:350`).
- 41–46: reader trace. No reader parses `suggested_rate`. Saved lines keep their copies. The blend re-reads are guarded by rule 1 (0 live rows). The field-app `'oz'` fallback only applies when the stock unit is also blank.
- 47, 48: captured-at-pick, the same as any correction today; copies keep the saved rate.
- 50: parents without an outcome and ungrouped products stay legacy by design.
- 52: the hold is RT-4a exclusion only.
- 62: the migration's preflight asserts the helper signatures it calls exist.
- 65: the history screen does not read `event_type`.

**Sent to Mason:** 54 (how a live rate gets changed after the switch) and 59 (how long to watch the pilot).

## Re-check settlement (Astra targeted re-check, 19 findings)

The re-check attacked rule 9's "even when the lock is off" protection. Covering every way a rate's meaning can move with the lock off (unit conversions 1, parent-only rates 3, stock unit or form changes 5, the guard's early returns 6) would rebuild the lock. **Simplified design (pending Mason, decision 3):** `set_product_rate_lock` refuses to unlock while any parent is `approved`. The existing lock then covers 1, 3, 5 and 6 unchanged, and rule 9's guard stays "lock on, plus refuse approved parents in every pass-writing path".

Other settlements, applied at build:
- **2:** `correct_product_rates` also refuses sizes of `approved` parents.
- **4:** every refusal in `correct_parent_rates`, `correct_product_rates` and `move_product_size` (both parents) runs after that function's own row locks.
- **7, 8:** no table triggers. The approved-parent refusal goes inside `_product_rate_review_run` only for rows whose status is `change`, so unchanged rows still pass. Derive skips `approved` parents and lists them as skipped.
- **9:** joined to decision 1.
- **10:** restore runs the same blend-reference check as promote.
- **11:** the in-flight blend writer is the same residual risk as any locked unit correction today. `guard_product_rate_unit_for_blend_lines` is unchanged, and only Smart Choice changes unit, with 0 blend rows. Accepted and named.
- **12, 13:** restore is previewed. If the old unit or rate no longer passes for a current size, restore is refused, the parent stays `approved` (a safe state), and the refusal is reported. Proof case P4b covers the promote → restore round trip from `Dry oz` and from `oz`.
- **14:** promote also refuses when any size's rate or unit differs from the parent. While `approved`, sizes cannot diverge.
- **15:** the no-change branch runs its own full check: each size's snapshot and its current per-acre prices against `p_expected`.
- **16:** eligibility also requires `_product_rate_value_ok`.
- **17:** `p_expected` has one shape per outcome. `no_per_acre_default` carries `outcome_version` and the parent's rate-row IDs and versions (possibly empty).
- **18:** text is compared and kept trimmed; empty string and NULL both mean blank. Live has no empty-string values.
- **19:** "duplicates" means duplicate size entries only.

## Settled business decisions (Mason, 2026-11-17)

- Products with no per-acre default: "Yes, leave it blank" when switched.
- Piksi Dust Plus and Infurrow: "Keep both on today's values".
- Smart Choice: "1.8 lb per acre".
- Rollout: "Pilot a few, then the rest".

## Open business decisions

1. **Changing a live rate after the switch.** Recommended: switch the parent back, fix the rate in the rate review, then switch it on again (a few minutes on the old rate; no new screen now). The alternative is a one-step "edit live rate" tool, built now instead of in RT-4b, which costs more time and review.
2. **Pilot watch.** Recommended: go on to the rest the same day, once the pilot checks pass in the app. The alternative is to wait a day of real quoting first.
3. **The rate lock after the first switch.** Recommended: once any product is switched, the "Lock rates" switch cannot be turned off until every switched product is switched back. Rates on products not yet switched can still be fixed one at a time with the locked correction. This narrows Mason's 2026-10-29 answer that any admin may switch the lock at any time (grand plan, overlap 11, question 11). The alternative keeps the lock switch free, at the cost of a much larger guard to rebuild.
