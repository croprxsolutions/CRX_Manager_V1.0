**LOCAL CANDIDATE — NOT APPLIED.** `20261231120000_dry_product_fluid_ounce_guard.sql` (SQL sha256: `219b5ff4150789600a0780d24d04db764a321a65690ae550c1812bf697f1b23a`). KI-16 last gap: a fluid ounce on a DRY product is refused wherever it is stored, so it can no longer bill, hold or deduct as weight ounces (16 fl oz as 1 lb).

**What changes.** New `unit_names_fluid_ounce(text)` (IMMUTABLE; save_job's fluid-ounce concept test after `unit_fold_invisible`). Four new BEFORE row triggers, each on its own SECURITY DEFINER read-only function, raising `CHEM_UNIT_FORM_MISMATCH`: `trg_job_chemicals_zz_dry_fluid_ounce_guard` (`unit` or `rate_unit` on a dry product), `trg_zz_blend_ticket_products_dry_fluid_ounce_guard` (`unit`, or the unit billing uses: the line's rate unit, else the product's), `zzz_quote_items_dry_fluid_ounce_guard` (a booking line's `rate_unit` or `price_unit`), `trigger_zzzzz_products_dry_fluid_ounce_guard` (a dry product's `rate_unit`, `unit_size` or `inventory_unit`; and `PRODUCT_SETUP_INVALID` for a product with no form). `products.product_form` becomes NOT NULL (Mason 2026-11-10: every product needs a form; a saved form already cannot change, so no product can turn dry under its lines; the spreadsheet import of a blank-form product is now refused). `normalize_rate_unit` and every reader are unchanged.

**Who may call.** `unit_names_fluid_ounce`: EXECUTE authenticated and service_role only. Trigger functions: SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE revoked from PUBLIC, anon, authenticated, service_role. No other grant, policy or RPC changes.

**Preflight.** One transaction, `lock_timeout` 5s; refuses unless `20261231110000` is applied (tab folding and dotted `fl. oz`) unless `unit_names_fluid_ounce` does not exist yet, and unless every product has a form. Postflight checks the helper on 22 fluid-ounce spellings (package counts such as `32 fl oz` included) and 18 non-matches, the four triggers enabled, `product_form` NOT NULL, grants, and that no stored row or product would be refused.

**Proof.** `scripts/smoke/prove-rate-unit-guard-real-schema.mjs` GB-G5 (real schema; BEFORE: a dry blend line bills 200 fl oz as 12.5 lb through `create_invoice_from_blend_ticket`; AFTER: refused at save on every path; prints `RATE_UNIT_GUARD_PROOF_PASS`).

**Rollback** (its own reviewed migration): drop the four triggers, their functions and `unit_names_fluid_ounce`; drop NOT NULL on `products.product_form`. No data changes.

Contract: `docs/plans/2026-11-10-ki16-dry-fluid-ounce-CONTRACT.md`.
