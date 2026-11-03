**LOCAL CANDIDATE — NOT APPLIED.** `20261104090000_product_forms_seed_each.sql` (LF SQL sha256: `3fc7ab85f9e7650ee84a19de6885e8332bb2c8837fd77cb0c9f1ddd128f0f8a6`). Adds exact Seed and Each stock-unit rules, rejects quote lines with missing or mismatched units, and rejects job-chemical lines in another unit (filling a blank one from the stock unit). Fills a blank product rate unit from its stock unit before per-acre pricing.

Live capture (read-only, 2026-11-02 about 10:50 PM Central): 1,100 ledger rows; highest stamp by name (else version) `20261103150000`; highest raw version `20261103015728`; this candidate is not applied. Live `unit_conversions` has `Lb`, `Unit` and `Ea`, so the exact rule-row postflight runs there. Re-read the ledger at apply time.

Rollback: remove the quote-unit and job-line unit triggers and the form-unit table, then restore the prior function bodies and liquid/dry product-form constraint after confirming no Seed or Each products remain.
