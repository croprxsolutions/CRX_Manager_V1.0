# KI-16 rate-unit follow-ups (items b–f after #1733) — behavior contract

Read at `b291ed9ad` (origin/main, 2026-11-10). Live bodies read read-only from `rhyzpcqhnizqbxphqdkr` the same day.
Builds on `2026-11-10-ki16-rate-unit-denominator-and-invisible-chars-CONTRACT.md` (settled; unchanged parts are not
re-argued). Out of scope: the accepted voided-invoice case (`DECISION_LOG.md` 2026-11-10, #1733), KI-16's cost-rounding
and split-acre bullets.

## Facts (with source)

- Live md5 of `replace(prosrc, chr(13), '')`: `normalize_rate_unit` `ac8e7b56f9b08f627a035b2330f958fb`,
  `unit_fold_invisible` `4966a39646767af017bd5a5289302bfe`, `guard_product_rate_unit_for_blend_lines`
  `e956e4b8b2bf51817b0d2f9f60afa0f1`, `save_job` (wrapper, 731 chars) `88ca038686daffbbb2c7a46a05d37e5d`,
  `_save_job_cost_step2_impl` (78,192 chars) `8acf34542105a90212ddb0a5e7c5d272`.
- `save_job` is a thin wrapper: actor check, then `_save_job_cost_step2_impl(... p_chemicals ...)` for an admin, or
  `_save_job_cost_step2_impl(... _cost_step2_job_chemicals(p_job_id, p_chemicals) ...)` otherwise. The impl's ACL is
  `postgres` only, so every app save passes through the wrapper. `_cost_step2_job_chemicals` never reads `rate_unit`.
- The impl's denominator probe is `lower(btrim(rate_unit))` → fold `[^a-z0-9/]+` to a space → strip one per-acre
  suffix → refuse a surviving `/` or `per`. Its character rule maps only U+00A0/U+202F and deletes U+200B–D/U+FEFF.
  So `pt/a<ZWSP>c` becomes `pt/a c` and is refused, while `rate_unit_line_refusal` (trigger) folds first and accepts.
- `unit_fold_invisible` callers: `normalize_rate_unit`, `rate_unit_line_refusal`, `guard_blend_ticket_product_rate_unit`.
  `normalize_rate_unit` callers (15): billing (`create_invoice_from_blend_ticket`), holds (`_sync_job_holds`,
  `_sync_quote_job_reservations`), shortfalls, dispatch stock, watchdog, job completion, order/app-record from blend
  ticket, product setup/validation, `_product_rate_max_unit`, `guard_seed_each_job_chemical_units`, save_job impl.
  Every one compares its output for equality or passes it to `field_app_priced_quantity` (size lists). None indexes,
  constrains or generates a column from it (live `pg_index`: 0).
- `field_app_priced_quantity` sizes `'oz','fl oz','floz','fluid ounce'` on the LIQUID branch and
  `'oz','dry oz','ounce','ounces'` on the DRY branch. Billing passes it `normalize_rate_unit(...)` output.
- `blend_tickets.deleted_at` is the soft-delete column (`.claude/schema-registry.json`; `blend_ticket_products` has
  none). No live function sets `blend_tickets.deleted_at` back to NULL, and no screen does (grep `deleted_at: null`).
- Live data: no `job_chemicals`, `products` or `quote_items` unit contains a tab/CR/LF/VT/FF; no product unit spells a
  dotted `fl.`; `blend_tickets` 0 rows (0 deleted).
- JS `String.prototype.trim()` strips TAB, LF, VT, FF, CR, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029,
  U+202F, U+205F, U+3000 and U+FEFF. SQL `btrim(x)` strips U+0020 only.

## Outcome and the smallest change

1. **Dotted fluid ounce.** `normalize_rate_unit` maps `fl. oz`, `fl.oz`, `fl oz.`, `fl. oz.`, `fl.oz.`, `floz.`
   (after the per-acre strip) to **`fl oz`**, not `oz`. Billing then sizes it on a liquid product (`fl oz` is on the
   liquid list) and still refuses it on a dry product (`fl oz` is not on the dry list), as it refuses the dotted
   spelling today. Mapping to `oz` would let a dry product's fluid-ounce rate bill as weight ounces; the undotted
   `fl oz` already does that (pre-existing, recorded as a new KI-16 LOW, not changed here). Every other input returns
   exactly what it returned before. TS mirrors (`normalizeRateUnit`, blend validator `rateBaseUnit`) get the same map.
2. **save_job folds first.** Re-emit only the 731-char `save_job` wrapper: before either call it rewrites each
   chemical line's `rate_unit` (when it is a JSON string) to `unit_fold_invisible(rate_unit)`, keeping array order and
   every other key. The impl is not touched; the migration's preflight pins both md5s and its postflight re-checks
   the impl md5 is unchanged.
3. **One whitespace rule.** Whitespace is what JavaScript `trim()` treats as whitespace. `unit_fold_invisible` maps all
   of those characters (list above, except U+FEFF which it already deletes) to a space; `foldInvisibleUnitChars` maps
   the same list. Then `btrim` (SQL) and `.trim()` (JS) strip the same characters, and an interior tab acts as a space
   on both sides. `oz<TAB>` bills as `oz`; a tab-only unit counts as invisible-only (refused on a blend line, as today).
4. **Soft-deleted tickets don't block a product edit.** `guard_product_rate_unit_for_blend_lines` adds
   `AND t.deleted_at IS NULL`. No screen or function restores a deleted ticket, but an admin or sales rep may clear
   `deleted_at` through the table API (live RLS `blend_tickets_office_update`). A restored ticket's blank-unit line
   is then refused at billing as unconvertible (a per-X unit is never a `unit_conversions` sold unit) — fails closed
   (prover F4).
5. **Blend screen warning.** The invisible-only line-unit warning runs on every line, regardless of rate.
6. **Prover.** `prove-rate-unit-guard-real-schema.mjs` creates real invoices through
   `create_invoice_from_blend_ticket` for the per-acre and invisible-character cases, plus the new tab and dotted cases.
7. After apply: regenerate `src/types/supabase.ts` and the RPC fixture snapshot.

Files: one migration + ledger record, `src/lib/labelGuardrails.ts`, `src/lib/blendMathValidator.ts` (+ tests),
the prover, `KNOWN_ISSUES.md` KI-16, this contract.

## Authority

No grants change. `normalize_rate_unit`, `unit_fold_invisible`, `save_job` keep their ACLs (restated:
anon none; authenticated + service_role EXECUTE; `save_job` SECURITY DEFINER, `search_path = public, pg_temp`).
The wrapper keeps its `ACTOR_MISMATCH` check first and its admin/non-admin branch unchanged.

## State and failure

- **Rules that always hold:** no job or blend line stores a per-X rate unit; billing never sizes a fluid unit as a
  dry weight via the new dotted map. A refusal rolls the whole save back (one transaction).
- **Existing rows:** outputs change only for inputs carrying a dotted `fl.` spelling or a JS-whitespace character; live
  has none (query above). The postflight re-runs #1733's "every existing row still passes its guard" check.
- **Stored value change:** a job line saved through `save_job` now stores its rate unit invisible-folded. Idempotency
  fingerprints are taken by the impl over the folded payload, so a retry of the same request replays; a key spent
  before deploy on a payload with such a character would see `IDEMPOTENCY_INTENT_MISMATCH` on any later retry (live
  has 0 such job lines).
- **Timing:** no new lock; #1733's per-product advisory lock is unchanged. The server is applied before the screens
  merge. It now accepts more than old screens predict, so an old screen may show a warning the server no longer
  needs. The one case an old screen stays quiet on and the server refuses (an invisible-only unit on a zero-rate
  line) is today's behavior, and ends when the new screen loads.
- **Undo:** none (no lifecycle change).

## Proof cases (real-schema prover, Docker, test data only)

1. When a liquid product's blend line has rate unit `fl. oz/ac`, then `create_invoice_from_blend_ticket` creates the
   invoice (before: `BLEND_TICKET_UNIT_UNCONVERTIBLE`).
2. When a dry product's blend line has `fl. oz/ac`, then billing still refuses it.
3. When `save_job` gets a priced line with rate unit `pt/a<ZWSP>c`, then it saves (before:
   `CHEM_RATE_DENOMINATOR_NOT_ACRES`); `oz/<ZWSP>cwt` is still refused.
4. When a blend line has `oz<TAB>` (and `fl<TAB>oz`), then it saves and bills as oz (before: refused at save).
   A tab-only unit is refused at save as invisible-only.
5. When a soft-deleted ticket's blank-unit line uses product P, then P's rate unit can change to `oz/cwt`; a live
   (not deleted) unbilled ticket still blocks it.
6. When a blend line is per-acre (`pt/ac`) or carries a zero-width character (`oz<ZWSP>`), then the real RPC creates
   the invoice with the expected quantity.
7. Normalizer table: every #1733 postflight value unchanged; `fl oz` still `oz`; `Dry oz` still `dry oz`.
8. Screen tests (vitest), each failing without the fix: invisible-only warning on a zero/blank-rate line; `oz\t` and
   `fl. oz` parity in `normalizeRateUnit` / validator.
9. Live read-only after apply: functions' md5s as reviewed, impl md5 unchanged, grants unchanged; screens load clean.
   The new warnings/refusals themselves will not be seen live (no live data carries these units).

## Open business decisions

None. (Dotted `fl. oz` → `fl oz` rather than `oz` is the fail-closed technical choice above.)

## Astra cold challenge (gpt-6-astra high, 2026-11-10, 44 findings) — dispositions

Live read-only evidence for these (2026-11-10): across `job_chemicals.rate_unit/unit`, `products.rate_unit/
inventory_unit/unit_size`, `quote_items.rate_unit`, `blend_recipe_items.unit`, `blend_ticket_products`, 0 values carry
any JS-whitespace or invisible character and 0 carry a dotted `fl.`/`floz.`/`fl oz.`; 0 dry products lack an
inventory unit; `blend_tickets.payment_status` is NOT NULL.

- **#1 BLOCKER (dry product, dotted line and dotted inventory unit both → `fl oz`, converter's equality shortcut
  bills): refuted.** `trg_validate_product_units` only lets a product's `inventory_unit` be a `unit_conversions`
  row of its form or `both`; the dry/both rows are Dry oz, Ea, g, Lb, LB, MG, Unit. The `unit_size` fallback only
  applies when `inventory_unit` is blank, and no dry product has a blank one (live: 0).
