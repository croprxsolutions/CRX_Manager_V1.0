# Pricing audit top 4 fixes: behavior contract

Read at `origin/staging` `e1e2d6f99` (2026-11-25). Source: Mason's "CRX Pricing & Cost Audit — Nov 2026", items 1-4 ("Yes, start fixes", 2026-11-24). Out of scope: Tier 1 lowest-or-highest question (open with Mason), any tier-order logic, `supplier_cost_basis_enabled`.

## 1. Below-cost approval lists every line it covers

**Outcome.** Before an admin types a below-cost reason, the prompt lists every line in that save priced below today's cost: product, price, cost, quantity and total shortfall, plus the save's total shortfall.

**Facts.**
- `_enforce_below_cost_line` (newest body `supabase/migrations/20270201180000_grower_share_rep_needs_price_to_cover_cost.sql:47`) is a row trigger. It compares each line's price with `products.current_cost` (locked `FOR SHARE`), raises `BELOW_COST_REASON_REQUIRED:<detail of the first below-cost row>` when the admin gave no reason, and, on retry, logs every below-cost row in that transaction under the one reason from `app.crx_below_cost_reason`.
- Only an active admin ever reaches `REASON_REQUIRED`; a rep gets `ADMIN_REQUIRED` first (same trigger).
- Admins read cost only through `get_admin_cost_fields` (SECURITY DEFINER, admin-only; `src/lib/costFields.ts`).
- The prompt (`src/contexts/BelowCostApprovalContext.tsx`, `src/components/ui/BelowCostApprovalModal.tsx`) names only `detail.product_name`, with a sentence that the reason applies to every below-cost line.

**Smallest change (front end only, no migration).** `runWithBelowCostApproval(attempt, lines?)` takes an optional function that returns the save's lines as the screen will send them (`product_id`, name, unit price in cents, quantity; a non-product line may carry its own cost in cents). On `REASON_REQUIRED` only, the provider calls it, reads today's cost of those products through `fetchAdminCostFields('products', …)`, and passes the below-cost lines to the prompt. Each save screen that holds its lines passes them; paths that copy stored rows server-side read the source quote's lines.

**Authority.** Unchanged. The database remains the only enforcement and the only audit record. The list is information for the admin; it never decides what is approved. Nothing is sent to a rep (the provider only asks for cost after an admin-only refusal, and the cost lookup itself refuses non-admins).

**Failure and mismatch.** The list is computed from the screen's lines and today's cost, so it can differ from the database's view (the server re-derives quote prices and quantities; cost can change between the refusal and the lookup). Therefore:
- The database-reported line is always shown, with the database's price and cost.
- If the screen gave no lines, the lookup failed, or the computed list does not contain the database-reported product, the prompt keeps today's warning ("the reason applies to every below-cost line in this save, not only the one shown") and says the full list could not be confirmed.
- Retry, double-click and idempotency are unchanged (same `attempt` and reason transport).

**Proof cases.**
- When an admin saves an order with two lines below cost and one above, the prompt lists exactly the two, each with its shortfall, and the total. (Unit test of the provider + browser check on staging.)
- When the screen passes no lines, the prompt shows the database-reported product and the "applies to every line" warning. (Unit test.)
- When the computed list misses the database-reported product, that product is still listed and the warning shows. (Unit test.)
- When the cost lookup fails, the prompt still opens with the database line and the warning; the save is not blocked. (Unit test.)
- When a sales rep saves below cost, they still get "requires an admin" and no cost lookup is made. (Unit test.)

## 2. Supplier price-history chart uses one unit

**Facts.** `get_product_price_history` returns `normalized_cost_cents` (per inventory unit) and `cost_cents` (per supplier package / PO unit). The chart plots `normalized_cost_cents ?? cost_cents` (`src/components/products/ProductPriceHistory.tsx:108`), so an un-normalizable point is plotted in package units on the same axis.

**Change.** Plot only points that have `normalized_cost_cents`; title the chart "per inventory unit"; count the left-off points under the chart ("N points in package units are listed below but not charted"). In the list, an un-normalized amount is labelled "per package". Display only; no data or cost-basis selection changes.

**Proof.** When history mixes normalized and package-only points, only normalized points are drawn and the left-off count shows. (Unit test + staging screenshot.)

## 3. Margin typed as a fraction; prices hugging cost

