# CRX Manager — Monthly Integrity Reports

Automated cross-entity consistency checks run on the first of each month before Mason runs month-end close.
Each check mirrors `src/lib/reconciliation.ts` → `runReconciliationChecks()`.

---

## 2026-11-01 Run

**Verdict: FAIL — 5 inventory discrepancies. Resolve before closing October.**

Run time: 2026-11-01 12:11 UTC | Database: `rhyzpcqhnizqbxphqdkr`

| # | Check | Result | Entities Checked | Discrepancies |
|---|---|---|---|---|
| 1 | Order Totals | ✅ PASS | 68 orders | 0 |
| 2 | Inventory Ledger | ❌ FAIL | 117 products | 5 |
| 3 | Invoice Payments | ✅ PASS | 3 invoices | 0 |
| 4 | Invoice Balance Formula | ✅ PASS | 13 invoices | 0 |
| 5 | Commission Splits | ✅ PASS | 32 buckets | 0 |
| 6 | Quote-Hold Parity | ✅ PASS | 0 planned active quotes | 0 |
| 7 | Delivery-Invoice Qty Parity | ✅ PASS | 18 order+product pairs | 0 |
| 8 | Pre-booked Inventory | ✅ PASS | 117 products | 0 |
| 9 | Return-Credit Linkage | ✅ PASS | 0 credited returns | 0 |
| 10 | Customer AR Consistency | ✅ PASS | 14 invoices | 0 |

### Check 2 — Inventory Ledger Discrepancies

`quantity_available` (stored) vs ledger recompute from `inventory_transactions`. Units are physical quantities, not cents. Tolerance: 0.01 units.

| Product | Expected (ledger) | Actual (stored) | Delta |
|---|---|---|---|
| Black Strap Molasses Sugar - Tote | 675 | 2,000 | **1,325** |
| Start Right 2.0 (AgBio) - Tote | 140.19 | 670.19 | **530** |
| 2, 4D Amine 4# - 2.5 Gal | -70 | 25 | **95** |
| 2, 4D Amine 4# - Bulk | 0 | 55 | **55** |
| Start Right 2.0 (AgBio) - 2.5G | 280 | 290 | **10** |

**What this means:** `quantity_available` in the `inventory` table does not match what the full `inventory_transactions` ledger computes for these 5 products. This is the same check the `/integrity-report` admin page shows. Common causes: a manual `adjusted` transaction was recorded against `quantity_prebooked` only (a `PREBOOK_ONLY_ADJUSTMENT_TX_IDS` candidate not yet in the exclusion list), a direct-edit of `quantity_available` outside the ledger, or an `adjusted` transaction with a sign error.

**Note:** Two of these involve 2,4D Amine 4# (both 2.5 Gal and Bulk containers), which may be related. The two Start Right 2.0 AgBio containers showing similar patterns (530 unit gap on the Tote, 10 on the 2.5G) may also be related.

**Recommended action:** Pull the full transaction history for each flagged product from the `inventory_transactions` table and compare against the `inventory.quantity_available` value. Confirm whether any unreported `adjusted` rows belong in `PREBOOK_ONLY_ADJUSTMENT_TX_IDS` in `src/lib/reconciliation.ts`, then correct via a reviewed migration if any row is missing or wrong.

**Resolve N discrepancies before closing:** Resolve 5 inventory discrepancies before closing October.
