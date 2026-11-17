**LOCAL CANDIDATE — NOT APPLIED.** Sol HIGH on the staging billing work (17 Nov, #1940 round 21, at `20270117120000_billing_sol_fixes_staging.sql:361`): `20270124140000_draft_tax_follows_box_on_post.sql`.

- **HIGH (a kept Bill Split draft could post with the wrong tax):** `set_order_sales_tax` keeps the tax of a draft the save path can't re-save and lists it in `drafts_kept`; nothing stopped that draft posting. New trigger `zz_sales_tax_matches_box_on_post_20270124` (function `guard_sales_tax_box_on_post_20270124`, `SECURITY DEFINER`, no grants): a chemical-sale draft leaving draft (to unposted, posted, paid or overdue) is refused (`SALES_TAX_BOX_MISMATCH`) when it has a tax rate but its sale's box is off, or the box is on, it has none, and the M4 switch is on. Unposted invoices posted again are not checked.
- **Existing rows:** live has none affected (M4 off, no rate rows). The postflight reports how many drafts it would refuse.
- **Proof:** `scripts/smoke/prove-draft-tax-follows-box-real-schema.mjs` (chain `smoke-draft-tax-follows-box.sql`). Contract: `docs/plans/2026-11-17-draft-tax-follows-box-CONTRACT.md`.
- **Rollback:** its own reviewed migration: drop the trigger and the function.
- **Ordering:** after `20270117140000_billing_m4_db_switch`.

- Luna round 1 (2026-11-17): the trigger also checks soft-deleted drafts (its WHEN no longer requires deleted_at IS NULL).
- Luna round 2 (2026-11-17): the preflight requires the stale-line trigger to call its own function; postflight counts include soft-deleted drafts.
