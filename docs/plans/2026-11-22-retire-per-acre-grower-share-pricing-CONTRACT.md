# Behavior contract: retire per-acre grower-share pricing (2026-11-22)

Read at `origin/staging` f8ee14ee8.

## Outcome and authority

**Business rule (Mason, 2026-11-22):** "we never bill a flat price per acre for chemical etc, we always bill line by line but if we quoted and locked that price in for customer those prices need carried forward when invoicing."

**Feature retired:** a field's per-acre price override.
- It is stored as `field_billing_defaults.price_override_cents` plus its `pricing_note`. Source: `20260221200000_grower_share_pricing.sql:12`.
- When set, every invoice path billed that farm's share as one "$X/acre" line, and the chemicals inside it at $0 ("grower share" line kind).

**Kept unchanged:**
- Splitting a field between several payers by percent (`split_pct`, the "grower shares" block on PDFs).
- Line-by-line billing.
- Quoted and locked prices. The carry-forward is a separate PR, `claude/spray-invoice-quote-price-c2a6fc`.

**Smallest change:**
1. **One new migration** adds `CHECK (price_override_cents IS NULL AND pricing_note IS NULL)` on `field_billing_defaults`, and `CHECK (price_per_acre_cents IS NULL AND pricing_note IS NULL)` on `invoice_shares` (Sol r1: a draft saved at a per-acre rate keeps that rate on its share and would still post it after the split was cleared; an admin could also type a rate straight onto a draft share).
   - Every per-acre branch reads its override from this one table: `derive_customer_shares_from_fields`, read by the field-app save, split save, preview and blend-ticket invoice, and the job transfer's direct `fbd.price_override_cents` read.
   - The below-cost wall's grower-share exemption is only marked by those callers.
   - So once no row can hold a value, every per-acre branch is unreachable.
   - Writers are `save_field` (via `elem->>'price_override_cents'`, `elem->>'pricing_note'`) and nothing else in the app. A crafted call is refused by the constraint itself. No RLS or SECURITY DEFINER path can bypass a CHECK.
2. **Screens stop offering it:**
   - Field Setup: remove the "Price Override ($/ac)" and "Pricing Note" inputs, and send null.
   - Field Dashboard: remove the "$/ac override" display.
   - Field-application invoice editor: remove the "Grower-share pricing is active" banner and its lookup.
   - Job Detail: remove the "Grower-share override active" banner and its lookup. Keep the `SPLIT_OVERRIDE_UNSUPPORTED` toast and its `src/lib/db.ts` code entry: the transfer raises that code only when a field has an override, so it is unreachable while the constraint holds, and the toast covers a database rollback window.

**Deliberately NOT changed (dead but harmless):**
- **The per-acre branches inside the money RPCs:** save, split save, preview, blend-ticket invoice, transfer, and the wall's grower-share exemption.
  - Re-emitting five pinned money functions to delete unreachable branches adds risk and collides with in-flight PRs that pin those bodies: below-cost and quote-price for the transfer, and the field-billing lanes.
  - Behavior is identical with or without them once the constraint holds. Deleting them is an optional later cleanup.
- **`src/components/ui/BelowCostApprovalModal.tsx` wording.** It is hands-off (Taha) and unreachable.
- **`errorSanitizer.ts` `FIELD_APP_GROWER_SHARE_*` text.** Both sibling PRs edit that file; the text is unreachable.
- **PDFs.** They print `invoice_shares.pricing_note` beside a payer's name whenever it is set; live has 0 such rows, and the new CHECK keeps it empty. A legacy manual line can print its stored description, which could carry per-acre wording; live has 0 such lines.

## State and failure

- **Rule that always holds:** no `field_billing_defaults` row and no `invoice_shares` row has a per-acre price or pricing note. Both are enforced by validated CHECKs, so they hold in every transaction.
- **Existing rows** (production, read-only, 2026-11-22):
  - `field_billing_defaults`: 6 rows; 0 with an override; 0 with a non-blank note.
  - `invoice_shares`: 3 rows; 0 with `price_per_acre_cents`; 0 with a note. `invoice_items`: 0 lines containing "grower share" or "/ac" wording.
  - **Decision (Mason, 2026-11-22):** the feature was never used (the counts above), so the migration adds the two constraints and does not search invoice history for per-acre invoices.
  - The migration's preflight locks both tables (ACCESS EXCLUSIVE, the ALTERs' own mode), re-counts splits and shares, and refuses (`PER_ACRE_PRICING_IN_USE`, naming the count) if any row has either, so it never silently clears a price.
  - It does not blank-coerce: an empty-string note also blocks the apply.
