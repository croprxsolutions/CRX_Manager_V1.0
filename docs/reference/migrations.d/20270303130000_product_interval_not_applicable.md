**LOCAL CANDIDATE — NOT APPLIED.** `20270303130000_product_interval_not_applicable.sql` (SQL sha256: `5bdd5637045f7819a99dcd2f38a146efc23527793c358f91acc9bb2db8ac8ff7`). Adds `products.rei_not_applicable` / `phi_not_applicable` (default false) so a product can record that its label gives no REI or PHI without storing a fake 0; a trigger clears a flag when a number is written or the EPA number changes, and product change history watches both flags.

Contract: `docs/plans/2026-11-24-rei-phi-not-applicable-CONTRACT.md`.
