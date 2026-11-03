**LOCAL CANDIDATE — NOT APPLIED.** `20261103210000_product_use_timings.sql` (LF SQL sha256: `6260401dba05361c0914f235500a6e09356ddde9cb5789e1359781067f51ebd3`). Mason-gated: this adds column grants to the existing products table. It adds option codes and a list of product use timings, backfills existing labels, and keeps the old text column synchronized for legacy readers and the pricing workbook.

Rollback drops the synchronization trigger and function, the list column, and the options table. The old text column retains its last joined labels.

The pricing workbook previews timing text without checking the option labels or category. Use the exact labels; a misspelled label cancels the whole upload at apply. The same apply-time refusal covers timings on other categories. The governed workbook apply can remove a saved timing after its version check; ordinary legacy text writes cannot remove any code from a product with several timings.

**Live ordering re-read — 2026-11-03 04:22 UTC (read-only `execute_sql` over `supabase_migrations.schema_migrations`; 1100 rows):** effective high-water computed row by row (each row's name timestamp, falling back to its version when the name has none) is `20261103150000` (`20261103150000_ar_aging_flags_unrebuildable_customers`, ledger version `20261103015728`); no row names `use_timing`. `20261103210000` is strictly greater, so ordering holds.