**Facts.** Sheet margins are whole percents (`18.5` = 18.5%). `0.35` is read as 0.35%; on staging that priced a $6.40-cost product at $6.42. Preview warnings come from the database; each warned product needs a typed reason (`pricingAcknowledgements`).

**Change.**
- `assertPricingPreviewRowsSafe` (runs before every pricing preview: sheet, bulk grid, product page) refuses a margin-driven row with any tier margin greater than 0 and below 1, naming the product and tier: "type 35 for 35%". Nothing is previewed or saved. A margin of exactly 0 is allowed (it is caught by the next rule).
- The preview marks every ready row whose new tier price is at or above cost but within 2% of cost (`price × 100 < cost × 102`, cost above 0). Each such product needs its own tick box ("Yes, Tier N at $X is meant to be within 2% of its $Y cost") before Apply is enabled; a typed reason alone does not clear it.

**Authority.** Admin-only screens; the database is unchanged. These are input-mistake guards on the admin screen, not new financial invariants: below-cost is still enforced in the database (`PRICE_BELOW_COST` warning, the below-cost line trigger at sale).

**Proof.** `0.35` margin is refused with the message; `35` passes; `0` passes the refusal. A preview with a $6.42 price on $6.40 cost keeps Apply disabled until the tick box is ticked, even with a reason typed. (Unit tests + staging run with a staging test product, restored afterwards.)

## 4. Export fills pricing_mode

**Facts.** Products store no mode; the screens infer it with `defaultPricingMode` (all three prices set = `price_driven`; else all three margins = `margin_driven`; else blank). The export writes `pricing_mode: ''` (`src/lib/productPricingWorkbook.ts:457`), and a changed row with a blank mode is refused (`WORKBOOK_BLANK_MODE_CHANGED_VALUES`).

**Change.** The export writes `defaultPricingMode` of the product's current prices and margins, the same default the bulk grid already shows. Mixed rows stay blank. A price-driven row whose margins are edited is still refused with the existing "to change margins, set margin_driven" message, so no edit is silently dropped.

**Proof.** Exported sheet has `price_driven` on a product with three prices; re-uploading the untouched sheet previews as unchanged; editing a price previews as ready without touching the mode cell. (Unit test + staging export/upload, no apply.)

## Delivery

One PR into `staging`, front end only, no migration. Verified on staging as an admin with staging test products, each restored.

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-25): 40 findings, how each was settled

**Fix 1 (findings 1-14, 39).** Accepted. A list worked out on the screen can disagree with what the database approves in both directions: it can show lines the database won't flag and miss lines it will. Causes: server re-pricing of quotes, exempt order-linked invoice lines, total-cost fees, restore and draw-down rows, and a retry that runs in a later transaction. The front-end-only design cannot meet "lists every line". DECISION sent to Mason (Q1): split fix 1 into its own database-first PR (recommended), ship a labelled estimate, or leave it. Fix 1 is not built until he answers.

**Fix 2.** 15: the list renders independently of the chart (built that way). 16: an unconverted amount is labelled "per supplier unit", not "per package". 18: the left-off count is taken after the supplier filter. 17 (older basis rows copied into the normalized field without a historical-unit check) is a pre-existing data question. It is out of scope and listed in the PR as a follow-up.

**Fix 3.** 19: DECISION (Q2, recommend refuse). 20: a sheet row whose margin equals its current_ cell is not refused. The product page and bulk grid re-send current margins, so a product already saved under 1% is refused there with a "use price_driven" path (listed in the PR). 21: an Excel cell formatted as a percent stores 35% as 0.35. The refusal catches it and its message gives the fix. 22: uses the preview's after-cost and after-prices on ready rows with pricing changes, 2% included (`price × 100 ≤ cost × 102`). 23: lists every affected tier. 24: shown and required even with no database warning. 25: ticks are scoped to the change set, and the Apply click re-checks. 27: DECISION (Q3, recommend screen check only). 38: existing mis-priced products are out of scope; a read-only report is a possible follow-up.

**Fix 4.** 28/29: mode is read from the nullable export values before formatting, in the same order as `defaultPricingMode`. 30: DECISION (Q4, recommend price_driven as the bulk grid does). 31-33: verified on staging (blank companion cell, reason/source required, untouched round trip). 34: the validation prompt now explains the pre-filled value.

**Delivery (35-37).** Staging checks use staging test products. Each change is recorded and restored, and any history rows a staging apply leaves are named in the PR.
