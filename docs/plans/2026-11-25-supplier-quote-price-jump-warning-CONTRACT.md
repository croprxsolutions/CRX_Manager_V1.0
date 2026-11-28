# Supplier quote price-jump warning: behavior contract

Follow-up to `2026-11-24-supplier-quote-unit-floor-CONTRACT.md` (Astra #4, plausibility). Read at `origin/staging`
`c8f9f8e77`.

## Outcome and authority

- **Result:** on the Supplier Pricing "Staged import" review of an import still awaiting review, a pending row whose
  cost per inventory unit is far from the current approved price for the same product supplier link shows one plain-English warning line naming both
  amounts (for example a $4,500.00 typo for $45.00). It is a warning only: selection, approval and every server path
  are unchanged.
- **Smallest change:** screen only, `src/pages/SupplierPricing.tsx` and its test. The page already loads
  `get_supplier_pricing_workspace` with no filter, whose `evidence` comes from `get_supplier_market_evidence(NULL)`
  (newest body: `supabase/migrations/20260720230000_supplier_pricing_durable_replay_and_reject.sql`). Each
  `evidence[].suppliers[]` entry is the link's latest current, uncorrected approved observation with
  `normalized_cost_cents = round(cost_cents / package_quantity / inventory_units_per_supplier_unit)`: the same
  formula the row's own converted cost uses (`supplierUnitCostCents`). No database change, no new read.
- **Who may act:** unchanged. The page and both RPCs are admin-only; the warning adds no action.
- **Server enforcement:** none needed. The warning changes no stored data and no decision the server makes. Approving
  an observation never changes sell prices or cost basis (cost basis needs its own approval).

## Facts the warning relies on

- Only `approve_supplier_price_import` and `correct_supplier_price_observation` insert observations, so every
  observation is an approved (or corrected) price.
- "Current approved price" = the evidence entry for that link: among the link's observations that are effective today
  (Chicago date) and not replaced by a correction, the one with the latest effective date, then latest saved. It is
  not necessarily the most recently approved one, so the text says "current approved … (effective DATE)".
- Evidence leaves out archived suppliers (`vendors.deleted_at`), inactive links and inactive products. Those links get
  no warning. Future, expired or corrected observations are skipped one by one, so another eligible observation on the
  link can still be the comparison. The warning is a typo catch, not a guarantee.
- The comparison is a snapshot of the workspace as loaded; Refresh reloads it. No promise about prices approved in
  another tab since.
- Both amounts use the link's conversion factor (a link with approved history cannot change it:
  `SUPPLIER_LINK_WITH_HISTORY_IMMUTABLE`) and the same whole-cent rounding. Rounding to the cent can hide a swing when
  the price per inventory unit is a few cents (a per-ton quote on a per-pound product); accepted, see Sol below.
- The row's amount and unit label are the converted cost the screen already shows (unchanged behavior, including how
  a missing conversion unit is labeled and the "package size too large" text).
- The row's converted cost is shown only when the link is comparable, active, has a factor above 0 and converts to
  the product's inventory unit; the warning uses exactly that value, so it never appears where no converted cost is
  shown.

## Rules

- Warn when the row's cost per unit is more than 40% above or more than 40% below the current approved cost per unit
  (Mason, 2026-11-25: "any chemical that is more than 40% price swing"): `new × 10 > old × 14` or `new × 10 < old × 6`.
  Exactly 40% either way does not warn. Every product, whole cents, BigInt arithmetic.
- No warning when the link has no approved price, its approved price per unit is $0.00 or not comparable, the row is
  not pending (`new`, `changed`, `cannot_compare`), or the import is no longer `needs_review`. A staged cost is
  always above $0 (`COST_MUST_BE_POSITIVE`).
- The text names the row's cost per unit, the current approved cost per unit and its effective date, and says the
  warning does not block approval. The approve confirmation adds "Check first: N selected row(s) are more than 40%
  away from the current approved price." so a warned row cannot be approved unseen in a bulk approval.