- **#4 (screen predicts success, server refuses, dry product sold in `fl oz`): refuted** by the same trigger.
- **#2 (normalizer not idempotent: `fl oz` → `oz` on a second pass), #3 (punctuation decides meaning), #5 (label max
  `fl oz` vs rate `fl. oz` cannot compare):** no caller normalizes an already-normalized value (every caller passes a
  stored column); the label comparison was `cannot_compare` before too (no new false pass, no new false alarm). The
  undotted `fl oz` → `oz` on a dry product is the pre-existing LOW recorded in KI-16, for its own change.
- **#6 (a tab in the job line's `unit`):** this contract's whitespace rule covers rate units only; `unit` comes from a
  pick-list. Claim narrowed here, not widened.
- **#7 (holds with an inventory unit `gal<TAB>`): refuted** — `inventory_unit` must equal a `unit_conversions` row.
- **#21 (an idempotency key spent before deploy on a rate unit with such a character mismatches on retry):**
  accepted, wording fixed — any retry of such a request, not only in flight; live has 0 such job lines.
- **#22–#25 (wrapper payload shape, authority, other writers, tab-only unit):** the wrapper folds only when the payload
  is a JSON array and only a string `rate_unit`, keeps order (`WITH ORDINALITY`), turns `[]` into `[]` (COALESCE), and
  passes SQL NULL and non-arrays through untouched; its actor check and admin/non-admin branches are byte-identical
  (body diff in the PR). The row trigger already folds for every other writer. A tab-only rate unit is stored as a
  space-only one; both normalize to NULL, as before.
