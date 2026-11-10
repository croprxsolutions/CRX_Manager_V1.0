**LOCAL CANDIDATE — NOT APPLIED.** `20261231110000_rate_unit_followups_whitespace_dotted_floz_save_job_fold.sql` (SQL sha256: `d6300ca3113739add574435bcb46efdb81c666cb732eb1dce770c3a4c7ecd380`). KI-16 rate-unit follow-ups after `20261231100000`: dotted "fl. oz" reads as fluid ounces, `save_job` folds invisible characters before its own denominator check, one whitespace rule (what JavaScript `trim()` strips) on both sides, and soft-deleted blend tickets no longer block a product rate unit edit.

**What changes.** `unit_fold_invisible` also maps TAB, LF, VT, FF, CR, U+1680, U+2000-U+200A, U+2028, U+2029, U+205F and U+3000 to a space (it already mapped U+00A0, U+2007, U+202F and deleted U+00AD, U+200B-U+200D, U+2060, U+FEFF). `normalize_rate_unit` keeps its body and maps `fl. oz`, `fl.oz`, `fl oz.`, `fl. oz.`, `fl.oz.`, `floz.` to `fl oz` (liquid billing sizes it; dry billing still refuses it). `guard_product_rate_unit_for_blend_lines` adds `t.deleted_at IS NULL`. The 731-char `save_job` wrapper rewrites each chemical line's string `rate_unit` and stock `unit` through `unit_fold_invisible` before calling the unchanged `_save_job_cost_step2_impl`; its actor check and admin/non-admin branches are unchanged.

**Who may call.** No grant changes; all restated. `save_job`: SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE authenticated and service_role. Helpers: invoker, EXECUTE authenticated and service_role. Trigger function: EXECUTE revoked from PUBLIC, anon, authenticated, service_role.

**Preflight.** One transaction, `lock_timeout` 5s; refuses unless all five bodies (`normalize_rate_unit`, `unit_fold_invisible`, `guard_product_rate_unit_for_blend_lines`, `save_job`, `_save_job_cost_step2_impl`) match their live md5s read 2026-11-10. Postflight checks each folded character, the normalizer table, the dotted conversion on liquid and dry, the impl md5 unchanged, the three guard triggers enabled, grants and SECURITY DEFINER, and that no existing line (soft-deleted tickets skipped) would be refused.

**Proof.** `scripts/smoke/prove-rate-unit-guard-real-schema.mjs` (real schema; R0 and FB-F5 bill real invoices through `create_invoice_from_blend_ticket` and save through `save_job`; prints `RATE_UNIT_GUARD_PROOF_PASS`).

**Rollback** (its own reviewed migration): re-create the four previous bodies from `20261231100000` and `20261019230000`. No data changes; job lines saved meanwhile keep their folded rate unit.

Contract: `docs/plans/2026-11-10-ki16-rate-unit-followups-CONTRACT.md`.