## Proof cases

- Page test, one product with two links (link-1 $9.00/gal, link-2 $900.00/gal) and a third with no approved price:
  $12.60 (exactly +40%) and $5.40 (exactly -40%) are silent; $12.61 warns "more than 40% above", $5.39 "more than 40%
  below", $900.00 on link-1 "more than 40% above"; $900.00 on link-2 (its own price) and on link-3 (no price) are
  silent. The $12.61 row is a `changed` row (a routine price update), the rest `new`. Approve stays enabled; after
  one warned row is deselected, its confirmation says "Check first: 2 selected row(s) are more than 40% away…".
- When the warning line is removed from the screen, the page test fails. (run once by hand)
- On staging, link UF-ARCH-1 (Atrazine 4L, 5 gal per case; workspace evidence on 2026-11-25: approved $40.00/case =
  $8.00/gal, effective 2026-11-25): a $40.00/case quick quote shows no warning; a $4,000.00/case quick quote shows
  the warning, its checkbox stays selectable and the approve confirmation opens with the "Check first" line, then is
  cancelled. (A $40.00 quote is the approved price itself; a 40% line is $56.00 / $24.00 per case.) Both test imports are rejected afterwards, so no test price becomes the baseline. (browser, staging only)

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-25, 24 findings), settled

- Fixed: #1 (warning gated on the import still awaiting review; text "does not block approval"), #2/#3/#4/#5 (the
  comparison is described as the current approved price with its effective date, and every exclusion is listed above),
  #13 (approve confirmation counts warned rows), #19/#20 (test uses two links on one product and exact boundaries).
- Existing behavior this change reuses unchanged: #6, #8, #16, #17 (converted cost, units and legacy rows are the
  screen's existing conversion; the unit-floor PR bounds the conversion), #18 (the warning is derived from the same
  workspace and review state as the existing converted cost, with no new request or state).
- Disproved: #11 (a staged cost must be above $0; a $0.00 approved price is skipped), #14/#15 (the page and both RPCs
  are admin-only; the workspace RPC returns `get_supplier_market_evidence` output, confirmed on staging in the browser;
  observation writers listed above), #23 (frontend-only; nothing to undo in data).
- Accepted: #7 (rounding at sub-dollar prices), #12 (snapshot; Refresh reloads), #10 (compare with today's current
  price of any price type; a promo or contract price more than 40% off the current one will warn, which is the point
  of a warning). #9 settled by Mason's answer below.
- #21/#22: staging check stages quotes, opens the approve confirmation and cancels, then rejects the test import, so
  no test price becomes a baseline.
- #24: the approved-price lookup is now built once per workspace load.

## Sol round 1 (gpt-6.2-sol high, head 48681de74, CLEAN with 4 MED / 2 LOW), settled

- Fixed: the "Check first" count now comes first in the approve confirmation, ahead of the cost list; the approved-price
  lookup is built once per workspace load and the confirmation text only while it is open; the page test deselects a
  warned row and checks the count follows; this contract no longer describes changing a factor on a link with history.
- Deferred, accepted (warning only, Mason's flags-not-blocks preference): rounding both sides to whole cents can hide
  a swing when the price per inventory unit is a few cents (a per-ton quote on a per-pound product); staging and
  production products price per gallon or pound at well above that. A stale workspace (another admin corrected the
  approved price since this page loaded) shows the old comparison until Refresh; same as every other number on the
  page.

## Business decision

1. How far off triggers the warning. Recommended 3x; **Mason, 2026-11-25: more than a 40% swing either way, every
   product, no warning without a prior approved price, warning only.** Built that way.

## Sol round 2 (gpt-6.2-sol high, head 3b3f347a3, CLEAN with 2 MED / 2 LOW), settled

- MED rounding and MED stale workspace: the same two deferrals accepted under Sol round 1 above.
- Fixed (test and contract only): the page test now includes a `changed` row that warns; this proof-case line now
  matches the test's count of 2.
