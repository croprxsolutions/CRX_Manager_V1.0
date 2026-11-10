# KI-16 last gap: a fluid ounce on a dry product — behavior contract (2026-11-10)

Base: `origin/claude/ki16-rate-unit-followups` (PR #1741, head b7349ce1c), on main b291ed9ad. Migration
`20261231120000_dry_product_fluid_ounce_guard.sql`, after #1741's `20261231110000`; it re-emits none of #1741's or
#1733's functions.

## Facts (read 2026-11-10)

- `normalize_rate_unit` maps `fl oz`, `floz`, `fluid ounce` (any whitespace/invisible spelling, any per-acre suffix)
  to `oz` (`20261231100000`, unchanged by #1741). `field_app_priced_quantity`'s DRY branch sizes `oz` as one weight
  ounce (`20260630180000`), so on a dry product 16 fl oz becomes 16 dry oz = 1 lb.
- Readers that size a stored unit that way:
  - job billing and holds/demand: `field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), ...)`
    (`20261204100000`, `20261206110000`, `20261107070000`);
  - job stock deduction in `complete_job` (`20261217100000`): same call on `jc.unit`, raw fallback when NULL;
  - blend billing in `create_invoice_from_blend_ticket` (`20261022020000`): `COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)`;
  - blend stock deduction in the application record (`20260713060200`): `btp.unit`.
- Writers: `job_chemicals` has no INSERT/UPDATE grant for `anon`/`authenticated` (live); it is written by
  `_save_job_cost_step2_impl`, `_create_job_from_quote_section_replay_impl_20261015` (copies `quote_items.price_unit`
  and `rate_unit`) and `load_recipe_into_job`. `save_job` already refuses a fluid ounce on a dry product on either
  side (`CHEM_UNIT_FORM_MISMATCH`, `20260904185900`); the other two do not check.
  `authenticated` holds column INSERT/UPDATE on `blend_ticket_products.unit`, `.rate_per_acre_unit`, `.product_id`
  and on `products.rate_unit`, `.product_form` (RLS: product writes are admin-only).
- `products.inventory_unit` on a dry product is limited to dry/both `unit_conversions` rows by
  `validate_product_units`, so the stock side never spells a fluid ounce.
- Live read-only 2026-11-10: 0 rows in `job_chemicals.unit/rate_unit`, `blend_ticket_products.unit/rate_per_acre_unit`,
  `products.rate_unit`, `quote_items.rate_unit/price_unit`, `blend_recipe_items.unit` name a fluid ounce (save_job's
  concept test), on any form; `blend_tickets` 0 rows.

## Outcome and the smallest change

A dry product's line can never be stored with a fluid-ounce unit, so no bill, hold or stock deduction can read one.
`normalize_rate_unit` and every reader stay as they are (changing the map would turn the wrong amount into a raw
fallback on demand and job deduction).

1. `unit_names_fluid_ounce(text) → boolean`, IMMUTABLE: save_job's concept test, verbatim, after
   `unit_fold_invisible`: fold separators, drop everything from the first `/`, drop a `per …` tail, delete every
   non-alphanumeric, match `^(fl|fluid)(oz|ozs|ounce|ounces)$`. Catches `fl oz`, `FLOZ/acre`, `fl. oz`,
   `fluid ounces per acre`, `fl<NBSP>oz`; passes `oz`, `dry oz`, `lb`, `flour oz`.
2. Four BEFORE row triggers, each a new SECURITY DEFINER function (reads only; EXECUTE revoked from everyone; definer
   so RLS never hides a row from the check), raising `CHEM_UNIT_FORM_MISMATCH` with save_job's wording:
   - `job_chemicals` INSERT, or UPDATE changing `unit`, `rate_unit` or `product_id`: refused when the product is dry
     and either unit names a fluid ounce. Covers save_job, scheduling from a booking, and recipes.
   - `blend_ticket_products` INSERT, or UPDATE changing `unit`, `rate_per_acre_unit` or `product_id`: refused when
     the product is dry and `unit`, or the unit billing uses (`NULLIF(btrim(rate_per_acre_unit), '')`, else the
     product's `rate_unit`), names a fluid ounce.
   - `quote_items` (bookings) INSERT, or UPDATE changing `rate_unit`, `price_unit` or `product_id`: refused when the
     product is dry and either unit names a fluid ounce (scheduling copies both into the job line).
   - `products` INSERT, or UPDATE changing `rate_unit`, `unit_size`, `inventory_unit` or `product_form`: refused when
     the product is (or becomes) dry and any of those three units names a fluid ounce, or, when it becomes dry, any job,
     booking or blend line names a fluid ounce for it (soft-deleted tickets included: an admin can clear `deleted_at`
     through the table API; a blend line with a blank rate unit counts by the product's OLD rate unit, the one it was
     entered against, so changing form and rate unit in one edit cannot slip past).
3. Race between a line save and a product turning dry: the job and booking sides take
   `pg_advisory_xact_lock_shared(160017, hashtext(product_id))` only when a unit names a fluid ounce (the blend side
   always, since a blank line inherits the product's unit), then reads the
   form; the product side takes the exclusive lock when the form becomes dry, then looks for lines. Whichever commits
   first is seen by the other (READ COMMITTED, which every app path uses: each statement in the trigger takes a fresh
   snapshot). Shared locks never block each other, so line saves never wait on one another.

Who may act is unchanged: no grant, policy or RPC signature changes.

## State and failure

- Existing rows: 0 live rows are affected; the postflight re-checks that every stored row passes, and refuses the
  migration otherwise. Rows are checked only when a unit, product or form changes, so other edits never trip it.
- Rollout: the app already deployed sends what save_job accepts; the job screen mirrors save_job's refusal. A blend
  ticket or product screen that sends a dry fluid ounce now gets the error toast instead of a save (0 live cases).
- Timing/idempotency: a refusal rolls back the whole RPC (no partial ticket/job, no spent key). No new mutating RPC.
- Not covered (named): `gal`, `pt`, `qt`, `l`, `ml` on a dry product already convert to nothing; billing refuses them
  and job completion deducts the raw number flagged for office review (existing, known design). Recipes
  (`blend_recipe_items`) are not guarded at save; a dry fluid-ounce recipe line is refused when loaded into a job (0 live
  rows). A product's default rate unit changing under blank blend lines is a general unit question, not a fluid-ounce one.
- Undo: none needed; nothing is written by the change.
- Rollback: its own reviewed migration dropping the four triggers, their functions and the helper, only if the guard
  blocks legitimate work; a forward fix is preferred.

## Proof cases (container prover, real migrated schema, extending `scripts/smoke/prove-rate-unit-guard-real-schema.mjs`)

- G-BEFORE: a dry product line `fl oz` reaches a job through `create_job_from_quote_section`; its demand sizes 16 as
  1 (lb); a blend ticket line `fl oz/ac` on a dry product saves and its invoice bills 16 fl oz/ac × 100 ac as 100 lb.
- G0: the migration applies; a second run refuses with nothing changed.
- G1: scheduling a stored (pre-guard) booking whose dry line is `fl oz` is refused (`CHEM_UNIT_FORM_MISMATCH`), no
  job; save_job still refuses as before; a liquid `fl oz` line schedules; `save_quote` (signed-in admin) refuses a dry
  `fl oz` price unit or `FLOZ/acre` rate unit, saves dry `oz` and liquid `fl oz`; editing or moving a booking line onto
  a dry fluid ounce is refused.
- G2: blend ticket lines on a dry product are refused for rate `fl oz/ac`, `FLUID OUNCES per acre`, `fl. oz`, a
  quantity unit `fl oz`, and a blank rate on a dry product whose own rate unit is `fl oz` (product set by owner);
  `oz/ac`, `dry oz`, `lb/ac` save and invoice; a liquid `fl oz/ac` saves and invoices; an edit moving a `fl oz` line to
  the dry product is refused.
- G3: a direct `job_chemicals` insert/update (owner) with `unit` or `rate_unit` `fl oz` on a dry product is refused;
  `oz` on dry and `fl oz` on liquid save; an unrelated edit saves.
- G4: products: setting a dry product's rate unit, unit size or stock unit to `fl oz` is refused; flipping a liquid
  product to dry is refused while a job, booking or blend line (also on a soft-deleted ticket, and a blank-rate line
  when the same edit changes the rate unit) names a fluid ounce for it; allowed once none does. Race, both orders, two
  real sessions: a line saved while the product turns dry (and the reverse) — the second one is refused, and no dry
  fluid-ounce line is stored.
- G5: helper table: the spellings in item 1.

## Open business decisions

None. Refusing a fluid ounce on a dry product is save_job's existing rule (Mason's KI-16 direction 2026-11-10:
"Separate fix later"), applied to every other writer.

## Plan challenge (Astra, gpt-6-astra high, 2026-11-10): 26 findings, dispositions

- Fixed in the design: booking lines guarded (#12); product `unit_size`/`inventory_unit` checked (#4); a blank blend
  line counts by the OLD product rate unit (#9); two-session race proof (#7); legitimate dry invoices proved (#20);
  wording (#18, #19, #22).
- Settled by evidence: RLS cannot hide rows from the checks (owner `postgres` has BYPASSRLS; RLS not forced) (#1);
  the triggers sort last on each table and compare final NEW with OLD (#2); foreign keys to products are not
  deferrable and the form CHECK is lowercase (#5); `product_id` indexes exist on every line table (#25);
  `invoice_items` history has 0 fluid-ounce rows on dry products (#16); the postflight runs after `CREATE TRIGGER`
  (which locks each table) in the same transaction with `lock_timeout` 5s (#15, #17).
- Accepted with reasons: app paths run READ COMMITTED (named assumption, #6); shared locks never conflict and Postgres
  detects the rare admin deadlock and rolls one back (#8); a product with fluid-ounce history cannot become dry — the
  remedy is a separate dry product, since reinterpreting billed history is wrong (#10); rollback only if the guard
  blocks legitimate work (#24).
- Out of scope: #11 (inherited from #1741); extending #1741's existing guards instead of new triggers (#26), declined so
  this file re-emits no function under review in #1741.

## Database reviewers (rls-security-reviewer, migration-drift-reviewer, opus, 2026-11-10): 0 BLOCKER/HIGH

- Fixed: the booking trigger renamed `zzz_quote_items_dry_fluid_ounce_guard` so it sorts last, like the other three;
  the postflight now refuses if a guard function's owner could be filtered by RLS (live owner `postgres` has BYPASSRLS).
- Corrected fact: `guard_product_setup_fields` (`20261102102000`) already refuses changing a saved `product_form`, so
  only a product whose form was never set (`product_form` is nullable; live 0 such products of 606) can become dry.
  The becoming-dry branch stays for that path; the prover now proves liquid-to-dry is locked and uses unset-form
  products for G4 and the race.
- Accepted, named: the job trigger is stricter than save_job, which skips its form check on zero-quantity
  customer-supplied lines; a dry line in fluid ounces is refused there too (no live rows; nothing billed or held).
  Deadlocks (`40P01`) between a multi-product line save and a multi-product NULL-to-dry edit are possible and
  Postgres rolls one back; nothing wrong is stored. A refused caller could learn a product is dry from the message;
  every active profile can already read products.
- Not covered, all fail closed: recipes (`blend_recipe_items`) and product parents (`product_parents.rate_unit`) are
  refused when copied onto a job or a dry size; restoring an old quote version holding a dry fluid ounce is refused;
  a size with a number (`32 fl oz`) is not matched but converts to nothing; plain `oz` lines on a product whose form
  was never set read as fluid ounces and would read as weight ounces after it is set to dry (0 such products live).
- For #1741 (not changed here): `authenticated` holds UPDATE on `blend_tickets.deleted_at` (live, read-only
  2026-11-10), so a soft-deleted ticket can be restored; `20261231110000`'s product rate-unit guard skips deleted
  tickets. Its prover (F4) shows a restored blank-rate line is refused at billing, so it fails closed.

## Luna round 1 (gpt-6-luna xhigh, head 93ae69a06): 0 BLOCKER/HIGH, 3 MED

- Fixed: a dry product's package size or stock unit that leads with a number (`32 fl oz`) is now refused too
  (prover G4).
- #1741's file (not changed here): a restored soft-deleted ticket can become unbillable, and a save_job retry with
  foldable characters returns `IDEMPOTENCY_INTENT_MISMATCH`; both fail closed and are recorded in #1741's contract.
