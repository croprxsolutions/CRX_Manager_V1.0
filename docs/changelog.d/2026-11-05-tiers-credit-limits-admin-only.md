## 2026-11-05 — Price tiers and credit limits are admin-only; a booking's tier and planned flag change only by saving the quote

- New migration `20261111100000_tiers_credit_limits_admin_only.sql` (not applied; record in
  `docs/reference/migrations.d/`). Mason's decision of 1 Nov: only an admin sets or changes a
  customer's price tier or credit limit. The customer guard that already keeps the commission split
  admin-only now refuses a sales rep's tier or credit-limit change (`TIER_ADMIN_ONLY`,
  `CREDIT_LIMIT_ADMIN_ONLY`) through the API, `save_customer` and Bulk Customer Import. A rep's new
  customer starts on the Settings Default Tier with no limit. Its trigger now also fires on those two
  columns; before, a direct update of just the tier never reached it.
- A booking's tier and planned flag change only through `save_quote`: a direct API update of either
  is refused (`QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE`), admins included. The screens' direct status and
  soft-delete updates don't touch them.
- Customer screen: Pricing Tier and Credit Limit are read-only for a sales rep, with a one-line note.
  Bulk Customer Import puts a rep's rows on the Default Tier whatever tier the file says, and says so.
- Proof: permission matrix 264/264 on the local test copy (new W07b, P15–P18; W07 now admin-only;
  W05 green); smoke chain `smoke-tiers-credit-limits-admin-only.sql` passes after and fails on the
  old bodies at A, B, D and F.
