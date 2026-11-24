# Better Product Labels — Specimen Labels, SDS Links & Accurate Weights (PLAN)

Status: approved direction, not built. Owner sign-off on the lean scope: Mason, 2026-11-24.
Live doc: https://claude.ai/artifact/F1GUASLMivxwAEzN9bdsLB (rev 36). This file is the build copy.

**Goal:** give every product in CRX Manager a one-click manufacturer specimen label, its SDS, and an accurate, approved lb/gal — using free manufacturer files entered by hand. Kept deliberately small: Mason asked for no license/compliance machinery.

## What must stay true
- No weight reaches a blend ticket or loader sheet until a person approves it. (Already true today.)
- One weight per product group — so every brand in a group must really weigh the same. If not, split the group.
- A missing weight shows as missing on the ticket, never as a quietly wrong total.

## The problem
- The EPA label link is the registration copy (acceptance letter + stamped master label with bracketed alternates), not the specimen label on the jug.
- Supplemental 2(ee) and state 24(c) labels are hard to find.
- No SDS link anywhere. The SDS (section 9) is the best source for density.
- lb/gal is typed by hand; blend tickets and loader sheets depend on it.

## Where label data comes from
Manufacturer websites: free, links are fine, addresses change when sites are redone. EPA: registration copies only (kept as backup). CDMS/Agrian (TELUS) and Greenbook: paid license, terms forbid linking or loading without permission — **not used**.

lb/gal from an SDS = specific gravity × 8.345404 (already in `src/lib/productWeights.ts`). Pounds of *active ingredient* per gallon on a label is not product weight.

## What CRX Manager does today (verify before building)
- EPA lookup proposes name, maker, signal word, RUP flag, actives; `label_url` per EPA number; EPA proposals only accept `https://www3.epa.gov/` links and pick the newest-dated PDF (`supabase/migrations/20270105110000_epa_chemistry_proposals.sql`).
- Brands: `src/components/products/ProductBrandsSection.tsx`.
- Weights: `product_parent_density_values` (one approved + one draft per parent), helper `_save_parent_density_draft` (`supabase/migrations/20261207100000_product_weights.sql`), UI `src/components/products/ProductWeightCard.tsx`, logic `src/lib/productWeights.ts`. `saveWeight()` approves immediately. A product moving parent already sends the weight back to draft.
- Setup spreadsheet import: `supabase/migrations/20270103160000_setup_workbook_chemistry_tabs.sql` and related code.

## Step 0 — Quick check (half a day, read-only, changes nothing)
1. Count brands missing a specimen label or SDS, and liquid groups with no approved weight.
2. List product groups that hold more than one brand.
3. Record what a blend ticket and loader sheet show today when a weight is missing.

Output: a short findings note in `docs/plans/` beside this file.

## Step 1 — Label and SDS links (main build)
- In product setup's brands section, each brand gets: **Specimen label link**, **SDS link**, and an optional list of **supplemental / 24(c) links** (each with state and expiry date).
- Buttons beside each brand on the product page. The existing EPA label stays as a backup button.
- Bulk entry: link columns in the setup spreadsheet import. **Blank cells change nothing** (never clear an existing link).
- Light safeguards: https only; links to cdms.net and greenbook.net are refused; expired 24(c) shown greyed out; change history kept; a "Report broken link" button puts it on a short fix list.

Done when: a real product opens its manufacturer specimen label and SDS from its brand, and importing an old spreadsheet (no link columns) changes nothing.

## Step 2 — Accurate weights
- SDS button on the weight card, next to the weight; staff can enter specific gravity from SDS section 9 and the app converts it (existing conversion).
- The weight card lists every brand in the group; the approver confirms they match. If one differs, split the group. Step 0's multi-brand groups get checked once.
- Adding a brand to a group sends its weight back to draft for re-check (extend the existing parent-move trigger to brands).
- A new draft no longer overwrites someone else's waiting draft (today `_save_parent_density_draft` replaces it, event `draft_replaced`). Refuse with a clear message instead.
- Missing weight flagged on tickets — only if Step 0 shows it isn't already.

Done when: in staging, a blend ticket and loader sheet print correctly for a product with an approved weight, one with no weight (clearly flagged), and one just re-checked; old saved tickets are unchanged.

## Later, only if needed
- Auto-read the SDS section 9 and pre-fill the number (a person still approves). Only if hand entry is too slow.
- Paid label data (CDMS, Greenbook). Not now.

## Scope
In: specimen, SDS and supplemental/24(c) links per brand; product-page buttons; spreadsheet link columns; broken-link reporting; SDS beside the weight card; whole-group check before approving; re-check when a brand joins; no draft overwrites.
Out: paid label data; SDS auto-reading; automatic link checking; storing PDF copies; proving which label version applied on a past date; reading rates/REI/PHI from labels; changes to blend math or loader formulas; FarmRx.

## Risks
| Risk | Safeguard |
| --- | --- |
| One brand's weight used for a different brand in the same group | Approver sees every brand; differing brands → split the group |
| Wrong number typed from the SDS | SDS opens next to the weight; a second person approves |
| Wrong label linked to a brand | Links sit on the brand, history kept, staff can report it |
| Manufacturer moves a file | "Report broken link"; EPA label still there as backup |
| Live database change | Normal CRX PR review, staging test, Mason approves going live |

## Decisions for Mason
- OK to start Step 0 and Step 1.
- Who enters links and weights, and who approves weights.
- Groups whose brands weigh differently: split the group.
