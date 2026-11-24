**LOCAL CANDIDATE — NOT APPLIED.** `20270303130000_product_interval_not_applicable.sql` (SQL sha256: `bb828439421f3e3ebb9706417616552c5f48ea79dd7c9a631a53831012e475bd`). Adds `products.rei_not_applicable` / `phi_not_applicable` (default false) so a product can record that its label gives no REI or PHI without storing a fake 0; a trigger clears a flag when a number is written or the EPA number changes, and product change history watches both flags.

Contract: `docs/plans/2026-11-24-rei-phi-not-applicable-CONTRACT.md`.