- **#27 (the copied existing-rows check would flag a deleted ticket's line): fixed** — the postflight skips
  soft-deleted tickets, matching item 4.
- **#31, #32 (wording):** the server now accepts more than old screens predict (an old screen may show a "will fail
  when you invoice" warning the server no longer needs: harmless). Refusals roll the whole save back (one
  transaction), rather than "before any write".
- **#33, #35, #39, #42:** the preflight pins all five replaced bodies, the postflight re-checks grants and SECURITY
  DEFINER; the prover asserts exact invoice quantities (R0, F1, F2); a vitest loop checks all 23 whitespace codes at
  both ends and inside a unit; after apply, live read-only constant-input probes call the helpers and the converter.
- **Out of scope (#1733's shipped guard design, reviewed by Sol over five rounds; not changed here):** #8–#20, #37,
  #38, #41, #43 (per-acre word forms, unpriced lookalike slash, blank-numerator equality shortcut, line moved between
  tickets, `no_charge` → billable, RLS visibility inside invoker triggers, isolation and lock ordering, catalog-default
  binding). Recorded in KI-16 as inherited, unverified.
- **#44 (suggestion: handle dotted spellings only in billing):** declined — billing's conversion input *is*
  `normalize_rate_unit`; a second path would be one more place to drift.