- **Already-deployed app during rollout:**
  - The old Field Setup still shows the inputs. Saving a field with an override typed in is refused, and nothing is saved.
  - A save without one is unchanged: the old screen sends `|| null`, so a blank note is null.
  - No reader changes.
- **Timing:** a single DDL statement under `lock_timeout`. A concurrent `save_field` either commits first (and the preflight's count in the same transaction sees it, because the ALTER validates all rows) or waits on the lock.
- **Undo:** `scripts/smoke/retire-per-acre-pricing-reverse.sql` drops the constraint. No data was changed, so nothing else needs restoring.
- **Automatic record changes:** none.

## Delivery (corrected after the Astra challenge)

Two PRs, database first:

1. **Database PR.** It holds the migration, the reverse script, the prover, this contract and the ledger record. It is compatible with the deployed app. The old Field Setup still shows the inputs; typing a per-acre price there is refused, and nothing is saved.
2. **Screen PR.** It merges only after the constraint is live on staging. Shipping the screens first would let a save from the new Field Setup silently null an override typed meanwhile in an old tab, and the preflight would then count zero.
   - It removes the Field Setup inputs, the Field Dashboard display, both banners and their lookups.
   - It also removes the amber Customers-tab hint that says preview applies "grower-share overrides" (`FieldApplicationInvoice` ~3592).
   - It keeps the `SPLIT_OVERRIDE_UNSUPPORTED` toast mapping. It is harmless and covers a database rollback window.

## Astra cold challenge (gpt-6.2-astra high, 2026-11-22, 33 findings): settlement

- **Settled by correcting this contract:**
  - Release order (10, 11, 32): two PRs, database first.
  - Exact-predicate recount (19): live 2026-11-22 found 0 of 6 rows with `price_override_cents IS NOT NULL OR pricing_note IS NOT NULL`.
  - The amber hint (12).
  - Lock before count (27): the preflight now takes `ACCESS EXCLUSIVE` (the ALTERs' own mode, Sol r2) before it counts.
  - Real saves after the constraint, not only preview (30): the prover runs `save_field_app_invoice` on a 60/40 field.
- **Disproved:**
  - Note without a price (8): live has 0 notes of any kind.
  - Idempotent replay (15): a replay returns an earlier result and writes no row, so the invariant holds. The prover tests a fresh call.
  - The old client's typed 0 (13): `|| null` sends null, which is allowed and means "no override", the same as today.
- **Out of scope:**
  - The quote-price PR: findings 4, 5, 6 and 9.
  - Split boundaries and stale tabs (17, 18): pre-existing; behavior is unchanged by this PR.
  - Historical documents (20–23): none exist live.
  - The below-cost wall and approval modal (25, 26): the bodies are unchanged, and the modal is in hands-off `src/components/ui`.
- **Decision 29** (a positive count at apply): the preflight stops and names the count. An admin then contacts Mason. No automatic clearing.

## Proof cases

| # | When … | then … | Proof |
|---|---|---|---|
| 1 | migration applied on a replayed schema with 0 override rows | applies; constraint exists and is validated | real-schema prover |
| 2 | a row with an override exists before apply | apply refuses `PER_ACRE_PRICING_IN_USE`, nothing changes | prover (rolled back) |
| 3 | `save_field` called as an admin with `price_override_cents` set, or a non-null `pricing_note` | refused by the CHECK (23514); the field's existing splits are unchanged | prover, as authenticated admin |
| 4 | `save_field` with plain percent splits (two payers 60/40, null override and note) | saves both rows exactly as before | prover |
| 5 | `save_field_app_invoice` for a 60/40 split field (10 Gal at $30, no service) after the constraint | farm A billed $180.00 and farm B $120.00, each on a priced chemical line; no per-acre line (before the constraint, with A at $20/ac, A got a per-acre line and a $0 chemical) | prover |
| 6 | reverse script run | constraint gone; a second run refuses | prover |
| 7 | Field Setup screen | no per-acre or note inputs; saving a 60/40 split works | unit test + browser on local vite |
| 8 | Job Detail / field invoice editor | no grower-share banner; no lookup query | unit test |

## Open business decisions

None. Mason's rule above settles it, and it reverses no recorded decision: the 2026-02-21 feature had no live users.
