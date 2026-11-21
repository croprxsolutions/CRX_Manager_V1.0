# Product Master CMP-2 build sheet: the Brand vs Generic page rebuilt

**Status (2026-11-18):** a plan only. No code and no migration have been written. It was written against `origin/staging` (`b7b0d9c66`) and the live database, using read-only counts only. For building, this sheet sits beside the CMP-2 section of `docs/plans/2026-10-29-product-GRAND-PLAN.md` (Stage 5). The grand plan still wins on Mason's settled decisions and acceptance; this sheet adds the build order, the data check and the package split. **Mason (2026-11-18): fill the chemistry first, then build.** No CMP-2 code starts until section 3's "start when" is met (`docs/manual/DECISION_LOG.md`, 2026-11-18).

**What CMP-2 does, in one line.** Pick one premix, several, or a whole category. Each row shows the brand price per acre beside the cost of building the same active-ingredient amounts from chosen generics. It reads "Build saves $X/acre (Y% off the brand price)", or turns red with "Not a saving to build".

---

## 1. Facts this plan is built on (checked 2026-11-18, live, read-only)

| Fact | Value |
|---|---|
| Parents | 456 |
| `active_ingredients` rows | **0** |
| `product_parent_ingredients` rows (any status) | **0** (no parent has chemistry) |
| `product_parent_modes_of_action` rows | **0** |
| `ingredient_map` rows (old page's table) | **0** |
| Approved `product_rates` rows | 698 |
| RT-4 (quotes use approved rates) | Merged to `staging` (#1953); **not live** (`product_parents.rate_source` absent live). Taha owns the release. |

**Today's page (`src/pages/BrandVsGeneric.tsx`, 339 lines):** reads `products` and `ingredient_map`. It has been **read-only since DM-1** (a note says ingredients move to each product's Chemistry section), and its table is empty, so it shows nothing today. It is on the menu for `admin` and `sales_rep` (`src/appPages.tsx:300`, `src/components/layout/WorkspaceTabs.tsx:43`). Cost is shown to admins only through `withAdminCosts` (`src/lib/costFields`).

**Consequence:** every CMP-2 benchmark comes from `product_parent_ingredients` strengths (`strength_value`, `strength_unit` `lb_per_gal`/`pct_ww`, `strength_basis`) and from `active_ingredients` (canonical acid, `canonical_fraction`). With both empty, every row would read "incomplete". A build now could only be proven on test data.

## 2. Mason's decisions this sheet relies on

- 2026-10-29 / 10-30: rebuilt from scratch, last; premix benchmark, shared reference set, admin Cost mode, profit and margin admin-only, many products and categories (grand plan Stage 5).
- 2026-11-17: plan approved with one change. The generic build is always the yardstick; red "Not a saving to build" when the build costs the same or more. Rate per acre is the only editable value, as a what-if; nothing is saved.
- **2026-11-18: fill the chemistry first.** Offered "build now on test data" and "price-per-acre slice only"; he chose to wait for real ingredient data, then MOA-1, then CMP-2.

## 3. Start when (all must be true, checked live at the time)

1. **Chemistry filled:** the premixes and generics Mason wants compared carry active ingredients with known strengths. Path: DM-4 EPA lookup (live, 0 proposals so far) for products with an EPA number; DM-1b workbook or a reviewed manual proposal for the rest. Proof: live counts of `active_ingredients` and parents with active `product_parent_ingredients` rows, plus the Halex GT parent and its three generic references (glyphosate, mesotrione, S-metolachlor) all present with strengths.
2. **MOA-1 landed and its one-time group load done** (`docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md`), because CMP-2's mode-of-action filter reads it.
3. **RT-4 live** (released by Taha), so the "approved default" rate a row starts from is the same rate quotes use.
4. **Use guidance:** only what CMP-2 reads. None of its acceptance needs USE-1/USE-2, so it does not wait on them (Mason, 2026-10-30: "relevant use guidance").

When 1-3 are true, the next session re-checks the facts in section 1, then runs `plan-contract` on package A.

## 4. Packages

**A · Read path and price-mode page (Sol-listed: database)**
- One read-only RPC per comparison set (`SECURITY DEFINER`, `search_path = public, pg_temp`, granted to `authenticated`, checks `admin` or `sales_rep`). It returns, per premix: rate and unit from the approved default, active ingredients with strengths, the shared generic reference per ingredient (product, size, strength), and tier selling prices. Exact numeric values; the screen turns them into whole cents only for display.
- **Cost, profit and margin are returned only to admins, decided in the RPC**, never by hiding columns. A sales rep's direct call gets no cost fields.
- New page replaces `BrandVsGeneric.tsx` at the same route and menu entry. Search by ingredient (through the canonical acid) and filter by mode-of-action group, tier selector (Tier 1 default), many premixes or a whole category, whole-set sorting, total/visible counts.
- Signs exactly as the grand plan's "Signs and denominators": G < B → "Build saves $(B − G)/acre (Y% off the brand price)"; G ≥ B → red "Not a saving to build" with $(G − B); B = 0 → percent unavailable.
- Incomplete rows (missing ingredient, strength, price or rate; non-positive rate → "Comparison rate required") show what is missing and are left out of complete-deal ranking.
- Rate per acre is editable as a what-if: marked "edited" with a reset; no write anywhere.
- Equivalence warnings: salt/ester, formulation/safener/built-in surfactant, premium quality (D-O), adjuvants excluded (D-P), RUP never shown as verified.

**B · Admin Cost mode and profit columns.** Cost/Selling-price toggle, cost/acre, profit/acre, margin % (revenue denominator; aggregate first), the three labelled difference columns, sort by cost/profit/margin. Admin-only from the server.

**C · Reference overrides.** Change a row's generic component; the row is marked as a separate scenario. Deactivated reference → incomplete; zero stock still eligible.

A can ship alone; B and C follow on the same RPC. CLN-2 (drop `ingredient_map`) follows the verified replacement and needs Mason's yes as a destructive change.

## 5. Gates

- A and B touch the database and money display: Sol-listed (`docs/reference/sol-required-paths.md`), Luna until clean, then Sol before the PR.
- `/security-review` on A and B (who sees cost).
- Browser proof on the test app: Halex GT at 4 pt gives 33.44 oz generic Roundup, 3.34 oz generic Callisto, 1.09 pt generic Dual; the $10-vs-$8 and $8-vs-$10 fixtures; a sales rep sees no cost in the network response.
- Files: a new page and its components plus a migration. No quote screen and no `components/ui` file (Taha's hands-off note); re-check his open PRs before building.

## 6. Acceptance

The grand plan's CMP-2 "Done when" and "Added acceptance" lists apply unchanged.
