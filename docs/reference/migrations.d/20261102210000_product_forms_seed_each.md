**LOCAL CANDIDATE — NOT APPLIED.** `20261102210000_product_forms_seed_each.sql` (LF SQL sha256: `5ccf6d7fca82ae366444ed974c9c51bd98deb60aeca9a85ec6e77e8a5c1eb647`). Adds exact Seed and Each stock-unit rules and rejects quote lines with missing or mismatched units. Fills a blank product rate unit from its stock unit before per-acre pricing.

Rollback: remove the quote-unit trigger and form-unit table, then restore the prior function bodies and liquid/dry product-form constraint after confirming no Seed or Each products remain.