## Luna round 1 (gpt-6-luna xhigh, head 1d8a02b44, 6 findings) — dispositions

- **#1 HIGH (undotted `fl oz` on a dry product bills as weight ounces): deferred, out of this diff.** The `fl oz → oz`
  line is unchanged since `20260630170000`. Live read-only 2026-11-10: 0 products, job lines or blend lines use any
  `fl`/`fluid` spelling, so no record is affected. The obvious fix (map it to `fl oz` like the dotted forms) is unsafe
  alone: `field_app_priced_quantity` would return NULL on a dry product, and job demand
  (`COALESCE(…, jc.quantity)`, `20261206110000`) and stock deduction (`20261217100000`) would then use the raw
  quantity. It needs its own plan; KI-16 now records it as HIGH, latent.
- **#2 (RLS visibility in invoker triggers), #3 (`no_charge` → billable), #4 (line moved between tickets), #6
  (`pt per ac`):** inherited from `20261231100000`, already named as deferrals above and in KI-16; this PR neither
  creates nor widens them (#2's trigger only gains `deleted_at IS NULL`).
- **#5 (retry of a pre-deploy `save_job` key whose payload had a foldable character):** accepted as named in "State and
  failure": the retry gets the intent-mismatch refusal (fail closed, nothing written twice); live has 0 job lines
  with such characters.

## Luna round 2 (head 9d30760b3, 3 findings)

- **#1 HIGH (undotted `fl oz` on dry):** same as round 1 #1; it survived two rounds, so it goes to Mason as a decision
  (fix here, widening into demand and deduction, or its own plan).
  **Mason 2026-11-10: "Separate fix later"** — deferred to its own plan; recorded in KI-16.
- **#2 MED (spent pre-deploy idempotency key):** accepted, as round 1 #5.
- **#3 MED (invoker product guard misses RLS-hidden lines): refuted for live.** Live policies 2026-11-10:
  `products_update` is `is_admin()` only, and `blend_ticket_products_office_all` / `blend_tickets` select allow
  `is_admin()`, so any REST writer that can change a product sees every blend line; SECURITY DEFINER callers run as
  the owner and bypass RLS. Becomes real only if product edits are opened to a non-admin role.
