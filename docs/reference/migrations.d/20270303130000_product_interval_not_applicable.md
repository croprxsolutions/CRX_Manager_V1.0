**LOCAL CANDIDATE — NOT APPLIED.** `20270303130000_product_interval_not_applicable.sql` (SQL sha256: `16162d91d8f53c70722768a6b4c28b3757c39ac7df5f2b8b07b4adfeedda4ca2`). Adds `products.rei_not_applicable` / `phi_not_applicable` (default false) so a product can record that its label gives no REI or PHI without storing a fake 0; a trigger clears a flag when a number is written or the EPA number changes, and product change history watches both flags.

Contract: `docs/plans/2026-11-24-rei-phi-not-applicable-CONTRACT.md`.
