## 2026-11-19 - Inventory edge cases left by #1940 (#1942)

- New migration `20270203120000_inventory_edge_cases_1942.sql`. Not applied anywhere; staging applies it after the merge.
- **Deadlock:** two delivery completions that both create a missing stock row for the same products now wait instead of deadlocking. This fixes the case #1940 accepted as known.
- **Count precision:** a stock count on a quantity with more than 4 decimals now completes at exactly the counted figure.
- **Order lines:** a system flow with the admin override on can no longer move an order line that has delivery lines to another order or product.
- **Partial deliveries:** a partial delivery whose line list changed since the screen loaded it is refused ("reload it and enter the quantities again") instead of delivering the changed lines in full. The same goes for a blank or malformed figure. (An offline receipt already goes to office review today, for missing completion evidence.)
- **Shortage warnings:** one product on two lines that are short together now warns and flags review, once per product.
- **Screens:** `src/lib/errorSanitizer.ts` explains the two new refusals.
- **Proof:** `node scripts/smoke/prove-inventory-edge-cases-1942-real-schema.mjs` prints `INVENTORY_EDGE_CASES_PROOF_PASS`.
- **Rollback:** `scripts/smoke/inventory-edge-cases-1942-reverse.sql`.
