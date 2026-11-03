**LOCAL CANDIDATE — NOT APPLIED.** `20261103140000_product_use_timings.sql` (LF SQL sha256: `6260401dba05361c0914f235500a6e09356ddde9cb5789e1359781067f51ebd3`). Mason-gated: this adds column grants to the existing products table. It adds option codes and a list of product use timings, backfills existing labels, and keeps the old text column synchronized for legacy readers and the pricing workbook.

Rollback drops the synchronization trigger and function, the list column, and the options table. The old text column retains its last joined labels.

The pricing workbook previews timing text without checking the option labels or category. Use the exact labels; a misspelled label cancels the whole upload at apply. The same apply-time refusal covers timings on other categories. The governed workbook apply can remove a saved timing after its version check; ordinary legacy text writes cannot remove any code from a product with several timings.
