**LOCAL CANDIDATE — NOT APPLIED.** `20261103230000_pricing_tier_order_warning.sql` (LF SQL sha256: `662149f4abb30f296711c3ef0582ad6fd48109e23170093f0de94c6d2a88d07e`). This routine migration replaces the private pricing-warning function to add the final-price `TIER_ORDER` warning. It changes no data, grants, or policies.

The preflight pins the live warning function, warning-set helper, and three consumer bodies as read on 2026-11-02. Rollback: re-create it from 20261027050000 (~228-334) as CREATE OR REPLACE. The existing five warning codes and their details must remain unchanged on the same previews. A stated $0 is a real final tier price.

Live migration high-water read 2026-11-02: `20261103150000_ar_aging_flags_unrebuildable_customers`; re-check before apply.
